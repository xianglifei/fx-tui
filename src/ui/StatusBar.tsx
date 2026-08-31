/**
 * The live status line: spinner + phase on the left, context/usage/effort on
 * the right. Model and session id live only in the welcome banner — repeating
 * them here would duplicate it. The left side degrades (reasoning suffix,
 * then detail) before it is allowed to wrap, so the line never breaks the
 * layout. On the right, the context water level colors amber at 80% and red
 * at 95%, and low-priority segments (effort, then usage) drop first when the
 * terminal is narrow.
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Box, Text, useStdout } from 'ink'
import stringWidth from 'string-width'
import type { Phase } from '../store.js'
import { theme } from './theme.js'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** East-Asian-Ambiguous glyphs this component renders. string-width counts
 * them as one column, but CJK-configured terminals (iTerm2's "ambiguous
 * characters are double-width" among them) paint them two — and this line is
 * packed flush-right, so every unaccounted cell pushed past the edge clips
 * the tail (the lost final character of `推理 high`). Counting them as two
 * keeps the degradation ahead of the real render on any terminal. */
const AMBIGUOUS_GLYPHS = new Set(['●', '·', '↑', '↓', '×'])

/** Terminal cells `text` occupies in the worst case. */
function displayWidth(text: string): number {
  let extra = 0
  for (const ch of text) {
    if (AMBIGUOUS_GLYPHS.has(ch)) extra++
  }
  return stringWidth(text) + extra
}

export interface StatusBarProps {
  phase: Phase
  detail: string
  usage: string
  reasoningChars: number
  contextTokens: number
  contextWindow?: number
  childAgents: number
  /** Reasoning effort carried by the latest request ('' when none/default). */
  effortLabel: string
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
  const contextColor = contextTone(props.contextTokens, props.contextWindow)
  // Degradation order: effort drops first, then usage — the context level
  // survives narrow terminals, colored by its pressure.
  const parts: Array<{ text: string; priority: number; color?: string }> = [
    { text: context, priority: 2, ...(contextColor !== undefined ? { color: contextColor } : {}) },
    { text: props.usage, priority: 1 },
    { text: props.effortLabel !== '' ? `推理 ${props.effortLabel}` : '', priority: 0 },
  ]
  const kept = parts.map(p => p.text)
  const fits = (): boolean => displayWidth(kept.filter(t => t !== '').join(' · ')) <= width - 10
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
  const visible = parts
    .map((part, index) => ({ ...part, text: kept[index] ?? '' }))
    .filter(part => part.text !== '')

  // The spinner glyph renders before the left text but was never budgeted —
  // on ambiguous-wide terminals that is one more unaccounted cell at the
  // right edge. Budget it together with the left side.
  const spinnerCells = displayWidth(active ? frame : '●')
  let left = ` ${label}`
  if (props.childAgents > 0) left += ` · 🌱×${props.childAgents}`
  const withDetail = props.detail !== '' ? `${left} · ${props.detail}` : left
  const withReasoning = props.phase === 'thinking' && props.reasoningChars > 0
    ? `${withDetail} · 已思考 ${formatCount(props.reasoningChars)} 字`
    : withDetail
  const budget = Math.max(12, width - displayWidth(visible.map(part => part.text).join(' · ')) - 4)
  if (displayWidth(withReasoning) + spinnerCells <= budget) {
    left = withReasoning
  } else if (displayWidth(withDetail) + spinnerCells <= budget) {
    left = withDetail
  } else if (displayWidth(left) + spinnerCells <= budget) {
    left = left
  }
  // else: bare label already fits the guaranteed minimum budget.

  return (
    <Box>
      <Text color={active ? theme.accent : theme.success}>{active ? frame : '●'}</Text>
      <Text>{left}</Text>
      <Box flexGrow={1} />
      {visible.map((part, index) => (
        <Text key={index} dimColor={part.color === undefined} color={part.color}>
          {`${index > 0 ? ' · ' : ''}${part.text}`}
        </Text>
      ))}
    </Box>
  )
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** Context water-level text like `上下文 45% (58k/128k)`; empty before any measurement. */
function contextText(tokens: number, window: number | undefined): string {
  if (tokens <= 0) return ''
  const used = formatCount(tokens)
  if (window === undefined || window <= 0) return `上下文 ~${used}`
  const percent = Math.round((tokens / window) * 100)
  return `上下文 ${percent}% (${used}/${formatCount(window)})`
}

/** Pressure tone for the context segment: red at 95%, amber at 80%, muted otherwise. */
function contextTone(tokens: number, window: number | undefined): string | undefined {
  if (tokens <= 0 || window === undefined || window <= 0) return undefined
  const ratio = tokens / window
  if (ratio >= 0.95) return theme.danger
  if (ratio >= 0.8) return theme.warning
  return undefined
}
