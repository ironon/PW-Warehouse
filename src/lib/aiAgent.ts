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

const API_KEY = import.meta.env.VITE_GEMINI_API_KEY
// Planning is a reasoning job rather than an OCR one, so this is worth
// pointing at a stronger model than the scanner uses. It is separate from
// VITE_GEMINI_MODEL for exactly that reason. gemini-3.1-pro-preview is the
// upgrade to try; the default stays on flash because it is not a preview.
const MODEL = import.meta.env.VITE_GEMINI_PLANNING_MODEL || 'gemini-3.6-flash'

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
  /** One line describing the plan, empty when there is no plan this turn. */
  planSummary: string
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

Every reply has three parts:
- "reply": what you say to the person. Always fill this in.
- "planSummary": one line describing the plan, when you propose one.
- "operations": the concrete changes. Leave this EMPTY when you are asking a question, explaining something, or answering without changing anything.

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

const OPERATION_SCHEMA = {
  type: 'object',
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
  properties: {
    reply: { type: 'string' },
    planSummary: { type: 'string' },
    operations: { type: 'array', items: OPERATION_SCHEMA },
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

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
      signal: input.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction(input.snapshot) }] },
        contents: input.turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0.2,
        },
      }),
    }
  )

  const json = await res.json()
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

  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) {
    const reason = json?.candidates?.[0]?.finishReason
    if (reason === 'MAX_TOKENS') {
      throw new Error(
        'Gemini ran out of room before finishing. Ask for a smaller piece of work (one shelf at a time, say).'
      )
    }
    throw new Error(`Gemini returned no result${reason ? ` (finishReason: ${reason})` : ''}.`)
  }

  let parsed: Partial<AgentReply>
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Gemini returned a response that was not valid JSON.')
  }

  return {
    reply: parsed.reply?.trim() || '(no reply)',
    planSummary: parsed.planSummary?.trim() ?? '',
    operations: Array.isArray(parsed.operations) ? parsed.operations : [],
  }
}
