/**
 * The multiline input editor: code-point-aware cursor editing, input history,
 * and the keyboard contract for the whole app (submit, newline, interrupt,
 * clear, arm-exit).
 *
 * Input arrives through two Ink channels: `useInput` for keystrokes and
 * `usePaste` for pasted text (bracketed paste mode). Multi-character chunks
 * that still reach `useInput` are coalesced typing or piped automation; their
 * line endings are normalized and a trailing newline behaves like Enter.
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import { Box, Text, useInput, usePaste } from 'ink'
import type { TuiStore } from '../store.js'

export interface InputBoxProps {
  store: TuiStore
  history: readonly string[]
  frozen: boolean
  onSubmit(text: string): void
  onInterrupt(): void
  onExit(): void
}

interface EditorState {
  lines: string[]
  row: number
  col: number
}

const HELP_TEXT =
  'Enter 发送 · Ctrl+J 换行 · ↑↓ 翻输入历史 · Esc 中断/清空 · ' +
  'Ctrl+C 清空，空输入时双击退出 · /exit 退出 · /help 帮助'

export function InputBox(props: InputBoxProps): ReactElement {
  const { store, history, frozen, onSubmit, onInterrupt, onExit } = props
  const [ed, setEd] = useState<EditorState>({ lines: [''], row: 0, col: 0 })
  const [histIdx, setHistIdx] = useState(-1)
  const [draft, setDraft] = useState<string | null>(null)

  const isEmpty = ed.lines.length === 1 && ed.lines[0] === ''

  useInput((input, key) => {
    if (frozen) return

    if (key.ctrl && input === 'c') {
      if (!isEmpty) {
        setEd({ lines: [''], row: 0, col: 0 })
        setHistIdx(-1)
        setDraft(null)
      } else if (store.getSnapshot().exitArmed) {
        onExit()
      } else {
        store.armExit()
      }
      return
    }

    if (key.escape) {
      if (store.getSnapshot().phase !== 'idle') {
        onInterrupt()
      } else if (!isEmpty) {
        setEd({ lines: [''], row: 0, col: 0 })
        setHistIdx(-1)
        setDraft(null)
      }
      return
    }

    // Coalesced typing or piped automation: insert as (multi-)line text and
    // submit when the chunk carries a trailing newline.
    if (input.length > 1) {
      insertChunk(input, true)
      return
    }

    // Newline: Ctrl+J (LF), bare '\n', or Option/Alt+Enter (meta+return).
    if ((key.ctrl && input === 'j') || input === '\n' || (key.return && key.meta)) {
      insertNewline()
      return
    }

    if (key.return) {
      submit()
      return
    }

    if (key.upArrow) {
      if (ed.row > 0) {
        setEd(current => ({ ...current, row: current.row - 1, col: 0 }))
      } else {
        browseHistory(-1)
      }
      return
    }
    if (key.downArrow) {
      if (ed.row < ed.lines.length - 1) {
        setEd(current => ({ ...current, row: current.row + 1, col: 0 }))
      } else {
        browseHistory(1)
      }
      return
    }

    if (key.leftArrow) {
      setEd(current => {
        if (current.col > 0) return { ...current, col: current.col - 1 }
        if (current.row > 0) {
          const row = current.row - 1
          return { ...current, row, col: Array.from(current.lines[row] ?? '').length }
        }
        return current
      })
      return
    }
    if (key.rightArrow) {
      setEd(current => {
        const chars = Array.from(current.lines[current.row] ?? '')
        if (current.col < chars.length) return { ...current, col: current.col + 1 }
        if (current.row < current.lines.length - 1) return { ...current, row: current.row + 1, col: 0 }
        return current
      })
      return
    }

    if (key.ctrl && input === 'a') {
      setEd(current => ({ ...current, col: 0 }))
      return
    }
    if (key.ctrl && input === 'e') {
      setEd(current => ({ ...current, col: Array.from(current.lines[current.row] ?? '').length }))
      return
    }

    if (key.backspace) {
      setEd(current => {
        const chars = Array.from(current.lines[current.row] ?? '')
        if (current.col > 0) {
          const lines = [...current.lines]
          lines.splice(current.row, 1, chars.slice(0, current.col - 1).join('') + chars.slice(current.col).join(''))
          return { ...current, lines, col: current.col - 1 }
        }
        if (current.row > 0) {
          const lines = [...current.lines]
          const prev = lines[current.row - 1] ?? ''
          lines.splice(current.row - 1, 2, prev + (lines[current.row] ?? ''))
          return { lines, row: current.row - 1, col: Array.from(prev).length }
        }
        return current
      })
      return
    }
    if (key.delete) {
      setEd(current => {
        const chars = Array.from(current.lines[current.row] ?? '')
        if (current.col < chars.length) {
          const lines = [...current.lines]
          lines.splice(current.row, 1, chars.slice(0, current.col).join('') + chars.slice(current.col + 1).join(''))
          return { ...current, lines }
        }
        if (current.row < current.lines.length - 1) {
          const lines = [...current.lines]
          const cur = lines[current.row] ?? ''
          lines.splice(current.row, 2, cur + (lines[current.row + 1] ?? ''))
          return { ...current, lines }
        }
        return current
      })
      return
    }

    if (key.ctrl || key.meta) return
    if (input.length > 0 && input !== '\r') {
      setEd(current => {
        const chars = Array.from(current.lines[current.row] ?? '')
        const lines = [...current.lines]
        lines.splice(
          current.row,
          1,
          chars.slice(0, current.col).join('') + input + chars.slice(current.col).join(''),
        )
        return { ...current, lines, col: current.col + Array.from(input).length }
      })
    }
  })

  usePaste((text) => {
    if (frozen) return
    insertChunk(text, false)
  })

  function insertNewline(): void {
    setEd(current => {
      const chars = Array.from(current.lines[current.row] ?? '')
      const before = chars.slice(0, current.col).join('')
      const after = chars.slice(current.col).join('')
      const lines = [...current.lines]
      lines.splice(current.row, 1, before, after)
      return { lines, row: current.row + 1, col: 0 }
    })
  }

  /** Insert a chunk as multi-line text at the cursor; optionally submit on trailing newline. */
  function insertChunk(raw: string, submitOnTrailingNewline: boolean): void {
    const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    if (text === '') return
    const trailing = submitOnTrailingNewline && text.endsWith('\n')
    const body = trailing ? text.slice(0, -1) : text
    const next = spliceInto(ed, body)
    if (trailing) {
      setEd({ lines: [''], row: 0, col: 0 })
      setHistIdx(-1)
      setDraft(null)
      submitText(next.lines.join('\n'))
    } else {
      setEd(next)
    }
  }

  function submit(): void {
    submitText(ed.lines.join('\n'))
  }

  function submitText(text: string): void {
    const trimmed = text.trim()
    if (trimmed === '') return
    const command = trimmed.toLowerCase()
    if (command === '/exit' || command === '/quit' || command === '/bye') {
      onExit()
      return
    }
    if (command === '/help') {
      store.addNotice(HELP_TEXT)
    } else {
      onSubmit(trimmed)
    }
    setEd({ lines: [''], row: 0, col: 0 })
    setHistIdx(-1)
    setDraft(null)
  }

  function browseHistory(direction: -1 | 1): void {
    if (history.length === 0) return
    if (direction === 1 && histIdx === -1) return
    if (histIdx === -1) setDraft(ed.lines.join('\n'))
    let index = histIdx === -1 ? history.length : histIdx
    index += direction
    if (index < 0) index = 0
    if (index >= history.length) {
      setHistIdx(-1)
      const text = draft ?? ''
      const lines = text.split('\n')
      setEd({ lines, row: lines.length - 1, col: Array.from(lines[lines.length - 1] ?? '').length })
      return
    }
    setHistIdx(index)
    const text = history[index] ?? ''
    const lines = text.split('\n')
    setEd({ lines, row: lines.length - 1, col: Array.from(lines[lines.length - 1] ?? '').length })
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={frozen ? 'gray' : 'cyan'} paddingX={1}>
      {isEmpty && histIdx === -1 && (
        <Text dimColor>说点什么…（Enter 发送 · Ctrl+J 换行 · /help 查看按键）</Text>
      )}
      {ed.lines.map((line, index) => (
        <Text key={index}>
          {index === ed.row
            ? <CursorLine line={line} col={ed.col} />
            : (line === '' ? ' ' : line)}
        </Text>
      ))}
    </Box>
  )
}

