// Name matching for the "you may be about to create a duplicate" checks on
// every Add form.
//
// Two jobs, and they want different rules:
//   - Exact: is this the same name as something that already exists? Compared
//     the same way the shelf scanner compares labels, so what counts as a
//     duplicate here is what counts as a duplicate there.
//   - Similar: what should I show while someone is still typing? That has to
//     tolerate prefixes ("m5 scr"), word order, and typos.

/** Same comparison the scanner uses for labels: case- and spacing-blind. */
export function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function trigrams(value: string): Set<string> {
  // Padding makes the start and end of a string count, so "screw" and "crews"
  // don't look identical.
  const padded = `  ${value} `
  const out = new Set<string>()
  for (let i = 0; i < padded.length - 2; i += 1) out.add(padded.slice(i, i + 3))
  return out
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  return (2 * shared) / (a.size + b.size)
}

/**
 * 0..1. Exact is 1; a candidate that starts with what's been typed so far
 * scores just under, because that is overwhelmingly the case that matters
 * mid-typing; then containment either way; then fuzzy overlap for typos.
 */
export function similarity(query: string, candidate: string): number {
  const q = normalizeName(query)
  const c = normalizeName(candidate)
  if (!q || !c) return 0
  if (q === c) return 1
  if (c.startsWith(q)) return 0.95
  if (c.includes(q) || q.includes(c)) return 0.85
  return dice(trigrams(q), trigrams(c))
}

export interface NameCandidate {
  id: string
  name: string
  /** Shown beside the name — a location, say. */
  detail?: string
}

export interface NameMatch extends NameCandidate {
  score: number
}

export interface NameMatchResult {
  /** Same name as something that exists. Creating would make a duplicate. */
  exact: NameMatch[]
  /** Close but not the same — worth a look before committing. */
  similar: NameMatch[]
}

/** Below this, a single character typed would drag in half the warehouse. */
const MIN_QUERY_LENGTH = 2
const SIMILAR_THRESHOLD = 0.45
const SIMILAR_LIMIT = 6

export function matchNames(
  query: string,
  candidates: readonly NameCandidate[],
  options: { limit?: number; threshold?: number } = {}
): NameMatchResult {
  const q = normalizeName(query)
  if (!q) return { exact: [], similar: [] }

  const limit = options.limit ?? SIMILAR_LIMIT
  const threshold = options.threshold ?? SIMILAR_THRESHOLD

  const exact: NameMatch[] = []
  const similar: NameMatch[] = []

  for (const candidate of candidates) {
    const score = similarity(q, candidate.name)
    if (score === 1) exact.push({ ...candidate, score })
    else if (q.length >= MIN_QUERY_LENGTH && score >= threshold) {
      similar.push({ ...candidate, score })
    }
  }

  similar.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  return { exact, similar: similar.slice(0, limit) }
}
