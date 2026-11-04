// @vitest-environment jsdom
// Route-level error boundary: a page that throws while rendering shows the crash card instead of a
// white screen, logs the error, and "Try again" / "Back to models" recover without a reload.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { I18nProvider } from '@/i18n'
import { ErrorBoundary } from './error-boundary'

let root: Root
let container: HTMLDivElement
let consoleError: ReturnType<typeof vi.spyOn>

// React reports a render error to window even when a boundary catches it; jsdom turns that into an
// uncaught-error event. Swallow only the error this test throws on purpose, so anything else still fails.
const EXPECTED = 'cannot read properties of undefined (reading "models")'
function swallowExpected(e: ErrorEvent) {
  const message = String(e.error?.message ?? e.message ?? '')
  if (message.includes(EXPECTED) || String(e.error?.cause?.message ?? '').includes(EXPECTED)) e.preventDefault()
}

/** Throws while `state.broken` is true, renders normally once it is fixed. */
const state = { broken: true }
function FlakyPage() {
  if (state.broken) throw new Error(EXPECTED)
  return <p>page content</p>
}

function WhereAmI() {
  const loc = useLocation()
  return <p data-testid="where">{loc.pathname}</p>
}

function render() {
  act(() => root.render(
    <I18nProvider initialLocale="en">
      <MemoryRouter initialEntries={['/health']}>
        <Routes>
          <Route path="/health" element={<ErrorBoundary><FlakyPage /></ErrorBoundary>} />
          <Route path="/" element={<WhereAmI />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  ))
}

const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent === label)

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  state.broken = true
  // React and the boundary both log the caught error; keep the test output clean but observable.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  window.addEventListener('error', swallowExpected)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  consoleError.mockRestore()
  window.removeEventListener('error', swallowExpected)
})

describe('ErrorBoundary', () => {
  it('renders the page untouched when nothing throws', () => {
    state.broken = false
    render()
    expect(container.textContent).toContain('page content')
    expect(container.textContent).not.toContain('Something went wrong')
  })

  it('shows the crash card with the error message instead of a white screen, and logs it', () => {
    render()
    expect(container.textContent).toContain('Something went wrong')
    expect(container.querySelector('code')?.textContent).toBe(EXPECTED)
    expect(consoleError.mock.calls.some(c => c[0] === '[dashboard] page crashed:')).toBe(true)
  })

  it('"Try again" re-renders the page once it no longer throws', () => {
    render()
    state.broken = false
    act(() => button('Try again')!.click())
    expect(container.textContent).toContain('page content')
    expect(container.textContent).not.toContain('Something went wrong')
  })

  it('"Try again" on a page that still throws shows the crash card again, not a white screen', () => {
    render()
    act(() => button('Try again')!.click())
    expect(container.textContent).toContain('Something went wrong')
  })

  it('"Back to models" leaves the crashed page for the home route', () => {
    render()
    act(() => button('Back to models')!.click())
    expect(container.querySelector('[data-testid="where"]')?.textContent).toBe('/')
  })
})
