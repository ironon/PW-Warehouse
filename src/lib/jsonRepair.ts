// Salvaging a JSON response that didn't arrive intact.
//
// With responseSchema set, Gemini's output is generated against a grammar, so
// it does not emit malformed JSON of its own accord — quotes inside strings
// come back correctly escaped. What it does do is stop early, when thinking
// plus output runs into the token ceiling, and a response cut off mid-array is
// not parseable. That is what this recovers: the operations that did arrive,
// rather than throwing the whole reply away.

export interface LooseParse<T> {
  ok: boolean
  value?: T
  /** True when the text only parsed after being repaired. */
  repaired: boolean
  error?: string
}

/** Some models wrap JSON in a markdown fence even when asked not to. */
function stripFence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
}

/**
 * Closes a truncated JSON document: drops a dangling partial token, closes an
 * unterminated string, then closes whatever brackets are still open. Structure
 * is tracked by an actual scan rather than by counting characters, so braces
 * inside string values don't throw the count off.
 */
function closeTruncated(text: string): string | null {
  const stack: string[] = []
  let inString = false
  let escaped = false
  // Where the value currently being written started, so a half-finished one
  // can be dropped rather than guessed at.
  let lastSafe = -1

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]

    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }

    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']')
    else if (ch === '}' || ch === ']') stack.pop()
    else if (ch === ',') lastSafe = i
  }

  if (stack.length === 0) return null

  let out = text
  if (inString) {
    // Mid-string: everything after the last complete element is unusable.
    if (lastSafe >= 0) {
      out = text.slice(0, lastSafe)
      // Recompute what is still open now that the tail is gone.
      return closeTruncated(out) ?? out
    }
    out += '"'
  } else {
    // Trim a trailing comma or a half-written key, both of which are invalid.
    out = out.replace(/,\s*$/, '')
    if (/[:,]\s*$/.test(out) && lastSafe >= 0) out = text.slice(0, lastSafe)
  }

  for (let i = stack.length - 1; i >= 0; i -= 1) out += stack[i]
  return out
}

export function parseLooseJson<T>(text: string): LooseParse<T> {
  const cleaned = stripFence(text)
  if (!cleaned) return { ok: false, repaired: false, error: 'The response was empty.' }

  try {
    return { ok: true, value: JSON.parse(cleaned) as T, repaired: false }
  } catch (first) {
    const firstMessage = first instanceof Error ? first.message : String(first)
    const closed = closeTruncated(cleaned)
    if (closed) {
      try {
        return { ok: true, value: JSON.parse(closed) as T, repaired: true }
      } catch {
        /* fall through to reporting the original failure */
      }
    }
    return { ok: false, repaired: false, error: firstMessage }
  }
}
