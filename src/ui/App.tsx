/**
 * The Ink root: Static region for the settled transcript, dynamic region for
 * pending tools, the streaming reply, approval/question prompts, status line,
 * and the input editor.
 */

import { appendFileSync } from 'node:fs'
import { useSyncExternalStore } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Box, Static, Text, useInput, useStdout, measureElement } from 'ink'
import type { DOMElement } from 'ink'
import type {
  ActiveQuestion,
  ApprovalMode,
  ApprovalPrompt,
  FinalItem,
  PendingTool,
  Snapshot,
  TuiStore,
  ToolItem,
} from '../store.js'
import { formatToolArgs, QUESTION_WINDOW } from '../store.js'
import type { EditorState, MenuEntry } from './Input.js'
import { renderFileDiffs } from '../diff.js'
import { renderMarkdownLines } from '../markdown.js'
import { BANNER_BOX_HEIGHT, WelcomeBanner } from './Banner.js'
import { estimateApprovalHeight, estimateItemHeight, estimateQuestionHeight, formatElapsed, headTailPreview, questionHintText, questionOptionRow, truncateLine, userBarRows } from './estimate.js'
import { computeInputHeight, imageTrayRows, seedToState } from './Input.js'
import { InputBox } from './Input.js'
import type { Menu } from './Input.js'
import type { SubmitOptions } from './Input.js'
import { StatusBar } from './StatusBar.js'
import { theme } from './theme.js'

export interface AppActions {
  onSubmit(text: string, opts?: SubmitOptions): void
  runCommand(line: string): void
  /** Attaches image paths extracted from a terminal file-drop. */
  onDroppedFiles(paths: readonly string[]): void
  /** Attaches a clipboard image (PNG bytes + display name). */
  onClipboardImage(data: Uint8Array, name: string): void
  /** Recalls the newest unclaimed message back into the editor; null when none pending. */
  onRecallPending(): string | null
  onInterrupt(): void
  onExit(): void
}

export interface AppProps {
  store: TuiStore
  history: readonly string[]
  actions: AppActions
  listCommands(): readonly MenuEntry[]
  /** Initial editor content (external-editor re-mount). */
  seed?: string
  /** Restored editor state for resize rebuilds (text + cursor). */
  restore?: EditorState
  /** True only for the first frame after a resize rebuild: the splash filler
   * then keeps a small safety slack so an estimator miss can never make the
   * first frame taller than the viewport (an overflow would scroll the
   * replayed transcript's head into scrollback). */
  rebuilding?: boolean
}

/** Frame-overflow diagnostics, mirroring index.ts's debugLog channel: an
 * over-viewport dynamic frame is a rendering bug (the terminal scrolls it and
 * ink's cursor model desyncs — the "input box jumped up" family), so every
 * occurrence is worth a line in /tmp/fx-debug.log under FX_TUI_DEBUG. */
function frameDebug(label: string, data: Record<string, unknown>): void {
  if (process.env.FX_TUI_DEBUG === undefined) return
  try {
    appendFileSync('/tmp/fx-debug.log', `${Date.now()} ${label} ${JSON.stringify(data)}\n`)
  } catch { /* debug logging is best-effort */ }
}

