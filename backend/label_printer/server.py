"""Local HTTP bridge between the PW-Warehouse web app and the label printer.

Runs on this laptop only; the static frontend calls it at
http://127.0.0.1:8765. It is deliberately unauthenticated and bound to
loopback, matching the internal-only trust model of the rest of the app.
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import config, printer, stocks
from .render import Style, render_pdf_bytes, render_png_bytes

app = FastAPI(title="PW-Warehouse Label Printer", version="1.0.0")

_cors: dict = {
    "allow_credentials": False,
    "allow_methods": ["GET", "POST", "OPTIONS"],
    "allow_headers": ["*"],
}
if config.ALLOWED_ORIGINS:
    _cors["allow_origins"] = config.ALLOWED_ORIGINS
else:
    # Loopback plus private LAN ranges, so a phone on the same network works.
    _cors["allow_origins"] = []
    _cors["allow_origin_regex"] = config.ALLOWED_ORIGIN_REGEX

app.add_middleware(CORSMiddleware, **_cors)


class PrintRequest(BaseModel):
    text: str = Field(..., description="Label text (the container's name)")
    copies: int = Field(2, ge=1, le=50, description="How many identical labels")
    bold: bool = True
    italic: bool = False
    underline: bool = False

    def style(self) -> Style:
        return Style(bold=self.bold, italic=self.italic, underline=self.underline)


@app.get("/health")
def health() -> dict:
    """Fast liveness check. Deliberately does NOT open the serial port: on a
    Bluetooth link that takes seconds to fail, which would make the frontend
    feel broken. Use /printer/check for a real connectivity test."""
    return {
        "ok": True,
        "service": "pw-warehouse-label-printer",
        "printer": {
            "transport": config.PRINTER_TRANSPORT,
            "target": printer.describe_target(),
        },
        "label": {
            "stock": stocks.current().to_dict(),
            "width_mm": config.label_width_mm(),
            "height_mm": config.label_height_mm(),
            "width_dots": config.label_width_dots(),
            "height_dots": config.label_height_dots(),
            "dpi": config.DPI,
        },
    }


@app.get("/stocks")
def list_stocks() -> dict:
    return {
        "stocks": [s.to_dict() for s in stocks.all_stocks()],
        "current": stocks.current().id,
    }


class StockRequest(BaseModel):
    id: str = Field(..., description="Label stock id, e.g. '150x102'")


@app.post("/stock")
def set_stock(req: StockRequest) -> dict:
    """Records which stock is physically loaded in the printer."""
    try:
        stock = stocks.set_current(req.id)
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"current": stock.id, "stock": stock.to_dict()}


@app.get("/printer/check")
def printer_check() -> dict:
    # 5s cap so a busy printer can't stall the caller.
    reachable, message = printer.port_available(timeout=5.0)
    return {"reachable": reachable, "target": printer.describe_target(), "message": message}


@app.get("/ports")
def ports() -> dict:
    """Serial ports, for the fallback serial transport only."""
    return {"ports": printer.list_ports(), "configured": config.PRINTER_PORT}


@app.get("/preview.png")
def preview_png(
    text: str = "", bold: bool = True, italic: bool = False, underline: bool = False
) -> Response:
    style = Style(bold=bold, italic=italic, underline=underline)
    return Response(
        content=render_png_bytes(text, style),
        media_type="image/png",
        # The preview changes with text and style, so never let it cache.
        headers={"Cache-Control": "no-store"},
    )


@app.get("/preview.pdf")
def preview_pdf(
    text: str = "", bold: bool = True, italic: bool = False, underline: bool = False
) -> Response:
    style = Style(bold=bold, italic=italic, underline=underline)
    return Response(
        content=render_pdf_bytes(text, style),
        media_type="application/pdf",
        headers={"Content-Disposition": 'inline; filename="label.pdf"'},
    )


@app.post("/print")
def print_labels(req: PrintRequest) -> dict:
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Label text is empty.")

    try:
        sent = printer.print_label(text, copies=req.copies, style=req.style())
    except printer.PrinterError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return {
        "printed": sent,
        "text": text,
        "style": req.style().to_dict(),
        "stock": stocks.current().to_dict(),
    }


def main() -> None:
    import uvicorn

    uvicorn.run(app, host=config.HOST, port=config.PORT, log_level="info")


if __name__ == "__main__":
    main()
