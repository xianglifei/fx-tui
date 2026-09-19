/**
 * The `!` / `!!` shell passthrough: parse the input gesture, run the command
 * under the user's own shell, and surface the outcome as a transcript panel.
 *
 * The gesture is pure local execution — the output is displayed to the user
 * and deliberately never enters the session log: dsh has no
 * inject-without-turn seam, so a bang output delivered to the model would
 * either trigger a reply (followup) or require session-log surgery. The `!!`
 * spelling is accepted as an alias (mcode muscle memory) rather than promising
 * context semantics that cannot be delivered yet.
 */

import { spawn } from 'node:child_process'
import { formatCount, truncateLine } from './text.js'

export interface ShellBang {
  readonly command: string
  /** `!!` spelling; currently an execution-identical alias of `!`. */
  readonly quiet: boolean
}

/** Parse a `!`-prefixed input line; undefined when the text is not one. */
export function parseShellBang(text: string): ShellBang | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('!')) return undefined
  const quiet = trimmed.startsWith('!!')
  return { command: trimmed.slice(quiet ? 2 : 1).trim(), quiet }
}

export interface ShellRunOutcome {
  readonly command: string
  readonly exitCode: number | null
  readonly signalName: string | null
  /** True when the run was killed for exceeding the timeout. */
  readonly timedOut: boolean
  readonly timeoutMs: number
  readonly durationMs: number
  readonly output: string
  /** True when output beyond the byte cap was discarded (not a shell failure). */
  readonly truncated: boolean
}

/** Generous ceiling: interactive gestures may run a slow test suite, but a
 * gesture nobody can see or interrupt must never outlive the session. */
export const SHELL_TIMEOUT_MS = 600_000
const KILL_GRACE_MS = 2_000
const MAX_OUTPUT_BYTES = 200_000

/** Run one command under the user's shell; never throws — failures resolve
 * into the outcome (spawn errors ride `output`). */
export function runShellCommand(
  command: string,
  opts: { timeoutMs?: number; maxOutputBytes?: number; cwd?: string; shell?: string } = {},
): Promise<ShellRunOutcome> {
  const timeoutMs = opts.timeoutMs ?? SHELL_TIMEOUT_MS
  const maxOutputBytes = opts.maxOutputBytes ?? MAX_OUTPUT_BYTES
  const shell = opts.shell ?? process.env.SHELL ?? '/bin/bash'
  return new Promise(resolve => {
    const startedAt = Date.now()
    let child: ReturnType<typeof spawn>
    try {
      // Detached: the timeout kill takes the whole process tree (the command's
      // own children must not outlive the gesture).
      child = spawn(shell, ['-c', command], {
        cwd: opts.cwd ?? process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      resolve({
        command, exitCode: null, signalName: null, timedOut: false, timeoutMs,
        durationMs: 0, output: error instanceof Error ? error.message : String(error),
        truncated: false,
      })
      return
    }
    const chunks: Buffer[] = []
    let totalBytes = 0
    let truncated = false
    let timedOut = false
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const settle = (exitCode: number | null, signalName: string | null, error?: Error): void => {
      if (settled) return
      settled = true
      if (killTimer !== null) clearTimeout(killTimer)
      if (error !== undefined) chunks.push(Buffer.from(error.message))
      const output = Buffer.concat(chunks).toString('utf8')
      resolve({
        command, exitCode, signalName, timedOut, timeoutMs,
        durationMs: Math.max(0, Date.now() - startedAt), output, truncated,
      })
    }
    const onChunk = (chunk: Buffer): void => {
      if (truncated) return
      if (totalBytes + chunk.length > maxOutputBytes) {
        chunks.push(chunk.subarray(0, Math.max(0, maxOutputBytes - totalBytes)))
        truncated = true
        return
      }
      chunks.push(chunk)
      totalBytes += chunk.length
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)
    child.on('error', error => { settle(null, null, error) })
    child.on('close', (code, signal) => { settle(code, signal) })
    setTimeout(() => {
      timedOut = true
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM')
      } catch { /* already gone */ }
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      killTimer = setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        } catch { /* already gone */ }
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }, KILL_GRACE_MS)
    }, timeoutMs)
  })
}

// -- Transcript presentation ----------------------------------------------------

/** One-line status of a finished run: `✓ 退出 0 · 1.2s` family. Shared by the
 * result panel and the stashed transport block. */
export function shellStatusLine(outcome: ShellRunOutcome): string {
  const seconds = formatDuration(outcome.durationMs)
  if (outcome.timedOut) return `✗ 超时（${formatDuration(outcome.timeoutMs)} 后终止）`
  if (outcome.signalName !== null) return `✗ 信号 ${outcome.signalName} · ${seconds}`
  if (outcome.exitCode === 0) return `✓ 退出 0 · ${seconds}`
  return `✗ 退出码 ${outcome.exitCode ?? '?'} · ${seconds}`
}

