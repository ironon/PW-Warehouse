import { ref } from 'vue'
import { askAgent, type AgentTurn } from '../lib/aiAgent'
import { warehouse, validateAgentPlan, type ValidatedOperation } from './warehouse'

// The conversation lives in a module-level store rather than in AiWorkView so
// that flipping to Search to check something doesn't throw away a plan you
// spent a minute describing. It is deliberately not persisted: a plan is only
// meaningful against the shelf state it was drawn up from, and reloading the
// page is a fair moment to start over.

export interface PlanRow extends ValidatedOperation {
  selected: boolean
}

export interface ChatMessage {
  role: 'user' | 'model'
  text: string
  /** Present on a model message that came with a plan. */
  planSummary?: string
  rows?: PlanRow[]
  /** Set once the plan has been applied, so it can't be applied twice. */
  applied?: { applied: number; proposed: number }
}

export const messages = ref<ChatMessage[]>([])
export const thinking = ref(false)
export const chatError = ref('')
/** Text of a message that failed to send, so the view can put it back in the
 *  box instead of making the person retype it. */
export const failedDraft = ref('')

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
    messages.value = [
      ...messages.value,
      {
        role: 'model',
        text: reply.reply,
        planSummary: reply.planSummary || undefined,
        rows: rows.length ? rows : undefined,
      },
    ]
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
}
