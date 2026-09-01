/** /config: persisted startup defaults — an interactive picker, or a direct
 * one-shot form. Changing a default also flips the current session so both
 * views stay consistent — unlike Shift+Tab, which never touches the file. */

import { notifyModeLabel } from '../notify.js'
import type { NotifyMode } from '../notify.js'
import type { ApprovalMode } from '../store.js'
import type { CommandCtx } from './types.js'
import { pick } from './pick.js'

/** Persisted-settings labels; keeps notices and panels uniform. */
export function modeLabel(mode: ApprovalMode): string {
  return mode === 'auto' ? '自动允许' : '每次询问'
}

const DIRECT_MODE_WORDS: Record<string, ApprovalMode> = {
  auto: 'auto', ask: 'ask',
  '自动允许': 'auto', 自动: 'auto',
  '每次询问': 'ask', 询问: 'ask',
}

const AUTO_WORDS: Record<string, boolean> = {
  on: true, off: false,
  开启: true, 开: true, 打开: true,
  关闭: false, 关: false,
}

const NOTIFY_WORDS: Record<string, NotifyMode> = {
  off: 'off', bell: 'bell', system: 'system',
  关闭: 'off', 铃声: 'bell', 终端铃声: 'bell', 系统: 'system', 系统通知: 'system',
}

export async function runConfig(c: CommandCtx, arg: string): Promise<void> {
  const tokens = arg.split(/\s+/).filter(token => token !== '')
  if (tokens.length > 0) {
    const [key, value] = tokens
    const modeTarget = key === 'permission' && value !== undefined ? DIRECT_MODE_WORDS[value.toLowerCase()] : undefined
    if (modeTarget !== undefined) {
      applyApprovalMode(c, modeTarget)
      return
    }
    const autoRaw = key === 'autoupdate' && value !== undefined ? value.toLowerCase() : undefined
    if (autoRaw !== undefined) {
      const autoTarget = AUTO_WORDS[autoRaw]
      if (autoTarget === undefined) {
        c.store.addNotice('用法：/config autoupdate <on|off>', 'warn')
        return
      }
      applyAutoUpdate(c, autoTarget)
      return
    }
    const notifyRaw = key === 'notify' && value !== undefined ? value.toLowerCase() : undefined
    if (notifyRaw !== undefined) {
      const notifyTarget = NOTIFY_WORDS[notifyRaw]
      if (notifyTarget === undefined) {
        c.store.addNotice('用法：/config notify <off|bell|system>（关闭 / 终端铃声 / macOS 系统通知）', 'warn')
        return
      }
      applyNotify(c, notifyTarget)
      return
    }
    const compactRaw = key === 'autocompact' && value !== undefined ? value.toLowerCase() : undefined
    if (compactRaw !== undefined) {
      const compactTarget = AUTO_WORDS[compactRaw]
      if (compactTarget === undefined) {
        c.store.addNotice('用法：/config autocompact <on|off>（水位过高时自动 /compact）', 'warn')
        return
      }
      applyAutoCompact(c, compactTarget)
      return
    }
    c.store.addNotice('用法：/config（交互选择）· /config permission <auto|ask> · /config autoupdate <on|off> · /config notify <off|bell|system> · /config autocompact <on|off>', 'warn')
    return
  }
  const modeChosen = await pick(c, `设置启动默认权限模式（当前 ${modeLabel(c.settings.approvalMode)}）`, [
    { label: '自动允许', description: '工具调用不再逐个询问；之后每次启动默认开启' },
    { label: '每次询问', description: '工具调用逐个请求批准；之后每次启动默认关闭' },
  ])
  const modeTarget = DIRECT_MODE_WORDS[modeChosen ?? '']
  if (modeTarget !== undefined) applyApprovalMode(c, modeTarget)
  const autoChosen = await pick(c, `后台自动更新（当前 ${c.settings.autoUpdate ? '开启' : '关闭'}）`, [
    { label: '开启', description: '启动约两分钟后静默拉取新版本并重建；每 24 小时最多联网一次，重启 fx 生效' },
    { label: '关闭', description: '仅在手动运行 /update 时联网' },
  ])
  if (autoChosen !== undefined) {
    const autoTarget = AUTO_WORDS[autoChosen]
    if (autoTarget !== undefined) applyAutoUpdate(c, autoTarget)
  }
  const notifyChosen = await pick(c, `长任务完成通知（当前 ${notifyModeLabel(c.settings.notify)}）`, [
    { label: '终端铃声', description: '回合超过 10 秒结束时响铃（终端的铃声/视觉提示设置决定表现形式）' },
    { label: '系统通知', description: 'macOS 通知中心弹窗 + 提示音（同样只在超过 10 秒的回合结束时）' },
    { label: '关闭', description: '不做任何提醒' },
  ])
  if (notifyChosen !== undefined) {
    const notifyTarget = NOTIFY_WORDS[notifyChosen]
    if (notifyTarget !== undefined) applyNotify(c, notifyTarget)
  }
  const compactChosen = await pick(c, `自动压缩历史（当前 ${c.settings.autoCompact ? '开启' : '关闭'}）`, [
    { label: '开启', description: '空闲且上下文水位 ≥85% 时自动压缩历史（/compact 同款，压缩后无法完整回放旧对话）' },
    { label: '关闭', description: '只在 80%/95% 水位警告，由你手动 /compact' },
  ])
  if (compactChosen !== undefined) {
    const compactTarget = AUTO_WORDS[compactChosen]
    if (compactTarget !== undefined) applyAutoCompact(c, compactTarget)
  }
}

