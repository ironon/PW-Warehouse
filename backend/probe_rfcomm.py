"""Finds the RFCOMM channel the D520 accepts connections on.

The printer advertises a vendor-specific service rather than standard SPP,
so Windows never bound a usable COM port to it. Connecting a raw RFCOMM
socket sidesteps COM ports entirely - this scans the valid channel range to
find which one answers.
"""

from __future__ import annotations

import socket
import sys
import time

MAC = "60:6E:41:09:70:91"
CHANNELS = range(1, 31)
TIMEOUT_S = 4.0


def try_channel(mac: str, channel: int, timeout: float = TIMEOUT_S) -> tuple[bool, str]:
    sock = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
    sock.settimeout(timeout)
    try:
        sock.connect((mac, channel))
        return True, "connected"
    except Exception as exc:  # noqa: BLE001 - report whatever Windows says
        return False, f"{type(exc).__name__}: {exc}"
    finally:
        try:
            sock.close()
        except OSError:
            pass


def main() -> int:
    mac = sys.argv[1] if len(sys.argv) > 1 else MAC
    print(f"probing RFCOMM channels on {mac}\n")

    found: list[int] = []
    for ch in CHANNELS:
        ok, msg = try_channel(mac, ch)
        status = "OPEN" if ok else "    "
        # Only print failures that are interesting, to keep output readable.
        if ok:
            print(f"  [{status}] channel {ch:>2}  <-- accepts connections")
            found.append(ch)
        else:
            print(f"  [{status}] channel {ch:>2}  {msg}")
        time.sleep(0.15)

    print()
    if found:
        print(f"Usable channel(s): {found}")
        print(f"Set PRINTER_RFCOMM_CHANNEL={found[0]}")
        return 0
    print("No channel accepted a connection.")
    print("Check the printer is on and NOT currently connected to Labelife or a phone -")
    print("these printers usually allow only one active connection at a time.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
