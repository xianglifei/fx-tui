/**
 * The live status line: spinner + phase on the left, the configured item
 * segments on the right. The left side is the session's heartbeat and is not
 * configurable; the right side renders whatever `/statusline` saved (via
 * buildStatusSegments — unavailable sources simply hide). Segments degrade
 * (lowest priority first, rightmost among equals) before the line is allowed
 * to wrap, and the context water level colors amber at 80% and red at 95%.
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Box, Text, useStdout } from 'ink'
import stringWidth from 'string-width'
import type { Phase, RetryWait } from '../store.js'
import { buildStatusSegments } from '../statusline.js'
import type { StatusLineItemId } from '../statusline.js'
import { formatCount } from '../text.js'
import { theme } from './theme.js'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** East-Asian-Ambiguous glyphs this component renders. string-width counts
 * them as one column, but CJK-configured terminals (iTerm2's "ambiguous
 * characters are double-width" among them) paint them two — and this line is
 * packed flush-right, so every unaccounted cell pushed past the edge clips
 * the tail (the lost final character of `推理 high`). Counting them as two
 * keeps the degradation ahead of the real render on any terminal. */
const AMBIGUOUS_GLYPHS = new Set(['●', '·', '↑', '↓', '×', '⟳'])

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
  /** Live LLM retry wait; null when the current request is not backing off. */
  retryWait: RetryWait | null
  /** Configured right-side items, in display order (/statusline). */
  items: readonly StatusLineItemId[]
  /** provider/model route label. */
  model: string
  /** Current git branch; '' hides the segment. */
  gitBranch: string
  /** Custom command's first stdout line; null hides the segment. */
  customStatus: string | null
  /** Auto-compaction in progress. */
  compacting: boolean
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

  const built = buildStatusSegments(props.items, {
    contextTokens: props.contextTokens,
    contextWindow: props.contextWindow,
    usage: props.usage,
    effortLabel: props.effortLabel,
    model: props.model,
    gitBranch: props.gitBranch,
    customStatus: props.customStatus,
    compacting: props.compacting,
  })
  const parts = built.map(segment => ({
    text: segment.text,
    priority: segment.priority,
    color: segment.tone === 'danger' ? theme.danger : segment.tone === 'warning' ? theme.warning : undefined,
  }))
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
    .map((part, index) => Object.assign({}, part, { text: kept[index] ?? '' }))
    .filter(part => part.text !== '')

  // The spinner glyph renders before the left text but was never budgeted —
  // on ambiguous-wide terminals that is one more unaccounted cell at the
  // right edge. Budget it together with the left side. The retry segment
  // rides the same degradation chain: it drops the reasoning suffix, then
  // the detail, before it is allowed to break the line.
  const spinnerCells = displayWidth(active ? frame : '●')
  let left = ` ${label}`
  if (props.childAgents > 0) left += ` · 🌱×${props.childAgents}`
  const withDetail = props.detail !== '' ? `${left} · ${props.detail}` : left
  const withReasoning = props.phase === 'thinking' && props.reasoningChars > 0
    ? `${withDetail} · 已思考 ${formatCount(props.reasoningChars)} 字`
    : withDetail
  const retrySegment = props.retryWait !== null ? ` · ${retryText(props.retryWait)}` : ''
  const retryCells = displayWidth(retrySegment)
  const budget = Math.max(12, width - displayWidth(visible.map(part => part.text).join(' · ')) - 4)
  if (displayWidth(withReasoning) + retryCells + spinnerCells <= budget) {
    left = withReasoning
  } else if (displayWidth(withDetail) + retryCells + spinnerCells <= budget) {
    left = withDetail
  }
  // else: bare label already fits the guaranteed minimum budget.

  return (
    <Box>
      <Text color={active ? theme.accent : theme.success}>{active ? frame : '●'}</Text>
      <Text>{left}</Text>
      {retrySegment !== '' && <Text color={theme.warning}>{retrySegment}</Text>}
      <Box flexGrow={1} />
      {visible.map((part, index) => (
        <Text key={index} dimColor={part.color === undefined} color={part.color}>
          {`${index > 0 ? ' · ' : ''}${part.text}`}
        </Text>
      ))}
    </Box>
  )
}

/** Live retry segment like `⟳ 重试 2/5 · 8s（rate-limit）`; rendered in the
 * warning tone — during a backoff window this line is the only honest answer
 * to "is it hung?". */
function retryText(wait: RetryWait): string {
  const max = wait.maxRetries !== null ? `/${wait.maxRetries}` : ''
  const delay = wait.delayMs !== null ? ` · ${Math.max(1, Math.round(wait.delayMs / 1000))}s` : ''
  return `⟳ 重试 ${wait.attempt}${max}${delay}（${wait.reason}）`
}
