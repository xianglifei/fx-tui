import { describe, expect, it } from 'vitest'
import stringWidth from 'string-width'
import { computeInputHeight, cursorSegments, editorRowCap, editorRowsForSpace, layoutEditor, MENU_PANE_ROWS } from './Input.js'
import { textRows } from './ink-text.js'

describe('editorRowCap', () => {
  it('is 30% of the viewport with a 5-row floor', () => {
    expect(editorRowCap(24)).toBe(7)
    expect(editorRowCap(40)).toBe(12)
    expect(editorRowCap(10)).toBe(5)
  })

  it('falls back to the 24-row classic for unknown or absurd counts', () => {
    expect(editorRowCap(undefined)).toBe(7)
    expect(editorRowCap(0)).toBe(7)
    expect(editorRowCap(-5)).toBe(7)
    expect(editorRowCap(1000)).toBe(7)
    expect(editorRowCap(5000)).toBe(7)
  })
})

describe('computeInputHeight', () => {
  const base = { menuOpen: false, trayRows: 0, freeTextHint: false }

  it('counts borders plus one row per short line when uncapped', () => {
    expect(computeInputHeight({ ...base, lines: [''], columns: 80, rows: 40 })).toBe(3)
    expect(computeInputHeight({ ...base, lines: ['a', 'bb'], columns: 80, rows: 40 })).toBe(4)
  })

  it('caps the editor rows and reserves the overflow indicator past the cap', () => {
    // cap(24) = 7: 20 one-row lines → 2 borders + 7 shown + 1 indicator
    expect(computeInputHeight({ ...base, lines: Array.from({ length: 20 }, () => 'x'), columns: 80, rows: 24 })).toBe(10)
    // exactly at the cap: no indicator
    expect(computeInputHeight({ ...base, lines: Array.from({ length: 7 }, () => 'x'), columns: 80, rows: 24 })).toBe(9)
    // one past the cap: indicator appears
    expect(computeInputHeight({ ...base, lines: Array.from({ length: 8 }, () => 'x'), columns: 80, rows: 24 })).toBe(10)
  })

  it('caps even when the terminal height is unknown', () => {
    expect(computeInputHeight({ ...base, lines: Array.from({ length: 20 }, () => 'x'), columns: 80 })).toBe(10)
  })

  it('counts a wrapped logical line as its wrapped height against the cap', () => {
    // one 200-char line wraps to ceil(200/76) = 3 rows at columns 80 (inner 76)
    expect(computeInputHeight({ ...base, lines: ['a'.repeat(200)], columns: 80, rows: 24 })).toBe(2 + 3)
  })
})

describe('layoutEditor', () => {
  it('keeps short lines one-per-row and maps the cursor onto them', () => {
    const layout = layoutEditor(['aaaa', 'bb'], 76, 1, 1)
    expect(layout.rows).toEqual(['aaaa', 'bb'])
    expect(layout.cursorRow).toBe(1)
    expect(layout.cursorCol).toBe(1)
  })

  it('renders an empty logical line as a single blank row', () => {
    const layout = layoutEditor(['', 'x'], 76, 0, 0)
    expect(layout.rows).toEqual([' ', 'x'])
    expect(layout.cursorRow).toBe(0)
    expect(layout.cursorCol).toBe(0)
  })

  it('splits a hard-wrapped line and follows the cursor across its rows', () => {
    const layout = layoutEditor(['a'.repeat(25)], 10, 0, 12)
    expect(layout.rows).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)])
    expect(layout.cursorRow).toBe(1)
    expect(layout.cursorCol).toBe(2)
    expect(layoutEditor(['a'.repeat(25)], 10, 0, 0).cursorRow).toBe(0)
    // col == length lands on the last chunk
    expect(layoutEditor(['a'.repeat(25)], 10, 0, 25)).toEqual({
      rows: ['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)],
      cursorRow: 2,
      cursorCol: 5,
    })
  })

  it('maps the cursor across wide-character wraps', () => {
    // width 8 (the wrap's floor) fits four 中 per row
    const layout = layoutEditor(['中'.repeat(6)], 8, 0, 5)
    expect(layout.rows).toEqual(['中中中中', '中中'])
    expect(layout.cursorRow).toBe(1)
    expect(layout.cursorCol).toBe(1)
    expect(layoutEditor(['中'.repeat(6)], 8, 0, 3)).toEqual({
      rows: ['中中中中', '中中'],
      cursorRow: 0,
      cursorCol: 3,
    })
  })

  it('row count matches the estimator wrap for every draft shape', () => {
    const drafts: string[][] = [
      [''],
      ['hello world'],
      ['a'.repeat(200)],
      ['中'.repeat(60)],
      ['', 'second', '', '第四行 line'],
      Array.from({ length: 50 }, (_, i) => `第${i}行 some content here long enough to wrap around`),
      ['emoji 🎉🎉🎉 and more text to wrap around the editor width', 'x'],
    ]
    for (const inner of [8, 20, 76]) {
      for (const lines of drafts) {
        const layout = layoutEditor(lines, inner, 0, 0)
        const estimated = lines.reduce((n, line) => n + textRows(line === '' ? ' ' : line, inner), 0)
        expect(layout.rows.length).toBe(estimated)
      }
    }
  })

  it('never emits a visual row wider than the wrap width', () => {
    // Ink re-wraps an over-wide row, which would add unestimated rows — the
    // chunker must agree with the wrap on every row's width.
    const drafts: string[][] = [
      ['a'.repeat(200)],
      ['中'.repeat(60)],
      ['word boundary trailing spaces   and more words after that wrap'],
      Array.from({ length: 10 }, (_, i) => `第${i}行 some content here long enough to wrap around`),
    ]
    for (const inner of [8, 20, 76]) {
      for (const lines of drafts) {
        for (const row of layoutEditor(lines, inner, 0, 0).rows) {
          expect(stringWidth(row)).toBeLessThanOrEqual(inner)
        }
      }
    }
  })
})

