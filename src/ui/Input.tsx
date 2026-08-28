/**
 * The multiline input editor: code-point-aware cursor editing, input history,
 * slash-command and @-path completion menus, and the keyboard contract for the
 * whole app (submit, newline, interrupt, clear, arm-exit).
 *
 * Input arrives through two Ink channels: `useInput` for keystrokes and
 * `usePaste` for pasted text (bracketed paste mode). Multi-character chunks
 * that still reach `useInput` are coalesced typing or piped automation; their
 * line endings are normalized and a trailing newline behaves like Enter.
 *
 * A third arrival shape is a terminal file-drop: dropping a file onto the
 * window pastes its (quoted) path, which this editor offers to attach as an
 * image while the buffer holds nothing else — see interceptDrop below.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Box, Text, useInput, usePaste, useStdout } from 'ink'
import type { PendingImage, TuiStore } from '../store.js'
import { isExistingImagePath, parsePathChunk } from '../path-drops.js'
import { OSC11_REMNANT_RE } from '../terminal-bg.js'
import { fuzzyMatchPaths, listWorkspaceFiles } from '../workspace-files.js'
import { truncateLine } from './estimate.js'
import { textRows } from './ink-text.js'
import { theme } from './theme.js'

export interface MenuEntry {
  readonly name: string
  readonly description: string
  readonly kind: 'builtin' | 'dsh' | 'skill'
}

export interface InputBoxProps {
  store: TuiStore
  history: readonly string[]
  frozen: boolean
  /** A pending free-text question: Enter answers it instead of sending a message. */
  questionFreeText: boolean
  /** Initial editor content (used when re-mounting after the external editor). */
  seed?: string
  /** Full editor state (text + cursor) captured from a previous mount; takes
   * precedence over `seed` when a resize rebuild must not lose the draft. */
  restore?: EditorState
  pendingImages: readonly PendingImage[]
  listCommands(): readonly MenuEntry[]
  runCommand(line: string): void
  /** Attaches extracted drop paths to the next message (terminal file-drop). */
  onDropFiles?: (paths: readonly string[]) => void
  onSubmit(text: string): void
  onInterrupt(): void
  onExit(): void
  /** Reports the box's rendered row count (feeds the splash filler budget). */
  onHeightChange?: (rows: number) => void
}

export interface EditorState {
  lines: string[]
  row: number
  col: number
}

/**
 * The live editor state of the currently mounted InputBox, updated on every
 * render. A resize rebuild unmounts and remounts the whole Ink tree, so the
 * in-progress draft can only survive through this module-level handoff —
 * same pattern as the splash-filler height caches.
 */
export const draftCapture: { state: EditorState | null } = { state: null }

/** One rendered menu line: a selectable entry, or a non-selectable section
 * header (the skill group) that still occupies a visible slot. */
type MenuRow =
  | { readonly type: 'header'; readonly label: string }
  | { readonly type: 'entry'; readonly label: string; readonly description: string; readonly skill: boolean }

interface Menu {
  kind: 'commands' | 'files'
  query: string
  /** Rendered lines in order, headers included — the window slides over rows. */
  rows: readonly MenuRow[]
  /** Highlighted row; the invariant is that it always points at an entry row. */
  index: number
  /** First visible row of the MENU_SLOTS-tall sliding window over rows. */
  scroll: number
}

const HELP_TEXT =
  'Enter 发送 · Ctrl+J 换行 · ↑↓ 历史/菜单 · Tab 补全 · Esc 中断/清空 · Ctrl+O 工具详情 · ' +
  'Ctrl+C 清空，空输入时双击退出 · /help 帮助 · /edit 外部编辑器 · /image <路径> 附加图片'

/** Visible entry rows the menu always occupies; a longer filtered list scrolls
 * through this window, a shorter one is blank-filled to keep the frame height. */
const MENU_SLOTS = 8
/** Cap on fuzzy @-path matches gathered for the scrollable menu; commands are uncapped. */
const MAX_FILE_MATCHES = 60
/** Display-column cap on menu descriptions: long skill summaries stay a
 * one-line teaser. The pane's fixed height assumes one row per entry, so an
 * uncapped description could wrap and corrupt the slot budget. */
const MENU_DESC_COLUMNS = 40

