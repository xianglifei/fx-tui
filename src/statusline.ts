/**
 * Status-line configuration: the item catalog, the configured order, and the
 * async data sources (git branch, custom command) that feed the configurable
 * right side of the status bar.
 *
 * The left side (spinner, phase, retry) is deliberately not configurable — it
 * is the live heartbeat of the session. The catalog is deliberately small:
 * mcode's full panel (reordering, aliases, machine protocol, block display)
 * is upstream-scale machinery; fx needs selectable items, one custom command,
 * and honest degradation on narrow terminals.
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runShellCommand } from './shell-bang.js'
import { formatCount } from './text.js'

// -- Item catalog ---------------------------------------------------------------

export type StatusLineItemId = 'context' | 'usage' | 'effort' | 'model' | 'git' | 'compaction' | 'custom'

export interface StatusLineItemSpec {
  readonly id: StatusLineItemId
  readonly label: string
  readonly description: string
}

/** Canonical catalog; also the display order the interactive picker saves in. */
export const STATUS_LINE_ITEMS: readonly StatusLineItemSpec[] = [
  { id: 'context', label: '上下文水位', description: '百分比与 token 数，80%/95% 变色告警' },
  { id: 'usage', label: '会话用量', description: '输入/输出 token、缓存命中率、输出速度' },
  { id: 'effort', label: '推理强度', description: '当前请求携带的推理档位（默认档不显示）' },
  { id: 'model', label: '当前模型', description: 'provider/model 路由标签' },
  { id: 'git', label: 'git 分支', description: '当前工作目录的分支名（零依赖读取 .git/HEAD）' },
  { id: 'compaction', label: '压缩状态', description: '自动压缩进行中时显示（平时隐藏）' },
  { id: 'custom', label: '自定义命令', description: '外部命令 stdout 首行；需先 /statusline custom <命令>' },
]

/** The shipped configuration — exactly the pre-0.32 right side, so upgrading
 * changes nothing until the user edits the list. */
export const DEFAULT_STATUS_LINE: readonly StatusLineItemId[] = ['context', 'usage', 'effort']

export function isStatusLineItemId(value: unknown): value is StatusLineItemId {
  return typeof value === 'string' && STATUS_LINE_ITEMS.some(item => item.id === value)
}

/** Parse a persisted list: non-array falls back to the default, unknown ids
 * and duplicates are silently dropped (one typo must not invalidate the line). */
export function parseStatusLineItems(raw: unknown): StatusLineItemId[] {
  if (!Array.isArray(raw)) return [...DEFAULT_STATUS_LINE]
  const items: StatusLineItemId[] = []
  for (const entry of raw) {
    if (isStatusLineItemId(entry) && !items.includes(entry)) items.push(entry)
  }
  return items
}

// -- Segments -------------------------------------------------------------------

/** Render tone; mapped to theme colors by the view so this module stays
 * palette-free. */
export type SegmentTone = 'warning' | 'danger'

export interface StatusSegment {
  readonly text: string
  /** Degradation order on narrow terminals: lower drops first. */
  readonly priority: number
  readonly tone?: SegmentTone
}

export interface StatusSegmentData {
  readonly contextTokens: number
  readonly contextWindow: number | undefined
  readonly usage: string
  readonly effortLabel: string
  readonly model: string
  readonly gitBranch: string
  readonly customStatus: string | null
  readonly compacting: boolean
}

/** Build the configured right side, in configuration order. Empty text means
 * "nothing to show" — the view filters those out, so an unavailable source
 * (not a git repo, no usage yet, compaction idle) simply hides its segment. */
