import { describe, it, expect } from 'vitest'
import { formatCountdown, healthTone } from './HealthBoardPage'

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
