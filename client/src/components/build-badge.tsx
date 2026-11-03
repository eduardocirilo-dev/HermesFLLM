import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

const BUILD = typeof __HERMESFLLM_BUILD__ !== 'undefined'
  ? __HERMESFLLM_BUILD__
  : { version: 'dev', commit: null, builtAt: '' }

/** "HermesFLLM v0.5.0 · c42d940 · updated 03/11/2026, 11:40" */
export function buildLabel(build: typeof BUILD, updatedWord: string, locale?: string): string {
  const parts = [`HermesFLLM v${build.version}`]
  if (build.commit) parts.push(build.commit)
  const at = Date.parse(build.builtAt)
  if (Number.isFinite(at)) {
    parts.push(`${updatedWord} ${new Date(at).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })}`)
  }
  return parts.join(' · ')
}

export function BuildBadge({ className }: { className?: string }) {
  const { t, locale } = useI18n()
  return (
    <p className={cn('text-xs text-muted-foreground tabular-nums', className)} title={BUILD.builtAt}>
      {buildLabel(BUILD, t('build.updated'), locale)}
    </p>
  )
}