export function buildStatusSegments(items: readonly StatusLineItemId[], data: StatusSegmentData): readonly StatusSegment[] {
  const segments: StatusSegment[] = []
  for (const item of items) {
    switch (item) {
      case 'context': {
        const text = contextText(data.contextTokens, data.contextWindow)
        if (text !== '') segments.push({ text, priority: 3, tone: contextTone(data.contextTokens, data.contextWindow) })
        break
      }
      case 'usage':
        if (data.usage !== '') segments.push({ text: data.usage, priority: 2 })
        break
      case 'effort':
        if (data.effortLabel !== '') segments.push({ text: `推理 ${data.effortLabel}`, priority: 1 })
        break
      case 'model':
        if (data.model !== '') segments.push({ text: data.model, priority: 1 })
        break
      case 'git':
        if (data.gitBranch !== '') segments.push({ text: data.gitBranch, priority: 0 })
        break
      case 'compaction':
        // Transient by design: visible exactly while auto-compaction rewrites
        // history (the one window where "still idle?" is genuinely ambiguous).
        if (data.compacting) segments.push({ text: '压缩中', priority: 2, tone: 'warning' })
        break
      case 'custom':
        if (data.customStatus !== null && data.customStatus !== '') segments.push({ text: data.customStatus, priority: 0 })
        break
    }
  }
  return segments
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
function contextTone(tokens: number, window: number | undefined): SegmentTone | undefined {
  if (tokens <= 0 || window === undefined || window <= 0) return undefined
  const ratio = tokens / window
  if (ratio >= 0.95) return 'danger'
  if (ratio >= 0.8) return 'warning'
  return undefined
}

// -- Git branch (zero-dependency) --------------------------------------------------

/** Current branch of `cwd`'s repository, read straight from the filesystem —
 * no child process, cheap enough to poll. Detached HEAD degrades to the short
 * sha; anything unreadable returns null (the segment hides). Handles the
 * worktree/submodule layout where `.git` is a file pointing at a gitdir. */
export function readGitBranch(cwd: string): string | null {
  const dotGit = join(cwd, '.git')
  let headPath = join(dotGit, 'HEAD')
  try {
    // Reading a directory throws EISDIR — that is the normal repository
    // layout and keeps the default headPath. A readable `.git` is the
    // worktree/submodule pointer file: `gitdir: <path>`.
    const content = readFileSync(dotGit, 'utf8')
    const match = /^gitdir:\s*(.+)$/m.exec(content)
    if (match === null) return null
    headPath = resolve(cwd, match[1]!.trim(), 'HEAD')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'EISDIR') return null
  }
  return parseHead(headPath)
}

function parseHead(headPath: string): string | null {
  try {
    const head = readFileSync(headPath, 'utf8').trim()
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return ref !== null ? ref[1]! : head.slice(0, 7)
  } catch {
    return null
  }
}

// -- Custom command ----------------------------------------------------------------

/** First non-empty line of a command's stdout, trimmed — the only part the
 * inline segment shows. */
export function customCommandFirstLine(output: string): string {
  const line = output.split('\n').map(part => part.trim()).find(part => part !== '')
  return line ?? ''
}

/** External status commands must be quick and quiet: a status probe that
 * hangs or floods must never compete with the session it decorates. */
export const CUSTOM_COMMAND_TIMEOUT_MS = 5_000
const CUSTOM_COMMAND_MAX_BYTES = 65_536
/** Periodic refresh floor (mcode parity): sub-10-second polling is a rate-
 * limit incident waiting to happen, so 0–9 seconds all mean "events only". */
export const CUSTOM_MIN_INTERVAL_SECONDS = 10
export const CUSTOM_MAX_INTERVAL_SECONDS = 3600

export function clampCustomInterval(seconds: number): number {
  return Math.min(Math.max(0, Math.floor(seconds)), CUSTOM_MAX_INTERVAL_SECONDS)
}

/** The store surface the watcher drives; TuiStore satisfies it structurally. */
export interface StatusLineStore {
  setGitBranch(branch: string): void
  setCustomStatus(text: string | null): void
}

