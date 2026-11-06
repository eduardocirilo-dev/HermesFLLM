// @vitest-environment jsdom
// Sealed turns card: half-turns kept from Hermes, by kind, against the failures that still reach it.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nProvider } from '@/i18n'
import en from '../i18n/locales/en.json'
import ptPT from '../i18n/locales/pt-PT.json'
import ptBR from '../i18n/locales/pt-BR.json'
import { SEAL_KINDS, SealedTurnsCard, freezesAvoidedMinutes, visibleTone, type SealBoard } from './sealed-turns-card'

let root: Root
let container: HTMLDivElement

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const board = (over: Partial<SealBoard> = {}): SealBoard => ({
  enabled: true,
  releaseChars: 800,
  maxMs: 60_000,
  rescued24h: 7,
  rescued7d: 19,
  byKind24h: { stall: 3, loop: 0, guard: 2, inline: 1, cut: 1, other: 0 },
  visibleFailures24h: 0,
  visibleFailures7d: 4,
  stallSavingMs: 60_000,
  sinceRestart: { turns: 120, whole: 110, held: 31, released: { answer: 9, valve: 1 }, rescued: { stall: 3, loop: 0, guard: 2, inline: 1, cut: 1, other: 0 }, since: new Date().toISOString() },
  ...over,
})

function render(seal: SealBoard) {
  act(() => root.render(<I18nProvider initialLocale="en"><SealedTurnsCard seal={seal} /></I18nProvider>))
}

describe('helpers', () => {
  it('estimates freezes avoided from stalls caught inside the seal', () => {
    expect(freezesAvoidedMinutes(3, 60_000)).toBe(3)
    expect(freezesAvoidedMinutes(1, 30_000)).toBe(0)
    expect(freezesAvoidedMinutes(0, 60_000)).toBe(0)
    expect(freezesAvoidedMinutes(5, 0)).toBe(0)
  })

  it('reads visible failures green only at zero', () => {
    expect([visibleTone(0), visibleTone(2), visibleTone(9)]).toEqual(['good', 'warn', 'bad'])
  })
})

describe('SealedTurnsCard', () => {
  it('shows the half-turns kept from Hermes, by kind, and the visible failures it drives to zero', () => {
    render(board())
    const text = container.textContent!
    expect(text).toContain('Sealed turns')
    expect(text).toContain('half-turns kept from Hermes in 24h (19 in 7 days)')
    expect(text).toContain('≥ 3 min of freezing avoided')
    const kinds = [...container.querySelectorAll('li')].map(li => li.textContent)
    expect(kinds).toEqual(['Stalled after talking3', 'Broken tool call after text2', 'Tool call written as text1', 'Stream cut or provider error1', 'Looping or never ending0', 'Other0'])
    expect(text).toContain('Failures that still reached Hermes (24h)')
    expect(text).toContain('4 in 7 days. The goal is 0.')
    expect(text).toContain('Since restart: 120 agent turns. 31 were held until whole, 9 long answers started streaming early, 1 were released by the time valve.')
    expect(text).toContain('passes 800 characters')
    expect(text).toContain('after 60s')
  })

  it('says when sealing is off', () => {
    render(board({ enabled: false, releaseChars: null, maxMs: null }))
    expect(container.textContent).toContain('Sealing is off (HERMESFLLM_SEAL=0)')
    expect(container.textContent).toContain('Off')
  })
})

describe('translations', () => {
  it('has every card string, with its placeholders, in en, pt-PT and pt-BR', () => {
    for (const dict of [en, ptPT, ptBR] as Array<{ healthBoard: Record<string, string> }>) {
      const hb = dict.healthBoard
      for (const { kind } of SEAL_KINDS) expect(hb[`seal_${kind}`]).toBeTruthy()
      for (const k of ['sealTitle', 'sealDescription', 'sealKinds', 'sealVisible', 'sealOff']) expect(hb[k]).toBeTruthy()
      expect(hb.sealRescued).toContain('{week}')
      expect(hb.sealFreezes).toContain('{minutes}')
      expect(hb.sealVisibleWeek).toContain('{week}')
      for (const p of ['{turns}', '{held}', '{answer}', '{valve}']) expect(hb.sealDeliveries).toContain(p)
      for (const p of ['{chars}', '{seconds}']) expect(hb.sealHow).toContain(p)
    }
  })
})
