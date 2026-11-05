// @vitest-environment jsdom
// Model forensics card: ranks models by time lost, shows the cause split, and demotes or restores a
// model with one click.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { ModelForensicsCard, causeSegments, formatDuration, type ForensicsResponse } from './model-forensics-card'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

const laguna = {
  platform: 'nvidia', modelId: 'poolside/laguna-xs-2.1', name: 'Laguna XS 2.1', requests: 40, successes: 30, failed: 10,
  wastedMs: 312_000, avgFirstMs: 2_100,
  causes: { stall: 8, runaway: 0, guard: 1, deadline: 1, rateLimit: 0, other: 0 }, demotion: null as number | null,
}
const llama = {
  platform: 'groq', modelId: 'llama-3.3-70b', name: 'Llama 3.3 70B', requests: 90, successes: 88, failed: 2,
  wastedMs: 1_600, avgFirstMs: 400,
  causes: { stall: 0, runaway: 0, guard: 0, deadline: 0, rateLimit: 2, other: 0 }, demotion: null as number | null,
}

let root: Root
let container: HTMLDivElement
let client: QueryClient
let state: ForensicsResponse

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  state = { totalWastedMs: 313_600, totalFailed: 12, models: [{ ...laguna }, { ...llama }] }
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === '/api/curation/demotions') {
      const { modelId, demote } = JSON.parse(String(options?.body))
      state.models = state.models.map(m => m.modelId === modelId ? { ...m, demotion: demote ? 0.4 : null } : m)
      return {}
    }
    return structuredClone(state)
  })
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })

async function flush() { for (let i = 0; i < 5; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function render() {
  act(() => root.render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en"><ModelForensicsCard /></I18nProvider>
    </QueryClientProvider>,
  ))
  await flush()
}
const rows = () => [...container.querySelectorAll('li')]
const button = (row: Element, label: string) => [...row.querySelectorAll('button')].find(b => b.textContent?.includes(label))

describe('formatDuration', () => {
  it('reads like a table cell', () => {
    expect(formatDuration(42_000)).toBe('42s')
    expect(formatDuration(312_000)).toBe('5m 12s')
    expect(formatDuration(3_900_000)).toBe('1h 05m')
  })
})

describe('causeSegments', () => {
  it('splits a model\'s failures by cause and drops empty ones', () => {
    expect(causeSegments(laguna).map(s => [s.key, s.count])).toEqual([['stall', 8], ['guard', 1], ['deadline', 1]])
    expect(causeSegments({ failed: 0, causes: laguna.causes })).toEqual([])
  })
})

describe('ModelForensicsCard', () => {
  it('ranks models by the time they cost the agent, with the total', async () => {
    await render()
    expect(container.textContent).toContain('Where the agent loses time')
    expect(container.textContent).toContain('5m 14s lost · 12 failed attempts')
    expect(rows().map(r => r.querySelector('p span')?.textContent)).toEqual(['Laguna XS 2.1', 'Llama 3.3 70B'])
    expect(rows()[0].textContent).toContain('10 of 40 attempts failed')
    expect(rows()[0].textContent).toContain('5m 12s')
  })

  it('"Lower priority" demotes the model and the row shows it, "Restore" undoes it', async () => {
    await render()
    await act(async () => { button(rows()[0], 'Lower priority')!.click() })
    await flush()
    expect(apiFetch).toHaveBeenCalledWith('/api/curation/demotions', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ modelId: 'poolside/laguna-xs-2.1', demote: true }),
    }))
    expect(rows()[0].textContent).toContain('×0.4')
    expect(button(rows()[0], 'Restore')).toBeTruthy()

    await act(async () => { button(rows()[0], 'Restore')!.click() })
    await flush()
    expect(rows()[0].textContent).not.toContain('×0.4')
    expect(button(rows()[0], 'Lower priority')).toBeTruthy()
  })

  it('says so when nothing failed', async () => {
    state = { totalWastedMs: 0, totalFailed: 0, models: [] }
    await render()
    expect(container.textContent).toContain('No failed attempts in the last 24h.')
  })
})
