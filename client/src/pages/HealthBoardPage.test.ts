import { describe, it, expect } from 'vitest'
import { formatAgo, formatCountdown, healthTone } from './HealthBoardPage'

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
