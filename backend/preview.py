"""Renders sample labels to PNG so the layout can be checked without printing.

    python preview.py                 # a spread of real warehouse labels
    python preview.py "Custom text"   # one specific label
"""

import sys
from pathlib import Path

from label_printer import config
from label_printer.render import render_label

SAMPLES = [
    "Ribbon Data Cables >39 in",
    "TV Mount Accessories",
    "M5 Screws",
    "Unterminated power cables (from Whole Word Church)",
    "Fixed Installation PS-PS Short Power Cable #1",
    "Zip Ties/Straps / Rubber Bands",
    "Supercalifragilisticexpialidociousness",
]


def main() -> None:
    out_dir = Path(__file__).parent / "preview_out"
    out_dir.mkdir(exist_ok=True)

    texts = sys.argv[1:] or SAMPLES
    from label_printer import stocks

    print(f"stock: {stocks.current().name} @ {config.DPI}dpi "
          f"-> design {config.label_width_dots()}x{config.label_height_dots()} dots")

    for i, text in enumerate(texts, 1):
        image = render_label(text)
        safe = "".join(c if c.isalnum() else "_" for c in text)[:40]
        path = out_dir / f"{i:02d}_{safe}.png"
        image.save(path)
        print(f"  {image.size}  {path.name}")


if __name__ == "__main__":
    main()
