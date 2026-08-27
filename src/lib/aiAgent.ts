// Gemini client for the AI Work tab: a conversation about the warehouse that
// can end in a plan of concrete changes.
//
// Unlike the shelf scanner this is text-only and multi-turn. The whole
// inventory is small enough (a few hundred containers) to hand over in every
// request, which keeps the agent stateless and means it can answer questions
// like "which boxes should be merged?" without a retrieval step. If the
// warehouse ever grows past a few thousand containers this is the thing to
// revisit first.

import type { DeepReadonly } from 'vue'
import type { AgentOperation } from '../store/warehouse'
import type { Container, ContainerType, Item, ItemStack } from './types'
import { parseLooseJson } from './jsonRepair'
import { recordExchange, noteParseResult } from './geminiDebug'

const API_KEY = import.meta.env.VITE_GEMINI_API_KEY
// Planning is a reasoning job rather than an OCR one, so this is worth
// pointing at a stronger model than the scanner uses. It is separate from
// VITE_GEMINI_MODEL for exactly that reason. gemini-3.1-pro-preview is the
// upgrade to try; the default stays on flash because it is not a preview.
const MODEL = import.meta.env.VITE_GEMINI_PLANNING_MODEL || 'gemini-3.6-flash'

// Gemini 3.x models think before answering, and those thinking tokens come out
// of the SAME output budget as the answer. Left at the default, a plan of any
// size gets cut off mid-JSON: the request is slow (all that thinking) and the
// response is unparseable (it stopped partway). Both symptoms, one cause. So
// the ceiling is set explicitly and generously.
const MAX_OUTPUT_TOKENS = Number(import.meta.env.VITE_GEMINI_PLANNING_MAX_TOKENS || 16384)

// Thinking tokens are billed and waited on like any others, and these requests
// were spending thousands of them on trivial questions. 'low' roughly halved
// the round trip in testing. The field name differs between model families, so
// a model that rejects it gets one automatic retry without it (see request()).
// Set to 'off' to skip it entirely.
const THINKING_LEVEL = import.meta.env.VITE_GEMINI_THINKING_LEVEL || 'low'

export class GeminiNotConfiguredError extends Error {
  constructor() {
    super(
      'No Gemini API key set. Create one at https://aistudio.google.com/apikey, ' +
        'then set VITE_GEMINI_API_KEY in .env.local and rebuild.'
    )
  }
}

export function isAgentConfigured(): boolean {
  return Boolean(API_KEY)
}

export interface AgentTurn {
  role: 'user' | 'model'
  text: string
}

export interface AgentReply {
  /** What the agent says back, in prose. */
  reply: string
  /** Proposed changes. Empty when the agent is still asking questions. */
  operations: AgentOperation[]
}

// Taken straight from the live store, which hands out deeply readonly views -
// this only ever reads, so it takes them as they come rather than forcing a
// copy of the whole inventory on every keystroke.
export interface WarehouseSnapshot {
  containers: readonly DeepReadonly<Container>[]
  containerTypes: readonly DeepReadonly<ContainerType>[]
  items: readonly DeepReadonly<Item>[]
  itemStacks: readonly DeepReadonly<ItemStack>[]
  placementRules: string
}

// --- Prompt -----------------------------------------------------------------

/**
 * The inventory as compact lines rather than JSON: it is roughly a third of
 * the tokens, and the ids stay visually obvious, which matters because every
 * operation has to reference one exactly.
 */
function renderSnapshot(snap: WarehouseSnapshot): string {
  const typeName = new Map(snap.containerTypes.map((t) => [t.id, t.name]))
  const itemName = new Map(snap.items.map((i) => [i.id, i.name]))
  const stackById = new Map(snap.itemStacks.map((s) => [s.id, s]))

  const containerLines = snap.containers
    .slice()
    .sort((a, b) => a.location.localeCompare(b.location) || a.id.localeCompare(b.id))
    .map((c) => {
      const contents = c.contents
        .map((id) => {
          const stack = stackById.get(id)
          if (!stack) return null
          return `${id} "${itemName.get(stack.itemRef) ?? stack.itemRef}" x${stack.quantity}`
        })
        .filter(Boolean)
        .join('; ')
      const pending = c.pendingMove
        ? ` | PENDING: ${c.pendingMove.kind === 'merge' ? 'merge into ' : 'move to '}${c.pendingMove.to} (awaiting confirmation)`
        : ''
      return `${c.id} | ${c.location} | ${typeName.get(c.containerType) ?? '(no type)'} | ${
        c.label || '(no label)'
      } | ${contents || '(contents not surveyed)'}${pending}`
    })

  const shelves = new Map<string, Set<string>>()
  for (const c of snap.containers) {
    const [root, level] = c.location.split('-')
    if (!root) continue
    if (!shelves.has(root)) shelves.set(root, new Set())
    if (level) shelves.get(root)!.add(level)
  }
  const shelfLines = [...shelves.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([root, levels]) => `${root}: levels ${[...levels].sort().join(', ')}`)

  return [
    '## Shelves and the levels each one actually has',
    shelfLines.join('\n') || '(none)',
    '',
    '## Container types',
    snap.containerTypes.map((t) => `- ${t.name}`).join('\n') || '(none defined)',
    '',
    '## Items already in the catalogue',
    snap.items.map((i) => `${i.id} | ${i.name}`).join('\n') || '(none)',
    '',
    '## Containers',
    'Format: id | address | container type | label | contents',
    containerLines.join('\n') || '(none)',
  ].join('\n')
}

