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
import { formatToolArgs, QUESTION_WINDOW } from '../store.js'
import { formatElapsed } from '../text.js'
import { renderFileDiffs } from '../diff.js'
import { renderMarkdownLines } from '../markdown.js'
import { BANNER_BOX_HEIGHT } from './Banner.js'
import { textRows } from './ink-text.js'

// Shared display-width helpers live in ../text.ts; re-exported here so the
// view-layer import paths stay unchanged.
export { formatElapsed, truncateLine } from '../text.js'

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

/** Rows of a settled compact tool card (== actual): one status header line
 * (wraps at full columns when a command is long — counted via textRows) plus
 * indented preview rows. No border box. Truncated preview lines render
 * exactly one row each, so only their count matters; diff lines keep their
 * ANSI coloring and may wrap, counted via textRows. */
function estimateToolCardHeight(item: ToolItem, width: number, columns: number): number {
  const glyph = item.ok ? '✓' : '✗'
  const elapsed = formatElapsed(item.elapsedMs)
  const view = item.view

  if (view !== undefined && view.card === 'diff') {
    const lines = renderFileDiffs(view.diffs)
    const { shown, hidden } = headTailPreview(lines, item.verbose ? Math.max(1, lines.length) : 8)
    return textRows(`${glyph} ${view.title ?? item.title} · ${elapsed}`, columns) +
      shown.reduce((n, line) => n + textRows(`  ${line === '' ? ' ' : line}`, columns), 0) +
      (hidden > 0 ? 1 : 0)
  }
  if (view !== undefined && view.card === 'terminal') {
    const status = item.exitCode !== undefined
      ? (item.exitCode === 0 ? 'exit 0' : `exit ${item.exitCode}`)
      : item.signal !== undefined ? item.signal : ''
    const output = view.output ?? item.result
    const { shown, hidden } = headTailPreview(output.split('\n'), item.verbose ? 400 : 5)
    const exitGlyph = item.ok && item.exitCode !== 1 ? '✓' : '✗'
    return textRows(`${exitGlyph} ${view.title ?? item.title} · ${elapsed}${status !== '' ? ` · ${status}` : ''}`, columns) +
      shown.length + (hidden > 0 ? 1 : 0)
  }
  if (view !== undefined && view.card === 'search') {
    const summary = view.shape === 'matches'
      ? `${view.files.length} 个文件 · ${view.total} 处匹配${view.truncated ? '（已截断）' : ''}`
      : `${view.paths.length} 个路径${view.truncated ? ` / 共 ${view.total}（已截断）` : ''}`
    const header = textRows(`${glyph} ${view.title ?? item.title} · ${summary} · ${elapsed}`, columns)
    if (view.shape !== 'paths') return header
    const { shown, hidden } = headTailPreview(view.paths, item.verbose ? 200 : 3)
    return header + shown.length + (hidden > 0 ? 1 : 0)
  }
  if (view !== undefined && view.card === 'read') {
    return textRows(`${glyph} ${view.title ?? `读 ${view.path}`} · 行 ${view.offset}–${view.offset + view.lines.length - 1} / ${view.totalLines} · ${elapsed}`, columns)
  }
  if (view !== undefined && view.card === 'web') {
    const summary = view.kind === 'search'
      ? `${view.sources.length} 个来源${view.truncated ? '（已截断）' : ''}`
      : `HTTP ${view.statusCode}${view.truncated ? '（内容已截断）' : ''}`
    const header = textRows(`${glyph} ${view.title ?? 'web'} · ${summary} · ${elapsed}`, columns)
    if (view.kind !== 'search') return header
    const { shown, hidden } = headTailPreview(view.sources.map(source => source.title ?? source.url), 3)
    return header + shown.length + (hidden > 0 ? 1 : 0)
  }
  // Generic / fallback card: header may embed the args preview.
  const args = formatToolArgs(item.args, Math.max(16, width - 10))
  const { shown, hidden } = headTailPreview(item.result.split('\n'), item.verbose ? 400 : 5)
  return textRows(`${glyph} ${item.title}${args !== '' ? ` ${args}` : ''} · ${elapsed}`, columns) +
    shown.length + (hidden > 0 ? 1 : 0)
}