function applyNotify(c: CommandCtx, target: NotifyMode): void {
  const changed = c.settings.notify !== target
  c.settings.setNotify(target)
  if (!changed) {
    c.store.addNotice(`完成通知已是${notifyModeLabel(target)}（${c.settings.location}）`)
    return
  }
  c.store.addNotice(`完成通知已保存为${notifyModeLabel(target)}（${c.settings.location}）`)
}

function applyAutoCompact(c: CommandCtx, target: boolean): void {
  const changed = c.settings.autoCompact !== target
  c.settings.setAutoCompact(target)
  const state = target ? '开启' : '关闭'
  if (!changed) {
    c.store.addNotice(`自动压缩已是${state}（${c.settings.location}）`)
    return
  }
  c.store.addNotice(
    `自动压缩已保存为${state}` + (target ? '：空闲且上下文水位 ≥85% 时自动压缩历史' : '') + `（${c.settings.location}）`,
  )
}

function applyAutoUpdate(c: CommandCtx, target: boolean): void {
  const changed = c.settings.autoUpdate !== target
  c.settings.setAutoUpdate(target)
  const state = target ? '开启' : '关闭'
  if (!changed) {
    c.store.addNotice(`自动更新已是${state}（${c.settings.location}）`)
    return
  }
  c.store.addNotice(
    `自动更新已保存为${state}` + (target ? '：启动约两分钟后后台检查，每 24 小时最多联网一次，更新落盘后重启 fx 生效' : '')
    + `（${c.settings.location}）`,
  )
}

function applyApprovalMode(c: CommandCtx, target: ApprovalMode): void {
  const savedChanged = c.settings.approvalMode !== target
  c.settings.setApprovalMode(target)
  const sessionLabel = modeLabel(c.store.getSnapshot().approvalMode)
  c.store.setApprovalMode(target)
  if (!savedChanged && sessionLabel === modeLabel(target)) {
    c.store.addNotice(`启动默认权限模式已是${modeLabel(target)}（${c.settings.location}）`)
    return
  }
  c.store.addNotice(
    `启动默认权限模式已保存为${modeLabel(target)}（${c.settings.location}）`
    + (sessionLabel !== modeLabel(target) ? `，本次会话也已切换为${modeLabel(target)}` : ''),
  )
}