export function App(props: AppProps): ReactElement {
  const snap = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot)
  const { stdout } = useStdout()
  const columns = stdout?.columns
  const rows = stdout?.rows
  const termColumns = Math.max(24, columns !== undefined && columns > 0 ? columns : 80)
  const width = Math.max(24, termColumns - 2)
  // The banner spans the terminal's full width — the same width the input box
  // stretches to in the dynamic region — so the top and bottom borders align.
  const bannerWidth = termColumns
  const frozen = snap.approval !== null || (snap.question !== null && !snap.questionFreeText)

  // The editor state and completion menu live HERE, not in InputBox: the
  // splash-filler budget must be computed from the input's height in the same
  // commit that paints the input. A height reported from a child's layout
  // effect arrives one paint late — the oversized intermediate frame scrolls
  // the terminal, and ink's incremental renderer never re-syncs, which is
  // exactly the "input box jumps up" failure family (see docs/ui-research-2026-08.md).
  const [ed, setEd] = useState<EditorState>(() => props.restore ?? seedToState(props.seed))
  const [menu, setMenu] = useState<Menu | null>(null)
  // Cleared after the first commit so the rebuild-only filler slack applies
  // exactly once — later frames re-measure everything themselves.
  const firstFrameRef = useRef(true)

  // Elastic splash filler: blank rows between the settled transcript and the
  // live region keep the frame at viewport height while the conversation is
  // shorter than the screen — the banner stays pinned to the top edge and the
  // input to the bottom row, and every new line consumes filler instead of
  // scrolling (Claude Code's startup screen). Once the filler is exhausted the
  // app scrolls like a normal terminal transcript and the banner erodes into
  // scrollback line by line. Sizing errs on the small side: a short filler
  // only leaves a harmless gap above the status bar, while an oversized one
  // would push the frame top into the Static region and erase transcript rows.
  const rebuildSlack = props.rebuilding === true && firstFrameRef.current ? 2 : 0
  const isEmpty = ed.lines.length === 1 && ed.lines[0] === ''
  const inputHeight = computeInputHeight({
    lines: ed.lines,
    menuOpen: menu !== null && menu.rows.length > 0,
    trayRows: imageTrayRows(snap.pendingImages, termColumns),
    // An empty editor can only be un-browsing history (history entries are
    // never empty), so the hint needs no history-cursor knowledge here.
    freeTextHint: snap.questionFreeText && isEmpty,
    columns: termColumns,
  })
  const { filler, live } = computeFiller(snap as Snapshot, width, termColumns, rows, inputHeight, rebuildSlack)

  // Flicker detector (Gemini CLI's useFlickerDetector): a dynamic frame taller
  // than the viewport means some height estimate missed — ink will scroll the
  // overflow and strand the input box. Measured in a layout effect, when yoga
  // has already laid out this commit's tree.
  const liveRegionRef = useRef<DOMElement>(null)
  useLayoutEffect(() => {
    if (rows === undefined || rows <= 0 || rows >= 1000) return
    const node = liveRegionRef.current
    if (node === null) return
    const { height } = measureElement(node)
    if (height > rows) frameDebug('frame-overflow', { height, rows, version: snap.version })
  })
  useLayoutEffect(() => {
    firstFrameRef.current = false
  })

  return (
    <Box flexDirection="column">
      <Static items={snap.items as FinalItem[]}>
        {(item, index) => (
          <FinalItemView
            key={index}
            item={item}
            width={item.kind === 'banner' || item.kind === 'user' ? bannerWidth : width}
            columns={termColumns}
          />
        )}
      </Static>
      <Box ref={liveRegionRef} flexDirection="column">
        {filler > 0 && Array.from({ length: filler }, (_, index) => (
          <Text key={`filler-${index}`}>{' '}</Text>
        ))}
        {snap.pendingTools.length === 1 && <PendingToolView tool={snap.pendingTools[0]!} width={width} />}
        {snap.pendingTools.length > 1 && (
          // Codex's compact group display: parallel calls collapse to one
          // running line; each settles into its own card on completion.
          <Text color={theme.warning}>{truncateLine(`⚙ 并行运行 ${snap.pendingTools.length} 个工具…`, termColumns)}</Text>
        )}
        {snap.streaming !== '' && <StreamView text={snap.streaming} width={width} />}
        {snap.approval !== null && <ApprovalView store={props.store} prompt={snap.approval} />}
        {snap.question !== null && !snap.questionFreeText && (
          <QuestionView store={props.store} question={snap.question} width={width} />
        )}
        {snap.question !== null && snap.questionFreeText && (
          <FreeTextQuestionView question={snap.question} columns={termColumns} />
        )}
        {snap.todos.length > 0 && <TodoPanel todos={snap.todos} width={width} />}
        {snap.queuedMessages.length > 0 && (
          <Box flexDirection="column">
            {snap.queuedMessages.slice(0, 5).map((message, index) => (
              <Text key={message.id} color={theme.warning} dimColor>
                {truncateLine(
                  `${message.mode === 'steer' ? '🧭 已注入（下一步生效）' : '⏳ 已排队（下一轮生效）'}${snap.queuedMessages.length > 1 ? `（${index + 1}/${snap.queuedMessages.length}）` : ''}：${message.text}`,
                  termColumns,
                )}
              </Text>
            ))}
            {snap.queuedMessages.length > 5 && (
              <Text color={theme.warning} dimColor>{`…（还有 ${snap.queuedMessages.length - 5} 条消息，Alt+↑ 取回最后一条）`}</Text>
            )}
          </Box>
        )}
        <StatusBar
          phase={snap.phase}
          detail={snap.phaseDetail}
          usage={snap.usage}
          reasoningChars={snap.reasoningChars}
          contextTokens={snap.contextTokens}
          contextWindow={snap.contextWindow}
          childAgents={snap.childAgents}
          effortLabel={snap.effortLabel}
        />
        <InputBox
          store={props.store}
          history={props.history}
          frozen={frozen}
          questionFreeText={snap.question !== null && snap.questionFreeText}
          showFreeTextHint={snap.questionFreeText && isEmpty}
          pendingImages={snap.pendingImages}
          ed={ed}
          setEd={setEd}
          menu={menu}
          setMenu={setMenu}
          listCommands={props.listCommands}
          runCommand={props.actions.runCommand}
          onSubmit={props.actions.onSubmit}
          onRecallPending={props.actions.onRecallPending}
          onClipboardImage={props.actions.onClipboardImage}
          onDropFiles={props.actions.onDroppedFiles}
          onInterrupt={props.actions.onInterrupt}
          onExit={props.actions.onExit}
        />
        <ModeLine mode={snap.approvalMode} columns={termColumns} />
        {snap.exitArmed && <Text color={theme.danger}>再按一次 Ctrl+C 退出 fx-tui</Text>}
      </Box>
    </Box>
  )
}

