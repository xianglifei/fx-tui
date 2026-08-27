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
      out.push(...wrap(chalk.bold.cyanBright(inline(t.tokens)), width, 0))
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
  const widths: number[] = []
  for (let c = 0; c < columns; c++) {
    let w = stripAnsi(headers[c] ?? '').length
    for (const row of rows) w = Math.max(w, stripAnsi(row[c] ?? '').length)
    widths.push(Math.min(w, 24))
  }
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
  if (Array.isArray(cell.tokens)) return inline(cell.tokens)
  return decodeEntities(cell.text ?? '')
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
      case 'codespan': s += chalk.yellowBright(decodeEntities((t as Tokens.Codespan).text)); break
      case 'link': {
        const lt = t as Tokens.Link
        const label = inline(lt.tokens)
        s += chalk.cyanBright.underline(label !== '' ? label : lt.href)
        if (lt.href !== undefined && label !== '' && lt.href !== label) s += chalk.dim(` (${lt.href})`)
        break
      }
      case 'del': s += chalk.strikethrough(inline((t as Tokens.Del).tokens)); break
      case 'br': s += '\n'; break
      case 'escape': s += (t as Tokens.Escape).text; break
      case 'image': s += chalk.cyan(`[图片：${(t as Tokens.Image).text ?? ''}]`); break
      case 'html': s += chalk.dim((t as Tokens.HTML).text ?? ''); break
      default: s += 'text' in t ? String((t as { text?: string }).text ?? '') : ''
    }
  }
  return s
}

function safeHighlight(code: string, language: string): string {
  try {
    return highlight(code, { language })
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
  return w >= width ? text.slice(0, width) : text + ' '.repeat(width - w)
}
