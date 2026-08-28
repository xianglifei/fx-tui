/**
 * Markdown-to-ANSI renderer for the transcript.
 *
 * Built on the marked lexer, with cli-highlight for code blocks and
 * wrap-ansi/string-width for CJK-aware wrapping. Output is pre-styled plain
 * text, one string per terminal line, ready for Ink <Text> children.
 */

import chalk from 'chalk'
import { highlight } from 'cli-highlight'
import { marked } from 'marked'
import type { Token, Tokens } from 'marked'
import stringWidth from 'string-width'
import wrapAnsi from 'wrap-ansi'
import { theme } from './ui/theme.js'

export function renderMarkdownLines(md: string, width: number): string[] {
  const out: string[] = []
  try {
    for (const token of marked.lexer(md)) renderBlock(token, out, width)
  } catch {
    out.push(...md.split('\n'))
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.length > 0 ? out : [' ']
}

/**
 * One blank row between blocks, never more: marked emits `space` tokens for
 * blank-line runs ON TOP OF each block's own trailing separator, so naive
 * `push('')` stacking renders double-height gaps inside a reply. Blocks at the
 * very start of a reply get no leading blank either — message-boundary spacing
 * is App.tsx's job, kept uniform with it.
 */
function pushBlank(out: string[]): void {
  if (out.length === 0 || out[out.length - 1] === '') return
  out.push('')
}

function renderBlock(token: Token, out: string[], width: number): void {
  switch (token.type) {
    case 'heading': {
      const t = token as Tokens.Heading
      out.push(...wrap(theme.md.heading(inline(t.tokens)), width, 0))
      pushBlank(out)
      break
    }
    case 'paragraph': {
      const t = token as Tokens.Paragraph
      out.push(...wrap(inline(t.tokens), width, 0))
      pushBlank(out)
      break
    }
    case 'code': {
      const t = token as Tokens.Code
      const rule = chalk.dim('─'.repeat(Math.max(8, Math.min(width, 72))))
      out.push(rule)
      const code = t.lang !== undefined && t.lang !== '' && t.lang !== 'text'
        ? safeHighlight(t.text, t.lang)
        : t.text
      for (const line of code.split('\n')) {
        out.push(...wrap(line, width, 2))
      }
      out.push(rule)
      pushBlank(out)
      break
    }
    case 'list': {
      const t = token as Tokens.List
      const innerWidth = Math.max(12, width - 2)
      t.items.forEach((item, index) => {
        const marker = item.task
          ? (item.checked === true ? '☑ ' : '☐ ')
          : t.ordered
            ? `${(typeof t.start === 'number' ? t.start : 1) + index}. `
            : '• '
        const body: string[] = []
        for (const child of item.tokens) renderBlock(child, body, innerWidth)
        out.push(marker + (body[0] ?? ''))
        for (const line of body.slice(1)) out.push(`  ${line}`)
      })
      pushBlank(out)
      break
    }
    case 'blockquote': {
      const t = token as Tokens.Blockquote
      const inner: string[] = []
      for (const child of t.tokens) renderBlock(child, inner, Math.max(12, width - 2))
      for (const line of inner) out.push(`${chalk.dim('│ ')}${chalk.dim(line)}`)
      pushBlank(out)
      break
    }
    case 'hr': {
      out.push(chalk.dim('─'.repeat(width)))
      pushBlank(out)
      break
    }
    case 'table': {
      renderTable(token as Tokens.Table, out, width)
      pushBlank(out)
      break
    }
    case 'space': {
      pushBlank(out)
      break
    }
    case 'html': {
      break
    }
    default: {
      const t = token as Tokens.Text
      if ('tokens' in t && Array.isArray(t.tokens)) {
        out.push(...wrap(inline(t.tokens), width, 0))
      } else if (typeof t.text === 'string') {
        out.push(...wrap(decodeEntities(t.text), width, 0))
      }
      break
    }
  }
}

function renderTable(table: Tokens.Table, out: string[], width: number): void {
  const headers = table.header.map(cell => cellText(cell))
  const rows = table.rows.map(row => row.map(cell => cellText(cell)))
  const columns = headers.length
  if (columns === 0) return
  // Natural width of each column is the widest cell (header included),
  // measured in display columns — .length would count a CJK char as 1 and
  // desync the rule line from the cells it separates.
  const natural: number[] = []
  for (let c = 0; c < columns; c++) {
    let w = stringWidth(stripAnsi(headers[c] ?? ''))
    for (const row of rows) w = Math.max(w, stringWidth(stripAnsi(row[c] ?? '')))
    natural.push(w)
  }
  // Columns keep natural width whenever the table fits the surrounding wrap
  // budget; only genuine overflow shrinks anything, so the common case
  // renders cell text in full.
  const budget = Math.max(12, width) - (columns - 1) * 3
  const widths = fitWidths(natural, budget)
  const renderRow = (cells: string[], header: boolean): void => {
    const parts: string[] = []
    for (let c = 0; c < columns; c++) {
      const cell = cellPad(stripAnsi(cells[c] ?? ''), widths[c] ?? 8)
      parts.push(header ? chalk.bold(cell) : cell)
    }
    out.push(parts.join(chalk.dim(' │ ')))
  }
  renderRow(headers, true)
  out.push(chalk.dim(widths.map(w => '─'.repeat(w)).join('─┼─')))
  for (const row of rows) renderRow(row, false)
}

function cellText(cell: Tokens.TableCell): string {
  const text = Array.isArray(cell.tokens) ? inline(cell.tokens) : decodeEntities(cell.text ?? '')
  // A cell must occupy exactly one terminal line; <br> in markdown would
  // otherwise smuggle a raw newline into the padded row.
  return text.replace(/\n/g, ' ')
}

/** Overflow comes off the widest columns first so short cells keep their full
 * content; columns stay at TABLE_MIN_COL unless the budget cannot even hold
 * every column at that floor, in which case layout integrity wins and columns
 * go as low as 1 (cells collapse to '…'). */
const TABLE_MIN_COL = 4

function fitWidths(natural: number[], budget: number): number[] {
  const widths = natural.map(w => Math.min(w, Math.max(TABLE_MIN_COL, budget)))
  for (const floor of [TABLE_MIN_COL, 1]) {
    let total = widths.reduce((a, b) => a + b, 0)
    while (total > budget) {
      let target = -1
      let widest = floor
      for (let c = 0; c < widths.length; c++) {
        const w = widths[c] ?? floor
        if (w > widest) {
          widest = w
          target = c
        }
      }
      if (target === -1) break
      widths[target] = (widths[target] ?? floor) - 1
      total -= 1
    }
    if (total <= budget) break
  }
  return widths
}

function inline(tokens: Token[] | undefined): string {
  if (tokens === undefined) return ''
  let s = ''
  for (const t of tokens) {
    switch (t.type) {
      case 'text': {
        const tt = t as Tokens.Text
        s += 'tokens' in tt && Array.isArray(tt.tokens) ? inline(tt.tokens) : decodeEntities(tt.text ?? '')
        break
      }
      case 'strong': s += chalk.bold(inline((t as Tokens.Strong).tokens)); break
      case 'em': s += chalk.italic(inline((t as Tokens.Em).tokens)); break
      case 'codespan': s += theme.md.codespan(decodeEntities((t as Tokens.Codespan).text)); break
      case 'link': {
        const lt = t as Tokens.Link
        const label = inline(lt.tokens)
        s += theme.md.link(label !== '' ? label : lt.href)
        if (lt.href !== undefined && label !== '' && lt.href !== label) s += chalk.dim(` (${lt.href})`)
        break
      }
      case 'del': s += chalk.strikethrough(inline((t as Tokens.Del).tokens)); break
      case 'br': s += '\n'; break
      case 'escape': s += (t as Tokens.Escape).text; break
      case 'image': s += theme.md.image(`[图片：${(t as Tokens.Image).text ?? ''}]`); break
      case 'html': s += chalk.dim((t as Tokens.HTML).text ?? ''); break
      default: s += 'text' in t ? String((t as { text?: string }).text ?? '') : ''
    }
  }
  return s
}

function safeHighlight(code: string, language: string): string {
  try {
    return highlight(code, { language, theme: theme.highlight })
  } catch {
    return code
  }
}

function wrap(text: string, width: number, indent: number): string[] {
  const columns = Math.max(8, width - indent)
  const wrapped = wrapAnsi(text, columns, { hard: true, trim: false }).split('\n')
  const pad = ' '.repeat(indent)
  return wrapped.map(line => (line === '' ? '' : pad + line))
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

function cellPad(text: string, width: number): string {
  const w = stringWidth(text)
  if (w <= width) return text + ' '.repeat(width - w)
  // Truncated cell: cut to the column's display width with a trailing '…',
  // padding the remainder so every cell still ends on the same column.
  let out = ''
  let used = 0
  for (const ch of text) {
    const cw = stringWidth(ch)
    if (used + cw > width - 1) break
    out += ch
    used += cw
  }
  return out + '…' + ' '.repeat(Math.max(0, width - used - 1))
}
