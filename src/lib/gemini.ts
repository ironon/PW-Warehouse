// Gemini vision client: given a photo of one shelf, returns which labelled
// box sits at which position on that shelf.

import { parseLooseJson } from './jsonRepair'
import { recordExchange, noteParseResult } from './geminiDebug'

const API_KEY = import.meta.env.VITE_GEMINI_API_KEY
// gemini-2.5-* is retired for keys issued after its cutoff: generateContent
// answers 404 "no longer available to new users" even though ListModels still
// advertises it. 3.6-flash is the replacement the API itself names.
const MODEL = import.meta.env.VITE_GEMINI_MODEL || 'gemini-3.6-flash'

// Thinking tokens share the output budget with the answer, so an unset ceiling
// gets a shelf full of boxes cut off partway through the JSON. See aiAgent.ts.
const MAX_OUTPUT_TOKENS = Number(import.meta.env.VITE_GEMINI_SCAN_MAX_TOKENS || 8192)
const THINKING_LEVEL = import.meta.env.VITE_GEMINI_THINKING_LEVEL || 'low'

export class GeminiNotConfiguredError extends Error {
  constructor() {
    super(
      'No Gemini API key set. Create one at https://aistudio.google.com/apikey, ' +
        'then set VITE_GEMINI_API_KEY in .env.local and restart the dev server.'
    )
  }
}

export function isGeminiConfigured(): boolean {
  return Boolean(API_KEY)
}

export interface ScannedBox {
  label: string
  level: string
  column: string
  containerType: string
  confidence: 'high' | 'medium' | 'low'
}

export interface ScanResponse {
  boxes: ScannedBox[]
  notes: string
  /** True when the reading is partial — see the note in `notes`. */
  truncated?: boolean
}

/**
 * Shrinks a photo before upload: phone cameras produce 5–12MB images, which
 * are slow to send and can exceed the inline-data request limit. 1600px on
 * the long edge keeps label text readable while cutting size by ~10x.
 */
export async function fileToScaledJpegBase64(file: File, maxEdge = 1600): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not process the image (no canvas context).')
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
  return dataUrl.slice(dataUrl.indexOf(',') + 1)
}

function buildPrompt(input: {
  shelfId: string
  knownLevels: string[]
  knownLabels: string[]
  containerTypeNames: string[]
  extraInstructions?: string
}): string {
  const { shelfId, knownLevels, knownLabels, containerTypeNames } = input
  const extra = (input.extraInstructions ?? '').trim()

  return `You are reading a photograph of a single warehouse shelving unit in order to record where each labelled box currently sits.

THE SHELF IN THIS PHOTO IS: ${shelfId}

## Position format

Every position is written as ${shelfId}-LEVEL-COLUMN.

LEVEL is the horizontal tier, identified by these codes:
- T = the top tier
- L = the lowest/bottom tier
- M = a middle tier, when the shelf has only ONE middle tier
- M1, M2, M3... = middle tiers when the shelf has SEVERAL. M1 is always the tier directly above L, M2 is directly above M1, M3 above M2, and so on going upward.

The levels already recorded on shelf ${shelfId} are: ${knownLevels.length ? knownLevels.join(', ') : '(none recorded yet)'}.
Use these same level codes. In particular, if this shelf uses M1/M2/M3, never answer plain "M"; if it uses plain "M", never answer "M1".

COLUMN is the vertical bay, lettered A, B, C, D, E, F, G, H, I running LEFT to RIGHT as you face the shelf. One letter spans roughly two shelf uprights, so it is normal and expected for SEVERAL boxes to share the same level and column. Do not force boxes into different columns just to make them unique.

## Critical scoping rule

Report ONLY boxes that are physically on shelf ${shelfId}. Photographs often catch neighbouring shelving units at the edges of the frame, partly cropped or at an angle. Ignore every box that belongs to a different shelving unit. If you are unsure whether a box is on ${shelfId} or on a neighbouring unit, leave it out entirely. Omitting a box is much safer than assigning it to the wrong shelf.

## Labels

Read the text label on each box. These labels already exist in the inventory:
${knownLabels.map((l) => `- ${l}`).join('\n') || '(none yet)'}

If a box's label matches one of the above, reply with that EXACT text, character for character, so it can be matched to the existing record. Only invent new label text when the box genuinely is not in the list above. Do not guess a label you cannot actually read — omit the box instead.

## Container type

Judging by the box's physical appearance in the photo, classify each box as one of these container types:
${containerTypeNames.map((n) => `- ${n}`).join('\n') || '(none defined)'}
If you cannot tell from the photo, or none fit, use an empty string.

## Confidence

Mark confidence "high" only when both the label text and the position are unambiguous. Use "medium" when the position is clear but the text is partly obscured, and "low" when you are guessing.

Return every box you can confidently place on shelf ${shelfId}.${
    extra
      ? `

## Extra instructions for this photo

The person who took this photo added the following. It describes this
particular shelf or photo, so it takes precedence over the general guidance
above wherever the two disagree - except for the scoping rule, which always
holds: never report a box that is not on ${shelfId}.

${extra}`
      : ''
  }`
}

