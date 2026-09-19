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
 *
 * The editor paints at most editorRowCap(stdout.rows) visual rows, sliding a
 * window (with a one-row overflow indicator) over layoutEditor's wrap so the
 * cursor stays visible. The cap bounds the input box to a fraction of the
 * viewport no matter how large the draft grows — without it a big paste blows
 * the splash-filler budget, the frame overflows the viewport, and ink's
 * cursor model desyncs (the "input box jumped up" family's worst case).
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Dispatch, ReactElement, SetStateAction } from 'react'
import { Box, Text, useInput, usePaste, useStdout } from 'ink'
import stringWidth from 'string-width'
import type { PendingImage, PendingOutput, TuiStore } from '../store.js'
import { readClipboardImage, readClipboardText } from '../clipboard.js'
import { isExistingImagePath, parsePathChunk } from '../path-drops.js'
import { OSC11_REMNANT_RE } from '../terminal-bg.js'
import { parseShellBang } from '../shell-bang.js'
import {
  completeShellCommand,
  completeShellPath,
  isPathLikeWord,
  listPathCommands,
  quoteShellWord,
  shellWordAt,
} from '../shell-complete.js'
import { fuzzyMatchPaths, listWorkspaceFiles } from '../workspace-files.js'
import { truncateLine } from './estimate.js'
import { textRows, wrapTextRows } from './ink-text.js'
import { theme } from './theme.js'

export interface MenuEntry {
  readonly name: string
  readonly description: string
  readonly kind: 'builtin' | 'dsh' | 'skill'
}

export interface SubmitOptions {
  /** Queue as its own follow-up turn instead of steering the running one. */
  queue?: boolean
}

export interface InputBoxProps {
  store: TuiStore
  history: readonly string[]
  frozen: boolean
  /** A pending free-text question: Enter answers it instead of sending a message. */
  questionFreeText: boolean
  /** Show the free-text answer hint inside the editor (empty editor only). */
  showFreeTextHint: boolean
  pendingImages: readonly PendingImage[]
  /** `!`-run outputs stashed for the next message (the output tray). */
  pendingOutputs: readonly PendingOutput[]
  /** Editor state lives in App (not here): the splash-filler budget must be
   * computed from the input's height in the SAME commit that paints the input,
   * and a late useLayoutEffect report paints one oversized frame first — the
   * terminal scrolls it and ink's cursor model never re-syncs, stranding the
   * input above the bottom row. */
  ed: EditorState
  setEd: Dispatch<SetStateAction<EditorState>>
  /** Visible editor rows resolved by App from the same-commit filler budget
   * (editorRowsForSpace): when other live-region rows grow — a completion
   * menu, streaming reply, approval card — the editor SHRINKS instead of
   * pushing the frame past the viewport. Undefined falls back to the raw
   * terminal-rows cap for standalone use. */
  editorVisibleRows?: number
  /** Completion menu state, lifted to App for the same reason. */
  menu: Menu | null
  setMenu: Dispatch<SetStateAction<Menu | null>>
  listCommands(): readonly MenuEntry[]
  runCommand(line: string): void
  /** `!`-prefixed shell passthrough line (raw, bang included). */
  onShell(line: string): void
  /** Attaches extracted drop paths to the next message (terminal file-drop). */
  onDropFiles?: (paths: readonly string[]) => void
  onSubmit(text: string, opts?: SubmitOptions): void
  /** Recall the newest unclaimed message back into the editor; null when none pending. */
  onRecallPending(): string | null
  /** Attach a clipboard image (PNG bytes + display name) to the next message. */
  onClipboardImage(data: Uint8Array, name: string): void
  onInterrupt(): void
  onExit(): void
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
 * header (the skill group) that still occupies a visible slot. Entries carry
 * the fuzzy-match hit positions (character indices into `label`, rendered
 * bold) and the untruncated description for ←→ expansion. */
export type MenuRow =
  | { readonly type: 'header'; readonly label: string }
  | {
    readonly type: 'entry'
    readonly label: string
    readonly description: string
    readonly skill: boolean
    readonly hits?: readonly number[]
    readonly fullDescription?: string
  }

export interface Menu {
  kind: 'commands' | 'files' | 'shell'
  query: string
  /** Rendered lines in order, headers included — the window slides over rows. */
  rows: readonly MenuRow[]
  /** Highlighted row; the invariant is that it always points at an entry row. */
  index: number
  /** First visible row of the MENU_SLOTS-tall sliding window over rows. */
  scroll: number
  /** Commands menu only: ←→ toggles the description between the 40-column
   * teaser and the full text (still single-row, truncated to the pane). */
  expanded: boolean
  /** Shell menu only: where the completed word starts (code-point index into
   * the draft's single line) and whether it sits in command position. */
  shell?: { wordStart: number; command: boolean }
}

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
  const { store, history, frozen, questionFreeText, showFreeTextHint, pendingImages, pendingOutputs, ed, setEd, editorVisibleRows, menu, setMenu, listCommands, runCommand, onShell, onSubmit, onRecallPending, onClipboardImage, onDropFiles, onInterrupt, onExit } = props
  const [histIdx, setHistIdx] = useState(-1)
  const [draft, setDraft] = useState<string | null>(null)
  const menuIndexRef = useRef(0)
  const menuScrollRef = useRef(0)
  const dismissedQueryRef = useRef<string | null>(null)
  /** ←→ description-expansion flag, keyed by the query it belongs to. */
  const expandRef = useRef<{ query: string; expanded: boolean }>({ query: '', expanded: false })
  /** First visible visual row of the editor's scroll window; adjusted during
   * render (never painted from stale) and ignored by the height estimate. */
  const editorScrollRef = useRef(0)

