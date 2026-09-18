import { PassThrough } from 'node:stream'
import { Writable } from 'node:stream'
import { Console } from 'node:console'
import type { ReadStream, WriteStream } from 'node:tty'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { render } from 'ink'
import type { TuiStore } from '../store.js'
import { computeInputHeight, editorRowCap, InputBox } from './Input.js'

// vitest swaps the global console for a capture object without the Console
// constructor, which ink's patch-console needs — restore it before rendering.
;(console as { Console?: typeof Console }).Console ??= Console

/** Render InputBox through real ink against a captured fake stdout and return
 * the visible rows of the last frame (ANSI stripped). This is the only place
 * the suite exercises the actual render path, so the render side of the
 * estimate/render height lockstep is verified against ink itself. */
async function renderInputBox(lines: readonly string[], row: number, col: number, columns: number, rows: number): Promise<string[]> {
  const frames: string[] = []
  class Capture extends Writable {
    override _write(chunk: Buffer, _enc: string, cb: () => void): void {
      frames.push(chunk.toString())
      cb()
    }
  }
  const stdout = new Capture() as unknown as WriteStream & { columns: number; rows: number }
  stdout.columns = columns
  stdout.rows = rows
  const noop = (): void => {}
  const store = {
    getSnapshot: () => ({ exitArmed: false, phase: 'idle' as const }),
    cycleApprovalMode: noop,
    armExit: noop,
    addNotice: noop,
    clearPendingImages: () => 0,
    removeLastPendingImage: () => undefined,
    skipQuestion: noop,
    submitFreeTextAnswer: noop,
    toggleVerboseToolDetail: noop,
    toggleVerboseTranscript: noop,
  } as unknown as TuiStore
  // ink's useInput demands a raw-mode-capable TTY stdin, so fake one the way
  // ink-testing-library does.
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => {},
    ref: () => {},
    unref: () => {},
  }) as unknown as ReadStream
  const instance = render(
    createElement(InputBox, {
      store,
      history: [],
      frozen: false,
      questionFreeText: false,
      showFreeTextHint: false,
      pendingImages: [],
      ed: { lines: [...lines], row, col },
      setEd: noop,
      menu: null,
      setMenu: noop,
      listCommands: () => [],
      runCommand: noop,
      onSubmit: noop,
      onRecallPending: () => null,
      onClipboardImage: noop,
      onInterrupt: noop,
      onExit: noop,
    }),
    { stdout, stdin, exitOnCtrlC: false },
  )
  // Ink defers its throttled output flush in this environment — the frame
  // only lands on the stream around unmount — so tear down first, let the
  // writes settle, and use the last NON-empty frame (unmount erases the
  // dynamic region with an empty final write).
  instance.unmount()
  await new Promise(resolve => setTimeout(resolve, 50))
  const last = frames.filter(frame => frame !== '').at(-1) ?? ''
  return last
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .filter(line => line !== '')
}

describe('InputBox render', () => {
  it('shows every row of a short draft inside its borders', async () => {
    const rows = await renderInputBox(['第一行', '第二行'], 1, 3, 80, 40)
    // 2 borders + 2 editor rows; the cursor line is among them
    expect(rows.length).toBe(4)
    expect(rows.some(row => row.includes('第一行'))).toBe(true)
    expect(rows.some(row => row.includes('第二行'))).toBe(true)
  })

  it('caps a huge draft to editorRowCap rows plus the overflow indicator', async () => {
    const draft = Array.from({ length: 30 }, (_, i) => `草稿第 ${i + 1} 行`)
    const rows = await renderInputBox(draft, 29, draft[29]!.length, 80, 10)
    // cap(10 rows) = 5: 2 borders + 5 shown rows + 1 indicator = 8, exactly
    // what the estimator charges the filler budget for this state
    expect(rows.length).toBe(computeInputHeight({
      lines: draft,
      menuOpen: false,
      trayRows: 0,
      freeTextHint: false,
      columns: 80,
      rows: 10,
    }))
    expect(rows.length).toBe(2 + editorRowCap(10) + 1)
    // the window follows the cursor to the tail of the draft
    expect(rows.some(row => row.includes('草稿第 30 行'))).toBe(true)
    expect(rows.some(row => row.includes('编辑区共 30 行'))).toBe(true)
    expect(rows.some(row => row.includes('上方还有'))).toBe(true)
  })

  it('shows no overflow indicator while the draft is under the cap', async () => {
    const draft = Array.from({ length: 4 }, (_, i) => `行 ${i + 1}`)
    const rows = await renderInputBox(draft, 3, 0, 80, 40)
    expect(rows.length).toBe(2 + 4)
    expect(rows.some(row => row.includes('编辑区共'))).toBe(false)
  })
})
