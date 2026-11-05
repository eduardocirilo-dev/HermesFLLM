import { describe, it, expect } from 'vitest'
import { formatAgo, formatCountdown, healthTone, raceShares } from './HealthBoardPage'

describe('healthTone', () => {
  it('uses the 95% / 80% thresholds', () => {
    expect(healthTone(0.97)).toBe('good')
    expect(healthTone(0.95)).toBe('good')
    expect(healthTone(0.85)).toBe('warn')
    expect(healthTone(0.5)).toBe('bad')
    expect(healthTone(null)).toBe('none')
  })
})

describe('formatCountdown', () => {
  const now = Date.parse('2026-11-03T12:00:00Z')
  it('shows hours and minutes until the next pass', () => {
    expect(formatCountdown('2026-11-03T14:30:00Z', now)).toBe('2h 30m')
    expect(formatCountdown('2026-11-03T12:05:00Z', now)).toBe('5m')
  })
  it('never goes negative and handles a missing date', () => {
    expect(formatCountdown('2026-11-03T11:00:00Z', now)).toBe('0m')
    expect(formatCountdown(null, now)).toBeNull()
  })
})

describe('formatAgo', () => {
  const now = Date.parse('2026-11-03T12:00:00Z')
  it('reads as minutes, then hours', () => {
    expect(formatAgo('2026-11-03T11:59:40Z', now)).toBe('<1m')
    expect(formatAgo('2026-11-03T11:52:00Z', now)).toBe('8m')
    expect(formatAgo('2026-11-03T10:30:00Z', now)).toBe('1h 30m')
  })
})

import { buildLabel } from '@/components/build-badge'

describe('buildLabel', () => {
  it('shows version, commit and the update time', () => {
    const label = buildLabel({ version: '0.5.0', commit: 'abc1234', builtAt: '2026-11-03T11:40:00Z' }, 'updated', 'en-GB')
    expect(label).toMatch(/^HermesFLLM v0\.5\.0 · abc1234 · updated \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}$/)
  })
  it('degrades without a commit or build time', () => {
    expect(buildLabel({ version: 'dev', commit: null, builtAt: '' }, 'updated')).toBe('HermesFLLM vdev')
  })
})

describe('raceShares', () => {
  it('splits the bar by outcome and drops empty segments', () => {
    expect(raceShares({ races: 0, backupWins: 0, primaryWins: 0, bothFailed: 0 })).toEqual([])
    const shares = raceShares({ races: 4, backupWins: 3, primaryWins: 1, bothFailed: 0 })
    expect(shares.map(s => [s.key, s.share])).toEqual([['backup', 0.75], ['primary', 0.25]])
  })
})

import { RESCUE_KINDS } from './HealthBoardPage'
import en from '../i18n/locales/en.json'
import ptPT from '../i18n/locales/pt-PT.json'
import ptBR from '../i18n/locales/pt-BR.json'

describe('rescued turns card', () => {
  it('has a label for every rescue kind in en, pt-PT and pt-BR', () => {
    for (const dict of [en, ptPT, ptBR] as Array<{ healthBoard: Record<string, string> }>) {
      for (const { kind } of RESCUE_KINDS) expect(dict.healthBoard[`rescue_${kind}`]).toBeTruthy()
      expect(dict.healthBoard.rescuesTitle).toBeTruthy()
      expect(dict.healthBoard.rescuesSubtitle).toContain('{week}')
    }
  })
})

describe('raceShares with a winner that failed', () => {
  it('gives every race outcome its own segment, so the bar always fills', () => {
    const shares = raceShares({ races: 14, backupWins: 5, primaryWins: 8, winnerFailed: 1, bothFailed: 0 })
    expect(shares.map(s => s.key)).toEqual(['backup', 'primary', 'winner'])
    expect(shares.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1)
  })
})

import { formatTokens } from './HealthBoardPage'

describe('context fit card', () => {
  it('reads token counts at a glance', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(12_340)).toBe('12.3k')
    expect(formatTokens(2_500_000)).toBe('2.5M')
  })

  it('has its strings, with their placeholders, in en, pt-PT and pt-BR', () => {
    for (const dict of [en, ptPT, ptBR] as Array<{ healthBoard: Record<string, string> }>) {
      expect(dict.healthBoard.fitTitle).toBeTruthy()
      expect(dict.healthBoard.fitRegained).toContain('{since}')
      expect(dict.healthBoard.fitSummary).toContain('{tokens}')
      expect(dict.healthBoard.fitIdle).toContain('{turns}')
      expect(dict.healthBoard.fitHow).toBeTruthy()
    }
  })
})