  const isEmpty = ed.lines.length === 1 && ed.lines[0] === ''
  const { stdout } = useStdout()
  // Width of the dynamic region as laid out by App (terminal columns minus
  // the one-column margin that keeps the live UI off the terminal's last
  // column) — every truncation base here must match it or a max-width row
  // would wrap and corrupt the fixed pane budget.
  const regionColumns = Math.max(24, stdout?.columns !== undefined && stdout.columns > 0 ? stdout.columns : 80) - 1

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

    // Shell menu: a `!` passthrough draft completes PATH commands in command
    // position, real filesystem paths everywhere else. Single-line drafts
    // only — shell syntax past line 0 is left to the shell.
    if (ed.lines.length === 1 && text.startsWith('!')) {
      const word = shellWordAt(text, ed.col)
      if (word === undefined || word.query === '') {
        setMenu(null)
        return
      }
      if (dismissedQueryRef.current === `!${word.query}`) {
        setMenu(null)
        return
      }
      const useCommands = word.command && !isPathLikeWord(word.query)
      let cancelled = false
      void (async () => {
        const rows: readonly MenuRow[] = useCommands
          ? completeShellCommand(word.query, await listPathCommands()).map(name => ({
              type: 'entry' as const, label: name, description: '命令', skill: false,
            }))
          : (await completeShellPath(word.query, process.cwd())).map(match => ({
              type: 'entry' as const,
              label: match.label,
              description: match.directory ? '目录' : '',
              skill: false,
            }))
        if (cancelled) return
        if (rows.length === 0) {
          setMenu(null)
          return
        }
        const index = clampToEntryRow(rows, Math.min(menuIndexRef.current, rows.length - 1))
        const scroll = clampScroll(menuScrollRef.current, index, rows.length)
        menuScrollRef.current = scroll
        setMenu({
          kind: 'shell',
          query: word.query,
          rows,
          index,
          scroll,
          expanded: false,
          shell: { wordStart: word.start, command: word.command },
        })
      })()
      return () => { cancelled = true }
    }

