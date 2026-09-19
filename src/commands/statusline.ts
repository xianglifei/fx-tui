/** /statusline: choose which items ride the status bar's right side, and
 * configure the custom-command item. A bare command opens the multi-select
 * picker; a direct form sets the whole list in one shot (`/statusline context
 * git model`); `custom` manages the external status command. Configuration
 * order IS display order, left to right. */

import { STATUS_LINE_ITEMS, clampCustomInterval, isStatusLineItemId } from '../statusline.js'
import type { StatusLineItemId } from '../statusline.js'
import type { CommandCtx } from './types.js'

const OFF_WORDS = new Set(['off', 'none', '无', '清空', '隐藏'])
const DEFAULT_WORDS = new Set(['default', '默认', '恢复默认'])

const itemLabel = (id: StatusLineItemId): string => STATUS_LINE_ITEMS.find(item => item.id === id)?.label ?? id

function itemListLabel(items: readonly StatusLineItemId[]): string {
  return items.length > 0 ? items.map(itemLabel).join(' · ') : '（空，仅保留左侧运行状态）'
}

export async function runStatusline(c: CommandCtx, arg: string): Promise<void> {
  const tokens = arg.split(/\s+/).filter(token => token !== '')
  if (tokens.length === 0) {
    await pickItems(c)
    return
  }
  const head = tokens[0]
  if (head === undefined) return
  const rest = tokens.slice(1)
  if (DEFAULT_WORDS.has(head.toLowerCase())) {
    c.settings.setStatusLine(null)
    c.syncStatusLine()
    c.store.addNotice(`状态栏已恢复默认：${itemListLabel(c.settings.statusLine)}（${c.settings.location}）`)
    return
  }
  if (OFF_WORDS.has(head.toLowerCase())) {
    c.settings.setStatusLine([])
    c.syncStatusLine()
    c.store.addNotice(`状态栏条目已全部隐藏（${c.settings.location}）`)
    return
  }
  if (head === 'custom' || head === '自定义') {
    configureCustom(c, rest.join(' '))
    return
  }
  const requested = arg.split(/[,\s]+/).filter(token => token !== '')
  const unknown = requested.filter(token => !isStatusLineItemId(token))
  if (unknown.length > 0) {
    c.store.addPanel('/statusline', [
      `未知条目：${unknown.join('、')}`,
      '',
      '可用条目（顺序即显示顺序，空格或逗号分隔）：',
      ...STATUS_LINE_ITEMS.map(item => `· ${item.id} — ${item.label}：${item.description}`),
      '',
      '其他形式：/statusline（交互选择） · /statusline off（全隐） · /statusline default（恢复默认） ·',
      '  /statusline custom <shell 命令> · /statusline custom interval <秒> · /statusline custom off',
    ])
    return
  }
  const items = dedupe(requested as StatusLineItemId[])
  c.settings.setStatusLine(items)
  c.syncStatusLine()
  c.store.addNotice(`状态栏已保存为：${itemListLabel(items)}（${c.settings.location}）`)
}

/** Multi-select picker; the question title carries the live config because
 * the question card has no preselection. Skipped (Esc) changes nothing —
 * hiding everything is the `off` direct form's job. */
async function pickItems(c: CommandCtx): Promise<void> {
  const answer = await c.store.askQuestions([{
    id: `fx-tui-statusline-${Date.now()}`,
    question: `状态栏条目（当前：${itemListLabel(c.settings.statusLine)}）——空格或数字切换，回车保存`,
    multiSelect: true,
    options: STATUS_LINE_ITEMS.map(item => ({
      label: item.id,
      description: `${item.label} · ${item.description}`,
    })),
  }])
  const chosen = new Set(answer.answers[0]?.selected ?? [])
  if (chosen.size === 0) return
  const items = STATUS_LINE_ITEMS.map(item => item.id).filter(id => chosen.has(id))
  c.settings.setStatusLine(items)
  c.syncStatusLine()
  c.store.addNotice(`状态栏已保存为：${itemListLabel(items)}（${c.settings.location}）`)
}

function configureCustom(c: CommandCtx, rest: string): void {
  const text = rest.trim()
  const current = c.settings.statusLineCommand
  if (text === '') {
    c.store.addPanel('/statusline custom', [
      `当前命令：${current !== undefined ? current.command : '（未配置）'}`,
      `刷新：${current !== undefined ? describeInterval(current.intervalSeconds ?? 0) : '—'}`,
      '',
      '用法：',
      '· /statusline custom <shell 命令> — 设置命令；stdout 首行显示为「自定义命令」条目',
      '· /statusline custom interval <秒> — 周期刷新（≥10 秒；0＝仅回合结束/启动时刷新）',
      '· /statusline custom off — 清除命令',
      '',
      '提示：条目需在状态栏列表中启用（交互面板勾选 custom，或 /statusline context usage custom）。',
      '失败或超时（5 秒）保留上一次成功输出；会话切换后重新执行。',
    ])
    return
  }
  if (OFF_WORDS.has(text.toLowerCase()) || OFF_WORDS.has(text)) {
    c.settings.setStatusLineCommand(null)
    c.syncStatusLine()
    c.store.addNotice(`自定义状态命令已清除（${c.settings.location}）`)
    return
  }
  const intervalMatch = /^interval\s+(\d+)$|^间隔\s*(\d+)$/.exec(text)
  if (intervalMatch !== null) {
    if (current === undefined) {
      c.store.addNotice('尚未配置自定义命令：先用 /statusline custom <shell 命令> 设置', 'warn')
      return
    }
    const seconds = clampCustomInterval(Number.parseInt(intervalMatch[1] ?? intervalMatch[2] ?? '0', 10))
    c.settings.setStatusLineCommand({ command: current.command, ...(seconds > 0 ? { intervalSeconds: seconds } : {}) })
    c.syncStatusLine()
    c.store.addNotice(`自定义命令刷新已保存为：${describeInterval(seconds)}（${c.settings.location}）`)
    return
  }
  c.settings.setStatusLineCommand({ command: text })
  ensureCustomItem(c)
  c.syncStatusLine()
  c.store.addNotice(
    `自定义状态命令已保存：$ ${text}（${c.settings.location}）——stdout 首行显示在状态栏，每轮结束刷新；/statusline custom interval <秒> 开启周期刷新`,
  )
}

function ensureCustomItem(c: CommandCtx): void {
  if (c.settings.statusLine.includes('custom')) return
  c.settings.setStatusLine([...c.settings.statusLine, 'custom'])
}

function describeInterval(seconds: number): string {
  return seconds >= 10 ? `每 ${seconds} 秒` : '仅回合结束/启动时'
}

/** First occurrence wins; configuration order IS display order. */
function dedupe(items: readonly StatusLineItemId[]): StatusLineItemId[] {
  return [...new Set(items)]
}