export function InputBox(props: InputBoxProps): ReactElement {
  const { store, history, frozen, questionFreeText, seed, restore, pendingImages, listCommands, runCommand, onSubmit, onDropFiles, onInterrupt, onExit, onHeightChange } = props
  const [ed, setEd] = useState<EditorState>(() => restore ?? seedToState(seed))
  const [histIdx, setHistIdx] = useState(-1)
  const [draft, setDraft] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const menuIndexRef = useRef(0)
  const menuScrollRef = useRef(0)
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
    const menuOpen = menu !== null && menu.rows.length > 0
    const inner = Math.max(8, termColumns - 4)
    const editorRows = ed.lines.reduce((n, line) => n + textRows(line === '' ? ' ' : line, inner), 0)
    const h = 2 + editorRows +
      (pendingImages.length > 0
        ? textRows(`📎 已附加 ${pendingImages.length} 张图片，将随下一条消息发送`, inner) +
          textRows(trayDetailText(pendingImages), inner)
        : 0) +
      (questionFreeText && isEmpty && histIdx === -1 ? textRows('输入你的回答，Enter 提交（Esc 跳过）…', inner) : 0) +
      (menuOpen ? MENU_SLOTS + 3 : 0)
    if (h !== reportedHeightRef.current) {
      reportedHeightRef.current = h
      onHeightChange?.(h)
    }
  })

  // Mirror the live editor state into the module-level capture on every render
  // so a resize rebuild can remount with the draft (and cursor) intact.
  useLayoutEffect(() => {
    draftCapture.state = ed
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

    // Slash menu: the whole input is one unfinished command or skill word.
    if (text.startsWith('/') && !text.includes(' ') && !text.includes('\n')) {
      const query = text.slice(1).toLowerCase()
      if (dismissedQueryRef.current === `/${query}`) {
        setMenu(null)
        return
      }
      const commands: MenuRow[] = []
      const skills: MenuRow[] = []
      for (const entry of listCommands()) {
        if (!entry.name.toLowerCase().startsWith(query)) continue
        const row: MenuRow = {
          type: 'entry',
          label: `/${entry.name}`,
          description: truncateLine(entry.description, MENU_DESC_COLUMNS),
          skill: entry.kind === 'skill',
        }
        ;(entry.kind === 'skill' ? skills : commands).push(row)
      }
      // Both groups carry an explicit header; a group the filter emptied out
      // disappears together with its header.
      const rows: readonly MenuRow[] = [
        ...(commands.length > 0 ? [{ type: 'header' as const, label: '命令' }, ...commands] : []),
        ...(skills.length > 0 ? [{ type: 'header' as const, label: '技能' }, ...skills] : []),
      ]
      if (rows.length === 0) {
        setMenu(null)
        return
      }
      const index = clampToEntryRow(rows, menuIndexRef.current)
      const scroll = clampScroll(menuScrollRef.current, index, rows.length)
      menuScrollRef.current = scroll
      setMenu({ kind: 'commands', query, rows, index, scroll })
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
        const rows: readonly MenuRow[] = fuzzyMatchPaths(query, files, MAX_FILE_MATCHES)
          .map(match => ({ type: 'entry' as const, label: match.path, description: '', skill: false }))
        if (rows.length === 0) {
          setMenu(null)
          return
        }
        const index = clampToEntryRow(rows, Math.min(menuIndexRef.current, rows.length - 1))
        const scroll = clampScroll(menuScrollRef.current, index, rows.length)
        menuScrollRef.current = scroll
        setMenu({ kind: 'files', query, rows, index, scroll })
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
    // A terminal's OSC 11 background probe can be answered after the startup
    // detection window closed; ink then delivers the unknown escape sequence
    // here as literal text, which would type junk into the editor.
    if (OSC11_REMNANT_RE.test(input)) return

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

    // Menu navigation takes the arrows, Tab, and Enter while it is open. The
    // highlight walks the full filtered list (section headers are skipped —
    // they are never selectable); the visible window slides when the cursor
    // would leave it.
    if (menu !== null && menu.rows.length > 0) {
      if (key.upArrow || key.downArrow) {
        const index = key.upArrow
          ? prevEntryRow(menu.rows, menu.index)
          : nextEntryRow(menu.rows, menu.index)
        if (index === menu.index) return
        menuIndexRef.current = index
        menuScrollRef.current = clampScroll(menu.scroll, index, menu.rows.length)
        setMenu({ ...menu, index, scroll: menuScrollRef.current })
        return
      }
      if (key.tab) {
        const row = menu.rows[menu.index]!
        if (row.type === 'entry') applyMenuCompletion(row.label)
        return
      }
      if (key.return) {
        const row = menu.rows[menu.index]!
        if (row.type !== 'entry') return
        if (menu.kind === 'files' || row.skill) {
          // Skills (and any file entry) complete into the draft — the user
          // keeps typing the task text around the /name gesture.
          applyMenuCompletion(row.label)
          return
        }
        runCommand(row.label)
        setEd({ lines: [''], row: 0, col: 0 })
        setHistIdx(-1)
        setDraft(null)
        // Close in the same batch as the command's store update: the menu's
        // 11 rows must not share a frame with the panel/notice the command
        // just added — that frame overflows the viewport, the terminal
        // scrolls, and ink's incremental renderer never re-syncs its cursor
        // model, leaving the input box stranded above the bottom row.
        setMenu(null)
        menuIndexRef.current = 0
        menuScrollRef.current = 0
        return
      }
      // Any other key falls through to normal editing; the menu re-derives.
    }

    // Coalesced typing or piped automation: insert as (multi-)line text and
    // submit when the chunk carries a trailing newline.
    if (input.length > 1) {
      if (interceptDrop(input)) return
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

    // Attachment tray edits: with an empty editor, Backspace retracts the
    // newest pending image and Alt+Backspace empties the tray; once text is in
    // the editor they keep their normal editing role.
    if (key.backspace && isEmpty && pendingImages.length > 0) {
      if (key.meta || key.ctrl) {
        store.addNotice(`已清空 ${store.clearPendingImages()} 张待发送图片`)
      } else {
        const removed = store.removeLastPendingImage()
        if (removed !== undefined) store.addNotice(`已移除待发送图片：${removed.label}`)
      }
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
    if (interceptDrop(text)) return
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

  /**
   * Drop-to-attach gate: terminals implement dragging a file onto the window
   * as a paste of its path (quoted or escaped when it contains spaces). While
   * the editor holds nothing else, a chunk made purely of existing image paths
   * becomes an immediate attachment instead of typed text; any other content,
   * an in-progress draft, or a non-image keeps the original paste behavior.
   */
  function interceptDrop(chunk: string): boolean {
    if (frozen || onDropFiles === undefined) return false
    const buffer = ed.lines.join('\n').trim()
    if (buffer !== '' && buffer.toLowerCase() !== '/image') return false
    const parsed = parsePathChunk(chunk)
    if (!parsed.allImages || parsed.paths.some(path => !isExistingImagePath(path))) return false
    setEd({ lines: [''], row: 0, col: 0 })
    setHistIdx(-1)
    setDraft(null)
    onDropFiles(parsed.paths)
    return true
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
      {menu !== null && menu.rows.length > 0 && (
        // The pane always renders MENU_SLOTS slot rows (blank-filled) plus the
        // hint row, so its height stays constant while filtering and the input
        // box stays pinned to the bottom row. Deliberately NOT set via the
        // `height` style: a fixed-height column box mis-measures its text
        // children in ink 7's first layout pass (siblings get overlapping
        // positions and render on top of each other), while the natural
        // content height is already constant here.
        <Box flexDirection="column" borderStyle="round" borderColor={theme.muted} paddingX={1}>
          {Array.from({ length: MENU_SLOTS }, (_, line) => {
            const row = menu.rows[menu.scroll + line]
            if (row === undefined) return <Text key={`blank-${line}`}>{' '}</Text>
            if (row.type === 'header') {
              return <Text key={`header-${line}`} dimColor>{`— ${row.label} —`}</Text>
            }
            return (
              <Text key={row.label} inverse={menu.scroll + line === menu.index}>
                {`${row.label}${row.description !== '' ? `  ${row.description}` : ''}`}
              </Text>
            )
          })}
          <Text dimColor>{menuHint(menu)}</Text>
        </Box>
      )}
      <Box flexDirection="column" borderStyle="round" borderColor={frozen ? theme.muted : theme.accent} paddingX={1}>
        {isEmpty && histIdx === -1 && questionFreeText && (
          <Text dimColor>输入你的回答，Enter 提交（Esc 跳过）…</Text>
        )}
        {pendingImages.length > 0 && (
          <>
            <Text color={theme.approval}>{`📎 已附加 ${pendingImages.length} 张图片，将随下一条消息发送`}</Text>
            <Text dimColor>{trayDetailText(pendingImages)}</Text>
          </>
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

/**
 * Clamp a window offset so it stays inside the list and the highlighted row
 * stays visible. Sliding only happens at the window edges — an in-window move
 * keeps the offset (and the whole pane) perfectly still.
 */
function clampScroll(scroll: number, index: number, length: number): number {
  let at = Math.min(Math.max(0, scroll), Math.max(0, length - MENU_SLOTS))
  if (index < at) at = index
  if (index >= at + MENU_SLOTS) at = index - MENU_SLOTS + 1
  return at
}

/** Nearest selectable entry row at or after `at` (walking forward suffices: a
 * header is always followed by its section's entries, so it can only be
 * skipped over, never landed on). */
function clampToEntryRow(rows: readonly MenuRow[], at: number): number {
  let i = Math.min(Math.max(0, at), rows.length - 1)
  while (i < rows.length - 1 && rows[i]!.type === 'header') i++
  return i
}

/** Row of the previous entry, holding position at the first one. */
function prevEntryRow(rows: readonly MenuRow[], from: number): number {
  for (let i = from - 1; i >= 0; i--) if (rows[i]!.type === 'entry') return i
  return from
}

/** Row of the next entry, holding position at the last one. */
function nextEntryRow(rows: readonly MenuRow[], from: number): number {
  for (let i = from + 1; i < rows.length; i++) if (rows[i]!.type === 'entry') return i
  return from
}

/** One-row menu footer; prepends the window position when the filtered list
 * outgrows the visible slots, without adding a row to the fixed-height pane. */
function menuHint(menu: Menu): string {
  const entries = menu.rows.filter(row => row.type === 'entry').length
  const position = entries > MENU_SLOTS
    ? `第 ${menu.rows.slice(0, menu.index + 1).filter(row => row.type === 'entry').length}/${entries} 项 · `
    : ''
  return `${position}↑↓ 选择 · Tab 补全 · Enter ${menu.kind === 'commands' ? '执行/插入' : '补全'} · Esc 关闭`
}

/** Names of the queued images in the attachment tray; shared by the render and
 * the height estimate so the filler budget matches exactly what will be drawn. */
function trayDetailText(images: readonly PendingImage[]): string {
  return images.map(image => image.label).join(' · ')
}
export { trayDetailText }

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
