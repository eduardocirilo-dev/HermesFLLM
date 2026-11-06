import { Braces, CircleHelp, PackageCheck, Repeat, ShieldCheck, Snowflake, Unplug } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'

// HermesFLLM sealed turns: half-turns Hermes never saw (a model that talked, then stalled or broke
// its tool call, failed over before anything reached the agent) and the failures that still reach
// it, which this feature drives toward zero.

export type SealKind = 'stall' | 'loop' | 'guard' | 'inline' | 'cut' | 'other'

export interface SealBoard {
  enabled: boolean
  releaseChars: number | null
  maxMs: number | null
  rescued24h: number
  rescued7d: number
  byKind24h: Record<SealKind, number>
  visibleFailures24h: number
  visibleFailures7d: number
  stallSavingMs: number
  sinceRestart: {
    turns: number
    whole: number
    held: number
    released: { answer: number; valve: number }
    rescued: Record<SealKind, number>
    since: string
  }
}

/** Order and icon of each kind on the card. */
export const SEAL_KINDS: Array<{ kind: SealKind; icon: typeof Snowflake }> = [
  { kind: 'stall', icon: Snowflake },
  { kind: 'guard', icon: ShieldCheck },
  { kind: 'inline', icon: Braces },
  { kind: 'cut', icon: Unplug },
  { kind: 'loop', icon: Repeat },
  { kind: 'other', icon: CircleHelp },
]

/** Whole minutes of freezing avoided: each stall caught inside the seal skips the committed wait. */
export function freezesAvoidedMinutes(stalls: number, savingMs: number): number {
  if (stalls <= 0 || savingMs <= 0) return 0
  return Math.floor((stalls * savingMs) / 60_000)
}

/** Zero is the goal: green at 0, amber for a few, red beyond. */
export function visibleTone(n: number): 'good' | 'warn' | 'bad' {
  if (n === 0) return 'good'
  if (n <= 3) return 'warn'
  return 'bad'
}

const toneText = { good: 'text-emerald-600 dark:text-emerald-400', warn: 'text-amber-600 dark:text-amber-400', bad: 'text-red-600 dark:text-red-400' }

export function SealedTurnsCard({ seal }: { seal: SealBoard }) {
  const { t } = useI18n()
  const tone = visibleTone(seal.visibleFailures24h)
  const minutes = freezesAvoidedMinutes(seal.byKind24h.stall, seal.stallSavingMs)
  const s = seal.sinceRestart
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <PackageCheck className={cn('h-4 w-4', seal.enabled ? 'text-violet-500' : 'text-muted-foreground')} />
          {t('healthBoard.sealTitle')}
          <Badge variant={seal.enabled ? 'default' : 'secondary'} className="ml-auto">
            {seal.enabled ? t('healthBoard.on') : t('healthBoard.off')}
          </Badge>
        </CardTitle>
        <p className="text-sm text-muted-foreground">{t('healthBoard.sealDescription')}</p>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-3">
        <div className="space-y-1">
          <p className="text-4xl font-semibold tabular-nums">{seal.rescued24h}</p>
          <p className="text-sm text-muted-foreground">{t('healthBoard.sealRescued', { week: seal.rescued7d })}</p>
          {minutes > 0 && (
            <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">{t('healthBoard.sealFreezes', { minutes })}</p>
          )}
        </div>

        <ul className="space-y-1 text-xs" aria-label={t('healthBoard.sealKinds')}>
          {SEAL_KINDS.map(({ kind, icon: Icon }) => {
            const n = seal.byKind24h[kind] ?? 0
            return (
              <li key={kind} className={cn('flex items-center gap-2', n === 0 && 'text-muted-foreground')}>
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{t(`healthBoard.seal_${kind}`)}</span>
                <span className="ml-auto font-medium tabular-nums">{n}</span>
              </li>
            )
          })}
        </ul>

        <div className="space-y-2">
          <div className="rounded-md border px-3 py-2">
            <p className="text-xs text-muted-foreground">{t('healthBoard.sealVisible')}</p>
            <p className={cn('text-2xl font-semibold tabular-nums', toneText[tone])}>{seal.visibleFailures24h}</p>
            <p className="text-[11px] text-muted-foreground">{t('healthBoard.sealVisibleWeek', { week: seal.visibleFailures7d })}</p>
          </div>
          {s.turns > 0 && (
            <p className="text-xs text-muted-foreground">
              {t('healthBoard.sealDeliveries', { turns: s.turns, held: s.held, answer: s.released.answer, valve: s.released.valve })}
            </p>
          )}
        </div>

        <p className="text-xs text-muted-foreground md:col-span-3">
          {seal.enabled
            ? t('healthBoard.sealHow', { chars: seal.releaseChars ?? 800, seconds: Math.round((seal.maxMs ?? 60_000) / 1000) })
            : t('healthBoard.sealOff')}
        </p>
      </CardContent>
    </Card>
  )
}
