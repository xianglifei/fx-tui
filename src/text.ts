/**
 * Display-width text helpers shared by the store, the estimators, and the
 * views. This module sits below both `store.ts` and `ui/*` — either side may
 * import it, it imports nothing — which is what lets the store use these
 * without closing the store ↔ ui import cycle its duplicated private copies
 * used to work around.
 */

import stringWidth from 'string-width'

/** Truncate a single line to a display-width budget with a trailing `…`
 * (CJK-aware: the budget counts terminal cells, not code points). */
export function truncateLine(line: string, width: number): string {
  if (line === '') return ''
  if (stringWidth(line) <= width) return line
  let out = ''
  let w = 0
  for (const ch of Array.from(line)) {
    const cw = stringWidth(ch)
    if (w + cw > width) return `${out}…`
    out += ch
    w += cw
  }
  return out
}

/** Compact elapsed label (tool card headers, reasoning notices). */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`
}

/** Thousand-scaled token/char counts for the status surfaces. */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