/** One blank row above every user message and assistant reply: the settled
 * transcript keeps a uniform rhythm of a single blank row between items —
 * matching the intra-reply block spacing the markdown renderer emits. */
function LeadGap(): ReactElement {
  return <Text>{' '}</Text>
}

function FinalItemView(props: { item: FinalItem; width: number; columns: number }): ReactElement {
  const { item, width, columns } = props
  switch (item.kind) {
    case 'banner':
      return <WelcomeBanner item={item} width={width} />
    case 'user':
      return (
        <Box flexDirection="column">
          <LeadGap />
          {userBarRows(item.text, width).map((row, i) => (
            <Text key={i} backgroundColor={theme.userBarBackground} color={theme.userBarForeground} bold>{row}</Text>
          ))}
          {(item.images ?? []).map((label, i) => (
            <Text key={`img-${i}`} color={theme.approval} dimColor>{`📎 ${label}`}</Text>
          ))}
        </Box>
      )
    case 'assistant':
      return (
        <Box flexDirection="column">
          <LeadGap />
          {renderMarkdownLines(item.text, width).map((line, i) => (
            <Text key={i}>{line === '' ? ' ' : line}</Text>
          ))}
          {item.interrupted && <Text color={theme.warning} dimColor>（回复被中断，以上为已生成的部分）</Text>}
        </Box>
      )
    case 'tool':
      // Lead gap keeps the transcript's uniform one-blank-row rhythm; without
      // it adjacent cards sit border-to-border once the store stops emitting
      // the blank assistant items that used to space them apart.
      return (
        <Box flexDirection="column">
          <LeadGap />
          <ToolCardView item={item} columns={columns} />
        </Box>
      )
    case 'notice':
      return (
        <Text
          color={item.tone === 'error' ? theme.danger : item.tone === 'warn' ? theme.warning : theme.muted}
          dimColor={item.tone === 'info'}
        >
          {`${item.tone === 'error' ? '✗ ' : item.tone === 'warn' ? '⚠ ' : '· '}${item.text}`}
        </Text>
      )
    case 'panel':
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
          <Text color={theme.accent} bold>{item.title}</Text>
          {item.lines.map((line, i) => (
            <Text key={i}>{line === '' ? ' ' : line}</Text>
          ))}
        </Box>
      )
  }
}

