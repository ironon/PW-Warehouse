"""Which label stock is currently loaded in the printer.

The D520's print head is ~102 mm wide, so for any stock the *shorter* of the
two dimensions is the width across the head and the longer one is the feed
length. A 150 x 102 label therefore travels through the printer 102 mm wide
and 150 mm long, which means a design meant to be read landscape has to be
rotated 90 degrees before printing.

The selection is stored on disk so the web app, the CLI and the server all
agree on what is loaded, and it survives a restart.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from pathlib import Path

STATE_FILE = Path(__file__).resolve().parent.parent / "label_stock.json"
DPI = 203


@dataclass(frozen=True)
class Stock:
    id: str
    name: str
    # Physical geometry as the paper travels through the printer.
    paper_width_mm: float  # across the print head
    paper_length_mm: float  # along the feed direction
    # Degrees the design is rotated to fit that paper. 90 means the design is
    # composed landscape and turned to print down a narrower web.
    rotate: int = 0
    gap_mm: float = 2.0

    @property
    def design_width_mm(self) -> float:
        """Width of the canvas as a person reads the label."""
        return self.paper_length_mm if self.rotate % 180 else self.paper_width_mm

    @property
    def design_height_mm(self) -> float:
        return self.paper_width_mm if self.rotate % 180 else self.paper_length_mm

    def to_dict(self) -> dict:
        d = asdict(self)
        d["design_width_mm"] = self.design_width_mm
        d["design_height_mm"] = self.design_height_mm
        return d


STOCKS: dict[str, Stock] = {
    "102x64": Stock(
        id="102x64",
        name="102 x 64 mm",
        paper_width_mm=102,
        paper_length_mm=64,
        rotate=0,
    ),
    "150x102": Stock(
        id="150x102",
        name="150 x 102 mm (landscape)",
        paper_width_mm=102,
        paper_length_mm=150,
        rotate=90,
    ),
}

DEFAULT_STOCK_ID = "150x102"

_current_id: str | None = None


def _load() -> str:
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        stock_id = data.get("current")
        if stock_id in STOCKS:
            return stock_id
    except (OSError, ValueError):
        pass
    return DEFAULT_STOCK_ID


def current() -> Stock:
    global _current_id
    if _current_id is None:
        _current_id = _load()
    return STOCKS[_current_id]


def set_current(stock_id: str) -> Stock:
    global _current_id
    if stock_id not in STOCKS:
        raise KeyError(f"Unknown label stock {stock_id!r}. Known: {', '.join(STOCKS)}")
    _current_id = stock_id
    try:
        STATE_FILE.write_text(json.dumps({"current": stock_id}, indent=2), encoding="utf-8")
    except OSError:
        # A read-only location shouldn't stop printing; the choice just won't
        # persist across restarts.
        pass
    return STOCKS[stock_id]


def all_stocks() -> list[Stock]:
    return list(STOCKS.values())


def mm_to_dots(mm: float, *, round_to_byte: bool = False) -> int:
    dots = round(mm / 25.4 * DPI)
    if round_to_byte:
        dots = ((dots + 7) // 8) * 8
    return dots
