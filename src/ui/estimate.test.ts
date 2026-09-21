import { describe, expect, it } from 'vitest'
import type { ActiveQuestion, FinalItem } from '../store.js'
import { QUESTION_WINDOW } from '../store.js'
import {
  APPROVAL_CHOICES_TEXT,
  THINKING_TAIL_ROWS,
  terminalHeaderCommand,
  thinkingHeaderOf,
  thinkingTailRows,
  estimateApprovalHeight,
  estimateItemHeight,
  estimateQuestionHeight,
  formatElapsed,
  headTailPreview,
  questionHintText,
  questionOptionRow,
  truncateLine,
} from './estimate.js'
import { BANNER_BOX_HEIGHT } from './Banner.js'

const toolCard = (result: string): FinalItem => ({
  kind: 'tool', name: 'bash', title: 'run', args: '', ok: true, result, elapsedMs: 0, verbose: false,
})

const lines10 = (): string => Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n')

function makeQuestion(optionCount: number, state: { cursor?: number; scroll?: number } = {}): ActiveQuestion {
  return {
    item: {
      id: 'q1',
      question: '选择',
      options: Array.from({ length: optionCount }, (_, i) => ({ label: `opt-${i}` })),
    },
    selected: [],
    index: 1,
    total: 1,
    cursor: state.cursor ?? 0,
    scroll: state.scroll ?? 0,
  } as unknown as ActiveQuestion
}

describe('estimateItemHeight', () => {
  it('banner reserves the shared banner height', () => {
    expect(estimateItemHeight(
      { kind: 'banner', fxVersion: '0', dshVersion: '0', model: 'm', sessionId: 's', cwd: '/', resumed: false },
      78, 80,
    )).toBe(BANNER_BOX_HEIGHT)
  })

  it('user bar: lead gap + one row per source line + one per image', () => {
    expect(estimateItemHeight({ kind: 'user', text: 'hello' }, 78, 80)).toBe(2)
    expect(estimateItemHeight({ kind: 'user', text: 'line one\nline two' }, 78, 80)).toBe(3)
    expect(estimateItemHeight({ kind: 'user', text: 'hello', images: ['a.png'] }, 78, 80)).toBe(3)
  })

  it('assistant reply: lead gap + markdown lines (+1 when interrupted)', () => {
    expect(estimateItemHeight({ kind: 'assistant', text: 'hello', interrupted: false }, 78, 80)).toBe(2)
    expect(estimateItemHeight({ kind: 'assistant', text: 'a\n\nb', interrupted: false }, 78, 80)).toBe(4)
    expect(estimateItemHeight({ kind: 'assistant', text: 'hello', interrupted: true }, 78, 80)).toBe(3)
  })

  it('notice is a single row; panel is borders + title + lines', () => {
    expect(estimateItemHeight({ kind: 'notice', text: 'ok', tone: 'info' }, 78, 80)).toBe(1)
    expect(estimateItemHeight({ kind: 'panel', title: 't', lines: ['a', 'b'] }, 78, 80)).toBe(5)
  })

  it('tool card: lead gap + header + preview rows (+1 overflow row)', () => {
    expect(estimateItemHeight(toolCard('a\nb\nc'), 78, 80)).toBe(5)
    expect(estimateItemHeight(toolCard(lines10()), 78, 80)).toBe(8)
  })
})

describe('estimateApprovalHeight', () => {
  it('borders + tool line + command line + choices', () => {
    expect(estimateApprovalHeight({ seq: 1, toolName: 'bash', reason: '', command: 'ls -la' }, 80)).toBe(5)
  })

  it('the choices line is budgeted, not flat-counted', () => {
    expect(APPROVAL_CHOICES_TEXT).toContain('[n] 拒绝')
  })
})

describe('estimateQuestionHeight', () => {
  it('basic card: borders + title + options + hint', () => {
    expect(estimateQuestionHeight(makeQuestion(3), 78, 80)).toBe(7)
  })

  it('a full window adds the ▼ overflow indicator row', () => {
    expect(estimateQuestionHeight(makeQuestion(QUESTION_WINDOW + 3), 78, 80)).toBe(14)
  })
})

describe('questionOptionRow', () => {
  it('renders cursor / selection / approve markers in order', () => {
    expect(questionOptionRow({ label: 'a' }, 0, { selected: false, isApprove: false, cursor: false })).toBe('  [1] ○ a')
    expect(questionOptionRow({ label: 'a' }, 0, { selected: true, isApprove: false, cursor: true })).toBe('❯ [1] ● a')
    expect(questionOptionRow({ label: 'a', description: 'd' }, 0, { selected: false, isApprove: true, cursor: false }))
      .toBe('  [1] ○ ✓ a — d')
  })
})

describe('questionHintText', () => {
  it('varies by plan-review and multi-select', () => {
    expect(questionHintText(true, false)).toBe('↑↓ 选择 · Enter 批准 · Esc 跳过')
    expect(questionHintText(false, true)).toBe('↑↓ 移动 · 数字键多选 · Enter 确认 · Esc 跳过')
    expect(questionHintText(false, false)).toBe('↑↓ 选择 · 数字键直选 · Enter 确认 · Esc 跳过')
  })
})

