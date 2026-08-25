"""Self-checks both printer languages without needing the printer switched on.

ESC/POS: decodes the payload back into an image and compares it pixel for
pixel with the original.
TSPL2: validates the command structure and BITMAP geometry. This is the one
the D520 actually uses.
"""

from PIL import Image

from label_printer import config, printer
from label_printer.render import render_label

ESC_INIT = b"\x1b\x40"
GS_RASTER = b"\x1d\x76\x30\x00"


def decode(payload: bytes) -> Image.Image:
    assert payload.startswith(ESC_INIT), "payload must start with ESC @"
    pos = len(ESC_INIT)

    rows: list[bytes] = []
    width_bytes = None

    while pos < len(payload):
        if payload[pos : pos + 4] == GS_RASTER:
            pos += 4
            xl, xh, yl, yh = payload[pos : pos + 4]
            pos += 4
            wb = xl | (xh << 8)
            h = yl | (yh << 8)
            if width_bytes is None:
                width_bytes = wb
            assert wb == width_bytes, "inconsistent width between blocks"
            block = payload[pos : pos + wb * h]
            assert len(block) == wb * h, "truncated raster block"
            pos += wb * h
            for r in range(h):
                rows.append(block[r * wb : (r + 1) * wb])
        elif payload[pos : pos + 2] == b"\x1b\x64":
            pos += 3  # ESC d n
        else:
            raise AssertionError(f"unexpected byte 0x{payload[pos]:02x} at {pos}")

    assert width_bytes is not None, "no raster blocks found"
    data = b"".join(rows)
    # Printer uses 1=black; Pillow's '1' mode raw uses 0=black.
    img = Image.frombytes("1", (width_bytes * 8, len(rows)), bytes(b ^ 0xFF for b in data))
    return img


def check_tspl(original) -> None:
    """Validates the TSPL2 payload the D520 actually uses."""
    import re

    payload = printer.build_tspl_payload(original)
    text = payload[:200].decode("ascii", "replace")

    for required in ("SIZE ", "GAP ", "DIRECTION ", "CLS", "BITMAP "):
        assert required in text, f"TSPL payload missing {required!r}"
    assert payload.rstrip().endswith(b"PRINT 1,1"), "TSPL payload must end with PRINT"

    i = payload.index(b"BITMAP ")
    m = re.match(rb"BITMAP (\d+),(\d+),(\d+),(\d+),(\d+),", payload[i : i + 64])
    assert m, "malformed BITMAP command"
    x, y, width_bytes, height, mode = (int(g) for g in m.groups())

    expected_wb = (original.width + 7) // 8
    assert width_bytes == expected_wb, f"width {width_bytes} != {expected_wb}"
    assert height == original.height, f"height {height} != {original.height}"

    start = i + m.end()
    data = payload[start : start + width_bytes * height]
    assert len(data) == width_bytes * height, "bitmap data truncated"
    assert payload[start + len(data) :] == b"\r\nPRINT 1,1\r\n", "unexpected trailer"

    print("\n--- TSPL2 (the D520's actual language) ---")
    print(f"header         : {text.split('BITMAP')[0].strip().replace(chr(13),'').replace(chr(10),' | ')}")
    print(f"BITMAP         : x={x} y={y} width_bytes={width_bytes} height={height} mode={mode}")
    print(f"payload bytes  : {len(payload)}")
    print("OK - TSPL structure valid.")


def main() -> None:
    text = "Ribbon Data Cables >39 in"
    original = render_label(text)
    payload = printer.build_escpos_payload(original)
    decoded = decode(payload)

    print(f"label text     : {text!r}")
    print(f"original size  : {original.size}")
    print(f"decoded size   : {decoded.size}")
    print(f"payload bytes  : {len(payload)}")
    print(f"chunk lines    : {config.RASTER_CHUNK_LINES}")

    expected_blocks = -(-original.height // config.RASTER_CHUNK_LINES)
    actual_blocks = payload.count(GS_RASTER)
    print(f"raster blocks  : {actual_blocks} (expected {expected_blocks})")
    assert actual_blocks == expected_blocks, "unexpected block count"

    assert decoded.size == original.size, "size mismatch after round-trip"
    diff = sum(1 for a, b in zip(original.tobytes(), decoded.tobytes()) if a != b)
    print(f"differing bytes: {diff}")
    assert diff == 0, "pixel data changed in the round-trip"

    black = sum(1 for p in original.convert("L").tobytes() if p < 128)
    pct = black / (original.width * original.height) * 100
    print(f"black coverage : {pct:.1f}%")
    print("OK - ESC/POS raster round-trips exactly.")

    check_tspl(original)


if __name__ == "__main__":
    main()
