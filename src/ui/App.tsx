/**
 * The Ink root: Static region for the settled transcript, dynamic region for
 * pending tools, the streaming reply, approval/question prompts, status line,
 * and the input editor.
 */

import { useSyncExternalStore } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Box, Static, Text, useInput, useStdout } from 'ink'
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
import { formatToolArgs } from '../store.js'
import type { EditorState, MenuEntry } from './Input.js'
import { renderFileDiffs } from '../diff.js'
import { renderMarkdownLines } from '../markdown.js'
import { BANNER_BOX_HEIGHT, WelcomeBanner } from './Banner.js'
import { estimateApprovalHeight, estimateItemHeight, estimateQuestionHeight, formatElapsed, truncateLine, userBarRows } from './estimate.js'
import { InputBox } from './Input.js'
import { StatusBar } from './StatusBar.js'

export interface AppActions {
  onSubmit(text: string): void
  runCommand(line: string): void
  /** Attaches image paths extracted from a terminal file-drop. */
  onDroppedFiles(paths: readonly string[]): void
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
  /** Exact editor height for a restored draft (rebuild first frame). */
  initialInputHeight?: number
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

  // Matches InputBox's reported height for an empty single-line editor, so
  // the first paint already has the final filler and no second frame scrolls.
  // A resize rebuild passes the exact restored-draft height instead, since a
  // multi-line draft would otherwise make the first frame overflow.
  const [inputHeight, setInputHeight] = useState(props.initialInputHeight ?? 3)
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
  // would push the frame top into the static region and erase transcript rows.
  const rebuildSlack = props.rebuilding === true && firstFrameRef.current ? 2 : 0
  const { filler, live } = computeFiller(snap as Snapshot, width, termColumns, rows, inputHeight, rebuildSlack)
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
          />
        )}
      </Static>
      <Box flexDirection="column">
        {filler > 0 && Array.from({ length: filler }, (_, index) => (
          <Text key={`filler-${index}`}>{' '}</Text>
        ))}
        {snap.pendingTools.map((tool: PendingTool) => (
          <PendingToolView key={tool.callId} tool={tool} width={width} />
        ))}
        {snap.streaming !== '' && <StreamView text={snap.streaming} width={width} />}
        {snap.approval !== null && <ApprovalView store={props.store} prompt={snap.approval} />}
        {snap.question !== null && !snap.questionFreeText && (
          <QuestionView store={props.store} question={snap.question} width={width} />
        )}
        {snap.question !== null && snap.questionFreeText && (
          <FreeTextQuestionView question={snap.question} />
        )}
        {snap.todos.length > 0 && <TodoPanel todos={snap.todos} width={width} />}
        {snap.queuedMessages.length > 0 && (
          <Box flexDirection="column">
            {snap.queuedMessages.slice(0, 5).map((message, index) => (
              <Text key={message.id} color="yellow" dimColor>
                {`⏳ 已排队${snap.queuedMessages.length > 1 ? `（${index + 1}/${snap.queuedMessages.length}）` : ''}：${truncateLine(message.text, width - 12)}`}
              </Text>
            ))}
            {snap.queuedMessages.length > 5 && (
              <Text color="yellow" dimColor>{`…（还有 ${snap.queuedMessages.length - 5} 条排队消息）`}</Text>
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
        />
        <InputBox
          store={props.store}
          history={props.history}
          frozen={frozen}
          questionFreeText={snap.question !== null && snap.questionFreeText}
          seed={props.seed}
          restore={props.restore}
          pendingImages={snap.pendingImages}
          listCommands={props.listCommands}
          runCommand={props.actions.runCommand}
          onSubmit={props.actions.onSubmit}
          onDropFiles={props.actions.onDroppedFiles}
          onInterrupt={props.actions.onInterrupt}
          onExit={props.actions.onExit}
          onHeightChange={setInputHeight}
        />
        <ModeLine mode={snap.approvalMode} />
        {snap.exitArmed && <Text color="red">再按一次 Ctrl+C 退出 fx-tui</Text>}
      </Box>
    </Box>
  )
}

/**
 * User-bar tint as a literal hex, deliberately not a named ANSI color: themes
 * remap ANSI gray/light tones towards the theme's own palette — on light-theme
 * terminals "gray" lands near-white and the bar vanishes. The hue mirrors the
 * welcome-banner's rendered teal accent (~181°, brand-cyan family; yellow is
 * reserved for warnings) at pastel lightness, so the bar reads as part of the
 * app's existing palette; near-black text over it stays readable on both light
 * and dark terminals, and chalk degrades the hex gracefully off truecolor.
 */
const USER_BAR_BACKGROUND = '#bdeef2'

/** One blank row above every user message and assistant reply: the settled
 * transcript keeps a uniform rhythm of a single blank row between items —
 * matching the intra-reply block spacing the markdown renderer emits. */
function LeadGap(): ReactElement {
  return <Text>{' '}</Text>
}

function FinalItemView(props: { item: FinalItem; width: number }): ReactElement {
  const { item, width } = props
  switch (item.kind) {
    case 'banner':
      return <WelcomeBanner item={item} width={width} />
    case 'user':
      return (
        <Box flexDirection="column">
          <LeadGap />
          {userBarRows(item.text, width).map((row, i) => (
            <Text key={i} backgroundColor={USER_BAR_BACKGROUND} color="black" bold>{row}</Text>
          ))}
          {(item.images ?? []).map((label, i) => (
            <Text key={`img-${i}`} color="magenta" dimColor>{`📎 ${label}`}</Text>
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
          {item.interrupted && <Text color="yellow" dimColor>（回复被中断，以上为已生成的部分）</Text>}
        </Box>
      )
    case 'tool':
      // Lead gap keeps the transcript's uniform one-blank-row rhythm; without
      // it adjacent cards sit border-to-border once the store stops emitting
      // the blank assistant items that used to space them apart.
      return (
        <Box flexDirection="column">
          <LeadGap />
          <ToolCardView item={item} width={width} />
        </Box>
      )
    case 'notice':
      return (
        <Text
          color={item.tone === 'error' ? 'red' : item.tone === 'warn' ? 'yellow' : 'gray'}
          dimColor={item.tone === 'info'}
        >
          {`${item.tone === 'error' ? '✗ ' : item.tone === 'warn' ? '⚠ ' : '· '}${item.text}`}
        </Text>
      )
    case 'panel':
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text color="cyan" bold>{item.title}</Text>
          {item.lines.map((line, i) => (
            <Text key={i}>{line === '' ? ' ' : line}</Text>
          ))}
        </Box>
      )
  }
}

function PendingToolView(props: { tool: PendingTool; width: number }): ReactElement {
  return (
    <Text color="yellow">{`⚙ ${props.tool.title} 运行中…`}</Text>
  )
}

function ToolCardView(props: { item: ToolItem; width: number }): ReactElement {
  const { item, width } = props
  const color = item.ok ? 'green' : 'red'
  const view = item.view
  const border = view?.card === 'diff' ? 'green' : color

  if (view !== undefined && view.card === 'diff') {
    const lines = renderFileDiffs(view.diffs)
    const shown = item.verbose ? lines : lines.slice(0, 24)
    const more = lines.length - shown.length
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={border} paddingX={1}>
        <Text color={color}>
          {`${item.ok ? '✓' : '✗'} ${view.title ?? item.title} `}
          <Text dimColor>{`· ${formatElapsed(item.elapsedMs)}`}</Text>
        </Text>
        {shown.map((line, i) => (
          <Text key={i}>{line === '' ? ' ' : line}</Text>
        ))}
        {more > 0 && <Text dimColor>{`…（还有 ${more} 行，Ctrl+O 切换完整显示）`}</Text>}
      </Box>
    )
  }

  if (view !== undefined && view.card === 'terminal') {
    const status = item.exitCode !== undefined
      ? (item.exitCode === 0 ? 'exit 0' : `exit ${item.exitCode}`)
      : item.signal !== undefined ? item.signal : ''
    const output = view.output ?? item.result
    const lines = output.split('\n')
    const cap = item.verbose ? 400 : 12
    const shown = lines.slice(0, cap)
    const more = lines.length - shown.length
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
        <Text color={color}>
          {`${item.ok && item.exitCode !== 1 ? '✓' : '✗'} ${view.title ?? item.title} `}
          <Text dimColor>
            {`· ${formatElapsed(item.elapsedMs)}${status !== '' ? ` · ${status}` : ''}`}
          </Text>
        </Text>
        {shown.map((line, i) => (
          <Text key={i} dimColor>{truncateLine(line, width - 4)}</Text>
        ))}
        {more > 0 && <Text dimColor>{`…（还有 ${more} 行，Ctrl+O 切换完整显示）`}</Text>}
      </Box>
    )
  }

  if (view !== undefined && view.card === 'search') {
    const summary = view.shape === 'matches'
      ? `${view.files.length} 个文件 · ${view.total} 处匹配${view.truncated ? '（已截断）' : ''}`
      : `${view.paths.length} 个路径${view.truncated ? ` / 共 ${view.total}（已截断）` : ''}`
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
        <Text color={color}>
          {`${item.ok ? '✓' : '✗'} ${view.title ?? item.title} `}
          <Text dimColor>{`· ${summary} · ${formatElapsed(item.elapsedMs)}`}</Text>
        </Text>
        {(view.shape === 'paths' ? view.paths.slice(0, item.verbose ? 200 : 8) : []).map((path, i) => (
          <Text key={i} dimColor>{`  ${path}`}</Text>
        ))}
        {view.shape === 'paths' && view.paths.length > (item.verbose ? 200 : 8) && (
          <Text dimColor>{`…（还有 ${view.paths.length - (item.verbose ? 200 : 8)} 个）`}</Text>
        )}
      </Box>
    )
  }

  if (view !== undefined && view.card === 'read') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
        <Text color={color}>
          {`${item.ok ? '✓' : '✗'} ${view.title ?? `读 ${view.path}`} `}
          <Text dimColor>
            {`· 行 ${view.offset}–${view.offset + view.lines.length - 1} / ${view.totalLines} · ${formatElapsed(item.elapsedMs)}`}
          </Text>
        </Text>
      </Box>
    )
  }

  if (view !== undefined && view.card === 'web') {
    const summary = view.kind === 'search'
      ? `${view.sources.length} 个来源${view.truncated ? '（已截断）' : ''}`
      : `HTTP ${view.statusCode}${view.truncated ? '（内容已截断）' : ''}`
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
        <Text color={color}>
          {`${item.ok ? '✓' : '✗'} ${view.title ?? 'web'} `}
          <Text dimColor>{`· ${summary} · ${formatElapsed(item.elapsedMs)}`}</Text>
        </Text>
        {view.kind === 'search' && view.sources.slice(0, 5).map((source, i) => (
          <Text key={i} dimColor>{`  ${truncateLine(source.title ?? source.url, width - 6)}`}</Text>
        ))}
      </Box>
    )
  }

  // Generic / fallback card: title + args preview + result text.
  const resultLines = item.result.split('\n')
  const cap = item.verbose ? 400 : 12
  const shown = resultLines.slice(0, cap)
  const more = resultLines.length - shown.length
  const args = formatToolArgs(item.args, Math.max(16, width - 10))
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      <Text color={color}>
        {`${item.ok ? '✓' : '✗'} ${item.title} `}
        {args !== '' && <Text dimColor>{args}</Text>}
        <Text dimColor>{` · ${formatElapsed(item.elapsedMs)}`}</Text>
      </Text>
      {shown.map((line, i) => (
        <Text key={i} dimColor>{truncateLine(line, width - 4)}</Text>
      ))}
      {more > 0 && <Text dimColor>{`…（还有 ${more} 行，Ctrl+O 切换完整显示）`}</Text>}
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
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text color="magenta" bold>{`需要批准：${prompt.toolName}`}</Text>
      {prompt.command !== undefined && prompt.command !== '' && (
        <Text color="magenta">{`  ${prompt.command}`}</Text>
      )}
      {prompt.reason !== '' && <Text dimColor>{prompt.reason}</Text>}
      <Text>
        <Text color="green">[y] 允许一次</Text>
        {'  '}
        <Text color="yellow">[s] 本会话不再问</Text>
        {'  '}
        <Text color="cyan">[a] 总是允许（记住）</Text>
        {'  '}
        <Text color="red">[n] 拒绝</Text>
      </Text>
    </Box>
  )
}

