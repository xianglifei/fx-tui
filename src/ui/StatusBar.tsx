/**
 * The live status line: spinner + phase on the left, model/usage/session on
 * the right. The left side degrades (reasoning suffix, then detail) before it
 * is allowed to wrap, so the line never breaks the layout.
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Box, Text, useStdout } from 'ink'
import stringWidth from 'string-width'
import type { Phase } from '../store.js'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export interface StatusBarProps {
  phase: Phase
  detail: string
  usage: string
  reasoningChars: number
  model: string
  sessionId: string
  contextTokens: number
  contextWindow?: number
}

export function StatusBar(props: StatusBarProps): ReactElement {
  const [tick, setTick] = useState(0)
  const { stdout } = useStdout()
  const columns = stdout?.columns
  const width = Math.max(24, (columns !== undefined && columns > 0 ? columns : 80) - 2)
  const active = props.phase !== 'idle'
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => { setTick(t => t + 1) }, 100)
    return () => { clearInterval(timer) }
  }, [active])

  const frame = FRAMES[tick % FRAMES.length] ?? FRAMES[0]!
  const label = props.phase === 'thinking'
    ? '思考中'
    : props.phase === 'streaming'
      ? '输出中'
      : props.phase === 'tool'
        ? '执行工具'
        : '就绪'

  const context = contextText(props.contextTokens, props.contextWindow)
  // Right side degrades from lowest priority (session id, usage) so the
  // model name and context level survive narrow terminals.
  const parts: Array<{ text: string; priority: number }> = [
    { text: props.model, priority: 4 },
    { text: context, priority: 3 },
    { text: props.usage, priority: 2 },
    { text: props.sessionId.slice(0, 13), priority: 1 },
  ]
  const kept = parts.map(p => p.text)
  const fits = (): boolean => stringWidth(kept.filter(t => t !== '').join(' · ')) <= width - 10
  while (!fits()) {
    let dropIdx = -1
    let dropPriority = Number.MAX_SAFE_INTEGER
    for (let i = kept.length - 1; i >= 0; i--) {
      const text = kept[i]
      if (text === '') continue
      if (parts[i]!.priority < dropPriority) {
        dropPriority = parts[i]!.priority
        dropIdx = i
      }
    }
    if (dropIdx < 0) break
    kept[dropIdx] = ''
  }
  const right = kept.filter(t => t !== '').join(' · ')
  const budget = Math.max(12, width - stringWidth(right) - 4)

  let left = ` ${label}`
  const withDetail = props.detail !== '' ? `${left} · ${props.detail}` : left
  const withReasoning = props.phase === 'thinking' && props.reasoningChars > 0
    ? `${withDetail} · 已思考 ${formatCount(props.reasoningChars)} 字`
    : withDetail
  if (stringWidth(withReasoning) <= budget) {
    left = withReasoning
  } else if (stringWidth(withDetail) <= budget) {
    left = withDetail
  } else if (stringWidth(left) <= budget) {
    left = left
  }
  // else: bare label already fits the guaranteed minimum budget.

  return (
    <Box>
      <Text color={active ? 'cyan' : 'green'}>{active ? frame : '●'}</Text>
      <Text>{left}</Text>
      <Box flexGrow={1} />
      <Text dimColor>{right}</Text>
    </Box>
  )
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** Context water-level text like `上下文 45%·58k/128k`; empty before any measurement. */
function contextText(tokens: number, window: number | undefined): string {
  if (tokens <= 0) return ''
  const used = formatCount(tokens)
  if (window === undefined || window <= 0) return `上下文 ~${used}`
  const percent = Math.round((tokens / window) * 100)
  return `上下文 ${percent}%·${used}/${formatCount(window)}`
}
