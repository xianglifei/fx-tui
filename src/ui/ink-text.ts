/**
 * Terminal-row measurement for plain Ink <Text> content.
 *
 * Ink wraps text at layout time with wrap-ansi's `{ trim: false, hard: true }`
 * (see ink/build/wrap-text.js), so counting the rows of the same wrap at the
 * same width yields the exact rendered height. App.tsx's splash-filler budget
 * depends on these numbers being exact: an overestimate creeps the input box
 * up one row per transcript item, an underestimate erases transcript rows.
 *
 * @module ui/ink-text
 */

import wrapAnsi from 'wrap-ansi'

/** The exact visual rows Ink renders for `text` as a plain Text at `columns`
 * cells. The chunks join back to the input verbatim (the wrap never drops
 * characters), which is what lets the editor map a code-point cursor column
 * onto its visual row. */
export function wrapTextRows(text: string, columns: number): string[] {
  return wrapAnsi(text, Math.max(8, columns), { trim: false, hard: true }).split('\n')
}

/** Terminal rows Ink renders for `text` as a plain Text at `columns` cells. */
export function textRows(text: string, columns: number): number {
  return wrapTextRows(text, columns).length
}
