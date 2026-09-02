// Working out the truss structure that holds an LED wall up.
//
// The structure is a row of L shapes standing behind the wall: a vertical leg
// zip-tied to the panels, and a foot lying on the ground pointing away from
// the audience. The whole thing has to hide behind the wall when you look at
// it head on, which is what most of the constraints here are protecting.
//
// Coordinates used throughout:
//   x  across the wall, 0 at its left edge
//   y  up from the ground
//   z  away from the audience; the wall face is z = 0, trusses live at z > 0
//
// Nothing in this file imports Vue or touches the DOM, so the solver can be
// exercised on its own.

/** Stock we own, longest first. */
export const DEFAULT_STOCK = [2.5, 2, 1.5, 1.25, 1, 0.5]

/** A universal box is a 0.3 m cube, and truss is 0.3 m square in section. */
export const UB_SIZE = 0.3

export interface TrussSpec {
  panelsWide: number
  panelsHigh: number
  /** Metres, per panel. */
  panelWidth: number
  panelHeight: number
  /** How thick a panel is front to back. Does not change the solve - the
   *  trusses sit against the back of the wall wherever that falls - but the
   *  3D view draws each panel as a real box rather than a flat tile. */
  panelDepth: number
  /** Truss lengths available, in metres. Order does not matter. */
  stock: number[]
  /** Cross-section of a truss, and the size of a universal box. */
  section: number
  /** Most the outermost leg's centre may sit in from the wall's edge. */
  maxEdgeOffset: number
  /** Most clear air allowed between two neighbouring legs. */
  maxGap: number
  /** Foot length as a fraction of the standing height. */
  footRatio: number
  /**
   * How far up the wall, in panels, between rows of connecting bars. The row
   * tying the universal boxes together is always there on top of these.
   */
  connectorEvery: number
}

export const DEFAULT_SPEC: TrussSpec = {
  panelsWide: 12,
  panelsHigh: 6,
  panelWidth: 0.5,
  panelHeight: 0.5,
  panelDepth: 0.1,
  stock: DEFAULT_STOCK,
  section: UB_SIZE,
  maxEdgeOffset: 0.7,
  maxGap: 2,
  footRatio: 1 / 3,
  connectorEvery: 5,
}

/**
 * A saved build, shared through the database so the whole crew sees the same
 * setups. Only the inputs are stored - the plan is re-solved on load, so a
 * change to the rules shows up in every saved setup rather than freezing an
 * old answer in place.
 */
export interface TrussSetup {
  id: string
  name: string
  spec: TrussSpec
  savedBy: string
  savedAt: number
}

/** Rebuilds a spec from whatever the database holds, filling in any field a
 *  setup saved by an older version of the app is missing. */
export function specFromStored(raw: unknown): TrussSpec {
  const v = (raw ?? {}) as Partial<Record<keyof TrussSpec, unknown>>
  const num = (key: keyof TrussSpec, fallback: number): number => {
    const value = Number(v[key])
    return Number.isFinite(value) ? value : fallback
  }
  // Firebase hands arrays back as objects when the keys are sparse.
  const rawStock = v.stock
  const stock = Array.isArray(rawStock)
    ? rawStock
    : rawStock && typeof rawStock === 'object'
      ? Object.values(rawStock as Record<string, unknown>)
      : []
  const lengths = stock.map(Number).filter((n) => Number.isFinite(n) && n > 0)

  return {
    panelsWide: num('panelsWide', DEFAULT_SPEC.panelsWide),
    panelsHigh: num('panelsHigh', DEFAULT_SPEC.panelsHigh),
    panelWidth: num('panelWidth', DEFAULT_SPEC.panelWidth),
    panelHeight: num('panelHeight', DEFAULT_SPEC.panelHeight),
    panelDepth: num('panelDepth', DEFAULT_SPEC.panelDepth),
    stock: lengths.length ? lengths : [...DEFAULT_STOCK],
    section: num('section', DEFAULT_SPEC.section),
    maxEdgeOffset: num('maxEdgeOffset', DEFAULT_SPEC.maxEdgeOffset),
    maxGap: num('maxGap', DEFAULT_SPEC.maxGap),
    footRatio: num('footRatio', DEFAULT_SPEC.footRatio),
    connectorEvery: num('connectorEvery', DEFAULT_SPEC.connectorEvery),
  }
}

export interface BillLine {
  kind: 'truss' | 'ub'
  /** Metres. A universal box is recorded at its 0.3 m cube size. */
  length: number
  quantity: number
  /** Plain English: what these pieces are doing. */
  usedFor: string
}