/** Estimated rows of the question/approval card (== actual). Mirrors the
 * view's visible-window slicing: only the QUESTION_WINDOW options in the
 * current scroll window render, plus ▲/▼ overflow indicator rows. */
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
  const cursor = question.cursor ?? 0
  const scroll = question.scroll ?? 0
  if (scroll > 0) h += 1
  if (scroll + QUESTION_WINDOW < options.length) h += 1
  options.slice(scroll, scroll + QUESTION_WINDOW).forEach((option, visibleIndex) => {
    h += textRows(questionOptionRow(option, visibleIndex, {
      selected: question.selected.includes(option.label),
      isApprove: approveLabel !== undefined && option.label === approveLabel,
      cursor: scroll + visibleIndex === cursor,
    }), inner)
  })
  return h + textRows(questionHintText(isPlanReview, item.multiSelect === true), inner)
}

/** The question card's footer hint; the view and this estimator must render
 * the same string so the wrapped row count matches the budget. */
export function questionHintText(isPlanReview: boolean, multiSelect: boolean): string {
  return isPlanReview
    ? '↑↓ 选择 · Enter 批准 · Esc 跳过'
    : multiSelect
      ? '↑↓ 移动 · 数字键多选 · Enter 确认 · Esc 跳过'
      : '↑↓ 选择 · 数字键直选 · Enter 确认 · Esc 跳过'
}

/** Visible text of one question option row: cursor marker + visible-window
 * number + selection marker + label (+ description). The view renders this
 * string (colorized), the estimator budgets its wrapped rows — shared so the
 * two can never drift. */
export function questionOptionRow(
  option: { label: string; description?: string },
  visibleIndex: number,
  state: { selected: boolean; isApprove: boolean; cursor: boolean },
): string {
  return `${state.cursor ? '❯ ' : '  '}[${visibleIndex + 1}]${state.selected ? ' ● ' : ' ○ '}${state.isApprove ? '✓ ' : ''}${option.label}` +
    (option.description !== undefined ? ` — ${option.description}` : '')
}

/** Head+tail preview of a line list (Codex's output ellipsis): keep the first
 * cap−1 lines and the last one — the tail often carries the error or result
 * summary — and report how many middle lines were hidden. */
export function headTailPreview(lines: readonly string[], cap: number): { shown: string[]; hidden: number } {
  if (lines.length <= cap) return { shown: [...lines], hidden: 0 }
  if (cap <= 1) return { shown: [lines[lines.length - 1]!], hidden: lines.length - 1 }
  return {
    shown: [...lines.slice(0, cap - 1), lines[lines.length - 1]!],
    hidden: lines.length - cap,
  }
}

/** The approval card's choice line as one plain string; ApprovalView renders
 * the same text as colored segments, and the estimator budgets its wrapped
 * rows (it can wrap on narrow terminals — a flat +1 would under-count). */
export const APPROVAL_CHOICES_TEXT = '[y] 允许一次  [s] 本会话不再问  [a] 总是允许（记住）  [n] 拒绝'

/** Estimated rows of the approval prompt (== actual). */
export function estimateApprovalHeight(prompt: ApprovalPrompt, columns: number): number {
  const inner = Math.max(8, columns - 4)
  let h = 2 + textRows(`需要批准：${prompt.toolName}`, inner)
  if (prompt.command !== undefined && prompt.command !== '') h += textRows(`  ${prompt.command}`, inner)
  if (prompt.reason !== '') h += textRows(prompt.reason, inner)
  return h + textRows(APPROVAL_CHOICES_TEXT, inner)
}
