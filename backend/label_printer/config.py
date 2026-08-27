"""Printer and label geometry settings.

Every value here can be overridden with an environment variable of the same
name, so the printer can be re-pointed or the label size changed without
editing code.
"""

import os

# --- Label geometry -------------------------------------------------------
# The D520 prints at 203 dpi. Physical dimensions come from whichever stock
# is currently selected (see stocks.py), so these are functions rather than
# constants - the stock can change at runtime from the web app.
DPI = int(os.environ.get("LABEL_DPI", "203"))


def _mm_to_dots(mm: float, *, round_to_byte: bool = False) -> int:
    dots = round(mm / 25.4 * DPI)
    if round_to_byte:
        dots = ((dots + 7) // 8) * 8
    return dots


def label_width_mm() -> float:
    """Design canvas width, i.e. as a person reads the label."""
    from . import stocks

    return stocks.current().design_width_mm


def label_height_mm() -> float:
    from . import stocks

    return stocks.current().design_height_mm


def label_width_dots() -> int:
    return _mm_to_dots(label_width_mm(), round_to_byte=True)


def label_height_dots() -> int:
    return _mm_to_dots(label_height_mm())

# Horizontal shift applied at print time. Thermal print heads are often wider
# than the loaded stock, so if output sits off to one side, nudge this.
PRINT_X_OFFSET_DOTS = int(os.environ.get("PRINT_X_OFFSET_DOTS", "0"))

# The driver reports a printable width slightly wider than what actually
# lands on the label, so the far right edge gets clipped. Pulling the drawn
# area in by a few dots keeps the border and text inside the printed region.
PRINT_RIGHT_INSET_DOTS = int(os.environ.get("PRINT_RIGHT_INSET_DOTS", "12"))

# --- Typography -----------------------------------------------------------
# Segoe UI in its four weight/slant combinations. Underline has no font file
# of its own and is drawn as a rule beneath each line.
FONT_DIR = os.environ.get("LABEL_FONT_DIR", r"C:\Windows\Fonts")
FONT_FILES = {
    (False, False): os.environ.get("LABEL_FONT_REGULAR", "segoeui.ttf"),
    (True, False): os.environ.get("LABEL_FONT_BOLD", "segoeuib.ttf"),
    (False, True): os.environ.get("LABEL_FONT_ITALIC", "segoeuii.ttf"),
    (True, True): os.environ.get("LABEL_FONT_BOLD_ITALIC", "segoeuiz.ttf"),
}


def font_path(bold: bool = True, italic: bool = False) -> str:
    return os.path.join(FONT_DIR, FONT_FILES[(bool(bold), bool(italic))])


# Kept for callers that just want the default face.
FONT_PATH = font_path(bold=True)
MARGIN_DOTS = int(os.environ.get("LABEL_MARGIN_DOTS", "48"))
MAX_FONT_SIZE = int(os.environ.get("LABEL_MAX_FONT_SIZE", "200"))
MIN_FONT_SIZE = int(os.environ.get("LABEL_MIN_FONT_SIZE", "18"))

# --- Printer link ---------------------------------------------------------
# The D520 advertises a vendor-specific RFCOMM service (UUID E5B152ED-...,
# which Windows labels "WeChat") rather than standard SPP, so Windows never
# binds a working COM port to it. The COM4 that does exist is a leftover from
# an earlier Bluetooth radio - its device instance sits on a different radio
# than the printer, which is why opening it fails with WinError 52.
#
# Connecting a raw RFCOMM socket to the printer's MAC and channel sidesteps
# COM ports completely. Channel 23 was found with probe_rfcomm.py; re-run
# that script if the printer is ever re-paired and the channel moves.
# windows : print through the vendor driver over USB (most reliable - the
#           driver knows the printer's command language, so we only supply a
#           bitmap). Requires the D520 driver and a USB connection.
# rfcomm  : raw Bluetooth socket, we generate the printer language ourselves.
# serial  : COM port, same as rfcomm but over a serial link.
PRINTER_TRANSPORT = os.environ.get("PRINTER_TRANSPORT", "windows")

# Name of the installed Windows printer (see: Get-Printer).
WINDOWS_PRINTER_NAME = os.environ.get("WINDOWS_PRINTER_NAME", "D520 Printer")
PRINTER_MAC = os.environ.get("PRINTER_MAC", "60:6E:41:09:70:91")
PRINTER_RFCOMM_CHANNEL = int(os.environ.get("PRINTER_RFCOMM_CHANNEL", "23"))

# Only used when PRINTER_TRANSPORT=serial.
PRINTER_PORT = os.environ.get("PRINTER_PORT", "COM4")
PRINTER_BAUD = int(os.environ.get("PRINTER_BAUD", "115200"))
PRINTER_TIMEOUT_S = float(os.environ.get("PRINTER_TIMEOUT_S", "15"))

# --- Printer language -----------------------------------------------------
# Phomemo's shipping-label range (PM-241 / D520 / PM-246S ...) speaks TSPL2,
# not the ESC/POS raster used by their small M02/M110 pocket printers. Sending
# ESC/POS to a D520 is accepted over Bluetooth but prints nothing at all.
PRINTER_PROTOCOL = os.environ.get("PRINTER_PROTOCOL", "tspl")  # tspl | escpos

def label_gap_mm() -> float:
    """Gap between die-cut labels, from the selected stock."""
    from . import stocks

    override = os.environ.get("LABEL_GAP_MM")
    if override is not None:
        return float(override)
    return stocks.current().gap_mm
# TSPL feed direction / origin. Flip if labels come out upside down.
TSPL_DIRECTION = int(os.environ.get("TSPL_DIRECTION", "1"))
# TSPL BITMAP treats a 0 bit as black, which matches Pillow's packing. If
# output comes out inverted (black background), set this to 1.
TSPL_INVERT = os.environ.get("TSPL_INVERT", "0") == "1"

# Raster blocks are chunked so no single GS v 0 command carries too many
# lines; small Bluetooth buffers otherwise drop data mid-image.
RASTER_CHUNK_LINES = int(os.environ.get("RASTER_CHUNK_LINES", "128"))
CHUNK_PAUSE_S = float(os.environ.get("CHUNK_PAUSE_S", "0.06"))

# --- Server ---------------------------------------------------------------
# Binds all interfaces so a phone on the same network can print. The service
# is unauthenticated, so this must stay on a trusted internal network - it is
# the same trust model as the rest of the app.
HOST = os.environ.get("LABEL_SERVER_HOST", "0.0.0.0")
PORT = int(os.environ.get("LABEL_SERVER_PORT", "8765"))

# The frontend may be opened from localhost, from the machine's LAN address, or
# from an intranet name like http://pw-warehouse.local. So: loopback, the
# private ranges (RFC1918), any *.local mDNS name, and any single-label
# hostname -- on any port. Single-label and .local names cannot be registered
# on the public internet, so no external site can forge one of these origins;
# this stays as tight as a browser can make it without real authentication.
# An explicit LABEL_ALLOWED_ORIGINS overrides all of it with a fixed list.
ALLOWED_ORIGIN_REGEX = os.environ.get(
    "LABEL_ALLOWED_ORIGIN_REGEX",
    r"^http://("
    r"localhost|127\.0\.0\.1|"
    r"10\.\d{1,3}\.\d{1,3}\.\d{1,3}|"
    r"192\.168\.\d{1,3}\.\d{1,3}|"
    r"172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|"
    r"[A-Za-z0-9][A-Za-z0-9-]*(\.local)?"
    r")(:\d+)?$",
)
_explicit = os.environ.get("LABEL_ALLOWED_ORIGINS", "").strip()
ALLOWED_ORIGINS = [o.strip() for o in _explicit.split(",") if o.strip()] if _explicit else []
