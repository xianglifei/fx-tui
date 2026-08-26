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
}

export function StatusBar(props: StatusBarProps): ReactElement {
  const [tick, setTick] = useState(0)
  const { stdout } = useStdout()
  const width = Math.max(24, (stdout?.columns ?? 80) - 2)
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

  const right = `${props.model}${props.usage !== '' ? ` · ${props.usage}` : ''} · ${props.sessionId.slice(0, 13)}`
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