function QuestionView(props: { store: TuiStore; question: ActiveQuestion; width: number }): ReactElement {
  const { store, question } = props
  const item = question.item
  const intent = item.intent
  const isPlanReview = intent?.kind === 'plan-review'
  const approveLabel = isPlanReview ? intent.approve : undefined
  useInput((input, key) => {
    if (key.eventType === 'release') return
    if (key.return) {
      // A plan review confirms the approve option when nothing is selected.
      store.confirmQuestion(approveLabel)
      return
    }
    if (key.escape) {
      store.skipQuestion()
      return
    }
    if (/^[1-9]$/.test(input)) {
      const index = Number(input) - 1
      const options = item.options ?? []
      const option = options[index]
      if (option !== undefined) store.toggleQuestionOption(option.label)
    }
  })
  const options = item.options ?? []
  const planLines = isPlanReview && item.detail !== undefined
    ? renderMarkdownLines(item.detail, Math.max(24, props.width - 4))
    : []
  const shownPlan = planLines.slice(0, 30)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={isPlanReview ? 'magenta' : 'blue'} paddingX={1}>
      <Text color={isPlanReview ? 'magenta' : 'blue'} bold>
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
      {options.map((option, index) => {
        const selected = question.selected.includes(option.label)
        const isApprove = approveLabel !== undefined && option.label === approveLabel
        return (
          <Text
            key={option.label}
            color={isApprove ? 'green' : selected ? 'blue' : undefined}
            bold={selected || isApprove}
          >
            {`[${index + 1}]${selected ? ' ● ' : ' ○ '}${isApprove ? '✓ ' : ''}${option.label}` +
              (option.description !== undefined ? ` — ${option.description}` : '')}
          </Text>
        )
      })}
      <Text dimColor>
        {isPlanReview
          ? 'Enter 批准 · 数字键选择其他选项 · Esc 跳过'
          : item.multiSelect === true
            ? '数字键多选 · Enter 确认 · Esc 跳过'
            : '数字键选择 · Enter 确认 · Esc 跳过'}
      </Text>
    </Box>
  )
}

