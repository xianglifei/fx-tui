/**
 * Colored inline-diff rendering for {@link FileDiff} payloads (the
 * `DiffCallView`/`DiffResultView` presentation cards).
 *
 * Hunks are small (three context lines per side), so a plain LCS pass per
 * file is plenty. Output is pre-styled lines ready for Ink <Text>.
 */

import chalk from 'chalk'
import type { FileDiff } from '@deepseek-ai/dsh-tools'

const MAX_DIFF_LINES = 200

/** Render one file's change as colored +/- lines (with a dim path header). */
export function renderFileDiff(diff: FileDiff): string[] {
  const out: string[] = [chalk.bold(diff.path)]
  const oldLines = diff.oldText === null ? [] : diff.oldText.split('\n')
  const newLines = diff.newText.split('\n')
  // Trailing empty line from a final newline is not a content line.
  if (oldLines[oldLines.length - 1] === '') oldLines.pop()
  if (newLines[newLines.length - 1] === '') newLines.pop()

  if (diff.oldText === null) {
    for (const line of newLines.slice(0, MAX_DIFF_LINES)) out.push(chalk.green(`+ ${line}`))
    if (newLines.length > MAX_DIFF_LINES) out.push(chalk.greenBright(`+ …（还有 ${newLines.length - MAX_DIFF_LINES} 行）`))
    return out
  }

  const ops = lcsDiff(oldLines, newLines)
  let shown = 0
  for (const op of ops) {
    if (shown >= MAX_DIFF_LINES) {
      out.push(chalk.dim(`…（差异超过 ${MAX_DIFF_LINES} 行，已截断）`))
      break
    }
    if (op.kind === 'same') out.push(chalk.dim(`  ${op.text}`))
    else if (op.kind === 'del') out.push(chalk.red(`- ${op.text}`))
    else out.push(chalk.green(`+ ${op.text}`))
    shown++
  }
  return out
}

/** Render several file diffs with blank separators. */
export function renderFileDiffs(diffs: readonly FileDiff[]): string[] {
  const out: string[] = []
  for (const diff of diffs) {
    if (out.length > 0) out.push('')
    out.push(...renderFileDiff(diff))
  }
  return out
}

type DiffOp = { kind: 'same' | 'del' | 'add'; text: string }

/** Line-level LCS diff; both inputs are short hunk bodies. */
function lcsDiff(a: readonly string[], b: readonly string[]): DiffOp[] {
  const n = a.length
  const m = b.length
  // Guard against pathological sizes; hunks are tiny so this never trips.
  if (n * m > 1_000_000) {
    return [
      ...a.map(text => ({ kind: 'del' as const, text })),
      ...b.map(text => ({ kind: 'add' as const, text })),
    ]
  }
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', text: a[i]! })
      i++
      j++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ kind: 'del', text: a[i]! })
      i++
    } else {
      ops.push({ kind: 'add', text: b[j]! })
      j++
    }
  }
  while (i < n) {
    ops.push({ kind: 'del', text: a[i]! })
    i++
  }
  while (j < m) {
    ops.push({ kind: 'add', text: b[j]! })
    j++
  }
  return ops
}