describe('editorRowsForSpace', () => {
  const space = (availableRows: number, total = 40, menuRows = 0): number => editorRowsForSpace({
    rows: 30,
    availableRows,
    totalEditorRows: total,
    menuRows,
    trayRows: 0,
    hintRows: 0,
  })

  it('ignores the budget when unavailable and returns the base cap', () => {
    expect(editorRowsForSpace({ rows: 30, availableRows: undefined, totalEditorRows: 40, menuRows: 0, trayRows: 0, hintRows: 0 })).toBe(9)
    expect(editorRowsForSpace({ rows: 30, availableRows: undefined, totalEditorRows: 3, menuRows: 0, trayRows: 0, hintRows: 0 })).toBe(3)
  })

  it('shrinks the editor to fit the space left beside a menu', () => {
    // available 19 - 2 borders - 11 menu - 1 indicator - 1 safety = 4
    expect(space(19, 40, MENU_PANE_ROWS)).toBe(4)
    // without the menu the same space comfortably holds the base cap
    expect(space(19)).toBe(9)
  })

  it('reserves the overflow indicator only when the cap actually engages', () => {
    // total 6 fits the budget of 4? no — capped: 4 with indicator implied
    expect(space(19, 6, MENU_PANE_ROWS)).toBe(4)
    // generous space: uncapped drafts show everything
    expect(space(30, 6)).toBe(6)
  })

  it('never drops below one row even when the space is absurd', () => {
    expect(space(3, 40, MENU_PANE_ROWS)).toBe(1)
    expect(space(0, 40)).toBe(1)
  })

  it('keeps the box within the available rows across shapes', () => {
    for (const availableRows of [6, 10, 14, 19, 26, 34]) {
      for (const total of [1, 5, 9, 12, 40]) {
        for (const menuRows of [0, MENU_PANE_ROWS]) {
          const visible = space(availableRows, total, menuRows)
          const indicator = total > visible ? 1 : 0
          const box = 2 + visible + indicator + menuRows
          // Degenerate (chrome alone exceeds the space): the clamp floors the
          // editor at 1 row and the box legitimately overflows.
          const degenerate = availableRows < menuRows + 5
          expect(
            degenerate ? visible === 1 : box <= availableRows,
            `rows=${availableRows} total=${total} menu=${menuRows}: visible=${visible} box=${box}`,
          ).toBe(true)
        }
      }
    }
  })
})

describe('computeInputHeight with a budget', () => {
  const base = { menuOpen: false, trayRows: 0, freeTextHint: false }

  it('charges the resolved visible rows plus the indicator', () => {
    // budget 19 with the menu open: 4 editor rows + indicator
    expect(computeInputHeight({
      ...base,
      lines: Array.from({ length: 40 }, () => 'x'),
      columns: 80,
      availableRows: 19,
      editorVisibleRows: 4,
    })).toBe(2 + 4 + 1)
    // the same call resolving its own budget from availableRows agrees
    expect(computeInputHeight({
      ...base,
      lines: Array.from({ length: 40 }, () => 'x'),
      columns: 80,
      availableRows: 19,
      menuOpen: true,
    })).toBe(2 + 4 + 1 + MENU_PANE_ROWS)
  })

  it('stays within the available rows with the menu open (TC6 regression)', () => {
    // 80x30: banner 8 + fixed live 3 → available 19; menu 11 + box must fit
    const height = computeInputHeight({
      ...base,
      menuOpen: true,
      lines: Array.from({ length: 40 }, () => 'x'),
      columns: 80,
      availableRows: 19,
    })
    expect(height).toBeLessThanOrEqual(19)
  })
})

describe('cursorSegments', () => {
  it('highlights the character under the cursor', () => {
    expect(cursorSegments('hello', 2, 80)).toEqual({ before: 'he', at: 'l', after: 'lo' })
  })

  it('appends a cursor cell at end-of-line', () => {
    expect(cursorSegments('hello', 5, 80)).toEqual({ before: 'hello', at: ' ', after: '' })
  })

  it('folds the cursor into the last character on a full-width row', () => {
    expect(cursorSegments('hello', 5, 5)).toEqual({ before: 'hell', at: 'o', after: '' })
    expect(cursorSegments('中文', 2, 4)).toEqual({ before: '中', at: '文', after: '' })
  })

  it('keeps the appended space on an empty line', () => {
    expect(cursorSegments('', 0, 80)).toEqual({ before: '', at: ' ', after: '' })
  })

  it('never returns segments wider than the row', () => {
    expect(stringWidth(cursorSegments('hello', 5, 5).before + cursorSegments('hello', 5, 5).at) <= 5).toBe(true)
  })
})