/** One row of the loading list: how many of a length to put on the truck. */
export interface StockTotal {
  kind: 'truss' | 'ub'
  length: number
  quantity: number
}

export interface LegPlan {
  /** Truss lengths stacked from the universal box upwards. */
  segments: number[]
  /** Total truss in the vertical run, not counting the box underneath it. */
  legLength: number
  /** Ground to the top of the leg, box included. This is what must stay
   *  under the top of the wall. */
  standingHeight: number
  /** One truss lying on the ground. */
  foot: number
  /** How far the foot reaches back from the wall face, box included. */
  footReach: number
  /** Wall height left over above the leg. */
  headroom: number
}

export interface ConnectorPlan {
  /** Length of each bar. Equal to the clear gap between legs. */
  length: number
  /** Centre height of each row above the ground. The first is always the row
   *  tying the universal boxes together. */
  heights: number[]
  /** Total bars: gaps x rows. */
  count: number
}

export interface TrussPlan {
  /** The spec after sanitising, which is what these numbers were solved from.
   *  Read this rather than the raw input: a half-typed field is repaired here
   *  so the rest of the app never has to cope with a NaN. */
  spec: TrussSpec
  wallWidth: number
  wallHeight: number
  leg: LegPlan
  /** Centre of each leg, measured from the wall's left edge. */
  positions: number[]
  /** Centre to centre. Zero when there is only one leg. */
  pitch: number
  /** Clear air between neighbouring legs. */
  gap: number
  /** How far in from each edge the outermost leg centres sit. */
  inset: number
  connector: ConnectorPlan | null
  /** Itemised by job, so you can see where each piece goes. */
  bill: BillLine[]
  /** The same pieces grouped by length, for loading the truck. */
  stockTotals: StockTotal[]
  totalPieces: number
  /** Metres of truss, boxes excluded. */
  totalLength: number
  /** True when nothing pokes above or beyond the wall. */
  hidden: boolean
  warnings: string[]
}

// Lengths are solved on a 1 cm lattice. Fine enough that any sensible stock
// length lands on it exactly, coarse enough that the search stays trivial.
const UNIT = 0.01

function toUnits(metres: number): number {
  return Math.round(metres / UNIT)
}

export interface Fill {
  /** What the chosen pieces actually add up to. */
  total: number
  /** Lengths chosen, longest first. */
  pieces: number[]
}

/**
 * The tallest run of stock trusses that does not exceed `limit`, using as few
 * pieces as possible.
 *
 * Height comes first and piece count second, deliberately: the leg should
 * reach as close to the top of the wall as the stock allows, and only among
 * the ways of hitting that exact height does "fewest pieces" decide. A 2.5 m
 * run comes back as one 2.5 m truss, never two 1.25 m.
 */
export function fillLength(limit: number, stock: number[]): Fill {
  const cap = Math.floor(limit / UNIT + 1e-9)
  if (cap <= 0) return { total: 0, pieces: [] }

  const usable = stock
    .filter((len) => len > 0 && toUnits(len) <= cap)
    .map((len) => ({ len, units: toUnits(len) }))
  if (usable.length === 0) return { total: 0, pieces: [] }

  const best = new Array<number>(cap + 1).fill(Infinity)
  const from = new Array<number>(cap + 1).fill(0)
  best[0] = 0

  for (let n = 1; n <= cap; n += 1) {
    for (const { units } of usable) {
      if (units > n) continue
      const candidate = best[n - units] + 1
      if (candidate < best[n]) {
        best[n] = candidate
        from[n] = units
      }
    }
  }

  let top = cap
  while (top > 0 && !Number.isFinite(best[top])) top -= 1
  if (top === 0) return { total: 0, pieces: [] }

  const pieces: number[] = []
  for (let n = top; n > 0; n -= from[n]) {
    const chosen = usable.find((u) => u.units === from[n])
    if (!chosen) break // unreachable; guards against a corrupt table
    pieces.push(chosen.len)
  }
  pieces.sort((a, b) => b - a)

  return { total: top * UNIT, pieces }
}

/** The stock length closest to `target`, preferring the longer on a tie. */
function nearestStock(target: number, stock: number[]): number {
  const sorted = [...stock].sort((a, b) => a - b)
  let best = sorted[0] ?? 0
  let bestGap = Math.abs(best - target)
  for (const len of sorted) {
    const gap = Math.abs(len - target)
    if (gap <= bestGap) {
      best = len
      bestGap = gap
    }
  }
  return best
}

function round(value: number, places = 3): number {
  const f = 10 ** places
  return Math.round(value * f) / f
}