describe('headTailPreview', () => {
  it('keeps everything under the cap', () => {
    expect(headTailPreview(['a', 'b', 'c'], 5)).toEqual({ shown: ['a', 'b', 'c'], hidden: 0 })
  })

  it('keeps head + tail and counts the hidden middle', () => {
    expect(headTailPreview(['a', 'b', 'c', 'd', 'e', 'f'], 3)).toEqual({ shown: ['a', 'b', 'f'], hidden: 3 })
  })

  it('cap of 1 degenerates to the tail line', () => {
    expect(headTailPreview(['a', 'b'], 1)).toEqual({ shown: ['b'], hidden: 1 })
  })
})

describe('truncateLine', () => {
  it('passes through short lines and cuts CJK on display width', () => {
    expect(truncateLine('hello', 10)).toBe('hello')
    expect(truncateLine('中文', 4)).toBe('中文')
    expect(truncateLine('中文中文', 4)).toBe('中文…')
    expect(truncateLine('中文中文', 5)).toBe('中文…')
    expect(truncateLine('abc', 2)).toBe('ab…')
  })
})

describe('formatElapsed', () => {
  it('formats ms / s / m+s', () => {
    expect(formatElapsed(50)).toBe('50ms')
    expect(formatElapsed(1500)).toBe('1.5s')
    expect(formatElapsed(65_000)).toBe('1m5s')
  })
})

describe('thinking rows（Ctrl+T）', () => {
  const thinkingItem = (over: Partial<Extract<FinalItem, { kind: 'thinking' }>> = {}): FinalItem => ({
    kind: 'thinking', text: 'a\nb', chars: 3, durationMs: 1200, truncated: false, ...over,
  })

  it('header is shared verbatim between view and estimator', () => {
    expect(thinkingHeaderOf({ chars: 1234, durationMs: 5000 })).toBe('✻ 思考 · 5.0s · 1.2k 字')
    expect(thinkingHeaderOf({ chars: 0, durationMs: 40 })).toBe('✻ 思考 · 40ms')
  })

  it('thinkingTailRows keeps the last window and wraps CJK to width', () => {
    const many = Array.from({ length: 20 }, (_, i) => `行${i}`).join('\n')
    const rows = thinkingTailRows(many, 80)
    expect(rows).toHaveLength(THINKING_TAIL_ROWS)
    expect(rows.at(-1)).toBe('行19')

    const wide = '思'.repeat(200)
    for (const row of thinkingTailRows(wide, 40)) {
      expect(row.length).toBeLessThanOrEqual(40)
    }
  })

  it('thinkingTailRows of empty text is empty (hidden tail)', () => {
    expect(thinkingTailRows('', 80)).toEqual([])
  })

  it('settled thinking block: lead gap + header + body rows (+ marker)', () => {
    expect(estimateItemHeight(thinkingItem(), 78, 80)).toBe(4)
    expect(estimateItemHeight(thinkingItem({ truncated: true }), 78, 80)).toBe(5)
    expect(estimateItemHeight(thinkingItem({ text: '' }), 78, 80)).toBe(2)
  })
})

describe('terminal card compact header', () => {
  const terminalCard = (over: Record<string, unknown> = {}): FinalItem => ({
    kind: 'tool', name: 'bash', title: 'run', args: '', ok: true, result: '',
    elapsedMs: 52, exitCode: 0, verbose: false,
    view: { card: 'terminal', title: 'echo hi', output: 'out1\nout2\nout3' },
    ...over,
  } as unknown as FinalItem)

  it('terminalHeaderCommand truncates long commands into the one-row budget', () => {
    const suffix = '· 52ms · exit 0'
    expect(terminalHeaderCommand('echo hi', suffix, 80)).toBe('echo hi')
    const long = 'echo "' + '思'.repeat(120) + '"'
    const trimmed = terminalHeaderCommand(long, suffix, 80)
    expect(trimmed.startsWith('echo "思')).toBe(true)
    expect(trimmed.endsWith('…')).toBe(true)
    // `✓ ` prefix + command + space + suffix must fit the row exactly.
    expect(trimmed.length + suffix.length + 3).toBeLessThanOrEqual(80)
  })

  it('compact card: header + output-count marker (no output → header alone)', () => {
    expect(estimateItemHeight(terminalCard(), 78, 80)).toBe(3) // lead gap + header + marker
    expect(estimateItemHeight(terminalCard({ view: { card: 'terminal', title: 'cd /tmp', output: '' } }), 78, 80)).toBe(2)
  })

  it('a command that used to wrap dozens of rows now costs one', () => {
    const long = 'echo "' + '思'.repeat(200) + '"'
    expect(estimateItemHeight(terminalCard({ view: { card: 'terminal', title: long, output: 'x' } }), 78, 80)).toBe(3)
  })

  it('verbose mode keeps the head+tail preview budget', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `l${i}`).join('\n')
    expect(estimateItemHeight(terminalCard({ verbose: true, view: { card: 'terminal', title: 'echo hi', output: lines } }), 78, 80)).toBe(7)
  })
})