/** Pure splice of multi-line text into an editor state at its cursor. */
function spliceInto(ed: EditorState, body: string): EditorState {
  const chars = Array.from(ed.lines[ed.row] ?? '')
  const before = chars.slice(0, ed.col).join('')
  const after = chars.slice(ed.col).join('')
  const parts = body.split('\n')
  if (parts.length === 1) {
    const lines = [...ed.lines]
    lines.splice(ed.row, 1, before + body + after)
    return { lines, row: ed.row, col: ed.col + Array.from(body).length }
  }
  const first = parts[0] ?? ''
  const last = parts[parts.length - 1] ?? ''
  const middles = parts.slice(1, -1)
  const inserted = [before + first, ...middles, last + after]
  const lines = [...ed.lines]
  lines.splice(ed.row, 1, ...inserted)
  return { lines, row: ed.row + inserted.length - 1, col: Array.from(last).length }
}

function CursorLine(props: { line: string; col: number }): ReactElement {
  const chars = Array.from(props.line)
  const before = chars.slice(0, props.col).join('')
  const at = chars[props.col]
  const after = chars.slice(props.col + 1).join('')
  return (
    <>
      <Text>{before}</Text>
      <Text inverse>{at ?? ' '}</Text>
      <Text>{after}</Text>
    </>
  )
}
