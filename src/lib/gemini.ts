// Gemini vision client: given a photo of one shelf, returns which labelled
// box sits at which position on that shelf.

const API_KEY = import.meta.env.VITE_GEMINI_API_KEY
const MODEL = import.meta.env.VITE_GEMINI_MODEL || 'gemini-2.5-flash'

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
}): string {
  const { shelfId, knownLevels, knownLabels, containerTypeNames } = input

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

Return every box you can confidently place on shelf ${shelfId}.`
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    boxes: {
      type: 'array',
      items: {
        type: 'object',
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
}): Promise<ScanResponse> {
  if (!API_KEY) throw new GeminiNotConfiguredError()

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
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0,
        },
      }),
    }
  )

  const json = await res.json()
  if (!res.ok) {
    const message = json?.error?.message || res.statusText
    if (res.status === 404) {
      throw new Error(
        `Gemini model "${MODEL}" was not found. Set VITE_GEMINI_MODEL in .env.local to a vision-capable model you have access to. (${message})`
      )
    }
    throw new Error(`Gemini request failed: ${message}`)
  }

  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) {
    const reason = json?.candidates?.[0]?.finishReason
    throw new Error(`Gemini returned no result${reason ? ` (finishReason: ${reason})` : ''}.`)
  }

  let parsed: ScanResponse
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Gemini returned a response that was not valid JSON.')
  }

  return {
    boxes: Array.isArray(parsed.boxes) ? parsed.boxes : [],
    notes: parsed.notes ?? '',
  }
}
