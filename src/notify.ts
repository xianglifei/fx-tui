/**
 * Turn-completion notifications. A finished long turn is the moment the user
 * — who switched to another window — wants to be pulled back: 'bell' writes
 * BEL to the terminal (most terminals flash or sound once), 'system' posts a
 * macOS notification-center popup through osascript, 'off' disables both.
 */

import { spawnDetached } from './clipboard.js'

export type NotifyMode = 'off' | 'bell' | 'system'

export const NOTIFY_MODES: readonly NotifyMode[] = ['off', 'bell', 'system']

/** Turns shorter than this finish while the user is still watching. */
export const NOTIFY_MIN_TURN_MS = 10_000

export function isNotifyMode(value: unknown): value is NotifyMode {
  return typeof value === 'string' && (NOTIFY_MODES as readonly string[]).includes(value)
}

export function notifyModeLabel(mode: NotifyMode): string {
  return mode === 'off' ? '关闭' : mode === 'bell' ? '终端铃声' : '系统通知'
}

/** Announce one finished turn; aborted turns are filtered out by the caller. */
export function notifyTurnComplete(mode: NotifyMode, ok: boolean, elapsedMs: number): void {
  if (mode === 'off' || elapsedMs < NOTIFY_MIN_TURN_MS) return
  if (mode === 'bell') {
    process.stdout.write('\x07')
    return
  }
  const seconds = Math.round(elapsedMs / 1000)
  const body = ok ? `任务完成（耗时 ${seconds} 秒），回到 fx-tui 查看` : `任务出错（耗时 ${seconds} 秒），回到 fx-tui 处理`
  try {
    // Escape for the AppleScript string literal: the body is built from
    // fixed text and numbers today, but a model-supplied fragment would
    // otherwise break out of the quotes.
    const escaped = body.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    spawnDetached('osascript', ['-e', `display notification "${escaped}" with title "fx-tui" sound name "default"`])
  } catch {
    // notifications are best-effort
  }
}
