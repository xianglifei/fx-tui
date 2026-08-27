/**
 * The multiline input editor: code-point-aware cursor editing, input history,
 * slash-command and @-path completion menus, and the keyboard contract for the
 * whole app (submit, newline, interrupt, clear, arm-exit).
 *
 * Input arrives through two Ink channels: `useInput` for keystrokes and
 * `usePaste` for pasted text (bracketed paste mode). Multi-character chunks
 * that still reach `useInput` are coalesced typing or piped automation; their
 * line endings are normalized and a trailing newline behaves like Enter.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Box, Text, useInput, usePaste, useStdout } from 'ink'
import type { TuiStore } from '../store.js'
import { fuzzyMatchPaths, listWorkspaceFiles } from '../workspace-files.js'
import { textRows } from './ink-text.js'

export interface MenuEntry {
  readonly name: string
  readonly description: string
  readonly kind: 'builtin' | 'dsh'
}

export interface InputBoxProps {
  store: TuiStore
  history: readonly string[]
  frozen: boolean
  /** A pending free-text question: Enter answers it instead of sending a message. */
  questionFreeText: boolean
  /** Initial editor content (used when re-mounting after the external editor). */
  seed?: string
  pendingImageCount: number
  listCommands(): readonly MenuEntry[]
  runCommand(line: string): void
  onSubmit(text: string): void
  onInterrupt(): void
  onExit(): void
  /** Reports the box's rendered row count (feeds the splash filler budget). */
  onHeightChange?: (rows: number) => void
}

interface EditorState {
  lines: string[]
  row: number
  col: number
}

interface Menu {
  kind: 'commands' | 'files'
  query: string
  entries: readonly { label: string; description: string }[]
  index: number
}

const HELP_TEXT =
  'Enter 发送 · Ctrl+J 换行 · ↑↓ 历史/菜单 · Tab 补全 · Esc 中断/清空 · Ctrl+O 工具详情 · ' +
  'Ctrl+C 清空，空输入时双击退出 · /help 帮助 · /edit 外部编辑器 · /image <路径> 附加图片'

const MENU_SIZE = 8
/** Visible entry rows the menu always occupies (blank-filled while filtering). */
const MENU_SLOTS = 8

