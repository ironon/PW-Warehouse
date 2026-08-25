import { ref } from 'vue'
import { fetchStocks, setStock as apiSetStock, type LabelStock } from '../lib/labelPrinter'

// Which label roll is physically in the printer. This lives on the backend
// rather than in localStorage: it describes one shared piece of hardware, so
// every browser and the CLI must agree on it.
export const stocks = ref<LabelStock[]>([])
export const currentStockId = ref('')
export const stockError = ref('')
export const stocksLoaded = ref(false)

export async function loadStocks(): Promise<void> {
  try {
    const { stocks: list, current } = await fetchStocks()
    stocks.value = list
    currentStockId.value = current
    stockError.value = ''
    stocksLoaded.value = true
  } catch {
    // The print backend simply isn't running; not an error worth surfacing
    // until the user actually tries to print.
    stocksLoaded.value = false
  }
}

export async function changeStock(id: string): Promise<void> {
  const previous = currentStockId.value
  currentStockId.value = id
  stockError.value = ''
  try {
    await apiSetStock(id)
  } catch (err) {
    currentStockId.value = previous
    stockError.value = err instanceof Error ? err.message : String(err)
    throw err
  }
}

export function currentStock(): LabelStock | undefined {
  return stocks.value.find((s) => s.id === currentStockId.value)
}
