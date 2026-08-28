/**
 * Exact rendered-row estimators for settled transcript items and the live
 * region, shared by the App splash filler and the resize rebuild (index.ts),
 * which must budget a replayed tail of transcript against the viewport.
 *
 * Every estimator replicates Ink's own wrap (wrap-ansi, {trim:false,
 * hard:true}) at the same width the view wraps at, so sizing errs on neither
 * side: a systematic overestimate would creep the input box up one row per
 * transcript item, an underestimate would push the frame top into the Static
 * region and erase transcript rows.
 */

import stringWidth from 'string-width'
import wrapAnsi from 'wrap-ansi'
import type { ActiveQuestion, ApprovalPrompt, FinalItem, ToolItem } from '../store.js'
import { formatToolArgs } from '../store.js'
import { renderFileDiffs } from '../diff.js'
import { renderMarkdownLines } from '../markdown.js'
import { BANNER_BOX_HEIGHT } from './Banner.js'
import { textRows } from './ink-text.js'

/** Prompt glyph prefixing every user-message row. */
export const USER_PROMPT = '❯ '

/**
 * Full-gutter rows of a settled user message: each source line hard-wraps at
 * the terminal edge (same wrap Ink applies to plain Texts) and every visual
 * row is padded to the full width, so the tinted bar spans the whole line and
 * never soft-wraps into a second, unpadded row.
 */
export function userBarRows(text: string, columns: number): readonly string[] {
  const width = Math.max(24, columns)
  const rows: string[] = []
  for (const line of text.split('\n')) {
    const wrapped = wrapAnsi(`${USER_PROMPT}${line}`, width, { hard: true, trim: false })
    for (const row of wrapped.split('\n')) {
      const pad = width - stringWidth(row)
      rows.push(pad > 0 ? row + ' '.repeat(pad) : row)
    }
  }
  return rows
}

/** Estimated rendered rows of one settled transcript item (== actual).
 * `width` is the markdown wrap width (terminal columns − 2); plain Texts wrap
 * at the full `columns`, boxed cards at `columns − 4` (borders + paddingX). */
export function estimateItemHeight(item: FinalItem, width: number, columns: number): number {
  switch (item.kind) {
    case 'banner':
      return BANNER_BOX_HEIGHT
    case 'user':
      // Exact: the bar wraps each source line with the same wrap-ansi options
      // Ink applies, then pads every row to the full width (padding cannot
      // re-wrap); +1 for the lead gap row.
      return 1 + userBarRows(item.text, columns).length +
        (item.images?.length ?? 0)
    case 'assistant':
      // Exact: the same renderer the view uses; its lines fit within `width`.
      // +1 lead gap row above every reply.
      return 1 + renderMarkdownLines(item.text, width).length + (item.interrupted ? 1 : 0)
    case 'notice':
      return textRows(`${item.tone === 'error' ? '✗' : item.tone === 'warn' ? '⚠' : '·'} ${item.text}`, columns)
    case 'panel':
      return 2 + textRows(item.title, columns - 4) +
        item.lines.reduce((n, line) => n + textRows(line, columns - 4), 0)
    case 'tool':
      // +1 lead gap row, mirroring ToolCardView's wrapper.
      return 1 + estimateToolCardHeight(item, width, columns)
  }
}

/** Rows of a settled tool card, mirroring ToolCardView's caps and truncation.
 * Shown lines are pre-truncated by the view to `width − 4` cells, so each
 * renders exactly one row and only their count matters. */