// `boxes` is generated before `notes` on purpose. Structured output follows
// schema order, and a free-text field placed first can swallow the whole
// output budget - on the planning call the same mistake produced replies with
// zero results in them. Keep the data first and the prose last.
const RESPONSE_SCHEMA = {
  type: 'object',
  propertyOrdering: ['boxes', 'notes'],
  properties: {
    boxes: {
      type: 'array',
      items: {
        type: 'object',
        propertyOrdering: ['label', 'level', 'column', 'containerType', 'confidence'],
        properties: {
          label: { type: 'string' },
          level: { type: 'string' },
          column: { type: 'string' },
          containerType: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['label', 'level', 'column', 'confidence'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['boxes'],
}

export async function scanShelf(input: {
  imageBase64: string
  shelfId: string
  knownLevels: string[]
  knownLabels: string[]
  containerTypeNames: string[]
  /** Free-text notes from whoever took the photo, appended to the prompt. */
  extraInstructions?: string
}): Promise<ScanResponse> {
  if (!API_KEY) throw new GeminiNotConfiguredError()

  const generationConfig: Record<string, unknown> = {
    responseMimeType: 'application/json',
    responseSchema: RESPONSE_SCHEMA,
    temperature: 0,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  }
  if (THINKING_LEVEL && THINKING_LEVEL !== 'off') {
    generationConfig.thinkingConfig = { thinkingLevel: THINKING_LEVEL }
  }

  const startedAt = Date.now()
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: buildPrompt(input) },
              { inline_data: { mime_type: 'image/jpeg', data: input.imageBase64 } },
            ],
          },
        ],
        generationConfig,
      }),
    }
  )

  const json = await res.json()
  const durationMs = Date.now() - startedAt
  const candidate = json?.candidates?.[0]
  const usage = json?.usageMetadata
  const rawText: string =
    candidate?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? ''

  const debug = recordExchange({
    source: 'scan',
    model: MODEL,
    httpStatus: res.status,
    finishReason: candidate?.finishReason,
    promptTokens: usage?.promptTokenCount,
    outputTokens: usage?.candidatesTokenCount,
    thoughtsTokens: usage?.thoughtsTokenCount,
    totalTokens: usage?.totalTokenCount,
    rawText,
    durationMs,
    errorBody: res.ok ? undefined : JSON.stringify(json?.error ?? json, null, 2),
  })

  if (!res.ok) {
    const message = json?.error?.message || res.statusText
    if (res.status === 404) {
      throw new Error(
        `Gemini model "${MODEL}" isn't available to this API key. Google retires older model names for newly issued keys, and its own message usually names the replacement: ${message}. Set VITE_GEMINI_MODEL in .env.local and rebuild.`
      )
    }
    if (res.status === 429) {
      // Two very different things share this status. Saying "try again later"
      // for a depleted account sends people in circles.
      const credits = /credit/i.test(message)
      throw new Error(
        credits
          ? `The Gemini project has no credits left, so nothing can run. Top it up at https://ai.studio/projects (Billing). Google's message: ${message}`
          : `Gemini is rate limiting "${MODEL}". Wait a moment and try again. (${message})`
      )
    }
    throw new Error(`Gemini request failed: ${message}`)
  }

  const reason: string | undefined = candidate?.finishReason
  const ranOut = reason === 'MAX_TOKENS'
  const outOfRoom =
    `Gemini hit its output limit before it finished reading the shelf${
      usage?.thoughtsTokenCount ? ` — it spent ${usage.thoughtsTokenCount} tokens thinking first` : ''
    }. Raise VITE_GEMINI_SCAN_MAX_TOKENS (currently ${MAX_OUTPUT_TOKENS}) in .env.local, or set ` +
    'VITE_GEMINI_THINKING_LEVEL=low. Open Debug for the details.'

  if (!rawText) {
    noteParseResult(debug.id, { error: 'empty response' })
    if (ranOut) throw new Error(outOfRoom)
    throw new Error(
      `Gemini returned no result${reason ? ` (finishReason: ${reason})` : ''}. Open Debug to see the raw response.`
    )
  }

  const parsed = parseLooseJson<ScanResponse>(rawText)
  noteParseResult(debug.id, { error: parsed.error, repaired: parsed.repaired })

  if (!parsed.ok || !parsed.value) {
    if (ranOut) throw new Error(outOfRoom)
    throw new Error(
      `Gemini's answer wasn't valid JSON (${parsed.error}). Open Debug to see exactly what came back.`
    )
  }

  const boxes = Array.isArray(parsed.value.boxes) ? parsed.value.boxes : []
  // A repaired response is a partial reading of the shelf. Every box it didn't
  // reach would otherwise be proposed for the trash, so this has to be loud.
  const note = parsed.repaired
    ? `The response was cut short, so only ${boxes.length} box${
        boxes.length === 1 ? '' : 'es'
      } were read. Boxes further along the shelf are missing — do NOT apply the "not seen" trash proposals from this scan.`
    : ''

  return {
    boxes,
    notes: [parsed.value.notes ?? '', note].filter(Boolean).join(' '),
    truncated: parsed.repaired,
  }
}
