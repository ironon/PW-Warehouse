"""Command-line label printing, for testing without the web app.

    python printlabel.py --check                  # can we reach the printer?
    python printlabel.py --test                   # print one diagnostic label
    python printlabel.py "M5 Screws"              # print 2 labels (the default)
    python printlabel.py "M5 Screws" --copies 1
    python printlabel.py "Fragile" --italic --underline
    python printlabel.py "Notes" --regular        # not bold
    python printlabel.py "M5 Screws" --dry-run    # render only, save a PNG
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from label_printer import config, printer
from label_printer.render import render_label


def diagnostic_label(width: int | None = None, height: int | None = None) -> Image.Image:
    """A label that reveals alignment problems at a glance: a full-extent
    border, corner ticks, and a centre line, so any clipping or horizontal
    offset is obvious on the printed result."""
    w = width or config.label_width_dots()
    h = height or config.label_height_dots()
    img = Image.new("1", (w, h), 1)
    d = ImageDraw.Draw(img)

    d.rectangle([0, 0, w - 1, h - 1], outline=0, width=3)
    tick = 40
    for x, y in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        d.line([x, y, x + (tick if x == 0 else -tick), y], fill=0, width=6)
        d.line([x, y, x, y + (tick if y == 0 else -tick)], fill=0, width=6)
    d.line([w // 2, 0, w // 2, 24], fill=0, width=3)
    d.line([w // 2, h - 25, w // 2, h - 1], fill=0, width=3)

    try:
        font = ImageFont.truetype(config.FONT_PATH, 54)
        small = ImageFont.truetype(config.FONT_PATH, 30)
    except OSError:
        font = small = ImageFont.load_default()

    title = "PW-WAREHOUSE TEST"
    d.text(((w - d.textlength(title, font=font)) // 2, h // 2 - 60), title, font=font, fill=0)
    from label_printer import stocks

    sub = f"{stocks.current().name}   {w}x{h}px   {config.DPI}dpi"
    d.text(((w - d.textlength(sub, font=small)) // 2, h // 2 + 10), sub, font=small, fill=0)
    edge = "|<-- left edge"
    d.text((12, h // 2 + 55), edge, font=small, fill=0)
    right = "right edge -->|"
    d.text((w - 12 - d.textlength(right, font=small), h // 2 + 55), right, font=small, fill=0)
    return img


def check(retries: int = 2, scan: bool = False) -> bool:
    """Quick reachability test. Kept fast on purpose: a full channel scan can
    take a minute and a half, so it only runs when asked for with --scan."""
    print(f"transport    : {printer.describe_target()}")
    from label_printer import stocks

    stock = stocks.current()
    print(f"stock        : {stock.name}  (paper {stock.paper_width_mm:g}x{stock.paper_length_mm:g}mm, "
          f"rotate {stock.rotate} deg)")
    print(f"design       : {config.label_width_dots()}x{config.label_height_dots()} dots @ {config.DPI}dpi")

    for attempt in range(1, retries + 1):
        ok, msg = printer.port_available(timeout=5.0)
        if ok:
            print(f"\nOK: {msg}")
            return True
        print(f"\nattempt {attempt}/{retries} failed: {msg}")
        if attempt < retries:
            time.sleep(2.0)

    print(
        "\nCould not reach the printer. Most likely, in order:\n"
        "  1. Something else holds the connection - Labelife, a phone, or a print\n"
        "     job that just finished. The D520 accepts ONE connection at a time and\n"
        "     needs a few seconds to free it. Close Labelife and wait, then retry.\n"
        "  2. The printer is asleep - press its button to wake it.\n"
        "  3. It is out of range or switched off.\n"
        "\nIf it was re-paired, the RFCOMM channel may have moved:\n"
        "  python printlabel.py --check --scan     (takes up to ~90s)"
    )

    if scan:
        print("\nScanning channels 1-30 ...")
        found = printer.find_channel()
        if found is not None:
            print(f"  The printer answers on channel {found}.")
            print(f"  Set PRINTER_RFCOMM_CHANNEL={found} (or update config.py).")
        else:
            print("  No channel answered.")
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description="Print a PW-Warehouse label.")
    ap.add_argument("text", nargs="?", help="label text")
    ap.add_argument("--copies", type=int, default=2, help="copies to print (default 2)")
    ap.add_argument("--check", action="store_true", help="test printer connectivity only")
    ap.add_argument("--scan", action="store_true", help="with --check, scan for the RFCOMM channel (slow)")
    ap.add_argument("--test", action="store_true", help="print a diagnostic alignment label")
    ap.add_argument("--dry-run", action="store_true", help="render to PNG, do not print")
    ap.add_argument("--port", help="use a serial COM port instead of Bluetooth")
    ap.add_argument("--regular", action="store_true", help="not bold (bold is the default)")
    ap.add_argument("--italic", action="store_true", help="italic")
    ap.add_argument("--underline", action="store_true", help="underline")
    args = ap.parse_args()

    if args.check:
        return 0 if check(scan=args.scan) else 1

    from label_printer.render import Style

    style = Style(
        bold=not args.regular, italic=args.italic, underline=args.underline
    )
    image = diagnostic_label() if args.test else render_label(args.text or "", style=style)
    if not args.test and not args.text:
        ap.error("provide label text, or use --test / --check")

    if args.dry_run:
        out = Path(__file__).parent / "preview_out"
        out.mkdir(exist_ok=True)
        path = out / ("diagnostic.png" if args.test else "dry_run.png")
        image.save(path)
        print(f"rendered {image.size} -> {path}")
        return 0

    copies = max(1, args.copies)

    # The Windows driver path hands the driver a bitmap rather than building
    # the printer language ourselves.
    if config.PRINTER_TRANSPORT == "windows" and not args.port:
        from label_printer import windows_print

        renderer = (lambda _t, w, h: diagnostic_label(w, h)) if args.test else None
        try:
            info = windows_print.print_image(
                args.text or "", copies=copies, render=renderer, style=style
            )
        except windows_print.WindowsPrintError as exc:
            print(f"\nFAILED: {exc}", file=sys.stderr)
            return 1
        print(f"printer      : {info['printer']}")
        print(f"printable px : {info['printable_px'][0]}x{info['printable_px'][1]}")
        print(f"dpi          : {info['dpi'][0]}x{info['dpi'][1]}")
        print(f"copies       : {info['copies']}")
        print("done")
        return 0

    payload = printer.build_payload(image)
    print(f"protocol: {config.PRINTER_PROTOCOL}")
    print(f"payload: {len(payload)} bytes, {image.size[0]}x{image.size[1]} dots")
    target = f"serial {args.port}" if args.port else printer.describe_target()
    try:
        for i in range(1, copies + 1):
            print(f"sending copy {i}/{copies} to {target} ...")
            printer.send_bytes(payload, port=args.port)
            time.sleep(0.8)
    except printer.PrinterError as exc:
        print(f"\nFAILED: {exc}", file=sys.stderr)
        return 1
    print("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