function systemInstruction(snap: WarehouseSnapshot): string {
  return `You are the warehouse assistant for PW-Warehouse, an internal inventory system. You talk to a warehouse employee and, when they ask for changes, you produce a precise plan of operations that the system will carry out.

# How your answers are used

Every reply has two parts:
- "operations": the concrete changes, written FIRST. Leave this empty only when you are asking a question, explaining something, or answering without changing anything. If the person asked for changes, this is the part that matters — never describe changes in prose instead of putting them here.
- "reply": what you say to the person. Keep it to a few sentences: say what the plan does and flag anything you were unsure about. Do NOT list the operations again in prose; the person sees them as a checklist. Never pad this field or repeat yourself.

The person always sees your plan on a review screen and ticks off each operation before anything is written. So propose confidently, but never propose something you were not asked for.

Ask a clarifying question instead of guessing whenever the request is genuinely ambiguous. One round of questions is much cheaper than a wrong plan.

# Standing placement rules

${snap.placementRules.trim() || '(none set)'}

# Moving boxes costs real labour

Relocating a box means a person physically carries it. Because of that:
- Never propose a move that does not clearly fix something. Leaving a box where it is is always an acceptable answer.
- Shelves are full. Prefer "container.swap" over "container.move": a bare move only works if the destination slot is genuinely empty, and you can only tell that from the container list below.
- Say WHY in every operation's "reason". The person reads it while deciding whether to do the work.
- Moves and merges do not take effect when the plan is applied. They become proposals that someone confirms once they have actually done the lifting. Do not propose a follow-up that depends on a move having already happened.

# Addresses

An address is SHELF-LEVEL-COLUMN, e.g. SL1-M-A.
- LEVEL: T is the top tier, L is the bottom tier, M is the middle tier when there is only one. M1, M2, M3... number the middle tiers upward when there are several, with M1 directly above L.
- COLUMN: A, B, C... left to right. Several boxes routinely share one level and column.
- Use only levels that shelf actually has, from the list below. If a shelf uses M1/M2, never write plain M for it, and vice versa.

# Operations you may use

- container.move — containerId, location, reason. Only when the destination is genuinely free.
- container.swap — containerId, otherContainerId, reason. Exchanges two boxes' addresses. This is the normal way to reorganise a full shelf.
- container.merge — containerId (the box that gets emptied), targetContainerId (the box that receives its contents), reason. The emptied box is then trashed.
- container.create — label, location, containerTypeName (optional), notes (optional).
- container.update — containerId, and any of label, containerTypeName, notes. NEVER put a location on this; use move or swap.
- container.trash — containerId, reason. Recoverable.
- item.create — itemName, itemNotes (optional). Only for an item that does not exist yet.
- itemstack.add — containerId, itemName, quantity. Puts an item inside a container. If the item is not in the catalogue it is created automatically, so you do not need a separate item.create first.
- itemstack.update — itemStackId, quantity.
- itemstack.remove — itemStackId.
- containertype.create — containerTypeName, color (a hex colour like #ffcc00).

Rules for operations:
- Always reference containers, item stacks and items by the exact ids in the list below. Never invent an id.
- Quantity is free text ("200", "1 box", "~50"). If none is meaningful, use "1".
- containerTypeName must match an existing type's name exactly, unless you create it in the same plan with containertype.create first.
- Only include containers in your plan that are relevant to what was asked.

# Current state of the warehouse

${renderSnapshot(snap)}`
}

// Field order is load-bearing, not cosmetic. Structured output is generated
// in schema order, and with the prose fields first this model reliably spent
// its whole answer on them and returned ZERO operations - or fell into a
// repetition loop inside a free-text field and ran to the token limit,
// producing truncated JSON. Measured on the same request: prose-first gave 0
// operations; operations-first gave 27, in a third of the time. So the array
// is generated first, and there is exactly one free-text field left.
const OPERATION_SCHEMA = {
  type: 'object',
  propertyOrdering: ['op', 'containerId', 'otherContainerId', 'targetContainerId', 'location', 'reason'],
  properties: {
    op: {
      type: 'string',
      enum: [
        'container.move',
        'container.swap',
        'container.merge',
        'container.create',
        'container.update',
        'container.trash',
        'item.create',
        'itemstack.add',
        'itemstack.update',
        'itemstack.remove',
        'containertype.create',
      ],
    },
    reason: { type: 'string' },
    containerId: { type: 'string' },
    otherContainerId: { type: 'string' },
    targetContainerId: { type: 'string' },
    location: { type: 'string' },
    label: { type: 'string' },
    containerTypeName: { type: 'string' },
    notes: { type: 'string' },
    itemName: { type: 'string' },
    itemNotes: { type: 'string' },
    quantity: { type: 'string' },
    itemStackId: { type: 'string' },
    color: { type: 'string' },
  },
  required: ['op', 'reason'],
}

