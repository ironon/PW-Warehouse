"""Prints through the Phomemo Windows driver over USB.

This is the most reliable path: the vendor's own driver generates whatever
command language the printer wants, so we only have to hand it a bitmap.
Talking TSPL or ESC/POS over Bluetooth requires guessing that language
correctly; here the driver already knows it.

Requires the "D520 Printer" driver (installed with the printer over USB).
"""

from __future__ import annotations

from PIL import Image, ImageWin  # noqa: F401 - Image used for resampling

from . import config

# GetDeviceCaps indices
HORZRES, VERTRES = 8, 10
LOGPIXELSX, LOGPIXELSY = 88, 90

DMPAPER_USER = 256
DM_PAPERSIZE = 0x00000002
DM_PAPERLENGTH = 0x00000004
DM_PAPERWIDTH = 0x00000008
DM_ORIENTATION = 0x00000001
DMORIENT_PORTRAIT = 1


class WindowsPrintError(RuntimeError):
    pass


def list_printers() -> list[str]:
    import win32print

    return [p[2] for p in win32print.EnumPrinters(win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS)]


def printer_exists(name: str | None = None) -> tuple[bool, str]:
    name = name or config.WINDOWS_PRINTER_NAME
    try:
        printers = list_printers()
    except Exception as exc:  # noqa: BLE001
        return False, f"Could not enumerate printers: {exc}"
    if name in printers:
        return True, f'"{name}" is installed'
    return False, f'Printer "{name}" not found. Installed: {", ".join(printers) or "(none)"}'


def _build_devmode(printer_name: str):
    """Copies the driver's DEVMODE and forces our label size onto it.

    The driver ships configured for 4x6 shipping labels; the loaded stock is
    shorter, so the paper length has to be overridden or every label feeds
    six inches.
    """
    import win32print

    from . import stocks

    handle = win32print.OpenPrinter(printer_name)
    try:
        devmode = win32print.GetPrinter(handle, 2)["pDevMode"]
    finally:
        win32print.ClosePrinter(handle)

    if devmode is None:
        raise WindowsPrintError(f'No DEVMODE available for "{printer_name}".')

    stock = stocks.current()
    # DEVMODE paper dimensions are in tenths of a millimetre, and describe the
    # *physical* paper: width across the head, length along the feed.
    devmode.PaperSize = DMPAPER_USER
    devmode.PaperWidth = int(round(stock.paper_width_mm * 10))
    devmode.PaperLength = int(round(stock.paper_length_mm * 10))
    devmode.Orientation = DMORIENT_PORTRAIT
    devmode.Fields |= DM_PAPERSIZE | DM_PAPERWIDTH | DM_PAPERLENGTH | DM_ORIENTATION
    return devmode


def print_image(
    text: str,
    printer_name: str | None = None,
    copies: int = 1,
    render=None,
    style=None,
) -> dict:
    """Renders `text` to the driver's exact printable area and prints it."""
    import win32gui
    import win32ui

    printer_name = printer_name or config.WINDOWS_PRINTER_NAME
    ok, message = printer_exists(printer_name)
    if not ok:
        raise WindowsPrintError(message)

    if render is None:
        from .render import DEFAULT_STYLE, render_label

        active_style = style or DEFAULT_STYLE

        def render(t, w, h):
            return render_label(t, w, h, style=active_style)

    devmode = _build_devmode(printer_name)

    try:
        hdc = win32gui.CreateDC("WINSPOOL", printer_name, devmode)
    except Exception as exc:  # noqa: BLE001
        raise WindowsPrintError(f"Could not open a device context for {printer_name}: {exc}") from exc

    dc = win32ui.CreateDCFromHandle(hdc)
    try:
        width = dc.GetDeviceCaps(HORZRES)
        height = dc.GetDeviceCaps(VERTRES)
        dpi_x = dc.GetDeviceCaps(LOGPIXELSX)
        dpi_y = dc.GetDeviceCaps(LOGPIXELSY)

        if width <= 0 or height <= 0:
            raise WindowsPrintError(
                f"Driver reported an empty printable area ({width}x{height})."
            )

        from . import stocks

        stock = stocks.current()

        # The driver over-reports the printable width, so the far right of the
        # label is physically clipped. Draw into a slightly narrower rect.
        inset = max(0, config.PRINT_RIGHT_INSET_DOTS)
        draw_w = max(1, width - inset)
        draw_h = height

        # For a rotated stock the design is composed landscape - swapped
        # relative to the paper - then turned to fit the narrower web.
        if stock.rotate % 180:
            design = render(text, draw_h, draw_w)
            image = design.rotate(-stock.rotate, expand=True)
        else:
            image = render(text, draw_w, draw_h)

        if image.size != (draw_w, draw_h):
            # Guard against an off-by-one from rounding so nothing is clipped.
            image = image.resize((draw_w, draw_h), Image.LANCZOS)

        if image.mode != "RGB":
            image = image.convert("RGB")

        for _ in range(max(1, copies)):
            dc.StartDoc("PW-Warehouse Label")
            dc.StartPage()
            ImageWin.Dib(image).draw(dc.GetHandleOutput(), (0, 0, draw_w, draw_h))
            dc.EndPage()
            dc.EndDoc()

        return {
            "printer": printer_name,
            "stock": stock.name,
            "rotate": stock.rotate,
            "printable_px": [width, height],
            "drawn_px": [draw_w, draw_h],
            "right_inset_px": inset,
            "design_px": [draw_h, draw_w] if stock.rotate % 180 else [draw_w, draw_h],
            "dpi": [dpi_x, dpi_y],
            "copies": max(1, copies),
        }
    finally:
        try:
            dc.DeleteDC()
        except Exception:  # noqa: BLE001
            pass