function PendingToolView(props: { tool: PendingTool; width: number }): ReactElement {
  // Truncated to one row: the filler budget counts one row per pending tool,
  // so a wrapped title would push the frame past its budget.
  return (
    <Text color={theme.warning}>{`⚙ ${truncateLine(props.tool.title, props.width - 10)} 运行中…`}</Text>
  )
}

/** Compact tool card (Codex-style): one status header line plus indented dim
 * preview rows — no border box. Color marks STATE (green/red), not container;
 * a card costs ~2 rows before its content instead of the bordered card's 4.
 * Preview budgets: terminal/generic 5 lines, diff 8, search paths 3, web
 * sources 3 (Ctrl+O raises them). Mirrored row-for-row by
 * estimate.ts/estimateToolCardHeight. */
function ToolCardView(props: { item: ToolItem; columns: number }): ReactElement {
  const { item, columns } = props
  const color = item.ok ? theme.success : theme.danger
  const view = item.view
  const glyph = item.ok ? '✓' : '✗'
  const indent = '  '
  const elapsed = formatElapsed(item.elapsedMs)

  if (view !== undefined && view.card === 'diff') {
    const lines = renderFileDiffs(view.diffs)
    const { shown, hidden } = headTailPreview(lines, item.verbose ? Math.max(1, lines.length) : 8)
    return (
      <Box flexDirection="column">
        <Text color={color}>
          {`${glyph} ${view.title ?? item.title} `}
          <Text dimColor>{`· ${elapsed}`}</Text>
        </Text>
        {shown.map((line, i) => (
          <Text key={i} dimColor>{`${indent}${line === '' ? ' ' : line}`}</Text>
        ))}
        {hidden > 0 && <Text dimColor>{`…（还有 ${hidden} 行，Ctrl+O 切换完整显示）`}</Text>}
      </Box>
    )
  }

  if (view !== undefined && view.card === 'terminal') {
    const status = item.exitCode !== undefined
      ? (item.exitCode === 0 ? 'exit 0' : `exit ${item.exitCode}`)
      : item.signal !== undefined ? item.signal : ''
    const output = view.output ?? item.result
    const { shown, hidden } = headTailPreview(output.split('\n'), item.verbose ? 400 : 5)
    // A non-zero exit keeps the green success color but flips the glyph —
    // the command "ran", the result failed.
    const exitGlyph = item.ok && item.exitCode !== 1 ? '✓' : '✗'
    return (
      <Box flexDirection="column">
        <Text color={color}>
          {`${exitGlyph} ${view.title ?? item.title} `}
          <Text dimColor>{`· ${elapsed}${status !== '' ? ` · ${status}` : ''}`}</Text>
        </Text>
        {shown.map((line, i) => (
          <Text key={i} dimColor>{`${indent}${truncateLine(line, columns - 2)}`}</Text>
        ))}
        {hidden > 0 && <Text dimColor>{`…（还有 ${hidden} 行，Ctrl+O 切换完整显示）`}</Text>}
      </Box>
    )
  }

  if (view !== undefined && view.card === 'search') {
    const summary = view.shape === 'matches'
      ? `${view.files.length} 个文件 · ${view.total} 处匹配${view.truncated ? '（已截断）' : ''}`
      : `${view.paths.length} 个路径${view.truncated ? ` / 共 ${view.total}（已截断）` : ''}`
    const { shown, hidden } = headTailPreview(view.shape === 'paths' ? view.paths : [], item.verbose ? 200 : 3)
    return (
      <Box flexDirection="column">
        <Text color={color}>
          {`${glyph} ${view.title ?? item.title} `}
          <Text dimColor>{`· ${summary} · ${elapsed}`}</Text>
        </Text>
        {shown.map((path, i) => (
          <Text key={i} dimColor>{`${indent}${truncateLine(path, columns - 2)}`}</Text>
        ))}
        {hidden > 0 && <Text dimColor>{`…（还有 ${hidden} 个）`}</Text>}
      </Box>
    )
  }

  if (view !== undefined && view.card === 'read') {
    return (
      <Box flexDirection="column">
        <Text color={color}>
          {`${glyph} ${view.title ?? `读 ${view.path}`} `}
          <Text dimColor>{`· 行 ${view.offset}–${view.offset + view.lines.length - 1} / ${view.totalLines} · ${elapsed}`}</Text>
        </Text>
      </Box>
    )
  }

  if (view !== undefined && view.card === 'web') {
    const summary = view.kind === 'search'
      ? `${view.sources.length} 个来源${view.truncated ? '（已截断）' : ''}`
      : `HTTP ${view.statusCode}${view.truncated ? '（内容已截断）' : ''}`
    const { shown, hidden } = headTailPreview(
      view.kind === 'search' ? view.sources.map(source => source.title ?? source.url) : [],
      3,
    )
    return (
      <Box flexDirection="column">
        <Text color={color}>
          {`${glyph} ${view.title ?? 'web'} `}
          <Text dimColor>{`· ${summary} · ${elapsed}`}</Text>
        </Text>
        {shown.map((title, i) => (
          <Text key={i} dimColor>{`${indent}${truncateLine(title, columns - 2)}`}</Text>
        ))}
        {hidden > 0 && <Text dimColor>{`…（还有 ${hidden} 个来源）`}</Text>}
      </Box>
    )
  }

  // Generic / fallback card: header may embed the args preview.
  const args = formatToolArgs(item.args, Math.max(16, columns - 10))
  const { shown, hidden } = headTailPreview(item.result.split('\n'), item.verbose ? 400 : 5)
  return (
    <Box flexDirection="column">
      <Text color={color}>
        {`${glyph} ${item.title}`}
        {args !== '' && <Text dimColor>{` ${args}`}</Text>}
        <Text dimColor>{` · ${elapsed}`}</Text>
      </Text>
      {shown.map((line, i) => (
        <Text key={i} dimColor>{`${indent}${truncateLine(line, columns - 2)}`}</Text>
      ))}
      {hidden > 0 && <Text dimColor>{`…（还有 ${hidden} 行，Ctrl+O 切换完整显示）`}</Text>}
    </Box>
  )
}

