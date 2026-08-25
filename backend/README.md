# Label printing backend

Prints container labels to a **Phomemo D520BT** thermal label printer over
Bluetooth. Runs locally on this laptop; the PW-Warehouse web app calls it at
`http://127.0.0.1:8765`.

## Running it

Double-click **`start-printer-server.bat`** (it creates the virtual
environment and installs dependencies on first run), and leave the window
open while you're using label printing. Without it, the app still works
normally — only printing is unavailable, and it says so clearly.

## How it connects — USB via the vendor driver

**This is the path that works.** The printer is connected over USB and
installed as the Windows printer **"D520 Printer"**. Labels are rendered to a
bitmap and printed through that driver, so *Phomemo's own driver* generates
whatever command language the hardware wants. We never have to guess it.

The driver reports 203 dpi. Its DEVMODE is overridden per job to the loaded
stock's paper size — without that it defaults to 4 × 6 in and every label
feeds six inches.

### Why not Bluetooth

Bluetooth was tried first and abandoned. Recorded here because the failure
modes are genuinely misleading:

- The D520 advertises a **vendor-specific RFCOMM service**
  (`E5B152ED-6B46-09E9-4678-665E9A972CBC`, which Windows labels "WeChat"),
  not standard SPP, so Windows never binds a usable COM port to it.
- A `COM4` does exist carrying the printer's MAC, but it is a leftover from an
  earlier Bluetooth radio — its instance is on radio `7&2906BAE7` while the
  printer's device node is on `7&8C82AFD`. Opening it fails with
  `WinError 52 "a duplicate name exists on the network"`, which reads as if
  the printer were switched off even while it prints happily from Labelife.
- A raw RFCOMM socket to channel 23 *does* connect and accepts every byte —
  and prints nothing, because the payload language was wrong (see below).
- The link only accepts one connection at a time and goes to sleep, so
  connection attempts fail intermittently for reasons unrelated to the code.

The Bluetooth transports are still in the code (`PRINTER_TRANSPORT=rfcomm`
or `serial`) but are not the supported path.

This matters, because the obvious approach does not work here. The D520
advertises a *vendor-specific* RFCOMM service — UUID
`E5B152ED-6B46-09E9-4678-665E9A972CBC`, which Windows displays under the name
"WeChat" — rather than standard Serial Port Profile. Windows therefore never
binds a working serial port to it. There *is* a `COM4` on this machine whose
device id contains the printer's MAC, but it is a leftover from an earlier
Bluetooth radio: its instance sits on radio `7&2906BAE7` while the printer's
own device node is on `7&8C82AFD`. Opening it fails with a misleading
`WinError 52 "a duplicate name exists on the network"`, which reads like the
printer is switched off even when it is happily printing from Labelife.

Python's `socket.AF_BLUETOOTH` / `BTPROTO_RFCOMM` connects straight to the
printer and sidesteps all of that.


## Printing protocol — TSPL2, not ESC/POS

**This is the thing that is easy to get wrong.** Phomemo sells two families
that speak different languages:

- **Pocket printers** (M02, M110, M220) — ESC/POS raster (`GS v 0`).
- **Shipping-label printers** (D520, PM-241, PM-246S, PM-249) — **TSPL2/EPL2**.

The D520 is in the second group. Sending it ESC/POS raster is quietly
accepted over Bluetooth — the socket takes every byte and reports success —
and **prints absolutely nothing**. There is no error to tell you the language
is wrong, which makes this failure very easy to misdiagnose as a connection
problem.

The payload sent for each label:

```
SIZE 102 mm,64 mm
GAP 2 mm,0 mm
DIRECTION 1
REFERENCE 0,0
CLS
BITMAP 0,0,102,511,0,<52122 bytes of packed bitmap>
PRINT 1,1
```

`BITMAP` takes width in **bytes** (102) and height in **dots** (511). TSPL
treats a **0 bit as a black dot**, which is exactly how Pillow packs mode
`"1"`, so unlike ESC/POS the data needs no inversion. If output ever comes
out as white-on-black, set `TSPL_INVERT=1`.

Data goes out in 1 KB slices with a short pause, because the printer's
receive buffer is small and drops data on one large write.

The ESC/POS builder is kept for reference and reachable with
`PRINTER_PROTOCOL=escpos`. `verify_raster.py` self-checks both.

## Label stock and rotation

The print head is ~102 mm wide, so for any roll the **shorter** dimension is
the width across the head and the **longer** one is the feed length. That has
a consequence worth understanding:

| Stock | Paper through the printer | Design canvas | Rotation |
| --- | --- | --- | --- |
| `102x64` | 102 mm wide × 64 mm long | 102 × 64 mm | none |
| `150x102` | 102 mm wide × **150 mm long** | **150 × 102 mm** | **90°** |