    // Slash menu: the whole input is one unfinished command or skill word.
    if (text.startsWith('/') && !text.includes(' ') && !text.includes('\n')) {
      const query = text.slice(1).toLowerCase()
      if (dismissedQueryRef.current === `/${query}`) {
        setMenu(null)
        return
      }
      // Fuzzy ranking (Codex's popup order): exact-prefix matches first in
      // registry order, then in-order subsequence matches — "dk" surfaces
      // /doctor. Hits are label character indices (label = '/' + name).
      const queryChars = Array.from(query).length
      const scored: Array<{ entry: MenuEntry; tier: number; score: number; hits: number[]; order: number }> = []
      for (const [order, entry] of listCommands().entries()) {
        if (query === '') {
          scored.push({ entry, tier: 0, score: 0, hits: [], order })
          continue
        }
        if (entry.name.toLowerCase().startsWith(query)) {
          scored.push({ entry, tier: 0, score: 0, hits: Array.from({ length: queryChars }, (_, i) => i + 1), order })
          continue
        }
        const fuzzy = fuzzySubsequence(entry.name, query)
        if (fuzzy !== undefined) {
          scored.push({ entry, tier: 1, score: fuzzy.score, hits: fuzzy.hits.map(i => i + 1), order })
        }
      }
      scored.sort((a, b) => a.tier - b.tier || a.score - b.score || a.order - b.order)
      const commands: MenuRow[] = []
      const skills: MenuRow[] = []
      for (const { entry, hits } of scored) {
        const row: MenuRow = {
          type: 'entry',
          label: `/${entry.name}`,
          description: truncateLine(entry.description, MENU_DESC_COLUMNS),
          skill: entry.kind === 'skill',
          hits,
          fullDescription: entry.description,
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
      // Expansion survives re-derivations that did not change the query (a
      // cursor move, a refetch); typing a new query collapses it again. The
      // flag rides a ref keyed by query — `menu` must NOT join the deps (the
      // effect rewrites the menu object; a menu dep would loop forever).
      const expanded = expandRef.current.query === query ? expandRef.current.expanded : false
      expandRef.current = { query, expanded }
      const index = clampToEntryRow(rows, menuIndexRef.current)
      const scroll = clampScroll(menuScrollRef.current, index, rows.length)
      menuScrollRef.current = scroll
      setMenu({ kind: 'commands', query, rows, index, scroll, expanded })
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
          .map(match => ({
            type: 'entry' as const,
            label: match.path,
            // Directories carry a trailing `/` (walk convention); label it so
            // the entry reads as a folder, and completion leaves it open-ended.
            description: match.path.endsWith('/') ? '目录' : '',
            skill: false,
          }))
        if (rows.length === 0) {
          setMenu(null)
          return
        }
        const index = clampToEntryRow(rows, Math.min(menuIndexRef.current, rows.length - 1))
        const scroll = clampScroll(menuScrollRef.current, index, rows.length)
        menuScrollRef.current = scroll
        setMenu({ kind: 'files', query, rows, index, scroll, expanded: false })
        return
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
        dismissedQueryRef.current =
          menu.kind === 'commands' ? `/${menu.query}`
          : menu.kind === 'shell' ? `!${menu.query}`
          : `@${menu.query}`
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
      if (key.leftArrow || key.rightArrow) {
        // Commands menu only: ←→ toggles the description between the teaser
        // and the full text. The @ menu keeps the arrows for cursor movement
        // — there they change the @-word and the query itself.
        if (menu.kind === 'commands') {
          expandRef.current = { query: menu.query, expanded: !menu.expanded }
          setMenu({ ...menu, expanded: expandRef.current.expanded })
          return
        }
      }
      if (key.tab) {
        const row = menu.rows[menu.index]!
        if (row.type === 'entry') applyMenuCompletion(row.label)
        return
      }
      if (key.return) {
        const row = menu.rows[menu.index]!
        if (row.type !== 'entry') return
        if (menu.kind === 'shell') {
          // Enter runs the draft as typed — Tab is the completion key here
          // (mcode's applyOnEnter:false). Close first so the menu pane never
          // shares a frame with the run's panel or notice.
          dismissedQueryRef.current = null
          setMenu(null)
          menuIndexRef.current = 0
          menuScrollRef.current = 0
          submit()
          return
        }
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

    // Tab with no completion menu open: while the agent is busy, queue the
    // draft as its own follow-up turn — Enter steers the running turn instead.
    if (key.tab) {
      if (!isEmpty && store.getSnapshot().phase !== 'idle') submitAsQueue()
      return
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

    if ((key.ctrl || key.meta) && input === 'v') {
      void pasteFromClipboard()
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

    // Alt/Option+Up recalls the newest unclaimed message into the editor.
    if (key.upArrow && key.meta) {
      const text = onRecallPending()
      if (text !== null) {
        setEd(seedToState(text))
        setHistIdx(-1)
        setDraft(null)
      }
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
    // newest stashed item (image or `!` output — real stash order) and
    // Alt+Backspace empties both trays; once text is in the editor they keep
    // their normal editing role.
    if (key.backspace && isEmpty && (pendingImages.length > 0 || pendingOutputs.length > 0)) {
      if (key.meta || key.ctrl) {
        store.addNotice(`已清空 ${store.clearStash()} 条暂存（图片与命令输出）`)
      } else {
        const removed = store.removeLastStashed()
        if (removed === undefined) store.addNotice('暂存区已空', 'warn')
        else if (removed.kind === 'image') store.addNotice(`已移除待发送图片：${removed.label}`)
        else store.addNotice(`已移除暂存命令输出：${removed.command}`)
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
    if (menu.kind === 'shell') {
      // Replace the partial word with the candidate (quoted when the shell
      // would otherwise split it). A directory keeps no trailing space — the
      // user continues into it; anything else gets one for the next argument.
      const chars = Array.from(ed.lines[0] ?? '')
      const inserted = quoteShellWord(label)
      const tail = chars.slice(ed.col).join('')
      const needsGap = !label.endsWith('/') && (tail === '' || !/^\s/u.test(tail))
      const head = chars.slice(0, menu.shell?.wordStart ?? chars.length).join('') + inserted
      setEd({
        lines: [head + (needsGap ? ' ' : '') + tail],
        row: 0,
        col: Array.from(head).length + (needsGap ? 1 : 0),
      })
      return
    }
    setEd(current => {
      const chars = Array.from(current.lines[current.row] ?? [])
      const line = chars.join('')
      const before = chars.slice(0, current.col).join('')
      const at = before.lastIndexOf('@')
      if (at < 0) return current
      // A completed directory keeps no trailing space — the user continues
      // into it (@src/ui/ + `Input` → @src/ui/Input); files get one.
      const gap = label.endsWith('/') ? '' : ' '
      const completed = `${line.slice(0, at)}@${label}${gap}${line.slice(current.col)}`
      return { lines: [...current.lines.slice(0, current.row), completed, ...current.lines.slice(current.row + 1)], row: current.row, col: at + label.length + 1 + gap.length }
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
    // `!` passthrough outranks slash dispatch: the line never reaches the
    // command registry or the model. An empty command keeps the draft so the
    // user can finish typing it.
    const bang = parseShellBang(text)
    if (bang !== undefined) {
      if (bang.command === '') {
        store.addNotice('用法：! <命令> — 本地执行，输出暂存并随下一条消息进入上下文（!! 则仅本地查看）', 'warn')
        return
      }
      onShell(text)
      setEd({ lines: [''], row: 0, col: 0 })
      setHistIdx(-1)
      setDraft(null)
      return
    }
    if (text.startsWith('/') && !text.includes('\n')) {
      runCommand(text)
    } else {
      onSubmit(text)
    }
    setEd({ lines: [''], row: 0, col: 0 })
    setHistIdx(-1)
    setDraft(null)
  }

  /** Queue the draft as its own follow-up turn while the agent is busy (Tab).
   * Free-text questions and slash commands keep their Enter semantics — only
   * plain messages have a queue/steer distinction. */
  function submitAsQueue(): void {
    const text = ed.lines.join('\n').trim()
    if (text === '') return
    if (questionFreeText || text.startsWith('/')) {
      submit()
      return
    }
    onSubmit(text, { queue: true })
    setEd({ lines: [''], row: 0, col: 0 })
    setHistIdx(-1)
    setDraft(null)
  }

  /** Ctrl/Cmd+V: clipboard text inserts at the cursor (a functional update —
   * the read is async and typing may have moved the editor on); a bitmap
   * attaches to the next message as an image. */
  async function pasteFromClipboard(): Promise<void> {
    const text = await readClipboardText()
    if (text !== '') {
      const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      if (normalized !== '') {
        setEd(current => spliceInto(current, normalized))
        return
      }
    }
    const image = await readClipboardImage()
    if (image === null) {
      store.addNotice('剪贴板中没有文本或图片', 'warn')
      return
    }
    onClipboardImage(image.data, image.name)
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

  // The editor draws at most rowCap visual (wrapped) rows, sliding a window
  // over the layout so the cursor stays visible. App resolves the cap
  // (editorVisibleRows) from the same-commit filler budget, so a menu, tray,
  // or other live-region growth SHRINKS the editor instead of overflowing the
  // viewport; the raw terminal-rows cap is only the standalone fallback. The
  // window offset rides a ref: the input height the budget consumes does not
  // depend on the offset, so the same-commit invariant of computeInputHeight
  // is intact.
  const innerColumns = Math.max(8, regionColumns - 4)
  const layout = layoutEditor(ed.lines, innerColumns, ed.row, ed.col)
  const rowCap = Math.max(1, editorVisibleRows ?? editorRowCap(stdout?.rows))
  const editorCapped = layout.rows.length > rowCap
  const visibleRows = Math.min(layout.rows.length, rowCap)
  const maxEditorScroll = Math.max(0, layout.rows.length - visibleRows)
  let editorScroll = Math.min(Math.max(0, editorScrollRef.current), maxEditorScroll)
  // Edge-only slide, the completion menu's clampScroll feel: the window sits
  // perfectly still until the cursor would leave it, then moves just enough.
  if (layout.cursorRow < editorScroll) editorScroll = layout.cursorRow
  if (layout.cursorRow >= editorScroll + visibleRows) editorScroll = layout.cursorRow - visibleRows + 1
  editorScrollRef.current = editorScroll
  const shownRows = layout.rows.slice(editorScroll, editorScroll + visibleRows)

  return (
    <Box flexDirection="column">
      {menu !== null && menu.rows.length > 0 && (
        // The pane always renders MENU_SLOTS slot rows (blank-filled) plus the
        // hint row, so its height stays constant while filtering and the input
        // box stays pinned to the bottom row. Deliberately NOT set via the
        // `height` style: a fixed-height column box mis-measures its text
        // children in ink 7's first layout pass (siblings get overlapping
        // positions and render on top of each other), while the natural
        // content height is already constant here. Every row is truncated to
        // the pane's inner width — a wrapped row would corrupt the fixed slot
        // budget the filler was computed from.
        <Box flexDirection="column" borderStyle="round" borderColor={theme.borderMuted} paddingX={1}>
          {Array.from({ length: MENU_SLOTS }, (_, line) => {
            const row = menu.rows[menu.scroll + line]
            if (row === undefined) return <Text key={`blank-${line}`}>{' '}</Text>
            if (row.type === 'header') {
              return <Text key={`header-${line}`} dimColor>{truncateLine(`— ${row.label} —`, regionColumns - 4)}</Text>
            }
            return (
              <Text key={row.label} backgroundColor={menu.scroll + line === menu.index ? theme.selectedBg : undefined}>
                <MenuEntryText row={row} expanded={menu.expanded} innerWidth={regionColumns - 4} />
              </Text>
            )
          })}
          <Text dimColor>{truncateLine(menuHint(menu), regionColumns - 4)}</Text>
        </Box>
      )}
      <Box flexDirection="column" borderStyle="round" borderColor={frozen ? theme.borderMuted : theme.borderAccent} paddingX={1}>
        {showFreeTextHint && <Text dimColor>{FREE_TEXT_HINT}</Text>}
        {pendingImages.length > 0 && (
          <>
            <Text color={theme.approval}>{`📎 已附加 ${pendingImages.length} 张图片，将随下一条消息发送`}</Text>
            <Text dimColor>{trayDetailText(pendingImages)}</Text>
          </>
        )}
        {pendingOutputs.length > 0 && (
          <>
            <Text color={theme.approval}>{outputTrayHeadline(pendingOutputs.length)}</Text>
            <Text dimColor>{outputsDetailText(pendingOutputs)}</Text>
          </>
        )}
        {shownRows.map((row, index) => (
          <Text key={editorScroll + index}>
            {editorScroll + index === layout.cursorRow
              ? <CursorLine line={row} col={layout.cursorCol} maxWidth={innerColumns} />
              : row}
          </Text>
        ))}
        {editorCapped && (
          // One reserved row whenever the layout is capped (its presence
          // depends only on the row count, never on the window offset, so the
          // estimator stays exact): where the window sits inside the draft.
          <Text dimColor>
            {truncateLine(overflowHint(layout.rows.length, editorScroll, visibleRows), innerColumns)}
          </Text>
        )}
      </Box>
    </Box>
  )
}

/** One completion row's visible text: fuzzy-hit-bolded label + two-space gap
 * + description, composed so the total never exceeds the pane's inner width
 * (a wrapped row would corrupt the fixed slot budget the filler was computed
 * from). With ←→ expansion the description shows in full — still truncated
 * to the space left beside the label. */
function MenuEntryText(props: { row: Extract<MenuRow, { type: 'entry' }>; expanded: boolean; innerWidth: number }): ReactElement {
  const { row, expanded, innerWidth } = props
  const labelWidth = stringWidth(row.label)
  const descSource = expanded && row.fullDescription !== undefined ? row.fullDescription : row.description
  const descWidth = Math.max(0, innerWidth - labelWidth - 2)
  const desc = descWidth > 0 ? truncateLine(descSource, descWidth) : ''
  const label = desc !== '' ? row.label : truncateLine(row.label, innerWidth)
  return (
    <>
      <HitLabel label={label} hits={row.hits ?? []} />
      {desc !== '' && `  ${desc}`}
    </>
  )
}

/** Label text with the fuzzy-match characters bolded. */
function HitLabel(props: { label: string; hits: readonly number[] }): ReactElement {
  const chars = Array.from(props.label)
  const hits = new Set(props.hits)
  const runs: Array<{ text: string; hit: boolean }> = []
  for (const [index, ch] of chars.entries()) {
    const hit = hits.has(index)
    const last = runs[runs.length - 1]
    if (last !== undefined && last.hit === hit) last.text += ch
    else runs.push({ text: ch, hit })
  }
  return <>{runs.map((run, index) => <Text key={index} bold={run.hit}>{run.text}</Text>)}</>
}

export function seedToState(seed: string | undefined): EditorState {
  if (seed === undefined || seed === '') return { lines: [''], row: 0, col: 0 }
  const lines = seed.split('\n')
  const last = lines[lines.length - 1] ?? ''
  return { lines, row: lines.length - 1, col: Array.from(last).length }
}

/** Placeholder shown in an empty editor while a free-text question is open. */
export const FREE_TEXT_HINT = '输入你的回答，Enter 提交（Esc 跳过）…'

/** Rows the pending-image tray occupies inside the editor border (0 when empty).
 * Shared by the render and the height estimate so the filler budget matches
 * exactly what will be drawn. */
export function imageTrayRows(images: readonly PendingImage[], columns: number): number {
  if (images.length === 0) return 0
  const inner = Math.max(8, columns - 4)
  return textRows(`📎 已附加 ${images.length} 张图片，将随下一条消息发送`, inner) +
    textRows(trayDetailText(images), inner)
}

/** Headline of the output tray; the render and the estimator share one string. */
export function outputTrayHeadline(count: number): string {
  return `🧾 已暂存 ${count} 条命令输出，将随下一条消息发送（Enter 发送 · 空输入框 ⌫ 撤销）`
}

/** One-line summaries of the stashed `!` outputs. */
function outputsDetailText(outputs: readonly PendingOutput[]): string {
  return outputs.map(output => output.summary).join(' · ')
}

/** Rows the output tray occupies inside the editor border (0 when empty);
 * shared by the render and the height estimate. */
export function outputTrayRows(outputs: readonly PendingOutput[], columns: number): number {
  if (outputs.length === 0) return 0
  const inner = Math.max(8, columns - 4)
  return textRows(outputTrayHeadline(outputs.length), inner) +
    textRows(outputsDetailText(outputs), inner)
}

/** Floor on the visible editor rows: even a tiny terminal keeps the editor
 * usable (pi-tui's editor uses the same 5). */
const MIN_EDITOR_ROWS = 5

/** Visible editor rows cap — a fraction of the viewport, pi-tui style — so a
 * huge paste or draft adds an internal scroll instead of growing the input
 * box toward the viewport height. Unknown or absurd row counts (the renderer
 * treats ≥1000 the same way) fall back to the 24-row classic, which caps
 * conservatively. */
export function editorRowCap(termRows: number | undefined): number {
  const rows = termRows !== undefined && termRows > 0 && termRows < 1000 ? termRows : 24
  return Math.max(MIN_EDITOR_ROWS, Math.floor(rows * 0.3))
}

/** Rows the completion pane occupies inside the input-box column while open
 * (fixed slots + hint row + round borders). App needs the number BEFORE the
 * menu renders to carve the editor's budget, so it lives next to MENU_SLOTS. */
export const MENU_PANE_ROWS = MENU_SLOTS + 3

/** Exact wrapped row count of the editor buffer — shared by the App budget
 * and the height estimate so both reason from one number. */
export function countEditorRows(lines: readonly string[], inner: number): number {
  return lines.reduce((n, line) => n + textRows(line === '' ? ' ' : line, inner), 0)
}

/** Resolve the editor's visible rows from the space the input box may occupy.
 * Two caps combine: the base terminal-fraction cap, and — when App knows the
 * rows available to the input box (`availableRows`, viewport minus banner,
 * settled transcript, and other live-region rows) — a budget cap that makes
 * the editor SHRINK as menus/panels/streaming grow around it. Reserves one
 * row for the overflow indicator and one safety row so the box can never
 * exceed `availableRows`; never below 1. */
export function editorRowsForSpace(s: {
  rows?: number
  availableRows?: number
  totalEditorRows: number
  menuRows: number
  trayRows: number
  hintRows: number
}): number {
  const baseVisible = Math.min(s.totalEditorRows, editorRowCap(s.rows))
  if (s.availableRows === undefined) return baseVisible
  const budgetCap = Math.max(1, s.availableRows - s.menuRows - s.trayRows - s.hintRows - 4)
  return Math.min(baseVisible, budgetCap)
}

/** The editor's visual layout: every logical line pre-wrapped to the same
 * rows Ink would render (wrapTextRows, ink's own wrap options), plus the
 * cursor's position mapped onto them. InputBox paints a window over these
 * rows; computeInputHeight counts min(rows, cap) from the same wrap. */
export interface EditorLayout {
  /** Visual rows of the whole buffer; an empty logical line renders as ' '. */
  readonly rows: readonly string[]
  /** Visual row index the cursor sits on. */
  readonly cursorRow: number
  /** Code-point column of the cursor within rows[cursorRow]. */
  readonly cursorCol: number
}

/** Single-slot memo: InputBox re-renders on every store flush (streaming
 * frames included) with an unchanged editor, and the wrap is the pricey part. */
let layoutMemo: {
  lines: readonly string[]
  inner: number
  row: number
  col: number
  layout: EditorLayout
} | null = null

export function layoutEditor(
  lines: readonly string[],
  inner: number,
  edRow: number,
  edCol: number,
): EditorLayout {
  const memo = layoutMemo
  if (memo !== null && memo.lines === lines && memo.inner === inner && memo.row === edRow && memo.col === edCol) {
    return memo.layout
  }
  const rows: string[] = []
  let cursorRow = 0
  let cursorCol = 0
  lines.forEach((line, index) => {
    const chunks = wrapTextRows(line === '' ? ' ' : line, inner)
    if (index === edRow) {
      // The wrap never drops characters, so walking code-point lengths lands
      // the cursor on its chunk; the last-chunk fallback covers col == length.
      let seen = 0
      for (const [chunkIndex, chunk] of chunks.entries()) {
        const length = Array.from(chunk).length
        if (edCol < seen + length || chunkIndex === chunks.length - 1) {
          cursorRow = rows.length + chunkIndex
          cursorCol = Math.max(0, edCol - seen)
          break
        }
        seen += length
      }
    }
    rows.push(...chunks)
  })
  const layout: EditorLayout = {
    rows,
    cursorRow: Math.min(cursorRow, Math.max(0, rows.length - 1)),
    cursorCol,
  }
  layoutMemo = { lines, inner, row: edRow, col: edCol, layout }
  return layout
}

/** Content of the editor's overflow indicator row: where the scroll window
 * sits inside the draft. Render-only — the row's PRESENCE is what the
 * estimator counts, and that depends only on the row count. */
function overflowHint(total: number, above: number, shown: number): string {
  const below = total - above - shown
  const parts = [`编辑区共 ${total} 行`]
  if (above > 0) parts.push(`上方还有 ${above} 行`)
  if (below > 0) parts.push(`下方还有 ${below} 行`)
  return `…（${parts.join(' · ')}）`
}

/**
 * The input box's exact rendered row count: borders + visible editor rows
 * (capped, with a one-row overflow indicator past the cap) + optional
 * attachment tray / free-text hint / completion pane. App calls this in its
 * render body so the splash-filler budget is computed in the SAME commit
 * that paints the input — a height that reaches the budget one paint later
 * (the old useLayoutEffect report) draws an oversized frame first, the
 * terminal scrolls it, and ink's incremental renderer never re-syncs its
 * cursor model, leaving the input stranded above the bottom row.
 *
 * The editor's visible rows come from `editorVisibleRows` (App's budget
 * resolution, also handed to InputBox as a prop) when provided, else from
 * `editorRowsForSpace` over `availableRows`, else from the bare
 * `editorRowCap(rows)` — exactly one of the three levels applies.
 */
export function computeInputHeight(state: {
  lines: readonly string[]
  menuOpen: boolean
  trayRows: number
  freeTextHint: boolean
  columns: number
  /** Terminal rows; undefined caps the editor at the 24-row fallback. */
  rows?: number
  /** Rows available to the whole input box, per App's same-commit budget. */
  availableRows?: number
  /** Pre-resolved visible editor rows (App passes its editorRowsForSpace
   * result so the estimate and the render consume one shared number). */
  editorVisibleRows?: number
}): number {
  const inner = Math.max(8, state.columns - 4)
  const totalEditorRows = countEditorRows(state.lines, inner)
  const menuRows = state.menuOpen ? MENU_PANE_ROWS : 0
  const hintRows = state.freeTextHint ? textRows(FREE_TEXT_HINT, inner) : 0
  const visible = state.editorVisibleRows ??
    editorRowsForSpace({
      rows: state.rows,
      availableRows: state.availableRows,
      totalEditorRows,
      menuRows,
      trayRows: state.trayRows,
      hintRows,
    })
  const indicatorRows = totalEditorRows > visible ? 1 : 0
  return 2 + visible + indicatorRows + state.trayRows + hintRows + menuRows
}

/** In-order subsequence match of `query` against a command name (case-insensitive).
 * Score prefers contiguous runs, earlier hits, and tight spread; undefined = no match. */
function fuzzySubsequence(name: string, query: string): { score: number; hits: number[] } | undefined {
  const chars = Array.from(name.toLowerCase())
  const hits: number[] = []
  let score = 0
  let searchFrom = 0
  for (const ch of Array.from(query.toLowerCase())) {
    let found = -1
    for (let i = searchFrom; i < chars.length; i++) {
      if (chars[i] === ch) {
        found = i
        break
      }
    }
    if (found < 0) return undefined
    if (hits.length > 0 && found === hits[hits.length - 1]! + 1) score -= 4
    hits.push(found)
    searchFrom = found + 1
  }
  score += hits[hits.length - 1]! - hits[0]! + hits[0]!
  return { score, hits }
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
  const enter = menu.kind === 'commands' ? '执行/插入' : menu.kind === 'shell' ? '执行' : '补全'
  const expand = menu.kind === 'commands' ? ' · ←→ 描述' : ''
  return `${position}↑↓ 选择 · Tab 补全 · Enter ${enter}${expand} · Esc 关闭`
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

/**
 * Cursor-row composition: the inverse-video cell is the character at `col`,
 * or a trailing space at end-of-line — EXCEPT on a row already at full
 * display width, where an appended cursor cell would wrap and add one
 * unestimated visual row (the estimate/render mismatch family); there the
 * last character carries the inverse video instead.
 */
export function cursorSegments(
  line: string,
  col: number,
  maxWidth: number,
): { before: string; at: string; after: string } {
  const chars = Array.from(line)
  if (col >= chars.length) {
    if (chars.length > 0 && stringWidth(line) >= Math.max(1, maxWidth)) {
      return { before: chars.slice(0, -1).join(''), at: chars[chars.length - 1]!, after: '' }
    }
    return { before: line, at: ' ', after: '' }
  }
  return { before: chars.slice(0, col).join(''), at: chars[col] ?? ' ', after: chars.slice(col + 1).join('') }
}

function CursorLine(props: { line: string; col: number; maxWidth: number }): ReactElement {
  const { before, at, after } = cursorSegments(props.line, props.col, props.maxWidth)
  return (
    <>
      <Text>{before}</Text>
      <Text inverse>{at}</Text>
      <Text>{after}</Text>
    </>
  )
}