function FreeTextQuestionView(props: { question: ActiveQuestion }): ReactElement {
  const item = props.question.item
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
      <Text color="blue" bold>{`问 题：${item.question}`}</Text>
      {item.detail !== undefined && item.detail !== '' && <Text dimColor>{item.detail}</Text>}
      <Text dimColor>在下方输入框中输入回答，Enter 提交</Text>
    </Box>
  )
}

function TodoPanel(props: { todos: readonly { content: string; status: 'pending' | 'in_progress' | 'completed' }[]; width: number }): ReactElement {
  const shown = props.todos.slice(0, 8)
  const done = props.todos.filter(todo => todo.status === 'completed').length
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>{`📋 任务 ${done}/${props.todos.length}`}</Text>
      {shown.map((todo, index) => (
        <Text key={index} color={todo.status === 'in_progress' ? 'yellow' : undefined} dimColor={todo.status === 'completed'}>
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
 * current stance is always visible and the Shift+Tab cycle is advertised. */
function ModeLine(props: { mode: ApprovalMode }): ReactElement {
  return props.mode === 'auto'
    ? <Text color="yellow">⏵⏵ 自动允许模式已开启（shift+tab 切换）</Text>
    : <Text dimColor>权限模式：每次询问（shift+tab 切换自动允许）</Text>
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
    snap.pendingTools.length +
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