function ApprovalView(props: { store: TuiStore; prompt: ApprovalPrompt }): ReactElement {
  const { store, prompt } = props
  useInput((input, key) => {
    if (key.eventType === 'release') return
    if (input === 'y' || input === 'Y') store.answerApproval('once')
    else if (input === 's' || input === 'S') store.answerApproval('session')
    else if (input === 'a' || input === 'A') store.answerApproval('always')
    else if (input === 'n' || input === 'N' || key.escape) store.answerApproval('reject')
  })
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.approval} paddingX={1}>
      <Text color={theme.approval} bold>{`需要批准：${prompt.toolName}`}</Text>
      {prompt.command !== undefined && prompt.command !== '' && (
        <Text color={theme.approval}>{`  ${prompt.command}`}</Text>
      )}
      {prompt.reason !== '' && <Text dimColor>{prompt.reason}</Text>}
      <Text>
        <Text color={theme.success}>[y] 允许一次</Text>
        {'  '}
        <Text color={theme.warning}>[s] 本会话不再问</Text>
        {'  '}
        <Text color={theme.accent}>[a] 总是允许（记住）</Text>
        {'  '}
        <Text color={theme.danger}>[n] 拒绝</Text>
      </Text>
    </Box>
  )
}

/** Interactive option card for agent questions and plan reviews. Arrow keys
 * are the primary channel (Claude Code / Gemini style); digits 1–9 stay as a
 * jump-select shortcut addressing positions in the visible window. The card
 * shows QUESTION_WINDOW options at a time — longer lists scroll instead of
 * being capped, with ▲/▼ markers (mirrored by the estimator). */
