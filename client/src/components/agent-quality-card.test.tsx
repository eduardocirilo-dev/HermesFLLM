// @vitest-environment jsdom
// Task quality card: per-model rates from the Hermes plugin's reports, worst first, and the
// empty states that tell the user what to do.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { AgentQualityCard, factorLabel, qualityTone, type QualityResponse } from './agent-quality-card'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

let root: Root
let container: HTMLDivElement
let client: QueryClient
let state: QualityResponse

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  vi.mocked(apiFetch).mockReset().mockImplementation(async () => structuredClone(state))
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })

async function render() {
  act(() => root.render(<QueryClientProvider client={client}><I18nProvider initialLocale="en"><AgentQualityCard /></I18nProvider></QueryClientProvider>))
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

describe('qualityTone', () => {
  it('reads 90% green, 70% amber, below red', () => {
    expect([qualityTone(0.95), qualityTone(0.75), qualityTone(0.4), qualityTone(null)]).toEqual(['good', 'warn', 'bad', 'none'])
  })
})

describe('AgentQualityCard', () => {
  it('shows each model\'s tool and turn rates with the most frequent tool error', async () => {
    state = { events: 42, models: [
      { modelId: 'weak', toolCalls: 7, toolErrors: 4, toolSuccessRate: 3 / 7, turns: 5, turnsCompleted: 2, turnsFailed: 3, turnCompletionRate: 0.4, topErrorType: 'FileNotFoundError' },
      { modelId: 'good', toolCalls: 9, toolErrors: 1, toolSuccessRate: 8 / 9, turns: 2, turnsCompleted: 2, turnsFailed: 0, turnCompletionRate: null, topErrorType: null },
    ] }
    await render()
    const items = [...container.querySelectorAll('li')]
    expect(items.map(li => li.querySelector('p')?.textContent)).toEqual(['weak', 'good'])
    expect(items[0].textContent).toContain('43%')
    expect(items[0].textContent).toContain('3 of 7')
    expect(items[0].textContent).toContain('40%')
    expect(items[0].textContent).toContain('Most frequent tool error: FileNotFoundError')
    expect(items[1].textContent).toContain('89%')
    expect(items[1].textContent).toContain('—') // too few turns to rate
    expect(container.textContent).toContain('42 events')
  })

  it('tells the user how to start the reports when there are none', async () => {
    state = { events: 0, models: [] }
    await render()
    expect(container.textContent).toContain('Update the Hermes plugin to 0.3')
  })

  it('says reports are arriving before any model has enough of them', async () => {
    state = { events: 3, models: [] }
    await render()
    expect(container.textContent).toContain('Reports are arriving')
  })

  it('shows each model\'s success by agent phase, with how much it moves routing, and the phase routing tally', async () => {
    state = {
      events: 120,
      models: [{
        modelId: 'mixed', toolCalls: 40, toolErrors: 10, toolSuccessRate: 0.75, turns: 0, turnsCompleted: 0, turnsFailed: 0, turnCompletionRate: null, topErrorType: null,
        phases: [
          { phase: 'edit', calls: 20, errors: 0, rate: 1, factor: 1.08 },
          { phase: 'shell', calls: 20, errors: 10, rate: 0.5, factor: 0.7 },
        ],
      }],
      phaseRouting: { enabled: true, turns: { edit: 4, shell: 3, explore: 2, web: 1 }, stickyBroken: 2, since: new Date().toISOString() },
    }
    await render()
    const text = container.querySelector('li')!.textContent!
    expect(text).toContain('edit100%+8%')
    expect(text).toContain('shell50%−30%')
    expect(container.textContent).toContain('4 editing, 3 shell, 2 exploring, 1 web')
    expect(container.textContent).toContain('2 times')
  })
})

describe('factorLabel', () => {
  it('shows the routing shift and nothing when it is neutral', () => {
    expect([factorLabel(1), factorLabel(1.004), factorLabel(1.15), factorLabel(0.6)]).toEqual(['', '', '+15%', '−40%'])
  })
})
