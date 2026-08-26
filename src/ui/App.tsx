/**
 * The Ink root: Static region for the settled transcript, dynamic region for
 * pending tools, the streaming reply, the approval prompt, status line, and
 * the input editor.
 */

import { useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { Box, Static, Text, useInput, useStdout } from 'ink'
import type { ApprovalPrompt, FinalItem, PendingTool, TuiStore, ToolItem } from '../store.js'
import { renderMarkdownLines } from '../markdown.js'
import { InputBox } from './Input.js'
import { StatusBar } from './StatusBar.js'

export interface AppActions {
  onSubmit(text: string): void
  onInterrupt(): void
  onExit(): void
}

export interface AppProps {
  store: TuiStore
  history: readonly string[]
  actions: AppActions
}

export function App(props: AppProps): ReactElement {
  const snap = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot)
  const { stdout } = useStdout()
  const columns = stdout?.columns
  const width = Math.max(24, (columns !== undefined && columns > 0 ? columns : 80) - 2)

  return (
    <Box flexDirection="column">
      <Static items={snap.items as FinalItem[]}>
        {(item, index) => <FinalItemView key={index} item={item} width={width} />}
      </Static>
      <Box flexDirection="column">
        {snap.pendingTools.map((tool: PendingTool) => (
          <Text key={tool.callId} color="yellow">{`⚙ ${tool.name} 运行中…`}</Text>
        ))}
        {snap.streaming !== '' && <StreamView text={snap.streaming} width={width} />}
        {snap.approval !== null && <ApprovalView store={props.store} prompt={snap.approval} />}
        <StatusBar
          phase={snap.phase}
          detail={snap.phaseDetail}
          usage={snap.usage}
          reasoningChars={snap.reasoningChars}
          model={snap.model}
          sessionId={snap.sessionId}
        />
        <InputBox
          store={props.store}
          history={props.history}
          frozen={snap.approval !== null}
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

function ToolCardView(props: { item: ToolItem; width: number }): ReactElement {
  const { item, width } = props
  const color = item.ok ? 'green' : 'red'
  const resultLines = item.result.split('\n')
  const shown = resultLines.slice(0, 12)
  const more = resultLines.length - shown.length
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      <Text color={color}>
        {`${item.ok ? '✓' : '✗'} ${item.name} `}
        <Text dimColor>{formatArgs(item.args, width)}</Text>
      </Text>
      {shown.map((line, i) => (
        <Text key={i} dimColor>{truncateLine(line, width - 4)}</Text>
      ))}
      {more > 0 && <Text dimColor>{`…（还有 ${more} 行）`}</Text>}
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

function ApprovalView(props: { store: TuiStore; prompt: ApprovalPrompt }): ReactElement {
  const { store, prompt } = props
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') store.answerApproval('allowed-once')
    else if (input === 'n' || input === 'N' || key.escape) store.answerApproval('rejected')
  })
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text color="magenta" bold>{`需要批准：${prompt.toolName}`}</Text>
      {prompt.reason !== '' && <Text dimColor>{prompt.reason}</Text>}
      <Text>
        <Text color="green">[y] 允许一次</Text>
        {'  '}
        <Text color="red">[n] 拒绝</Text>
      </Text>
    </Box>
  )
}

function formatArgs(args: string, width: number): string {
  if (args === '') return ''
  let preview = args
  try {
    const parsed: unknown = JSON.parse(args)
    if (typeof parsed === 'object' && parsed !== null) {
      const entries = Object.entries(parsed as Record<string, unknown>)
      preview = entries
        .slice(0, 4)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ')
      if (entries.length > 4) preview += ` …（${entries.length - 4} 个参数已省略）`
    }
  } catch {
    // raw JSON string as produced by the model — keep as-is
  }
  return truncateLine(preview, Math.max(16, width - 10))
}

function truncateLine(line: string, width: number): string {
  if (line === '') return ''
  let out = ''
  let w = 0
  for (const ch of Array.from(line)) {
    const cw = ch.codePointAt(0) === undefined ? 1 : charWidth(ch)
    if (w + cw > width) return `${out}…`
    out += ch
    w += cw
  }
  return out
}

function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  // CJK and fullwidth ranges: East Asian Wide/Fullwidth
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