function QuestionView(props: { store: TuiStore; question: ActiveQuestion; width: number }): ReactElement {
  const { store, question } = props
  const item = question.item
  const intent = item.intent
  const isPlanReview = intent?.kind === 'plan-review'
  const approveLabel = isPlanReview ? intent.approve : undefined
  useInput((input, key) => {
    if (key.eventType === 'release') return
    if (key.upArrow) {
      store.moveQuestionCursor(-1)
      return
    }
    if (key.downArrow) {
      store.moveQuestionCursor(1)
      return
    }
    if (key.return) {
      // Single-select confirms the highlighted option; the cursor starts on
      // the plan review's approve option, so bare Enter still approves.
      // Multi-select confirms whatever the digit keys toggled.
      if (item.multiSelect !== true) {
        const option = (item.options ?? [])[question.cursor]
        if (option !== undefined) store.toggleQuestionOption(option.label)
      }
      store.confirmQuestion(approveLabel)
      return
    }
    if (key.escape) {
      store.skipQuestion()
      return
    }
    if (/^[1-9]$/.test(input)) {
      const target = question.scroll + Number(input) - 1
      const option = (item.options ?? [])[target]
      if (option === undefined) return
      store.pointQuestionCursor(target)
      store.toggleQuestionOption(option.label)
    }
  })
  const options = item.options ?? []
  const planLines = isPlanReview && item.detail !== undefined
    ? renderMarkdownLines(item.detail, Math.max(24, props.width - 4))
    : []
  const shownPlan = planLines.slice(0, 30)
  const shown = options.slice(question.scroll, question.scroll + QUESTION_WINDOW)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={isPlanReview ? theme.approval : theme.info} paddingX={1}>
      <Text color={isPlanReview ? theme.approval : theme.info} bold>
        {isPlanReview
          ? `计划审批：${item.question}`
          : `问 题${question.total > 1 ? `（${question.index}/${question.total}）` : ''}：${item.question}`}
      </Text>
      {item.header !== undefined && item.header !== '' && <Text dimColor>{item.header}</Text>}
      {isPlanReview && shownPlan.length > 0 && (
        <Box flexDirection="column" marginTop={0} marginBottom={0}>
          {shownPlan.map((line, i) => (
            <Text key={i}>{line === '' ? ' ' : line}</Text>
          ))}
          {planLines.length > shownPlan.length && (
            <Text dimColor>{`…（计划共 ${planLines.length} 行，已截断显示）`}</Text>
          )}
        </Box>
      )}
      {!isPlanReview && item.detail !== undefined && item.detail !== '' && (
        <Text dimColor>{truncateLine(item.detail, props.width - 4)}</Text>
      )}
      {question.scroll > 0 && <Text dimColor>{`▲（上方还有 ${question.scroll} 项）`}</Text>}
      {shown.map((option, visibleIndex) => {
        const selected = question.selected.includes(option.label)
        const isApprove = approveLabel !== undefined && option.label === approveLabel
        const isCursor = question.scroll + visibleIndex === question.cursor
        return (
          <Text
            key={option.label}
            color={isApprove ? theme.success : selected ? theme.info : undefined}
            bold={selected || isApprove}
            inverse={isCursor}
          >
            {questionOptionRow(option, visibleIndex, { selected, isApprove, cursor: isCursor })}
          </Text>
        )
      })}
      {question.scroll + QUESTION_WINDOW < options.length && (
        <Text dimColor>{`▼（下方还有 ${options.length - question.scroll - QUESTION_WINDOW} 项）`}</Text>
      )}
      <Text dimColor>
        {questionHintText(isPlanReview, item.multiSelect === true)}
      </Text>
    </Box>
  )
}

function FreeTextQuestionView(props: { question: ActiveQuestion; columns: number }): ReactElement {
  const item = props.question.item
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.info} paddingX={1}>
      <Text color={theme.info} bold>{`问 题：${item.question}`}</Text>
      {/* One row by truncation: the estimator budgets the detail as a single
       * line, so an unwrapped long detail would overflow the frame. */}
      {item.detail !== undefined && item.detail !== '' && <Text dimColor>{truncateLine(item.detail, props.columns - 4)}</Text>}
      <Text dimColor>在下方输入框中输入回答，Enter 提交</Text>
    </Box>
  )
}

