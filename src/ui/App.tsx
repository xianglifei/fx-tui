/**
 * The Ink root: Static region for the settled transcript, dynamic region for
 * pending tools, the streaming reply, approval/question prompts, status line,
 * and the input editor.
 */

import { useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { Box, Static, Text, useInput, useStdout } from 'ink'
import type {
  ActiveQuestion,
  ApprovalPrompt,
  FinalItem,
  PendingTool,
  TuiStore,
  ToolItem,
} from '../store.js'
import { formatToolArgs } from '../store.js'
import type { MenuEntry } from './Input.js'
import { renderFileDiffs } from '../diff.js'
import { renderMarkdownLines } from '../markdown.js'
import { InputBox } from './Input.js'
import { StatusBar } from './StatusBar.js'

export interface AppActions {
  onSubmit(text: string): void
  runCommand(line: string): void
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
}

export function App(props: AppProps): ReactElement {
  const snap = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot)
  const { stdout } = useStdout()
  const columns = stdout?.columns
  const width = Math.max(24, (columns !== undefined && columns > 0 ? columns : 80) - 2)
  const frozen = snap.approval !== null || (snap.question !== null && !snap.questionFreeText)

  return (
    <Box flexDirection="column">
      <Static items={snap.items as FinalItem[]}>
        {(item, index) => <FinalItemView key={index} item={item} width={width} />}
      </Static>
      <Box flexDirection="column">
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
        <StatusBar
          phase={snap.phase}
          detail={snap.phaseDetail}
          usage={snap.usage}
          reasoningChars={snap.reasoningChars}
          model={snap.model}
          sessionId={snap.sessionId}
          contextTokens={snap.contextTokens}
          contextWindow={snap.contextWindow}
        />
        <InputBox
          store={props.store}
          history={props.history}
          frozen={frozen}
          questionFreeText={snap.question !== null && snap.questionFreeText}
          seed={props.seed}
          pendingImageCount={snap.pendingImages.length}
          listCommands={props.listCommands}
          runCommand={props.actions.runCommand}
          onSubmit={props.actions.onSubmit}
          onInterrupt={props.actions.onInterrupt}
          onExit={props.actions.onExit}
        />
        {snap.exitArmed && <Text color="red">再按一次 Ctrl+C 退出 fx-tui</Text>}
      </Box>
    </Box>
  )
}

function FinalItemView(props: { item: FinalItem; width: number }): ReactElement {
  const { item, width } = props
  switch (item.kind) {
    case 'user':
      return (
        <Box flexDirection="column">
          {item.text.split('\n').map((line, i) => (
            <Text key={i} color="cyan" bold>{`❯ ${line}`}</Text>
          ))}
          {(item.images ?? []).map((label, i) => (
            <Text key={`img-${i}`} color="magenta" dimColor>{`📎 ${label}`}</Text>
          ))}
        </Box>
      )
    case 'assistant':
      return (
        <Box flexDirection="column">
          {renderMarkdownLines(item.text, width).map((line, i) => (
            <Text key={i}>{line === '' ? ' ' : line}</Text>
          ))}
          {item.interrupted && <Text color="yellow" dimColor>（回复被中断，以上为已生成的部分）</Text>}
        </Box>
      )
    case 'tool':
      return <ToolCardView item={item} width={width} />
    case 'notice':
      return (
        <Text
          color={item.tone === 'error' ? 'red' : item.tone === 'warn' ? 'yellow' : 'gray'}
          dimColor={item.tone === 'info'}
        >
          {`${item.tone === 'error' ? '✗ ' : item.tone === 'warn' ? '⚠ ' : '· '}${item.text}`}
        </Text>
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
  useInput((input, key) => {
    if (key.return) {
      store.confirmQuestion()
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
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
      <Text color="blue" bold>
        {`问 题${question.total > 1 ? `（${question.index}/${question.total}）` : ''}：${item.question}`}
      </Text>
      {item.header !== undefined && item.header !== '' && <Text dimColor>{item.header}</Text>}
      {item.detail !== undefined && item.detail !== '' && (
        <Text dimColor>{truncateLine(item.detail, props.width - 4)}</Text>
      )}
      {options.map((option, index) => {
        const selected = question.selected.includes(option.label)
        return (
          <Text key={option.label} color={selected ? 'blue' : undefined} bold={selected}>
            {`[${index + 1}]${selected ? ' ● ' : ' ○ '}${option.label}` +
              (option.description !== undefined ? ` — ${option.description}` : '')}
          </Text>
        )
      })}
      <Text dimColor>
        {item.multiSelect === true
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

function StreamView(props: { text: string; width: number }): ReactElement {
  const lines = renderMarkdownLines(props.text, props.width)
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i}>{line === '' ? ' ' : line}</Text>
      ))}
    </Box>
  )
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`
}

function truncateLine(line: string, width: number): string {
  if (line === '') return ''
  let out = ''
  let w = 0
  for (const ch of Array.from(line)) {
    const cw = charWidth(ch)
    if (w + cw > width) return `${out}…`
    out += ch
    w += cw
  }
  return out
}

function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x2fffd) ||
    (code >= 0x30000 && code <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}
