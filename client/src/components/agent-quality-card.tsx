import { useQuery } from '@tanstack/react-query'
import { ClipboardCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'

// HermesFLLM task quality, as Hermes saw it: for each model, how many of the tool calls it asked
// for actually ran, and how many of the turns it served finished. Reported by the Hermes plugin
// (names and outcomes only); the first measure of quality rather than delivery.

export interface ModelQuality {
  modelId: string
  toolCalls: number
  toolErrors: number
  toolSuccessRate: number | null
  turns: number
  turnsCompleted: number
  turnsFailed: number
  turnCompletionRate: number | null
  topErrorType: string | null
  phases?: PhaseQuality[]
}

export type AgentPhase = 'edit' | 'shell' | 'explore' | 'web'

export interface PhaseQuality {
  phase: AgentPhase
  calls: number
  errors: number
  rate: number
  /** Routing score multiplier in this phase (1 = neutral). */
  factor: number
}

export interface QualityResponse {
  models: ModelQuality[]
  events: number
  phaseRouting?: { enabled: boolean; turns: Record<AgentPhase, number>; stickyBroken: number; since: string }
}

/** "+8%" / "−25%" / "" for the routing multiplier, rounded; empty when it does not move the score. */
export function factorLabel(factor: number): string {
  const delta = Math.round((factor - 1) * 100)
  if (delta === 0) return ''
  return delta > 0 ? `+${delta}%` : `−${Math.abs(delta)}%`
}

const pct = (v: number) => `${Math.round(v * 100)}%`

/** Same reading as the rest of the board: green from 90%, amber from 70%, red below. */
export function qualityTone(rate: number | null): 'good' | 'warn' | 'bad' | 'none' {
  if (rate === null) return 'none'
  if (rate >= 0.9) return 'good'
  if (rate >= 0.7) return 'warn'
  return 'bad'
}

const toneBar = { good: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-red-500', none: 'bg-muted' }
const toneText = { good: 'text-emerald-600 dark:text-emerald-400', warn: 'text-amber-600 dark:text-amber-400', bad: 'text-red-600 dark:text-red-400', none: 'text-muted-foreground' }

function Rate({ label, rate, detail }: { label: string; rate: number | null; detail: string }) {
  const tone = qualityTone(rate)
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn('font-semibold tabular-nums', toneText[tone])}>{rate === null ? '—' : pct(rate)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className={cn('h-full rounded-full transition-[width] duration-700', toneBar[tone])} style={{ width: rate === null ? 0 : pct(rate) }} />
      </div>
      <p className="text-[11px] tabular-nums text-muted-foreground">{detail}</p>
    </div>
  )
}

export function AgentQualityCard() {
  const { t } = useI18n()
  const { data, isLoading, isError } = useQuery({
    queryKey: ['agent-quality'],
    queryFn: () => apiFetch<QualityResponse>('/api/curation/quality'),
    refetchInterval: 60_000,
  })

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <ClipboardCheck className="h-4 w-4 text-emerald-500" />
          {t('healthBoard.qualityTitle')}
          {data && data.events > 0 && (
            <Badge variant="outline" className="ml-auto tabular-nums">{t('healthBoard.qualityEvents', { count: data.events })}</Badge>
          )}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{t('healthBoard.qualityDescription')}</p>
        {data?.phaseRouting && (
          <p className="text-xs text-muted-foreground">
            {data.phaseRouting.enabled
              ? t('healthBoard.phaseRoutingOn', {
                  edit: data.phaseRouting.turns.edit, shell: data.phaseRouting.turns.shell,
                  explore: data.phaseRouting.turns.explore, web: data.phaseRouting.turns.web,
                  broken: data.phaseRouting.stickyBroken,
                })
              : t('healthBoard.phaseRoutingOff')}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {isError && <p className="text-sm text-red-500">{t('healthBoard.loadError')}</p>}
        {isLoading && <Skeleton className="h-24" />}
        {data && data.models.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {data.events > 0 ? t('healthBoard.qualityGathering') : t('healthBoard.qualityEmpty')}
          </p>
        )}
        {data && data.models.length > 0 && (
          <ul className="grid gap-x-8 gap-y-5 md:grid-cols-2">
            {data.models.map(m => (
              <li key={m.modelId} className="space-y-2">
                <p className="truncate text-sm font-medium" title={m.modelId}>{m.modelId}</p>
                <div className="grid grid-cols-2 gap-3">
                  <Rate
                    label={t('healthBoard.qualityTools')}
                    rate={m.toolSuccessRate}
                    detail={t('healthBoard.qualityToolsDetail', { ok: m.toolCalls - m.toolErrors, total: m.toolCalls })}
                  />
                  <Rate
                    label={t('healthBoard.qualityTurns')}
                    rate={m.turnCompletionRate}
                    detail={t('healthBoard.qualityTurnsDetail', { done: m.turnsCompleted, total: m.turns })}
                  />
                </div>
                {m.phases && m.phases.length > 0 && (
                  <div className="flex flex-wrap gap-1.5" aria-label={t('healthBoard.phaseLabel')}>
                    {m.phases.map(p => {
                      const tone = qualityTone(p.rate)
                      const shift = factorLabel(p.factor)
                      return (
                        <span
                          key={p.phase}
                          className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] tabular-nums"
                          title={t('healthBoard.phaseChipTitle', { ok: p.calls - p.errors, total: p.calls })}
                        >
                          <span className="text-muted-foreground">{t(`healthBoard.phase_${p.phase}`)}</span>
                          <span className={cn('font-semibold', toneText[tone])}>{pct(p.rate)}</span>
                          {shift && <span className={p.factor > 1 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>{shift}</span>}
                        </span>
                      )
                    })}
                  </div>
                )}
                {m.topErrorType && (
                  <p className="text-xs text-muted-foreground">{t('healthBoard.qualityTopError', { error: m.topErrorType })}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