function TodoPanel(props: { todos: readonly { content: string; status: 'pending' | 'in_progress' | 'completed' }[]; width: number }): ReactElement {
  const shown = props.todos.slice(0, 8)
  const done = props.todos.filter(todo => todo.status === 'completed').length
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warning} paddingX={1}>
      <Text color={theme.warning} bold>{`📋 任务 ${done}/${props.todos.length}`}</Text>
      {shown.map((todo, index) => (
        <Text key={index} color={todo.status === 'in_progress' ? theme.warning : undefined} dimColor={todo.status === 'completed'}>
          {`${todo.status === 'completed' ? '☑' : todo.status === 'in_progress' ? '◐' : '☐'} ${truncateLine(todo.content, props.width - 8)}`}
        </Text>
      ))}
      {props.todos.length > shown.length && (
        <Text dimColor>{`…（还有 ${props.todos.length - shown.length} 项）`}</Text>
      )}
    </Box>
  )
}

/** The permission-mode hint under the input box, Claude-Code style: the
 * current stance is always visible and the Shift+Tab cycle is advertised.
 * Truncated to one row — the filler budget counts this line as exactly 1. */
function ModeLine(props: { mode: ApprovalMode; columns: number }): ReactElement {
  return props.mode === 'auto'
    ? <Text color={theme.warning}>{truncateLine('⏵⏵ 自动允许模式已开启（shift+tab 切换）', props.columns)}</Text>
    : <Text dimColor>{truncateLine('权限模式：每次询问（shift+tab 切换自动允许）', props.columns)}</Text>
}

function StreamView(props: { text: string; width: number }): ReactElement {
  const lines = renderMarkdownLines(props.text, props.width)
  return (
    <Box flexDirection="column">
      <LeadGap />
      {lines.map((line, i) => (
        <Text key={i}>{line === '' ? ' ' : line}</Text>
      ))}
    </Box>
  )
}

// -- Splash filler sizing -----------------------------------------------------
//
// The filler must absorb every layout change without letting the live frame's
// top edge cross into the Static region (which would erase transcript rows),
// so item heights are estimated EXACTLY — the estimators live in estimate.ts,
// shared with the resize rebuild.

/**
 * Blank rows that keep the first screen at viewport height:
 * `rows - banner - settled transcript - live region`, clamped at 0.
 */
function computeFiller(
  snap: Snapshot,
  width: number,
  columns: number,
  rows: number | undefined,
  inputHeight: number,
  slack = 0,
): { filler: number; live: number } {
  if (rows === undefined || rows <= 0 || rows >= 1000) return { filler: 0, live: 0 }
  // Rendered-height cache: transcript items are immutable, so each object's
  // height is computed once per width (markdown wrapping is the pricey part).
  const cache = fillerCache
  if (cache.width !== width) {
    cache.width = width
    cache.map = new WeakMap()
  }
  let settled = 0
  for (const item of snap.items) {
    // The banner is accounted for by the BANNER_BOX_HEIGHT reservation below.
    if (item.kind === 'banner') continue
    const cached = cache.map.get(item)
    if (cached !== undefined) {
      settled += cached
      continue
    }
    const h = estimateItemHeight(item, width, columns)
    cache.map.set(item, h)
    settled += h
  }

  const live =
    (snap.streaming !== '' ? renderMarkdownLines(snap.streaming, width).length + 1 : 0) + // reply + lead gap
    (snap.pendingTools.length > 0 ? 1 : 0) + // one line, even for parallel calls
    (snap.approval !== null ? estimateApprovalHeight(snap.approval, columns) : 0) +
    (snap.question !== null ? estimateQuestionHeight(snap.question, width, columns) : 0) +
    (snap.todos.length > 0 ? 3 + Math.min(8, snap.todos.length) + (snap.todos.length > 8 ? 1 : 0) : 0) +
    (snap.queuedMessages.length > 0 ? Math.min(5, snap.queuedMessages.length) + (snap.queuedMessages.length > 5 ? 1 : 0) : 0) +
    (snap.exitArmed ? 1 : 0) +
    1 + // status bar
    1 + // permission-mode line under the input
    inputHeight +
    1 // trailing-newline budget: the first frame scrolls exactly its row count,
  // so one reserved row keeps the banner's top border on screen
  return { filler: Math.max(0, rows - BANNER_BOX_HEIGHT - settled - live - slack), live }
}

/** Width-keyed per-item height cache; replaced wholesale when the width changes. */
const fillerCache: { width: number; map: WeakMap<object, number> } = {
  width: -1,
  map: new WeakMap(),
}
