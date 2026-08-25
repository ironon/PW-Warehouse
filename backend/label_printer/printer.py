"""Sends rendered labels to the D520 over its Bluetooth serial link.

Phomemo printers do not handle ESC/POS *text* commands reliably, but they do
accept the standard ESC/POS raster bitmap command (GS v 0), which is what
this module uses: the label is rendered to a bitmap first, then shipped as
raster rows.
"""

from __future__ import annotations

import socket
import time

from PIL import Image

from . import config

ESC_INIT = b"\x1b\x40"  # ESC @   - reset to a known state
GS_RASTER = b"\x1d\x76\x30\x00"  # GS v 0 m=0 - print raster bit image
FEED = b"\x1b\x64"  # ESC d n - feed n lines


class PrinterError(RuntimeError):
    pass


def image_to_raster(image: Image.Image) -> tuple[bytes, int, int]:
    """Packs a 1-bit image into raster rows (1 = black, MSB first)."""
    if image.mode != "1":
        image = image.convert("1")

    width_bytes = (image.width + 7) // 8
    # Pillow's raw '1' packing already matches the ESC/POS layout, except
    # that Pillow uses 0 for black while the printer expects 1 for black.
    packed = image.tobytes("raw", "1")
    inverted = bytes(b ^ 0xFF for b in packed)
    return inverted, width_bytes, image.height


def _apply_offset(image: Image.Image) -> Image.Image:
    if not config.PRINT_X_OFFSET_DOTS:
        return image
    shifted = Image.new("1", (image.width, image.height), 1)
    shifted.paste(image, (config.PRINT_X_OFFSET_DOTS, 0))
    return shifted


def build_escpos_payload(image: Image.Image) -> bytes:
    """ESC/POS raster (GS v 0). Correct for Phomemo's M02/M110 pocket
    printers; the D520 accepts these bytes but prints nothing."""
    image = _apply_offset(image)
    data, width_bytes, height = image_to_raster(image)

    out = bytearray(ESC_INIT)
    chunk = max(1, config.RASTER_CHUNK_LINES)
    for top in range(0, height, chunk):
        rows = min(chunk, height - top)
        start = top * width_bytes
        end = start + rows * width_bytes
        out += GS_RASTER
        out += bytes([width_bytes & 0xFF, (width_bytes >> 8) & 0xFF])
        out += bytes([rows & 0xFF, (rows >> 8) & 0xFF])
        out += data[start:end]

    out += FEED + bytes([3])
    return bytes(out)


def build_tspl_payload(image: Image.Image) -> bytes:
    """TSPL2, which is what the D520 and its PM-241/PM-246S siblings speak.

    Structure: set up the media, clear the buffer, send one BITMAP, print.
    TSPL's BITMAP takes a 0 bit as a black dot, which is exactly how Pillow
    packs mode "1", so the data needs no inversion (unlike ESC/POS).
    """
    if image.mode != "1":
        image = image.convert("1")
    image = _apply_offset(image)

    width_bytes = (image.width + 7) // 8
    data = image.tobytes("raw", "1")
    if config.TSPL_INVERT:
        data = bytes(b ^ 0xFF for b in data)

    from . import stocks

    stock = stocks.current()
    header = "\r\n".join(
        [
            # TSPL wants the physical paper, not the design canvas.
            f"SIZE {stock.paper_width_mm:g} mm,{stock.paper_length_mm:g} mm",
            f"GAP {config.label_gap_mm():g} mm,0 mm",
            f"DIRECTION {config.TSPL_DIRECTION}",
            "REFERENCE 0,0",
            "CLS",
        ]
    ) + "\r\n"

    out = bytearray(header.encode("ascii"))
    out += f"BITMAP 0,0,{width_bytes},{image.height},0,".encode("ascii")
    out += data
    out += b"\r\n"
    out += b"PRINT 1,1\r\n"
    return bytes(out)


def build_payload(image: Image.Image) -> bytes:
    """Builds the byte stream for one label in the configured language."""
    if config.PRINTER_PROTOCOL == "escpos":
        return build_escpos_payload(image)
    return build_tspl_payload(image)


def _connect_rfcomm(mac: str, channel: int, timeout: float) -> socket.socket:
    sock = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
    sock.settimeout(timeout)
    try:
        sock.connect((mac, channel))
    except OSError as exc:
        sock.close()
        hint = ""
        if getattr(exc, "winerror", None) == 10064:
            hint = (
                " The printer appears to be off or out of range. If it is on, it may be "
                "busy with Labelife or a phone - these printers accept only one "
                "connection at a time."
            )
        elif getattr(exc, "winerror", None) == 10048:
            hint = " Another program on this machine already holds the connection."
        raise PrinterError(
            f"Could not connect to the printer at {mac} on RFCOMM channel {channel}: {exc}.{hint}"
            f" If the printer was re-paired, run probe_rfcomm.py to find the new channel."
        ) from exc
    return sock