export interface StatusLineConfigSource {
  readonly cwd: string
  readonly store: StatusLineStore
  /** Live configuration, re-read on every trigger so /statusline changes
   * apply without re-creating the watcher. */
  getItems(): readonly StatusLineItemId[]
  getCustomCommand(): { readonly command: string; readonly intervalSeconds?: number } | undefined
}

const GIT_POLL_MS = 10_000

/**
 * Owns the async sources behind the configurable segments: a 10s git poll and
 * the custom command's trigger fan-in (startup, turn end, session switch,
 * optional interval). Failures keep the last successful value — a flaky probe
 * must not flicker the line — and a session switch clears the cached output
 * before the rerun lands.
 */
export class StatusLineWatcher {
  private gitTimer: ReturnType<typeof setInterval> | null = null
  private customTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  private rerunPending = false

  constructor(private readonly source: StatusLineConfigSource) {}

  start(): void {
    this.refresh('startup')
    this.gitTimer = setInterval(() => {
      if (this.source.getItems().includes('git')) this.pollGit()
    }, GIT_POLL_MS)
    this.gitTimer.unref()
    this.restartCustomTimer()
  }

  /** Event-driven refresh: turn end, session switch, explicit request. */
  refresh(trigger: 'startup' | 'turn-end' | 'session-switch' | 'manual'): void {
    const items = this.source.getItems()
    if (items.includes('git')) this.pollGit()
    if (items.includes('custom')) void this.runCustomCommand(trigger === 'session-switch')
  }

  /** Re-arm after a configuration change: disabled sources hide immediately,
   * an interval change restarts the timer, and a command change discards the
   * cached output so stale text never outlives its config. */
  applyConfig(): void {
    const items = this.source.getItems()
    if (!items.includes('git')) this.source.store.setGitBranch('')
    else this.pollGit()
    this.restartCustomTimer()
    if (!items.includes('custom')) {
      this.source.store.setCustomStatus(null)
      return
    }
    void this.runCustomCommand(false)
  }

  dispose(): void {
    if (this.gitTimer !== null) clearInterval(this.gitTimer)
    if (this.customTimer !== null) clearInterval(this.customTimer)
    this.gitTimer = null
    this.customTimer = null
  }

  private pollGit(): void {
    this.source.store.setGitBranch(readGitBranch(this.source.cwd) ?? '')
  }

  private restartCustomTimer(): void {
    if (this.customTimer !== null) {
      clearInterval(this.customTimer)
      this.customTimer = null
    }
    const config = this.source.getCustomCommand()
    if (config === undefined) return
    const interval = clampCustomInterval(config.intervalSeconds ?? 0)
    if (interval < CUSTOM_MIN_INTERVAL_SECONDS) return
    this.customTimer = setInterval(() => {
      if (this.source.getItems().includes('custom')) void this.runCustomCommand(false)
    }, interval * 1000)
    this.customTimer.unref()
  }

  /** One command run at a time; a trigger arriving mid-run coalesces into a
   * single trailing rerun instead of queueing (mcode parity). */
  private async runCustomCommand(clearCache: boolean): Promise<void> {
    const config = this.source.getCustomCommand()
    if (config === undefined) {
      this.source.store.setCustomStatus(null)
      return
    }
    if (this.running) {
      this.rerunPending = true
      return
    }
    this.running = true
    try {
      if (clearCache) this.source.store.setCustomStatus(null)
      const outcome = await runShellCommand(config.command, {
        timeoutMs: CUSTOM_COMMAND_TIMEOUT_MS,
        maxOutputBytes: CUSTOM_COMMAND_MAX_BYTES,
        cwd: this.source.cwd,
      })
      if (outcome.exitCode === 0 && !outcome.timedOut) {
        const line = customCommandFirstLine(outcome.output)
        this.source.store.setCustomStatus(line === '' ? null : line)
      }
      // Failure, timeout, or launch error: keep the last successful value.
    } finally {
      this.running = false
      if (this.rerunPending) {
        this.rerunPending = false
        void this.runCustomCommand(false)
      }
    }
  }
}