interface Layout {
  positions: number[]
  pitch: number
  gap: number
  inset: number
  /** Length of the connecting bars, when they fit a stock length exactly. */
  barLength: number | null
}

/**
 * Where the legs stand across the wall.
 *
 * The 2 m limit is clear air between legs, so the centre-to-centre pitch it
 * allows is that plus one truss width. Every pair of legs gets tied together,
 * so the spacing is chosen first and foremost to make a stock bar fill the gap
 * exactly - nothing to cut, nothing to improvise on site. Standing the legs on
 * panel seams is the fallback, for the narrow walls where no bar reaches.
 */
function solveLayout(spec: TrussSpec, wallWidth: number): Layout {
  const maxPitch = spec.maxGap + spec.section
  // Half a truss width, so no leg pokes out past the edge of the wall and
  // becomes visible from the front.
  const minInset = spec.section / 2
  const minSpan = Math.max(0, wallWidth - 2 * spec.maxEdgeOffset)
  const maxSpan = Math.max(0, wallWidth - 2 * minInset)

  const minLegs = Math.max(2, Math.ceil(minSpan / maxPitch - 1e-9) + 1)

  const build = (count: number, span: number): Layout => {
    const inset = (wallWidth - span) / 2
    const pitch = count > 1 ? span / (count - 1) : 0
    const positions = Array.from({ length: count }, (_, i) => round(inset + i * pitch))
    return {
      positions,
      pitch: round(pitch),
      gap: round(Math.max(0, pitch - spec.section)),
      inset: round(inset),
      barLength: null,
    }
  }

  // Land on a spacing where one stock length is exactly the gap. Fewer legs
  // first, then the longest bar that still reaches wide enough.
  const byLongest = [...spec.stock].sort((a, b) => b - a)
  for (let count = minLegs; count <= minLegs + 4; count += 1) {
    for (const bar of byLongest) {
      const pitch = bar + spec.section
      if (pitch > maxPitch + 1e-9) continue
      const span = (count - 1) * pitch
      if (span < minSpan - 1e-9 || span > maxSpan + 1e-9) continue
      return { ...build(count, span), barLength: bar }
    }
  }

  // No bar reaches, so there is nothing to fit the spacing around. Stand the
  // legs on panel seams instead, where there is a frame to zip-tie to.
  const seams = seamLayout(spec, wallWidth, minLegs)
  if (seams) return seams

  // Nothing fits neatly. Spread the legs as wide as the rules allow: that
  // puts the least wall out past the end legs.
  const span = Math.min(maxSpan, (minLegs - 1) * maxPitch)
  return build(minLegs, Math.max(span, Math.min(minSpan, maxSpan)))
}

/**
 * A layout that puts every leg on a panel seam, where there is a frame to
 * zip-tie to. Widest pitch and fewest legs win; returns null when no seam
 * spacing satisfies the rules, which happens on narrow walls.
 */
function seamLayout(spec: TrussSpec, wallWidth: number, minLegs: number): Layout | null {
  if (spec.panelWidth <= 0) return null
  const maxPitch = spec.maxGap + spec.section
  const minInset = spec.section / 2
  const steps = Math.floor(maxPitch / spec.panelWidth + 1e-9)

  for (let count = minLegs; count <= minLegs + 2; count += 1) {
    for (let step = steps; step >= 1; step -= 1) {
      const pitch = round(step * spec.panelWidth)
      const span = (count - 1) * pitch
      const inset = (wallWidth - span) / 2
      if (inset < minInset - 1e-9 || inset > spec.maxEdgeOffset + 1e-9) continue
      // Both ends have to land on a seam too, not just the spacing between.
      const offSeam = Math.abs(inset / spec.panelWidth - Math.round(inset / spec.panelWidth))
      if (offSeam > 1e-6) continue
      return {
        positions: Array.from({ length: count }, (_, i) => round(inset + i * pitch)),
        pitch,
        gap: round(Math.max(0, pitch - spec.section)),
        inset: round(inset),
        barLength: null,
      }
    }
  }
  return null
}

/**
 * Repairs a spec that is mid-edit. Number inputs go briefly empty while
 * somebody is typing, which arrives here as NaN; solving from that produces a
 * blank render and an empty parts list, so every field falls back to something
 * buildable instead.
 */
