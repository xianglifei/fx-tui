/**
 * Background self-update orchestrator: fired on a startup delay by the
 * runner, it rate-limits itself through a stamp file in $DSH_HOME, locks
 * against concurrent fx instances, then reuses the manual-update pipeline in
 * place. Silent by contract — the only user-visible outputs are the single
 * completion / skip notices passed to `notify`; everything else returns as a
 * machine-readable status for tests and logging.
 *
 * @module fx-tui
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { UpdateOutcome } from './update.js'
import { installedRoot, performSelfUpdate } from './update.js'

/** At most one network check per day, regardless of restart frequency. */
export const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000
/** A lock older than this is wreckage from a dead process and gets stolen. */
const LOCK_STALE_MS = 30 * 60 * 1000

export type AutoUpdateStatus =
  | 'disabled' // toggle off via settings
  | 'unsupported' // not a git-clone install; stay silent here, /update explains
  | 'busy' // manual /update or another auto pass already running
  | 'rate-limited' // checked recently enough
  | 'locked' // another fx instance holds the lock
  | 'current' // no new commits upstream
  | 'applied' // rebuilt successfully; restart picks it up
  | 'failed'

export interface AutoUpdateHooks {
  dshHome: string | undefined
  /** Read at fire time so a mid-session /config change still takes effect. */
  isAutoEnabled(): boolean
  /** Shared with manual `/update` so the two paths can never interleave. */
  isBusy(): boolean
  setBusy(): void
  releaseBusy(): void
  notify(text: string): void
}

interface StampFile {
  lastCheckAt?: number
}

export async function maybeAutoUpdate(hooks: AutoUpdateHooks, options: {
  root?: string
  currentVersion?: string
  now?: () => number
} = {}): Promise<AutoUpdateStatus> {
  const now = options.now ?? Date.now
  if (!hooks.isAutoEnabled()) return 'disabled'
  if (hooks.isBusy()) return 'busy'

  const root = options.root ?? installedRoot()
  if (root === null || !existsSync(join(root, '.git')) || root.split('/').includes('node_modules')) {
    return 'unsupported'
  }

  const home = hooks.dshHome !== undefined && hooks.dshHome !== '' ? hooks.dshHome : join(homedir(), '.dsh')
  const stampPath = join(home, 'fx-tui-auto-update.json')
  const stamp = readStamp(stampPath)
  if (stamp.lastCheckAt !== undefined && now() - stamp.lastCheckAt < AUTO_UPDATE_INTERVAL_MS) {
    return 'rate-limited'
  }

  if (!acquireLock(join(home, 'fx-tui-auto-update.lock'), now)) return 'locked'
  try {
    const outcome = await performSelfUpdate(
      { root, force: false, currentVersion: options.currentVersion ?? '' },
      () => { /* background pass stays quiet while running */ },
    )
    markChecked(stampPath, now)
    report(outcome, hooks.notify)
    return outcome.ok ? (outcome.applied ? 'applied' : 'current') : 'failed'
  } finally {
    releaseLock(join(home, 'fx-tui-auto-update.lock'))
    hooks.releaseBusy()
  }
}

function report(outcome: UpdateOutcome, notify: (text: string) => void): void {
  if (!outcome.ok) {
    const reason = (outcome.lines[0] ?? '未知原因').replace(/[:：]\s*$/, '')
    notify(`fx 后台自动更新未执行：${reason}（需要时手动 /update）`)
    return
  }
  if (outcome.applied) {
    const version = outcome.versionAfter !== undefined ? `到 v${outcome.versionAfter}` : ''
    notify(`✅ fx 已在后台更新${version}，重启 fx 即为新版`)
    return
  }
  // up-to-date: silent success
}

function readStamp(path: string): StampFile {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StampFile
  } catch {
    return {}
  }
}

function markChecked(path: string, now: () => number): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const file: StampFile = { lastCheckAt: now() }
    writeFileSync(path, `${JSON.stringify(file)}\n`, { encoding: 'utf8' })
  } catch { /* rate-limit state is best-effort */ }
}

function acquireLock(path: string, now: () => number): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const fd = openSync(path, 'wx')
    writeFileSync(fd, `${process.pid}\n`)
    closeSync(fd)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') return false
    try {
      if (now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
        unlinkSync(path)
        return acquireLock(path, now)
      }
    } catch { /* vanished between check and steal; treat as locked */ }
    return false
  }
}

function releaseLock(path: string): void {
  try {
    // Only unlink a lock we own: if we stole a "stale" lock from a holder
    // that was merely hung and it later releases, deleting it would open a
    // window for a third instance to acquire mid-run.
    const owner = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
    if (owner !== process.pid) return
    unlinkSync(path)
  } catch { /* nothing to clean up */ }
}