A 150 × 102 label is read landscape, but it travels through the printer
102 mm wide. So the design is composed landscape at 150 × 102 mm and then
rotated 90° to print down the narrower web. `stocks.py` holds this mapping;
`Stock.design_width_mm` / `design_height_mm` give the canvas as a person
reads it, while `paper_width_mm` / `paper_length_mm` give the physical feed.

Which roll is loaded is stored in `label_stock.json` and changed from the web
app's sidebar (or the print dialog). It lives on the backend rather than in
the browser because it describes one shared piece of hardware — the CLI, the
server and every browser must agree on it.

Labels carry the container **name only**, set in Segoe UI Bold as large as
will fit, wrapped and centred. Nothing position-dependent is printed, so a
label stays correct after a box moves shelves.

### Text styles

The app's **Print Label** tab prints arbitrary text with bold / italic /
underline and a quantity. Each combination maps to a real Segoe UI face
rather than being synthesised:

| Style | Font file |
| --- | --- |
| regular | `segoeui.ttf` |
| bold | `segoeuib.ttf` |
| italic | `segoeuii.ttf` |
| bold italic | `segoeuiz.ttf` |

Underline has no font file, so it is drawn as a rule below each baseline,
scaled with the type size. The auto-fit loop reserves headroom for it, or the
rule on the last line would clip against the bottom margin.

### Right-edge clipping

The driver reports a printable width a little wider than what physically
lands on the label, so content at the far right gets cut off. The drawn area
is pulled in by `PRINT_RIGHT_INSET_DOTS` (default 12) to compensate. Increase
it if the right edge is still clipped; decrease it to reclaim width.

## Command line

```bash
python printlabel.py --check              # can the printer be reached? (fast)
python printlabel.py --check --scan       # ...and hunt for a moved channel (~90s)
python printlabel.py --test               # print a diagnostic alignment label
python printlabel.py --test --dry-run     # ...render it to PNG instead
python printlabel.py "M5 Screws"          # print 2 labels
python printlabel.py "M5 Screws" --copies 1
python preview.py                         # render sample labels to preview_out/
python verify_raster.py                   # self-check the wire format
```

Run these from `backend/` using `.venv\Scripts\python.exe`.

## Reading the diagnostic label

`python printlabel.py --test` prints a label with a border at the full
816 × 511 extent, corner ticks, and centre marks on the top and bottom edges,
so one print reveals any geometry problem:

- **Border complete, centre ticks centred** → geometry is right, nothing more to do.
- **Clipped on one side** → the print head is offset; set `PRINT_X_OFFSET_DOTS`
  (positive shifts right, negative left).
- **Squashed or stretched vertically** → the label size is wrong; check
  `LABEL_HEIGHT_MM` matches the stock.
- **Nothing prints, or garbage** → the D520 likely wants a different raster
  dialect. Say so and it can be adjusted; the command bytes are all in
  `label_printer/printer.py`.

## Configuration

Every setting in `label_printer/config.py` can be overridden with an
environment variable of the same name. The ones most likely to matter:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PRINTER_MAC` | `60:6E:41:09:70:91` | Printer's Bluetooth address |
| `PRINTER_RFCOMM_CHANNEL` | `23` | RFCOMM channel |
| `PRINTER_TRANSPORT` | `rfcomm` | `rfcomm` or `serial` (COM-port fallback) |
| `PRINTER_PROTOCOL` | `tspl` | `tspl` (D520) or `escpos` (M02/M110) |
| `LABEL_GAP_MM` | `2` | Gap between die-cut labels; `0` for continuous |
| `TSPL_DIRECTION` | `1` | Flip if labels print upside down |
| `TSPL_INVERT` | `0` | Set `1` if output is white-on-black |
| `PRINT_X_OFFSET_DOTS` | `0` | Nudge output left/right |
| `LABEL_WIDTH_MM` / `LABEL_HEIGHT_MM` | `102` / `64` | Stock size |
| `LABEL_FONT_PATH` | `C:\Windows\Fonts\segoeuib.ttf` | Segoe UI Bold |
| `LABEL_SERVER_PORT` | `8765` | HTTP port |
| `RASTER_CHUNK_LINES` | `128` | Rows per raster block |

## HTTP API

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness, current stock, and label geometry. |
| `GET /stocks` | Available label stocks and which one is loaded. |
| `POST /stock` | `{"id": "150x102"}` → records the loaded stock. |
| `GET /printer/check` | Confirms the printer is installed/reachable. |
| `GET /ports` | Serial ports (only relevant to the serial fallback). |
| `GET /preview.png?text=…` | Rendered label as a PNG. |
| `GET /preview.pdf?text=…` | Same label as a physically-sized PDF. |
| `POST /print` | `{"text": "...", "copies": 2}` → prints. |

Bound to loopback and unauthenticated, matching the internal-only trust
model of the rest of the app.