function sanitize(input: TrussSpec): TrussSpec {
  const positive = (value: number, fallback: number) =>
    Number.isFinite(value) && value > 0 ? value : fallback
  const whole = (value: number, fallback: number) =>
    Number.isFinite(value) && value >= 1 ? Math.round(value) : fallback
  const stock = (Array.isArray(input.stock) ? input.stock : [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)

  // Every panel is drawn as its own box, so an absurd count would be an
  // absurd amount of geometry. A 200 panel wall is 100 m across; nothing we
  // build comes near it, and the cap keeps a typo from locking up the tab.
  const MAX_PANELS = 200

  return {
    panelsWide: Math.min(whole(input.panelsWide, 1), MAX_PANELS),
    panelsHigh: Math.min(whole(input.panelsHigh, 1), MAX_PANELS),
    panelWidth: positive(input.panelWidth, DEFAULT_SPEC.panelWidth),
    panelHeight: positive(input.panelHeight, DEFAULT_SPEC.panelHeight),
    panelDepth: positive(input.panelDepth, DEFAULT_SPEC.panelDepth),
    stock: stock.length ? stock : [...DEFAULT_STOCK],
    section: positive(input.section, DEFAULT_SPEC.section),
    // Zero is a meaningful answer here - legs hard against the wall edge - so
    // only a negative or missing value gets replaced.
    maxEdgeOffset: Number.isFinite(input.maxEdgeOffset) && input.maxEdgeOffset >= 0
      ? input.maxEdgeOffset
      : DEFAULT_SPEC.maxEdgeOffset,
    maxGap: positive(input.maxGap, DEFAULT_SPEC.maxGap),
    footRatio: positive(input.footRatio, DEFAULT_SPEC.footRatio),
    connectorEvery: whole(input.connectorEvery, DEFAULT_SPEC.connectorEvery),
  }
}

export function planTruss(raw: TrussSpec): TrussPlan {
  const spec = sanitize(raw)
  const warnings: string[] = []
  const wallWidth = round(spec.panelsWide * spec.panelWidth)
  const wallHeight = round(spec.panelsHigh * spec.panelHeight)
  const stock = [...spec.stock].sort((a, b) => b - a)
  const shortest = stock.length ? stock[stock.length - 1] : 0

  // The universal box at the elbow sits on the ground and the leg stands on
  // top of it, so it eats the first 0.3 m of the height budget.
  const legBudget = wallHeight - spec.section
  const fill = fillLength(legBudget, stock)
  const standingHeight = round(spec.section + fill.total)

  if (stock.length === 0) {
    warnings.push('No truss lengths are listed, so there is nothing to build with.')
  } else if (fill.total === 0) {
    warnings.push(
      `The wall is only ${wallHeight.toFixed(2)} m tall. A universal box plus the shortest ` +
        `truss needs ${(spec.section + shortest).toFixed(2)} m, so no leg fits behind it.`
    )
  }

  const footTarget = standingHeight * spec.footRatio
  const foot = stock.length ? nearestStock(footTarget, stock) : 0

  const leg: LegPlan = {
    segments: fill.pieces,
    legLength: round(fill.total),
    standingHeight,
    foot,
    footReach: round(spec.section + foot),
    headroom: round(wallHeight - standingHeight),
  }

  const layout = solveLayout(spec, wallWidth)
  const legs = layout.positions.length

  // Every pair of universal boxes is tied together, whatever the wall size.
  // Above that, another row every few panels of height, so a tall wall gets
  // bars stacked up the legs rather than a single tie.
  let connector: ConnectorPlan | null = null
  const tiesImpossible = legs > 1 && layout.gap > 0 && shortest > layout.gap + 1e-9

  if (legs > 1 && layout.gap > 0 && !tiesImpossible) {
    const heights = [round(spec.section / 2)]
    const step = spec.connectorEvery * spec.panelHeight
    // A row has to sit low enough that the whole bar is still on the leg.
    const ceiling = standingHeight - spec.section / 2
    const rows = spec.connectorEvery > 0 ? Math.floor(spec.panelsHigh / spec.connectorEvery) : 0

    for (let k = 1; k <= rows; k += 1) {
      // Rows want to sit at their nominal interval, but a wall that has just
      // crossed a threshold has a leg barely taller than that - so the row
      // slides down to the top of the leg rather than being dropped. That
      // also means a tall wall always gets its legs tied at the top.
      const height = round(Math.min(k * step, ceiling))
      const previous = heights[heights.length - 1]
      // Clamping can stack two rows on each other, and no row may foul the
      // one tying the boxes together.
      if (height > previous + spec.section - 1e-9) heights.push(height)
    }
    connector = { length: round(layout.gap), heights, count: (legs - 1) * heights.length }

    if (layout.barLength === null) {
      warnings.push(
        `No stock length fills the ${layout.gap.toFixed(2)} m gap between legs exactly, so the ` +
          `connecting bars have to be cut to that length.`
      )
    }
  } else if (tiesImpossible) {
    warnings.push(
      `The legs end up ${layout.gap.toFixed(2)} m apart and the shortest truss we have is ` +
        `${metres(shortest)}, so there is nothing short enough to tie the boxes together.`
    )
  }

  // Parts list, grouped by length so it reads like a loading list.
  const counts = new Map<string, BillLine>()
  const add = (kind: BillLine['kind'], length: number, quantity: number, usedFor: string) => {
    if (quantity <= 0 || length <= 0) return
    const key = `${kind}:${length}:${usedFor}`
    const existing = counts.get(key)
    if (existing) existing.quantity += quantity
    else counts.set(key, { kind, length, quantity, usedFor })
  }

  for (const segment of leg.segments) add('truss', segment, legs, 'vertical legs')
  add('truss', leg.foot, legs, 'feet')
  add('ub', spec.section, legs, 'elbows')
  if (connector) add('truss', connector.length, connector.count, 'connecting bars')

  const bill = [...counts.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'truss' ? -1 : 1
    return b.length - a.length
  })

  // What actually gets loaded into the truck: one row per length, no matter
  // what job each piece is doing once it is on site.
  const byLength = new Map<string, StockTotal>()
  for (const line of bill) {
    const key = `${line.kind}:${line.length}`
    const existing = byLength.get(key)
    if (existing) existing.quantity += line.quantity
    else byLength.set(key, { kind: line.kind, length: line.length, quantity: line.quantity })
  }
  const stockTotals = [...byLength.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'truss' ? -1 : 1
    return b.length - a.length
  })

  const totalPieces = bill.reduce((sum, line) => sum + line.quantity, 0)
  const totalLength = round(
    bill.filter((l) => l.kind === 'truss').reduce((sum, l) => sum + l.length * l.quantity, 0),
    2
  )

  const hidden =
    standingHeight <= wallHeight + 1e-9 &&
    layout.inset >= spec.section / 2 - 1e-9 &&
    fill.total > 0

  if (layout.inset > spec.maxEdgeOffset + 1e-9) {
    warnings.push(
      `The outermost legs sit ${layout.inset.toFixed(2)} m in from the edge, past the ` +
        `${spec.maxEdgeOffset.toFixed(2)} m limit. Widen the spacing rules or add a leg.`
    )
  }
  if (legs > 1 && layout.pitch < spec.section - 1e-9) {
    warnings.push(
      `The wall is too narrow for two legs: at ${layout.pitch.toFixed(2)} m apart they would ` +
        `overlap. One leg, or a wider wall, is the only thing that fits.`
    )
  }
  if (layout.gap > spec.maxGap + 1e-9) {
    warnings.push(
      `Legs end up ${layout.gap.toFixed(2)} m apart, past the ${spec.maxGap.toFixed(2)} m limit.`
    )
  }

  return {
    spec,
    wallWidth,
    wallHeight,
    leg,
    positions: layout.positions,
    pitch: layout.pitch,
    gap: layout.gap,
    inset: layout.inset,
    connector,
    bill,
    stockTotals,
    totalPieces,
    totalLength,
    hidden,
    warnings,
  }
}