def _connect_with_retry(attempts: int = 3) -> socket.socket:
    """The D520 refuses connections for a few seconds after a previous one
    closes, so a single failed connect is not conclusive."""
    last: PrinterError | None = None
    for attempt in range(1, attempts + 1):
        try:
            return _connect_rfcomm(
                config.PRINTER_MAC, config.PRINTER_RFCOMM_CHANNEL, config.PRINTER_TIMEOUT_S
            )
        except PrinterError as exc:
            last = exc
            if attempt < attempts:
                time.sleep(2.0)
    assert last is not None
    raise last


def _send_rfcomm(payload: bytes) -> None:
    sock = _connect_with_retry()
    try:
        # The printer's receive buffer is small, so the image goes out in
        # slices with a brief pause rather than one large write.
        step = 1024
        with sock:
            for i in range(0, len(payload), step):
                sock.sendall(payload[i : i + step])
                time.sleep(config.CHUNK_PAUSE_S)
            # Give the print head time to consume the buffer before the
            # socket closes, or the tail of the label is lost.
            time.sleep(1.0)
    except socket.timeout as exc:
        raise PrinterError("Timed out sending data to the printer.") from exc
    except OSError as exc:
        raise PrinterError(f"Bluetooth error while printing: {exc}") from exc


def _send_serial(payload: bytes, port: str | None = None) -> None:
    import serial  # imported lazily: only the serial transport needs it

    port = port or config.PRINTER_PORT
    try:
        link = serial.Serial(
            port=port,
            baudrate=config.PRINTER_BAUD,
            timeout=config.PRINTER_TIMEOUT_S,
            write_timeout=config.PRINTER_TIMEOUT_S,
        )
    except serial.SerialException as exc:
        raise PrinterError(f"Could not open {port}: {exc}") from exc

    try:
        with link:
            step = 1024
            for i in range(0, len(payload), step):
                link.write(payload[i : i + step])
                link.flush()
                time.sleep(config.CHUNK_PAUSE_S)
            time.sleep(1.0)
    except serial.SerialException as exc:
        raise PrinterError(f"Serial error on {port}: {exc}") from exc


def send_bytes(payload: bytes, port: str | None = None) -> None:
    """Writes a prepared payload to the printer over the configured transport."""
    if config.PRINTER_TRANSPORT == "serial" or port:
        _send_serial(payload, port=port)
    else:
        _send_rfcomm(payload)


def print_label(
    text: str,
    copies: int = 2,
    port: str | None = None,
    style=None,
) -> int:
    """Renders and prints `copies` identical labels. Returns copies printed."""
    from .render import DEFAULT_STYLE, render_label

    style = style or DEFAULT_STYLE

    if config.PRINTER_TRANSPORT == "windows" and not port:
        from . import windows_print

        try:
            windows_print.print_image(text, copies=copies, style=style)
        except windows_print.WindowsPrintError as exc:
            raise PrinterError(str(exc)) from exc
        return max(1, copies)

    image = render_label(text, style=style)
    payload = build_payload(image)
    for _ in range(max(1, copies)):
        send_bytes(payload, port=port)
        time.sleep(0.8)
    return max(1, copies)


def describe_target() -> str:
    if config.PRINTER_TRANSPORT == "windows":
        return f'windows driver "{config.WINDOWS_PRINTER_NAME}" (USB)'
    if config.PRINTER_TRANSPORT == "serial":
        return f"serial {config.PRINTER_PORT}"
    return f"bluetooth {config.PRINTER_MAC} channel {config.PRINTER_RFCOMM_CHANNEL}"


def port_available(timeout: float = 5.0) -> tuple[bool, str]:
    """Checks whether the printer accepts a connection right now.

    Deliberately short-timeout: this is called from the UI and must fail fast
    rather than hanging while the printer is busy with another connection.
    """
    if config.PRINTER_TRANSPORT == "windows":
        from . import windows_print

        return windows_print.printer_exists()

    if config.PRINTER_TRANSPORT == "serial":
        import serial

        try:
            with serial.Serial(port=config.PRINTER_PORT, baudrate=config.PRINTER_BAUD, timeout=1):
                return True, f"{config.PRINTER_PORT} is available"
        except serial.SerialException as exc:
            return False, str(exc)

    try:
        sock = _connect_rfcomm(config.PRINTER_MAC, config.PRINTER_RFCOMM_CHANNEL, timeout)
        sock.close()
        return True, f"{describe_target()} is reachable"
    except PrinterError as exc:
        return False, str(exc)


def find_channel(
    mac: str | None = None,
    channels: range = range(1, 31),
    timeout: float = 3.0,
) -> int | None:
    """Scans for an RFCOMM channel the printer will accept, for when it has
    been re-paired and the channel has moved. Slow (up to ~90s) - only call
    this when the user explicitly asks for a scan."""
    mac = mac or config.PRINTER_MAC
    for ch in channels:
        try:
            sock = _connect_rfcomm(mac, ch, timeout)
        except PrinterError:
            continue
        sock.close()
        return ch
    return None


def list_ports() -> list[dict[str, str]]:
    try:
        from serial.tools import list_ports as _lp
    except ImportError:
        return []
    return [
        {"device": p.device, "description": p.description or "", "hwid": p.hwid or ""}
        for p in _lp.comports()
    ]
