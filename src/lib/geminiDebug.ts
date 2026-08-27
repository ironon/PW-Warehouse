import { ref } from 'vue'

// Keeps the raw truth of the last few Gemini calls, so "it returned invalid
// JSON" can be looked at rather than guessed about. Nothing here is persisted
// or sent anywhere — it lives in the tab until you reload.

export interface GeminiExchange {
  id: number
  at: number
  /** 'scan' or 'agent', so the panel can say which feature made the call. */
  source: 'scan' | 'agent'
  model: string
  httpStatus: number
  /** Why the model stopped. 'MAX_TOKENS' here is the usual cause of bad JSON. */
  finishReason?: string
  /** Token counts, when the API reports them. */
  promptTokens?: number
  outputTokens?: number
  thoughtsTokens?: number
  totalTokens?: number
  /** Exactly what came back, before any parsing. */
  rawText: string
  /** How long the request took, wall clock. */
  durationMs: number
  /** Set when parsing failed, or when it only succeeded after repair. */
  parseError?: string
  repaired?: boolean
  /** The error body, when the request itself failed. */
  errorBody?: string
}

const MAX_KEPT = 10

export const exchanges = ref<GeminiExchange[]>([])

let nextId = 1

export function recordExchange(entry: Omit<GeminiExchange, 'id' | 'at'>): GeminiExchange {
  const full: GeminiExchange = { ...entry, id: nextId++, at: Date.now() }
  exchanges.value = [full, ...exchanges.value].slice(0, MAX_KEPT)
  return full
}

/** Annotates the most recent exchange once parsing has been attempted. */
export function noteParseResult(id: number, result: { error?: string; repaired?: boolean }): void {
  const found = exchanges.value.find((e) => e.id === id)
  if (!found) return
  found.parseError = result.error
  found.repaired = result.repaired
}

export function clearExchanges(): void {
  exchanges.value = []
}

/** Everything about one call as plain text, for pasting into a bug report. */
export function exchangeAsText(e: GeminiExchange): string {
  const lines = [
    `time:          ${new Date(e.at).toISOString()}`,
    `source:        ${e.source}`,
    `model:         ${e.model}`,
    `http status:   ${e.httpStatus}`,
    `finishReason:  ${e.finishReason ?? '(none)'}`,
    `duration:      ${(e.durationMs / 1000).toFixed(1)}s`,
    `tokens:        prompt=${e.promptTokens ?? '?'} output=${e.outputTokens ?? '?'} thoughts=${
      e.thoughtsTokens ?? '?'
    } total=${e.totalTokens ?? '?'}`,
    `parse error:   ${e.parseError ?? '(none)'}`,
    `repaired:      ${e.repaired ? 'yes' : 'no'}`,
    '',
    '--- raw response text ---',
    e.rawText || '(empty)',
  ]
  if (e.errorBody) lines.push('', '--- error body ---', e.errorBody)
  return lines.join('\n')
}
