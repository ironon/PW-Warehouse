import { ref } from 'vue'
import { askAgent, type AgentTurn } from '../lib/aiAgent'
import {
  warehouse,
  validateAgentPlan,
  recordAiTurn,
  recordAiPlanApplied,
  type ValidatedOperation,
} from './warehouse'

// The conversation lives in a module-level store rather than in AiWorkView so
// that flipping to Search to check something doesn't throw away a plan you
// spent a minute describing.
//
// Every exchange is also written to the shared history in Firebase, so anyone
// can see what has been asked of the agent and what it actually changed. That
// record is read-only and separate from this live state: reloading still
// starts a fresh conversation, because a plan is only meaningful against the
// shelf state it was drawn up from.

export interface PlanRow extends ValidatedOperation {
  selected: boolean
}

export interface ChatMessage {
  role: 'user' | 'model'
  text: string
  rows?: PlanRow[]
  /** Set once the plan has been applied, so it can't be applied twice. */
  applied?: { applied: number; proposed: number }
  /** Where this message lives in the shared history, so applying a plan can
   *  be written back against the right turn. */
  historyId?: string
}

export const messages = ref<ChatMessage[]>([])
export const thinking = ref(false)
export const chatError = ref('')
/** Text of a message that failed to send, so the view can put it back in the
 *  box instead of making the person retype it. */
export const failedDraft = ref('')
/** Non-fatal: the exchange happened, it just didn't reach shared history. */
export const historyError = ref('')

/** Id of this conversation in the shared history; null until the first turn. */
const conversationId = ref<string | null>(null)

let controller: AbortController | null = null

function snapshot() {
  return {
    containers: warehouse.containers,
    containerTypes: warehouse.containerTypes,
    items: warehouse.items,
    itemStacks: warehouse.itemStacks,
    placementRules: warehouse.placementRules,
  }
}

export async function sendMessage(text: string): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed || thinking.value) return

  messages.value = [...messages.value, { role: 'user', text: trimmed }]
  chatError.value = ''
  failedDraft.value = ''
  historyError.value = ''
  thinking.value = true
  controller = new AbortController()

  // Only the prose goes back to the model. Plans are re-derived from the
  // conversation each turn, so a plan the person edited or rejected never
  // silently comes back as something the agent thinks it already did.
  const turns: AgentTurn[] = messages.value.map((m) => ({ role: m.role, text: m.text }))

  try {
    const reply = await askAgent({ turns, snapshot: snapshot(), signal: controller.signal })
    const rows = validateAgentPlan(reply.operations).map((row) => ({
      ...row,
      // A row that can't be applied starts unticked so Apply doesn't look
      // like it will do more than it will.
      selected: !row.error,
    }))
    const modelMessage: ChatMessage = {
      role: 'model',
      text: reply.reply,
      rows: rows.length ? rows : undefined,
    }
    messages.value = [...messages.value, modelMessage]

    // Recorded after the reply lands, so a failed request leaves no orphan
    // half-turn in the shared history. A failure here is reported but never
    // interrupts the conversation.
    try {
      const record = await recordAiTurn({
        conversationId: conversationId.value,
        userText: trimmed,
        modelText: reply.reply,
        proposals: rows.map((r) => r.summary),
      })
      conversationId.value = record.conversationId
      const stored = messages.value[messages.value.length - 1]
      if (stored === modelMessage) stored.historyId = record.modelMessageId
    } catch (err) {
      historyError.value = `Saved to the conversation, but not to shared history: ${
        err instanceof Error ? err.message : String(err)
      }`
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      chatError.value = 'Cancelled.'
    } else {
      chatError.value = err instanceof Error ? err.message : String(err)
    }
    // Drop the question that got no answer, so a retry doesn't send it twice,
    // and hand the text back to the view.
    messages.value = messages.value.slice(0, -1)
    failedDraft.value = trimmed
  } finally {
    thinking.value = false
    controller = null
  }
}

export function cancel(): void {
  controller?.abort()
}

export function resetChat(): void {
  cancel()
  messages.value = []
  chatError.value = ''
  failedDraft.value = ''
  historyError.value = ''
  // A new thread gets a new history entry rather than extending the old one.
  conversationId.value = null
}

/** Writes back what an applied plan actually did, against the turn that
 *  proposed it. Never throws: the warehouse change already succeeded, and
 *  losing the annotation must not be reported as a failed apply. */
export async function notePlanApplied(
  message: ChatMessage,
  result: { applied: number; proposed: number }
): Promise<void> {
  if (!conversationId.value || !message.historyId) return
  try {
    await recordAiPlanApplied({
      conversationId: conversationId.value,
      messageId: message.historyId,
      applied: result.applied,
      proposed: result.proposed,
      summaries: (message.rows ?? []).filter((r) => r.selected && !r.error).map((r) => r.summary),
    })
  } catch (err) {
    historyError.value = `Changes were applied, but shared history wasn't updated: ${
      err instanceof Error ? err.message : String(err)
    }`
  }
}
