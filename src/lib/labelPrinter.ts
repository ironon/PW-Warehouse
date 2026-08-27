// Client for the local label-printing backend (see backend/README.md).
// The backend runs on this laptop and talks to the D520 over Bluetooth; if
// it isn't running, label printing degrades to a clear message rather than
// blocking any inventory work.

// The backend runs on the same machine that serves this page, so its address
// is derived from wherever the page was loaded from. That way opening the app
// on a phone at http://192.168.10.83:5173 reaches the backend at
// http://192.168.10.83:8765 automatically - hardcoding 127.0.0.1 would make
// the phone call *itself*, and hardcoding a LAN IP breaks when DHCP changes.
const PRINTER_PORT = import.meta.env.VITE_LABEL_PRINTER_PORT || '8765'

function defaultBase(): string {
  if (typeof window === 'undefined') return `http://127.0.0.1:${PRINTER_PORT}`
  // Always http, never inherited from the page: the print service speaks plain
  // HTTP only, so a page served over https (or the intranet name behind a TLS
  // proxy) would silently fail every print on mixed-content blocking.
  return `http://${window.location.hostname}:${PRINTER_PORT}`
}

const BASE = (import.meta.env.VITE_LABEL_PRINTER_URL || defaultBase()).replace(/\/$/, '')

export const DEFAULT_COPIES = 2

export class PrinterUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PrinterUnavailableError'
  }
}

/** True if the backend is running. Short timeout: this is called on startup
 *  and must never delay the app. */
export async function backendReachable(timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE}/health`, { signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export interface LabelStyle {
  bold: boolean
  italic: boolean
  underline: boolean
}

export const DEFAULT_STYLE: LabelStyle = { bold: true, italic: false, underline: false }

function styleQuery(style: LabelStyle): string {
  return `bold=${style.bold}&italic=${style.italic}&underline=${style.underline}`
}

export function previewUrl(text: string, style: LabelStyle = DEFAULT_STYLE): string {
  return `${BASE}/preview.png?text=${encodeURIComponent(text)}&${styleQuery(style)}`
}

export interface LabelStock {
  id: string
  name: string
  paper_width_mm: number
  paper_length_mm: number
  rotate: number
  design_width_mm: number
  design_height_mm: number
}

export async function fetchStocks(): Promise<{ stocks: LabelStock[]; current: string }> {
  const res = await fetch(`${BASE}/stocks`)
  if (!res.ok) throw new PrinterUnavailableError(`Could not load label stocks (HTTP ${res.status}).`)
  return res.json()
}

/** Records which stock is physically loaded. Shared across the whole app. */
export async function setStock(id: string): Promise<LabelStock> {
  const res = await fetch(`${BASE}/stock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!res.ok) {
    let detail = `Could not change label stock (HTTP ${res.status}).`
    try {
      const body = await res.json()
      if (body?.detail) detail = String(body.detail)
    } catch {
      /* keep generic */
    }
    throw new PrinterUnavailableError(detail)
  }
  const body = await res.json()
  return body.stock as LabelStock
}

/** Prints `copies` identical labels. Resolves with the number printed. */
export async function printLabel(
  text: string,
  copies: number = DEFAULT_COPIES,
  style: LabelStyle = DEFAULT_STYLE
): Promise<number> {
  let res: Response
  try {
    res = await fetch(`${BASE}/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, copies, ...style }),
    })
  } catch {
    throw new PrinterUnavailableError(
      "Couldn't reach the label printer service. Start it by running " +
        'backend\\start-printer-server.bat, then try again.'
    )
  }

  if (!res.ok) {
    let detail = `Printing failed (HTTP ${res.status}).`
    try {
      const body = await res.json()
      if (body?.detail) detail = String(body.detail)
    } catch {
      /* keep the generic message */
    }
    throw new PrinterUnavailableError(detail)
  }

  const body = await res.json()
  return Number(body?.printed ?? copies)
}
