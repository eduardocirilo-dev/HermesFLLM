import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, Brain, Clock, Flame, Radar, ShieldCheck, ShieldOff, Trophy, XCircle, Zap } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { BuildBadge } from '@/components/build-badge'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'

export interface HealthBoard {
  policy: { strategy: string; weights: { reliability: number; speed: number; intelligence: number }; minReliability: number | null }
  curation: {
    intervalMinutes: number
    maxProbesPerRound: number
    verdictTtlMinutes: number
    dailyCapPerPlatform: number
    lastRound: { at: string; results: Array<{ platform: string; modelId: string; reason: string; status: string; latencyMs?: number }> } | null
    nextRoundAt: string | null
    urgentQueued: number
    probesToday: number
    reserve: Array<{ platform: string; modelId: string; name: string; lastStatus: string | null; lastProbedAt: string | null }>
    probedModels: number
    working: number
    excluded: Array<{ platform: string; modelId: string; name: string; reason: string | null; lastProbedAt: string }>
  }
  agentGuard: { enabled: boolean; savedLast24h: number; savedLast7d: number }
  race?: { enabled: boolean; races: number; backupWins: number; primaryWins: number; bothFailed: number; backupWinMs: number; since: string; minDelayMs: number; maxDelayMs: number }
  traffic: { requests24h: number; successRate24h: number | null }
  topModels: Array<{ platform: string; modelId: string; name: string; intelligenceRank: number | null; requests: number; successRate: number; avgLatencyMs: number | null }>
}

const pct = (v: number) => `${Math.round(v * 100)}%`

/** Green at ≥95%, amber at ≥80%, red below: the same thresholds an operator reads at a glance. */
export function healthTone(rate: number | null): 'good' | 'warn' | 'bad' | 'none' {
  if (rate === null) return 'none'
  if (rate >= 0.95) return 'good'
  if (rate >= 0.8) return 'warn'
  return 'bad'
}

