import { describe, expect, it } from 'vitest'
import { fitWidths, renderMarkdownLines } from './markdown.js'

/** cli-highlight emits ANSI even without a TTY; strip before asserting text. */
const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '')

describe('fitWidths', () => {
  it('keeps natural widths when the table fits the budget', () => {
    expect(fitWidths([3, 3, 3], 100)).toEqual([3, 3, 3])
  })

  it('shrinks the widest columns first', () => {
    expect(fitWidths([50, 50], 60)).toEqual([30, 30])
  })

  it('shrinks just enough to fit the budget, not further', () => {
    expect(fitWidths([100, 100, 100], 20)).toEqual([6, 7, 7])
  })

  it('stops shrinking at the TABLE_MIN_COL floor', () => {
    expect(fitWidths([10, 10, 10], 12)).toEqual([4, 4, 4])
  })

  it('collapses columns towards 1 when the budget cannot hold the floor', () => {
    expect(fitWidths([10, 10], 5)).toEqual([2, 3])
    expect(fitWidths([3, 3, 3], 5)).toEqual([1, 2, 2])
  })
})

describe('renderMarkdownLines', () => {
  it('renders a plain paragraph as one line', () => {
    expect(renderMarkdownLines('hello world', 78).map(plain)).toEqual(['hello world'])
  })

  it('collapses blank-line runs to a single separator and trims trailing blanks', () => {
    expect(renderMarkdownLines('a\n\n\n\nb', 78).map(plain)).toEqual(['a', '', 'b'])
    expect(renderMarkdownLines('a\n\n', 78).map(plain)).toEqual(['a'])
  })

  it('renders list items with bullet markers', () => {
    expect(renderMarkdownLines('- a\n- b', 78).map(plain)).toEqual(['• a', '• b'])
  })

  it('wraps code blocks between rules, indenting the body', () => {
    const lines = renderMarkdownLines('```\nconst x = 1\n```', 78).map(plain)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('─'.repeat(72))
    expect(lines[1]).toBe('  const x = 1')
    expect(lines[2]).toBe('─'.repeat(72))
  })

  it('renders tables with a column rule line', () => {
    const lines = renderMarkdownLines('| a | b |\n| --- | --- |\n| 1 | 2 |', 78).map(plain)
    expect(lines[0]).toContain('a')
    expect(lines[0]).toContain('b')
    expect(lines[1]).toContain('┼')
    expect(lines[2]).toContain('1')
    expect(lines[2]).toContain('2')
  })
})
