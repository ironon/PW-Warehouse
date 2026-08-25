"""Renders a container label to a 1-bit image sized for the loaded stock.

The label carries the container name only, set as large as it will fit, so
it stays readable from across the warehouse. Nothing position-dependent is
printed, which means a label stays correct after a box is moved.
"""

from __future__ import annotations

from dataclasses import dataclass

from PIL import Image, ImageDraw, ImageFont

from . import config


@dataclass(frozen=True)
class Style:
    """Typeface options for a label. Container labels use the default."""

    bold: bool = True
    italic: bool = False
    underline: bool = False

    def to_dict(self) -> dict:
        return {"bold": self.bold, "italic": self.italic, "underline": self.underline}


DEFAULT_STYLE = Style()


def _load_font(size: int, style: Style = DEFAULT_STYLE) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(config.font_path(style.bold, style.italic), size)
    except OSError:
        # Fall back to the default face rather than failing the whole print.
        return ImageFont.truetype(config.FONT_PATH, size)


def _wrap(text: str, font: ImageFont.FreeTypeFont, draw: ImageDraw.ImageDraw, max_width: int) -> list[str]:
    """Greedy word wrap, splitting any single word too long for a line."""
    def width_of(s: str) -> int:
        return int(draw.textlength(s, font=font))

    lines: list[str] = []
    for paragraph in text.splitlines() or [""]:
        words = paragraph.split()
        if not words:
            lines.append("")
            continue
        current = ""
        for word in words:
            candidate = f"{current} {word}".strip()
            if width_of(candidate) <= max_width:
                current = candidate
                continue
            if current:
                lines.append(current)
            # A single word wider than the line gets hard-split.
            if width_of(word) > max_width:
                piece = ""
                for ch in word:
                    if width_of(piece + ch) <= max_width:
                        piece += ch
                    else:
                        if piece:
                            lines.append(piece)
                        piece = ch
                current = piece
            else:
                current = word
        if current:
            lines.append(current)
    return lines


def _measure(lines: list[str], font: ImageFont.FreeTypeFont, draw: ImageDraw.ImageDraw) -> tuple[int, int, int]:
    """Returns (width, height, line_height) for a block of wrapped lines."""
    ascent, descent = font.getmetrics()
    line_height = int((ascent + descent) * 1.12)
    width = 0
    for line in lines:
        width = max(width, int(draw.textlength(line, font=font)))
    return width, line_height * len(lines), line_height


def render_label(
    text: str,
    width: int | None = None,
    height: int | None = None,
    style: Style = DEFAULT_STYLE,
) -> Image.Image:
    """Renders `text` centred and as large as fits. Returns a 1-bit image.

    `width`/`height` override the configured label geometry, which the
    Windows driver path uses to match the printer's exact printable area.
    """
    label = (text or "").strip() or "(no label)"

    width = width or config.label_width_dots()
    height = height or config.label_height_dots()
    max_width = width - 2 * config.MARGIN_DOTS
    max_height = height - 2 * config.MARGIN_DOTS

    image = Image.new("L", (width, height), 255)
    draw = ImageDraw.Draw(image)

    # Largest size that fits both dimensions. Sizes are tried downward; the
    # search is cheap enough at this range that a linear scan is fine and
    # avoids binary-search edge cases where wrapping changes non-monotonically.
    chosen_lines: list[str] = [label]
    chosen_font = _load_font(config.MIN_FONT_SIZE, style)
    chosen_line_height = 0

    for size in range(config.MAX_FONT_SIZE, config.MIN_FONT_SIZE - 1, -2):
        font = _load_font(size, style)
        lines = _wrap(label, font, draw, max_width)
        block_w, block_h, line_height = _measure(lines, font, draw)
        # An underline hangs below the last baseline, so it needs its own
        # headroom or the rule clips against the bottom margin.
        needed_h = block_h + (round(size * 0.15) if style.underline else 0)
        if block_w <= max_width and needed_h <= max_height:
            chosen_lines, chosen_font, chosen_line_height = lines, font, line_height
            break
    else:
        # Even the smallest size overflows; keep the minimum and let it clip.
        chosen_font = _load_font(config.MIN_FONT_SIZE, style)
        chosen_lines = _wrap(label, chosen_font, draw, max_width)
        _, _, chosen_line_height = _measure(chosen_lines, chosen_font, draw)

    total_h = chosen_line_height * len(chosen_lines)
    y = (height - total_h) // 2

    ascent, _ = chosen_font.getmetrics()
    rule = max(2, round(chosen_font.size * 0.06))

    for line in chosen_lines:
        line_w = int(draw.textlength(line, font=chosen_font))
        x = (width - line_w) // 2
        draw.text((x, y), line, font=chosen_font, fill=0)
        if style.underline and line.strip():
            # Sit the rule just below the baseline, scaled with the type size.
            uy = y + ascent + max(2, round(chosen_font.size * 0.08))
            draw.rectangle([x, uy, x + line_w, uy + rule - 1], fill=0)
        y += chosen_line_height

    # Fixed threshold rather than dithering: thermal heads reproduce solid
    # black far more cleanly than a halftone pattern, and this is pure text.
    return image.point(lambda v: 0 if v < 128 else 255, mode="1")


def render_png_bytes(text: str, style: Style = DEFAULT_STYLE) -> bytes:
    import io

    buf = io.BytesIO()
    render_label(text, style=style).save(buf, format="PNG")
    return buf.getvalue()


def render_pdf_bytes(text: str, style: Style = DEFAULT_STYLE) -> bytes:
    """PDF at the true physical size, for previewing or manual printing."""
    import io

    buf = io.BytesIO()
    # Saving as 1-bit yields a CCITT-style PDF some viewers dislike, so the
    # PDF copy goes out as greyscale.
    render_label(text, style=style).convert("L").save(
        buf, format="PDF", resolution=float(config.DPI)
    )
    return buf.getvalue()
