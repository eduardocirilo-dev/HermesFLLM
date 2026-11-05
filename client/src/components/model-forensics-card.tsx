import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDownToLine, Hourglass, Undo2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'

// HermesFLLM model forensics: which model costs the agent time, why, and a one-click demotion.
// Every failed attempt is time the agent waited for nothing before failover; this ranks models by
// that time over 24h, so the diagnosis that used to take SQL against the database is on the board.

export type Cause = 'stall' | 'runaway' | 'guard' | 'deadline' | 'rateLimit' | 'other'

export interface ModelForensics {
  platform: string
  modelId: string
  name: string
  requests: number
  successes: number
  failed: number
  wastedMs: number
  avgFirstMs: number | null
  causes: Record<Cause, number>
  demotion: number | null
}

export interface ForensicsResponse {
  totalWastedMs: number
  totalFailed: number
  models: ModelForensics[]
}

export const CAUSES: Array<{ key: Cause; className: string }> = [
  { key: 'stall', className: 'bg-amber-500' },
  { key: 'runaway', className: 'bg-fuchsia-500' },
  { key: 'guard', className: 'bg-rose-500' },
  { key: 'deadline', className: 'bg-sky-500' },
  { key: 'rateLimit', className: 'bg-slate-400' },
  { key: 'other', className: 'bg-zinc-500' },
]

/** healthBoard.causeStall, healthBoard.causeRateLimit, ... */
export const causeLabelKey = (cause: Cause) => `healthBoard.cause${cause[0].toUpperCase()}${cause.slice(1)}`

/** 42s, 3m 12s, 1h 05m: short enough for a table cell. */
export function formatDuration(ms: number): string {
  const s = Math.round(Math.max(0, ms) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** Bar segments for one model: each cause's share of its failed attempts, empty causes dropped. */
export function causeSegments(m: Pick<ModelForensics, 'failed' | 'causes'>) {
  if (m.failed <= 0) return []
  return CAUSES
    .map(c => ({ ...c, count: m.causes[c.key] ?? 0, share: (m.causes[c.key] ?? 0) / m.failed }))
    .filter(c => c.count > 0)
}

export function ModelForensicsCard() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const { data, isLoading, isError } = useQuery({
    queryKey: ['model-forensics'],
    queryFn: () => apiFetch<ForensicsResponse>('/api/curation/forensics'),
    refetchInterval: 60_000,
  })
  const demote = useMutation({
    mutationFn: (v: { modelId: string; demote: boolean }) =>
      apiFetch('/api/curation/demotions', { method: 'PUT', body: JSON.stringify(v) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['model-forensics'] }),
  })

  const worst = data?.models[0]?.wastedMs ?? 0

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Hourglass className="h-4 w-4 text-amber-500" />
          {t('healthBoard.forensicsTitle')}
          {data && data.totalFailed > 0 && (
            <Badge variant="outline" className="ml-auto tabular-nums">
              {t('healthBoard.forensicsTotal', { time: formatDuration(data.totalWastedMs), failed: data.totalFailed })}
            </Badge>
          )}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{t('healthBoard.forensicsDescription')}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {isError && <p className="text-sm text-red-500">{t('healthBoard.loadError')}</p>}
        {isLoading && <Skeleton className="h-24" />}
        {data && data.models.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('healthBoard.forensicsEmpty')}</p>
        )}
        {data && data.models.length > 0 && (
          <>
            <ol className="space-y-3">
              {data.models.map(m => {
                const width = worst > 0 ? Math.max(4, (m.wastedMs / worst) * 100) : 0
                return (
                  <li key={`${m.platform}/${m.modelId}`} className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(0,14rem)_1fr_auto_auto] sm:gap-4">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 truncate text-sm font-medium" title={`${m.platform}/${m.modelId}`}>
                        <span className="truncate">{m.name}</span>
                        {m.demotion !== null && (
                          <Badge variant="secondary" className="shrink-0 tabular-nums">×{m.demotion}</Badge>
                        )}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {m.platform} · {t('healthBoard.forensicsFailed', { failed: m.failed, requests: m.requests })}
                      </p>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                      <div className="flex h-full overflow-hidden rounded-full transition-[width] duration-700" style={{ width: `${width}%` }}>
                        {causeSegments(m).map(s => (
                          <div key={s.key} className={cn('h-full', s.className)} style={{ width: `${s.share * 100}%` }} title={`${t(causeLabelKey(s.key))}: ${s.count}`} />
                        ))}
                      </div>
                    </div>
                    <span className="text-sm font-semibold tabular-nums sm:text-right">{formatDuration(m.wastedMs)}</span>
                    {m.demotion === null ? (
                      <Button
                        size="sm" variant="outline" className="gap-1.5"
                        disabled={demote.isPending}
                        onClick={() => demote.mutate({ modelId: m.modelId, demote: true })}
                      >
                        <ArrowDownToLine className="h-3.5 w-3.5" />{t('healthBoard.forensicsDemote')}
                      </Button>
                    ) : (
                      <Button
                        size="sm" variant="ghost" className="gap-1.5"
                        disabled={demote.isPending}
                        onClick={() => demote.mutate({ modelId: m.modelId, demote: false })}
                      >
                        <Undo2 className="h-3.5 w-3.5" />{t('healthBoard.forensicsRestore')}
                      </Button>
                    )}
                  </li>
                )
              })}
            </ol>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {CAUSES.map(c => (
                <span key={c.key} className="flex items-center gap-1.5">
                  <span className={cn('h-2 w-2 rounded-full', c.className)} />{t(causeLabelKey(c.key))}
                </span>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t('healthBoard.forensicsHint')}</p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