/** Short machine-ish status for the tray summary line: `退出 0` / `退出 1` /
 * `信号 X` / `超时`. */
function shellStatusShort(outcome: ShellRunOutcome): string {
  if (outcome.timedOut) return '超时'
  if (outcome.signalName !== null) return `信号 ${outcome.signalName}`
  return `退出 ${outcome.exitCode ?? '?'}`
}

/** Transcript rows for a finished run: one status header + the (capped)
 * output. The cap is head+tail — shell failures print at the end, so a pure
 * head cap would hide exactly the lines that matter. */
export function shellPanel(outcome: ShellRunOutcome, cap: number): { title: string; lines: readonly string[] } {
  let status = shellStatusLine(outcome)
  if (outcome.truncated) status += ' · 输出过长已截断'
  const raw = outcome.output === '' ? ['（无输出）'] : outcome.output.replace(/\n+$/, '').split('\n')
  const budget = Math.max(4, cap)
  const lines: string[] = [status]
  if (raw.length <= budget) {
    lines.push(...raw)
  } else {
    const head = Math.ceil(budget / 2)
    const tail = budget - head
    lines.push(...raw.slice(0, head), `…（中间省略 ${raw.length - head - tail} 行）`, ...raw.slice(raw.length - tail))
  }
  const title = outcome.command.length > 120 ? `${outcome.command.slice(0, 119)}…` : outcome.command
  return { title: `$ ${title}`, lines }
}

// -- Stash transport ------------------------------------------------------------

/** Char cap on the stashed transport block — the model reads it verbatim as
 * part of the next user message, so it must inform without flooding context.
 * Independent of the display panel's line cap. */
export const STASH_OUTPUT_MAX_CHARS = 8000

/** The self-describing text block stashed into the next user message: what
 * ran, how it ended, and the (head+tail capped) output. */
export function stashTransportText(outcome: ShellRunOutcome): string {
  const raw = outcome.output.replace(/\n+$/, '')
  let output = raw
  if (raw.length > STASH_OUTPUT_MAX_CHARS) {
    const head = Math.ceil(STASH_OUTPUT_MAX_CHARS / 2)
    const tail = STASH_OUTPUT_MAX_CHARS - head
    output = `${raw.slice(0, head)}\n…（中间省略 ${raw.length - head - tail} 字符）\n${raw.slice(raw.length - tail)}`
  }
  return [
    '用户在本地终端手动执行了命令（输出可能已截断），结果如下：',
    `$ ${outcome.command}`,
    shellStatusLine(outcome),
    '',
    output === '' ? '（无输出）' : output,
  ].join('\n')
}

/** One-line tray/echo label: `` $ npm test · 退出 1 · 2.1k 字符 ``. */
export function stashSummary(outcome: ShellRunOutcome): string {
  const chars = formatCount(outcome.output.length)
  return `$ ${truncateLine(outcome.command, 40)} · ${shellStatusShort(outcome)} · ${chars} 字符`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

// -- Action wiring -----------------------------------------------------------------

/** Store surface the passthrough needs; TuiStore satisfies it. */
export interface ShellPassthroughUi {
  addNotice(text: string, tone?: 'info' | 'warn' | 'error'): void
  addPanel(title: string, lines: readonly string[]): void
  /** Stash one run's transport block for the next submitted message. */
  addPendingOutput(output: { text: string; summary: string; command: string }): void
}

/** A run this short needs no "正在执行" marker — the panel lands in the same
 * breath, and the marker would just leave a second permanent row. */
const RUNNING_NOTICE_DELAY_MS = 400

/** Launch one passthrough run and report it to the transcript. Long runs get
 * a one-line marker after a short grace window so silence is never ambiguous;
 * fast runs only ever produce the result panel. Unless `stash: false` (the
 * `!!` spelling), the output is additionally queued onto the pending-output
 * tray to ride the user's next message into the model's context. */
export async function launchShellPassthrough(
  command: string,
  ui: ShellPassthroughUi,
  opts: { stash?: boolean; timeoutMs?: number; maxOutputBytes?: number; cwd?: string; shell?: string } = {},
): Promise<void> {
  let announced = false
  const marker = setTimeout(() => {
    announced = true
    ui.addNotice(`▶ 正在执行：${command}`)
  }, RUNNING_NOTICE_DELAY_MS)
  let outcome: ShellRunOutcome
  try {
    outcome = await runShellCommand(command, opts)
  } catch (error) {
    clearTimeout(marker)
    ui.addNotice(`shell 执行失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    return
  }
  clearTimeout(marker)
  if (announced && outcome.timedOut) ui.addNotice('命令超时，已终止进程树', 'warn')
  const cap = Math.max(10, (process.stdout.rows ?? 40) - 12)
  const { title, lines } = shellPanel(outcome, cap)
  ui.addPanel(title, lines)
  if (opts.stash !== false) {
    ui.addPendingOutput({ text: stashTransportText(outcome), summary: stashSummary(outcome), command: outcome.command })
  }
}