const RESPONSE_SCHEMA = {
  type: 'object',
  propertyOrdering: ['operations', 'reply'],
  properties: {
    operations: { type: 'array', items: OPERATION_SCHEMA },
    reply: { type: 'string' },
  },
  required: ['reply'],
}

// --- Request ----------------------------------------------------------------

export async function askAgent(input: {
  turns: AgentTurn[]
  snapshot: WarehouseSnapshot
  signal?: AbortSignal
}): Promise<AgentReply> {
  if (!API_KEY) throw new GeminiNotConfiguredError()

  const generationConfig: Record<string, unknown> = {
    responseMimeType: 'application/json',
    responseSchema: RESPONSE_SCHEMA,
    // Not near-zero: greedy decoding is what tips a model into the repetition
    // loops that produced 15,000 tokens of "Done. Bye. End." and a truncated
    // response. Planning wants a little variety anyway.
    temperature: 0.6,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  }
  if (THINKING_LEVEL && THINKING_LEVEL !== 'off') {
    generationConfig.thinkingConfig = { thinkingLevel: THINKING_LEVEL }
  }

  const body = {
    systemInstruction: { parts: [{ text: systemInstruction(input.snapshot) }] },
    contents: input.turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    generationConfig,
  }

  const startedAt = Date.now()
  let { res, json } = await post(body, API_KEY, input.signal)

  // Older model families don't know thinkingConfig and reject it outright.
  // Retry once without it rather than making the feature unusable on them.
  if (!res.ok && rejectedThinkingConfig(json)) {
    delete generationConfig.thinkingConfig
    ;({ res, json } = await post(body, API_KEY, input.signal))
  }
  const durationMs = Date.now() - startedAt
  const candidate = json?.candidates?.[0]
  const usage = json?.usageMetadata
  const rawText: string =
    candidate?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? ''

  const debug = recordExchange({
    source: 'agent',
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
        `Gemini model "${MODEL}" isn't available to this API key. Google retires older model names for newly issued keys, and its own message usually names the replacement: ${message}. Set VITE_GEMINI_PLANNING_MODEL in .env.local and rebuild.`
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

  if (!rawText) {
    noteParseResult(debug.id, { error: 'empty response' })
    if (ranOut) throw new Error(outOfRoomMessage(usage))
    throw new Error(
      `Gemini returned no result${reason ? ` (finishReason: ${reason})` : ''}. Open Debug to see the raw response.`
    )
  }

  const parsed = parseLooseJson<Partial<AgentReply>>(rawText)
  noteParseResult(debug.id, { error: parsed.error, repaired: parsed.repaired })

  if (!parsed.ok || !parsed.value) {
    if (ranOut) throw new Error(outOfRoomMessage(usage))
    throw new Error(
      `Gemini's answer wasn't valid JSON (${parsed.error}). Open Debug to see exactly what came back.`
    )
  }

  const value = parsed.value
  const operations = Array.isArray(value.operations) ? value.operations : []

  // A repaired reply is a partial one. Say so rather than presenting half a
  // plan as though it were the whole plan.
  const truncationNote = parsed.repaired
    ? `

[This answer was cut short${
        ranOut ? ' because it hit the output limit' : ''
      }, and only the ${operations.length} operation${
        operations.length === 1 ? '' : 's'
      } that arrived intact are shown. Ask for a smaller piece of work — one shelf at a time — to get the rest.]`
    : ''

  return {
    reply: (value.reply?.trim() || '(no reply)') + truncationNote,
    operations,
  }
}

async function post(
  body: unknown,
  apiKey: string,
  signal?: AbortSignal
): Promise<{ res: Response; json: any }> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      signal,
      body: JSON.stringify(body),
    }
  )
  return { res, json: await res.json() }
}

function rejectedThinkingConfig(json: { error?: { message?: string } } | undefined): boolean {
  const message = json?.error?.message ?? ''
  return /thinking/i.test(message)
}

function outOfRoomMessage(usage: { thoughtsTokenCount?: number } | undefined): string {
  const thoughts = usage?.thoughtsTokenCount
  return (
    'Gemini hit its output limit before finishing, so the answer came back incomplete' +
    (thoughts ? ` — it spent ${thoughts} tokens thinking first` : '') +
    `. Raise VITE_GEMINI_PLANNING_MAX_TOKENS (currently ${MAX_OUTPUT_TOKENS}) in .env.local, or set ` +
    'VITE_GEMINI_THINKING_LEVEL=low so less of the budget goes on thinking. Open Debug for the details.'
  )
}