// Longest stock first, so the longest truss always gets the first colour and
// the palette stays stable as long as the stock list does. Mid-saturation
// throughout: these have to stay legible against a light or a dark canvas.
const PALETTE = ['#e8663c', '#3f8ee0', '#37a86b', '#c765d6', '#e0b13c', '#58c4d4', '#d1607f', '#7d8ce8']
const UB_COLOUR = '#8a93a8'

/**
 * Colour for a given length, shared by the 3D view and the parts list so a
 * row in the list can be found in the render by its colour alone.
 */
export function lengthColor(length: number, stock: number[], kind: 'truss' | 'ub' = 'truss'): string {
  if (kind === 'ub') return UB_COLOUR
  const sorted = [...stock].sort((a, b) => b - a)
  const index = sorted.findIndex((n) => Math.abs(n - length) < 1e-9)
  // A length that is not stock - a bar cut to fit - falls off the end of the
  // palette rather than stealing another length's colour.
  return index === -1 ? UB_COLOUR : PALETTE[index % PALETTE.length]
}

/** "2.5 m", "0.5 m" - one place unless the value needs two. */
export function metres(value: number): string {
  const fixed = Math.abs(value * 100 - Math.round(value * 10) * 10) < 1e-6 ? 1 : 2
  return `${value.toFixed(fixed)} m`
}
