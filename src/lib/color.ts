// Picks black or white text for readability against a hex background color.
export function readableTextColor(hex: string): string | undefined {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return undefined
  const full = match[1].length === 3
    ? match[1].split('').map((c) => c + c).join('')
    : match[1]
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  // Perceived brightness (YIQ) — closer to white than black above the midpoint.
  const brightness = (r * 299 + g * 587 + b * 114) / 1000
  return brightness > 127.5 ? '#000000' : '#ffffff'
}