function estimateToolCardHeight(item: ToolItem, width: number, columns: number): number {
  const inner = Math.max(8, columns - 4)
  const view = item.view
  const title = `${item.ok ? '✓' : '✗'} ${view?.title ?? item.title}`
  const elapsed = formatElapsed(item.elapsedMs)
  /** Rows of a capped line list plus the view's "…还有 N 行" overflow notice. */
  const cappedRows = (count: number, cap: number): number =>
    Math.min(count, cap) + (count > cap ? 1 : 0)

  if (view !== undefined && view.card === 'diff') {
    const lines = renderFileDiffs(view.diffs)
    const shown = item.verbose ? lines : lines.slice(0, 24)
    const rows = shown.reduce((n, line) => n + textRows(line === '' ? ' ' : line, inner), 0)
    return 2 + textRows(`${title} · ${elapsed}`, inner) + rows +
      (lines.length > shown.length ? 1 : 0)
  }
  if (view !== undefined && view.card === 'terminal') {
    const output = view.output ?? item.result
    return 2 + textRows(`${title} · ${elapsed}`, inner) +
      cappedRows(output.split('\n').length, item.verbose ? 400 : 12)
  }
  if (view !== undefined && view.card === 'search') {
    const summary = view.shape === 'matches'
      ? `${view.files.length} 个文件 · ${view.total} 处匹配${view.truncated ? '（已截断）' : ''}`
      : `${view.paths.length} 个路径${view.truncated ? ` / 共 ${view.total}（已截断）` : ''}`
    const extra = view.shape === 'paths' ? cappedRows(view.paths.length, item.verbose ? 200 : 8) : 0
    return 2 + textRows(`${title} · ${summary} · ${elapsed}`, inner) + extra
  }
  if (view !== undefined && view.card === 'read') {
    const header = `· 行 ${view.offset}–${view.offset + view.lines.length - 1} / ${view.totalLines} · ${elapsed}`
    return 2 + textRows(`${title} ${header}`, inner)
  }
  if (view !== undefined && view.card === 'web') {
    const summary = view.kind === 'search'
      ? `${view.sources.length} 个来源${view.truncated ? '（已截断）' : ''}`
      : `HTTP ${view.statusCode}${view.truncated ? '（内容已截断）' : ''}`
    const sourceRows = view.kind === 'search' ? Math.min(view.sources.length, 5) : 0
    return 2 + textRows(`${title} · ${summary} · ${elapsed}`, inner) + sourceRows
  }
  // Generic / fallback card: title + args preview + capped result lines.
  const args = formatToolArgs(item.args, Math.max(16, width - 10))
  return 2 + textRows(`${title} ${args} · ${elapsed}`, inner) +
    cappedRows(item.result.split('\n').length, item.verbose ? 400 : 12)
}

/** Estimated rows of the question/approval card (== actual). */
export function estimateQuestionHeight(question: ActiveQuestion, width: number, columns: number): number {
  const item = question.item
  const inner = Math.max(8, columns - 4)
  const intent = item.intent
  const isPlanReview = intent?.kind === 'plan-review'
  const approveLabel = isPlanReview ? intent.approve : undefined
  const title = isPlanReview
    ? `计划审批：${item.question}`
    : `问 题${question.total > 1 ? `（${question.index}/${question.total}）` : ''}：${item.question}`
  let h = 2 + textRows(title, inner)
  if (item.header !== undefined && item.header !== '') h += textRows(item.header, inner)
  if (item.detail !== undefined && item.detail !== '') {
    if (isPlanReview) {
      const planLines = renderMarkdownLines(item.detail, Math.max(24, width - 4))
      h += Math.min(planLines.length, 30) + (planLines.length > 30 ? 1 : 0)
    } else {
      h += 1 // the view truncates the detail to a single line
    }
  }
  const options = item.options ?? []
  options.forEach((option, index) => {
    const isApprove = approveLabel !== undefined && option.label === approveLabel
    const row = `[${index + 1}] ● ${isApprove ? '✓ ' : ''}${option.label}` +
      (option.description !== undefined ? ` — ${option.description}` : '')
    h += textRows(row, inner)
  })
  return h + 1 // hint row
}

/** Estimated rows of the approval prompt (== actual). */
export function estimateApprovalHeight(prompt: ApprovalPrompt, columns: number): number {
  const inner = Math.max(8, columns - 4)
  let h = 2 + textRows(`需要批准：${prompt.toolName}`, inner)
  if (prompt.command !== undefined && prompt.command !== '') h += textRows(`  ${prompt.command}`, inner)
  if (prompt.reason !== '') h += textRows(prompt.reason, inner)
  return h + 1 // choice row
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`
}

export function truncateLine(line: string, width: number): string {
  if (line === '') return ''
  let out = ''
  let w = 0
  for (const ch of Array.from(line)) {
    const cw = charWidth(ch)
    if (w + cw > width) return `${out}…`
    out += ch
    w += cw
  }
  return out
}

function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x2fffd) ||
    (code >= 0x30000 && code <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}