const toneText = { good: 'text-emerald-500', warn: 'text-amber-500', bad: 'text-red-500', none: 'text-muted-foreground' }
const toneBar = { good: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-red-500', none: 'bg-muted' }

export function formatCountdown(targetIso: string | null, now: number): string | null {
  if (!targetIso) return null
  const ms = Date.parse(targetIso) - now
  if (!Number.isFinite(ms)) return null
  if (ms <= 0) return '0m'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

/** Shares of the race outcomes, for the stacked bar. Empty when no race ran. */
export function raceShares(race: { races: number; backupWins: number; primaryWins: number; bothFailed: number }) {
  if (race.races <= 0) return []
  return [
    { key: 'backup', share: race.backupWins / race.races, className: 'bg-emerald-500' },
    { key: 'primary', share: race.primaryWins / race.races, className: 'bg-sky-500' },
    { key: 'both', share: race.bothFailed / race.races, className: 'bg-red-500' },
  ].filter(s => s.share > 0)
}

function RaceCard({ race, now }: { race: NonNullable<HealthBoard['race']>; now: number }) {
  const { t } = useI18n()
  const shares = raceShares(race)
  const avgS = race.backupWins > 0 ? (race.backupWinMs / race.backupWins / 1000).toFixed(1) : null
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Zap className={cn('h-4 w-4', race.enabled ? 'text-amber-500' : 'text-muted-foreground')} />
          {t('healthBoard.raceTitle')}
          <Badge variant={race.enabled ? 'default' : 'secondary'} className="ml-auto">
            {race.enabled ? t('healthBoard.on') : t('healthBoard.off')}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-4xl font-semibold tabular-nums">{race.backupWins}</p>
        <p className="text-muted-foreground">{t('healthBoard.raceRescued', { since: formatAgo(race.since, now) })}</p>
        {shares.length > 0 ? (
          <>
            <div className="flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
              {shares.map(s => <div key={s.key} className={cn('h-full transition-all', s.className)} style={{ width: `${s.share * 100}%` }} />)}
            </div>
            <p className="text-xs text-muted-foreground">
              {t('healthBoard.raceSummary', { races: race.races, backup: race.backupWins, primary: race.primaryWins, both: race.bothFailed })}
            </p>
            {avgS && <p className="text-xs text-muted-foreground">{t('healthBoard.raceAvg', { seconds: avgS })}</p>}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">{t('healthBoard.raceIdle')}</p>
        )}
        <p className="text-xs text-muted-foreground">
          {t('healthBoard.raceDelay', { min: Math.round(race.minDelayMs / 1000), max: Math.round(race.maxDelayMs / 1000) })}
        </p>
      </CardContent>
    </Card>
  )
}

export function formatAgo(iso: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(iso))
  const m = Math.floor(ms / 60_000)
  return m < 1 ? '<1m' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Big circular gauge for the 24h success rate. */
function PulseRing({ rate, label }: { rate: number | null; label: string }) {
  const tone = healthTone(rate)
  const r = 54
  const c = 2 * Math.PI * r
  const filled = rate === null ? 0 : c * rate
  return (
    <div className="relative h-36 w-36 shrink-0" role="img" aria-label={`${label}: ${rate === null ? '—' : pct(rate)}`}>
      <svg viewBox="0 0 128 128" className="h-full w-full -rotate-90">
        <circle cx="64" cy="64" r={r} fill="none" strokeWidth="10" className="stroke-muted" />
        <circle
          cx="64" cy="64" r={r} fill="none" strokeWidth="10" strokeLinecap="round"
          strokeDasharray={`${filled} ${c}`}
          className={cn('transition-[stroke-dasharray] duration-700', {
            'stroke-emerald-500': tone === 'good', 'stroke-amber-500': tone === 'warn', 'stroke-red-500': tone === 'bad',
          })}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={cn('text-3xl font-semibold tabular-nums', toneText[tone])}>{rate === null ? '—' : pct(rate)}</span>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      {tone === 'good' && <span className="absolute inset-0 rounded-full animate-ping bg-emerald-500/10 [animation-duration:3s]" aria-hidden />}
    </div>
  )
}

function WeightBar({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-2">{icon}{label}</span>
        <span className="tabular-nums text-muted-foreground">{pct(value)}</span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full bg-primary transition-[width] duration-700" style={{ width: pct(value) }} />
      </div>
    </div>
  )
}

export default function HealthBoardPage() {
  const { t } = useI18n()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const { data, isLoading, isError } = useQuery({
    queryKey: ['health-board'],
    queryFn: () => apiFetch<HealthBoard>('/api/curation'),
    refetchInterval: 30_000,
  })

  return (
    <div className="space-y-6">
      <PageHeader title={t('healthBoard.title')} description={t('healthBoard.description')} />
      <BuildBadge className="-mt-4" />

      {isError && <p className="text-sm text-red-500">{t('healthBoard.loadError')}</p>}
      {isLoading || !data ? (
        <div className="grid gap-4 md:grid-cols-3">
          {[0, 1, 2].map(i => <Skeleton key={i} className="h-48" />)}
        </div>
      ) : (
        <>
          <div className={cn('grid gap-4 md:grid-cols-2', data.race ? 'xl:grid-cols-4' : 'xl:grid-cols-3')}>
            <Card>
              <CardContent className="flex items-center gap-5 pt-6">
                <PulseRing rate={data.traffic.successRate24h} label={t('healthBoard.success24h')} />
                <div className="space-y-1 text-sm">
                  <p className="text-2xl font-semibold tabular-nums">{data.traffic.requests24h}</p>
                  <p className="text-muted-foreground">{t('healthBoard.requests24h')}</p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  {data.agentGuard.enabled ? <ShieldCheck className="h-4 w-4 text-emerald-500" /> : <ShieldOff className="h-4 w-4 text-muted-foreground" />}
                  {t('healthBoard.guardTitle')}
                  <Badge variant={data.agentGuard.enabled ? 'default' : 'secondary'} className="ml-auto">
                    {data.agentGuard.enabled ? t('healthBoard.on') : t('healthBoard.off')}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-4xl font-semibold tabular-nums">{data.agentGuard.savedLast24h}</p>
                <p className="text-sm text-muted-foreground">{t('healthBoard.guardSaved', { week: data.agentGuard.savedLast7d })}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Radar className="h-4 w-4 text-emerald-500 animate-[spin_6s_linear_infinite]" />{t('healthBoard.curationTitle')}
                  {data.curation.urgentQueued > 0 && (
                    <Badge variant="destructive" className="ml-auto">{t('healthBoard.urgent', { count: data.curation.urgentQueued })}</Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="text-4xl font-semibold tabular-nums">{data.curation.probesToday}</p>
                <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  <ShieldCheck className="h-3.5 w-3.5" />{t('healthBoard.agentProbe')}
                </p>
                <p className="text-muted-foreground">
                  {t('healthBoard.probesToday', { next: formatCountdown(data.curation.nextRoundAt, now) ?? '—', max: data.curation.maxProbesPerRound, every: data.curation.intervalMinutes })}
                </p>
                <p className="text-muted-foreground">
                  {t('healthBoard.probed', { working: data.curation.working, total: data.curation.probedModels })}
                </p>
              </CardContent>
            </Card>

            {data.race && <RaceCard race={data.race} now={now} />}
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base"><Trophy className="h-4 w-4 text-amber-500" />{t('healthBoard.topTitle')}</CardTitle>
              </CardHeader>
              <CardContent>
                {data.topModels.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('healthBoard.noTraffic')}</p>
                ) : (
                  <ol className="space-y-3">
                    {data.topModels.map((m, i) => {
                      const tone = healthTone(m.successRate)
                      return (
                        <li key={`${m.platform}/${m.modelId}`} className="grid grid-cols-[1.5rem_1fr_auto] items-center gap-3">
                          <span className="text-sm tabular-nums text-muted-foreground">{i + 1}</span>
                          <div className="min-w-0 space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium" title={`${m.platform}/${m.modelId}`}>{m.name}</span>
                              {m.intelligenceRank !== null && (
                                <Badge variant="outline" className="shrink-0 gap-1"><Brain className="h-3 w-3" />{m.intelligenceRank}</Badge>
                              )}
                            </div>
                            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                              <div className={cn('h-full rounded-full transition-[width] duration-700', toneBar[tone])} style={{ width: pct(m.successRate) }} />
                            </div>
                          </div>
                          <div className="text-right text-xs tabular-nums">
                            <span className={cn('font-semibold', toneText[tone])}>{pct(m.successRate)}</span>
                            <span className="block text-muted-foreground">
                              {m.requests} · {m.avgLatencyMs !== null ? `${(m.avgLatencyMs / 1000).toFixed(1)}s` : '—'}
                            </span>
                          </div>
                        </li>
                      )
                    })}
                  </ol>
                )}
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base"><Activity className="h-4 w-4" />{t('healthBoard.policyTitle')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <WeightBar icon={<ShieldCheck className="h-3.5 w-3.5" />} label={t('healthBoard.reliability')} value={data.policy.weights.reliability} />
                  <WeightBar icon={<Brain className="h-3.5 w-3.5" />} label={t('healthBoard.intelligence')} value={data.policy.weights.intelligence} />
                  <WeightBar icon={<Clock className="h-3.5 w-3.5" />} label={t('healthBoard.speed')} value={data.policy.weights.speed} />
                  <p className="text-xs text-muted-foreground">
                    {t('healthBoard.policyFoot', {
                      strategy: data.policy.strategy,
                      floor: data.policy.minReliability === null ? '—' : pct(data.policy.minReliability),
                    })}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Flame className="h-4 w-4 text-orange-500" />{t('healthBoard.reserveTitle')}
                    <Badge variant="outline" className="ml-auto gap-1 text-[10px]"><ShieldCheck className="h-3 w-3" />{t('healthBoard.agentTested')}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {data.curation.reserve.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('healthBoard.noReserve')}</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {data.curation.reserve.map(m => (
                        <li key={`${m.platform}/${m.modelId}`} className="flex items-center gap-2 text-sm">
                          <span
                            className={cn('h-2 w-2 shrink-0 rounded-full', {
                              'bg-emerald-500': m.lastStatus === 'working',
                              'bg-red-500': m.lastStatus === 'unavailable',
                              'bg-muted-foreground/40': m.lastStatus === null,
                            })}
                            aria-label={m.lastStatus ?? t('healthBoard.notProbed')}
                          />
                          <span className="truncate" title={`${m.platform}/${m.modelId}`}>{m.name}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {data.curation.lastRound && data.curation.lastRound.results.length > 0 && (
                    <div className="mt-3 border-t pt-2 text-xs text-muted-foreground">
                      <p className="mb-1">{t('healthBoard.lastRound', { ago: formatAgo(data.curation.lastRound.at, now) })}</p>
                      <ul className="space-y-0.5">
                        {data.curation.lastRound.results.map(r => (
                          <li key={`${r.platform}/${r.modelId}`} className="flex justify-between gap-2">
                            <span className="truncate">{r.modelId}</span>
                            <span className={cn('shrink-0', r.status === 'working' ? 'text-emerald-500' : r.status === 'unavailable' ? 'text-red-500' : '')}>
                              {r.status === 'working' && r.latencyMs !== undefined ? `${(r.latencyMs / 1000).toFixed(1)}s` : r.status}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base"><XCircle className="h-4 w-4 text-red-500" />{t('healthBoard.excludedTitle')}</CardTitle>
                </CardHeader>
                <CardContent>
                  {data.curation.excluded.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('healthBoard.noneExcluded')}</p>
                  ) : (
                    <ul className="space-y-2">
                      {data.curation.excluded.map(m => (
                        <li key={`${m.platform}/${m.modelId}`} className="text-sm">
                          <span className="font-medium">{m.name}</span>
                          {m.reason && <span className="block truncate text-xs text-muted-foreground" title={m.reason}>{m.reason}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