export function InputBox(props: InputBoxProps): ReactElement {
  const { store, history, frozen, questionFreeText, seed, pendingImageCount, listCommands, runCommand, onSubmit, onInterrupt, onExit, onHeightChange } = props
  const [ed, setEd] = useState<EditorState>(() => seedToState(seed))
  const [histIdx, setHistIdx] = useState(-1)
  const [draft, setDraft] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const menuIndexRef = useRef(0)
  const dismissedQueryRef = useRef<string | null>(null)
  const reportedHeightRef = useRef(-1)

  const isEmpty = ed.lines.length === 1 && ed.lines[0] === ''
  const { stdout } = useStdout()
  const termColumns = Math.max(24, stdout?.columns !== undefined && stdout.columns > 0 ? stdout.columns : 80)

  // Report the rendered row count (borders + wrapped editor lines + hints +
  // menu) so App's splash filler can absorb height changes without scrolling.
  // Must be the exact rendered height: the first frame's scroll budget depends
  // on it. Long editor lines wrap inside the border box at its inner width
  // (columns − 4), so the wrapped row count — not the line count — is what
  // occupies rows.
  useLayoutEffect(() => {
    const menuOpen = menu !== null && menu.entries.length > 0
    const inner = Math.max(8, termColumns - 4)
    const editorRows = ed.lines.reduce((n, line) => n + textRows(line === '' ? ' ' : line, inner), 0)
    const h = 2 + editorRows +
      (pendingImageCount > 0 ? textRows(`📎 已附加 ${pendingImageCount} 张图片，将随下一条消息发送`, inner) : 0) +
      (questionFreeText && isEmpty && histIdx === -1 ? textRows('输入你的回答，Enter 提交（Esc 跳过）…', inner) : 0) +
      (menuOpen ? MENU_SLOTS + 3 : 0)
    if (h !== reportedHeightRef.current) {
      reportedHeightRef.current = h
      onHeightChange?.(h)
    }
  })

  // -- Completion menu derivation -------------------------------------------

  useEffect(() => {
    if (frozen || questionFreeText) {
      setMenu(null)
      return
    }
    const text = ed.lines.join('\n')
    const line = ed.lines[ed.row] ?? ''
    const before = Array.from(line).slice(0, ed.col).join('')

    // Slash menu: the whole input is one unfinished command word.
    if (text.startsWith('/') && !text.includes(' ') && !text.includes('\n')) {
      const query = text.slice(1).toLowerCase()
      if (dismissedQueryRef.current === `/${query}`) {
        setMenu(null)
        return
      }
      const entries = listCommands()
        .filter(entry => entry.name.toLowerCase().startsWith(query))
        .slice(0, MENU_SIZE)
        .map(entry => ({ label: `/${entry.name}`, description: entry.description }))
      const index = Math.min(menuIndexRef.current, Math.max(0, entries.length - 1))
      setMenu(entries.length > 0 ? { kind: 'commands', query, entries, index } : null)
      return
    }

    // File menu: an @-reference word at the cursor.
    const at = before.lastIndexOf('@')
    if (at >= 0 && !before.slice(at + 1).includes(' ')) {
      const query = before.slice(at + 1)
      if (dismissedQueryRef.current === `@${query}`) {
        setMenu(null)
        return
      }
      let cancelled = false
      void listWorkspaceFiles(process.cwd()).then(files => {
        if (cancelled) return
        const entries = fuzzyMatchPaths(query, files, MENU_SIZE)
          .map(match => ({ label: match.path, description: '' }))
        const index = Math.min(menuIndexRef.current, Math.max(0, entries.length - 1))
        setMenu(entries.length > 0 ? { kind: 'files', query, entries, index } : null)
      })
      return () => { cancelled = true }
    }
    setMenu(null)
    return
  }, [ed, frozen, questionFreeText, listCommands])

  // -- Keyboard --------------------------------------------------------------

  useInput((input, key) => {
    if (frozen) return
    // Kitty-protocol terminals report key release as a separate event; without
    // this guard every keypress would fire the handler twice.
    if (key.eventType === 'release') return

    // Shift+Tab cycles the approval mode (每次询问 ⇄ 自动允许). Distinct from
    // the menu's plain Tab "accept completion", so it also works while a
    // completion menu is open.
    if (key.tab && key.shift) {
      store.cycleApprovalMode()
      return
    }

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
      if (menu !== null) {
        dismissedQueryRef.current = menu.kind === 'commands' ? `/${menu.query}` : `@${menu.query}`
        setMenu(null)
        return
      }
      if (questionFreeText) {
        store.skipQuestion()
        return
      }
      if (store.getSnapshot().phase !== 'idle') {
        onInterrupt()
      } else if (!isEmpty) {
        setEd({ lines: [''], row: 0, col: 0 })
        setHistIdx(-1)
        setDraft(null)
      }
      return
    }

    // Menu navigation takes the arrows, Tab, and Enter while it is open.
    if (menu !== null && menu.entries.length > 0) {
      if (key.upArrow) {
        menuIndexRef.current = Math.max(0, menu.index - 1)
        setMenu({ ...menu, index: menuIndexRef.current })
        return
      }
      if (key.downArrow) {
        menuIndexRef.current = Math.min(menu.entries.length - 1, menu.index + 1)
        setMenu({ ...menu, index: menuIndexRef.current })
        return
      }
      if (key.tab) {
        applyMenuCompletion(menu.entries[menu.index]!.label)
        return
      }
      if (key.return) {
        if (menu.kind === 'commands') {
          const entry = menu.entries[menu.index]!
          runCommand(entry.label)
          setEd({ lines: [''], row: 0, col: 0 })
          setHistIdx(-1)
          setDraft(null)
        } else {
          applyMenuCompletion(menu.entries[menu.index]!.label)
        }
        return
      }
      // Any other key falls through to normal editing; the menu re-derives.
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

    if (key.ctrl && input === 'o') {
      store.toggleVerboseToolDetail()
      return
    }
    if (key.ctrl && input === 'r') {
      store.toggleVerboseTranscript()
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
        const chars = Array.from(current.lines[current.row] ?? [])
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

  // -- Menu helpers -----------------------------------------------------------

  function applyMenuCompletion(label: string): void {
    if (menu === null) return
    dismissedQueryRef.current = null
    if (menu.kind === 'commands') {
      setEd({ lines: [`${label} `], row: 0, col: label.length + 1 })
      return
    }
    setEd(current => {
      const chars = Array.from(current.lines[current.row] ?? [])
      const line = chars.join('')
      const before = chars.slice(0, current.col).join('')
      const at = before.lastIndexOf('@')
      if (at < 0) return current
      const completed = `${line.slice(0, at)}@${label} ${line.slice(current.col)}`
      return { lines: [...current.lines.slice(0, current.row), completed, ...current.lines.slice(current.row + 1)], row: current.row, col: at + label.length + 2 }
    })
  }

  // -- Editing helpers ----------------------------------------------------------

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
      const submitted = next.lines.join('\n').trim()
      if (submitted === '') return
      if (questionFreeText) {
        if (submitted === '/exit' || submitted === '/quit') {
          onExit()
          return
        }
        store.submitFreeTextAnswer(submitted)
        return
      }
      submitText(submitted)
    } else {
      setEd(next)
    }
  }

  function submit(): void {
    const text = ed.lines.join('\n').trim()
    if (text === '') return
    if (questionFreeText) {
      if (text === '/exit' || text === '/quit') {
        onExit()
        return
      }
      store.submitFreeTextAnswer(text)
      setEd({ lines: [''], row: 0, col: 0 })
      setHistIdx(-1)
      setDraft(null)
      return
    }
    submitText(text)
  }

  function submitText(text: string): void {
    if (text.startsWith('/') && !text.includes('\n')) {
      runCommand(text)
    } else {
      onSubmit(text)
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

  // -- Render -------------------------------------------------------------------

  return (
    <Box flexDirection="column">
      {menu !== null && menu.entries.length > 0 && (
        // Fixed height: filtering swaps entries for blank slots instead of
        // resizing, so the frame height never changes while typing and the
        // input box stays pinned to the bottom row.
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} height={MENU_SLOTS + 1}>
          {Array.from({ length: MENU_SLOTS }, (_, index) => {
            const entry = menu.entries[index]
            if (entry === undefined) return <Text key={`blank-${index}`}>{' '}</Text>
            return (
              <Text key={entry.label} inverse={index === menu.index}>
                {`${entry.label}${entry.description !== '' ? `  ${entry.description}` : ''}`}
              </Text>
            )
          })}
          <Text dimColor>↑↓ 选择 · Tab 补全 · Enter {menu.kind === 'commands' ? '执行' : '补全'} · Esc 关闭</Text>
        </Box>
      )}
      <Box flexDirection="column" borderStyle="round" borderColor={frozen ? 'gray' : 'cyan'} paddingX={1}>
        {isEmpty && histIdx === -1 && questionFreeText && (
          <Text dimColor>输入你的回答，Enter 提交（Esc 跳过）…</Text>
        )}
        {pendingImageCount > 0 && (
          <Text color="magenta">{`📎 已附加 ${pendingImageCount} 张图片，将随下一条消息发送`}</Text>
        )}
        {ed.lines.map((line, index) => (
          <Text key={index}>
            {index === ed.row
              ? <CursorLine line={line} col={ed.col} />
              : (line === '' ? ' ' : line)}
          </Text>
        ))}
      </Box>
    </Box>
  )
}

function seedToState(seed: string | undefined): EditorState {
  if (seed === undefined || seed === '') return { lines: [''], row: 0, col: 0 }
  const lines = seed.split('\n')
  const last = lines[lines.length - 1] ?? ''
  return { lines, row: lines.length - 1, col: Array.from(last).length }
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
