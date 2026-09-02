/** Read-only introspection commands: /help, /status, /context, /doctor. */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { activeThemeName, themeDisplayLabel } from '../ui/theme.js'
import { notifyModeLabel } from '../notify.js'
import type { CommandCtx } from './types.js'
import { currentSessionTitle } from './session.js'
import { modeLabel } from './config.js'
import { themeSettingLabel } from './theme.js'

export function runHelp(c: CommandCtx): void {
  c.store.addPanel('fx-tui 按键与命令', [
    'Enter 发送消息（agent 运行中＝注入当前轮下一步生效） · Ctrl+J 或 Opt+Enter 换行 · ↑↓ 输入历史/菜单导航',
    'Tab 补全菜单高亮项；agent 运行中无菜单时＝把输入排入下一轮 · Shift+Tab 切换权限模式',
    'Alt+↑ 取回最后一条未处理消息 · Ctrl+V 粘贴剪贴板（文本直接插入，图片自动附加）',
    'Esc 中断轮次/清空/关闭菜单/跳过 · Ctrl+O 工具详情 摘要⇄完整 · Ctrl+R Transcript 模式',
    'Ctrl+C 清空输入（空输入双击退出）',
    '',
    '内置命令：/help 帮助 · /status 运行状态 · /sessions [关键词] 切换会话 · /rename <标题> 重命名 ·',
    '  /model 模型 · /effort 推理强度 · /btw <问题> 侧问 · /context 上下文明细 · /doctor 自检 ·',
    '  /config 设置（权限/更新/通知/自动压缩） · /theme 主题 · /export 导出 · /edit 外部编辑器 ·',
    '  /image <路径…> 附加图片 · /update 升级自身 · /exit 退出',
    '会话生命周期：/new 新会话 · /clear 清空（历史留在父会话） · /resume <id|关键词> 恢复 ·',
    '  /fork 复制 · /rewind 回退到某轮之前 · /tree 血缘树 · /trace 事件轨迹',
    '环境与账户：/skills 技能 · /provider provider 与路由 · /login 凭证状态 · /logout 清除指引 · /balance 余额',
    'dsh 命令（来自注册表）：/compact 压缩历史 · /goal 长任务目标 · /feedback 反馈（输入 / 查看全部）',
    '技能：/ 菜单技能分组选中插入 /技能名 手势；消息里直接写 /技能名 亦可（命令优先于同名技能）',
    '',
    '输入历史跨会话保存在 $DSH_HOME/fx-tui-input-history.json（上限 500 条）',
  ])
}

export async function runStatus(c: CommandCtx): Promise<void> {
  const plugins: string[] = []
  try {
    c.ctx.registry.forEach(runtime => {
      if (runtime.name !== undefined) plugins.push(runtime.name)
    })
  } catch { /* registry inspection is display-optional */ }
  const snapshot = c.store.getSnapshot()
  const themeActiveLabel = themeDisplayLabel(activeThemeName())
  const themeSavedLabel = themeSettingLabel(c.settings.theme)
  const context = snapshot.contextWindow !== undefined && snapshot.contextWindow > 0
    ? `${snapshot.contextTokens} / ${snapshot.contextWindow} tokens`
    : `${snapshot.contextTokens} tokens`
  const title = await currentSessionTitle(c)
  const pluginLines = plugins.slice(0, 15).map(name => `· ${name}`)
  if (plugins.length > 15) pluginLines.push(`…（共 ${plugins.length} 个插件）`)
  c.store.addPanel('运行状态', [
    `fx-tui v${c.fxVersion} · Node ${process.version} · ${process.platform}/${process.arch}`,
    `模型：${c.modelLabel()}${snapshot.effortLabel !== '' ? ` · 推理 ${snapshot.effortLabel}` : ''} · 会话：${c.agent().id}`,
    title !== undefined ? `标题：${title}` : '标题：（未设置，/rename 可命名）',
    `权限模式：当前会话 ${modeLabel(snapshot.approvalMode)}（shift+tab 切换）· 启动默认 ${modeLabel(c.settings.approvalMode)}（/config 修改）`,
    `主题：${themeSavedLabel === themeActiveLabel ? themeActiveLabel : `${themeSavedLabel}，显示为${themeActiveLabel}`}（/theme 修改）`,
    `通知：${notifyModeLabel(c.settings.notify)}（/config notify 修改） · 自动压缩：${c.settings.autoCompact ? '开启' : '关闭'}（/config autocompact 修改）`,
    `上下文：${context} · 工作区：${process.cwd()}`,
    '',
    `已加载插件（${plugins.length}）：`,
    ...pluginLines,
  ])
}

/** `/context`: water level plus a heuristic composition split (system /
 * tools / messages) — composition figures are estimates, the level and the
 * last provider usage report are not. */
export function runContext(c: CommandCtx): void {
  const meter = c.ctx.get('tokenMeter')
  const snapshot = c.store.getSnapshot()
  let total = snapshot.contextTokens
  if (meter !== undefined) {
    try {
      total = meter.measure(c.agent().session).totalTokens
    } catch { /* keep the last refreshed value */ }
  }
  const window = snapshot.contextWindow
  const percent = window !== undefined && window > 0 ? ` · ${Math.round((total / window) * 100)}%` : ''
  // Newest request/header reconstructs the envelope the next request sends.
  let systemChars = 0
  let toolCount = 0
  let toolChars = 0
  for (let i = c.agent().session.events.length - 1; i >= 0; i--) {
    const event = c.agent().session.events[i]!
    if (event.type !== 'request/header') continue
    systemChars = event.data.header.system?.length ?? 0
    const tools = event.data.header.tools ?? []
    toolCount = tools.length
    toolChars = tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0)
    break
  }
  const estimate = (chars: number): number => Math.round(chars / 3)
  const usage = snapshot.lastUsage
  const lines = [
    `上下文水位：${total} tokens${window !== undefined && window > 0 ? ` / ${window}` : ''}${percent}`,
    '',
    '组成（启发式估算，仅看大致占比）：',
    `· 系统提示：约 ${estimate(systemChars)} tokens（${systemChars} 字符）`,
    `· 工具定义：${toolCount} 个 · 约 ${estimate(toolChars)} tokens`,
    `· 对话消息：约 ${Math.max(0, total - estimate(systemChars) - estimate(toolChars))} tokens`,
    '',
    '最近一次请求用量（provider 报告）：',
    usage !== null
      ? `· 输入 ${usage.inputTokens} · 输出 ${usage.outputTokens} · 缓存读 ${usage.cacheReadTokens ?? 0} · 缓存写 ${usage.cacheWriteTokens ?? 0}${usage.reasoningTokens !== undefined ? ` · 推理 ${usage.reasoningTokens}` : ''}`
      : '· 尚无用量记录（还没有完成过一次请求）',
  ]
  c.store.addPanel('已加载上下文', lines)
}

/** `/doctor`: startup facts as ✓/✗/· lines; failures point at the fix. */
export async function runDoctor(c: CommandCtx): Promise<void> {
  const lines: string[] = []
  const check = (ok: boolean | null, label: string, detail: string): void => {
    lines.push(`${ok === true ? '✓' : ok === false ? '✗' : '·'} ${label}${detail !== '' ? `：${detail}` : ''}`)
  }
  check(parseInt(process.versions.node.split('.')[0] ?? '0', 10) >= 22, 'Node', `${process.version}（要求 ≥22.19）`)
  check(true, '平台', `${process.platform}/${process.arch}${process.platform === 'darwin' ? '' : '（fx-tui 仅在 macOS 上验证）'}`)
  const dshVersion = c.dshVersion()
  check(dshVersion !== '', 'dsh 内核', dshVersion !== '' ? dshVersion : '版本号不可读（不影响使用）')
  const route = c.selectionRef.current ?? c.selection
  const providers = c.ctx.llm.listProviders().map(provider => provider.id)
  check(providers.includes(route.provider), '模型路由', `${route.provider}/${route.model}${providers.includes(route.provider) ? '' : `（provider 未注册，可用：${providers.join(' / ') || '无'}）`}`)
  try {
    const info = await c.ctx.llm.resolveModelInfo(route.provider, route.model)
    const window = info.context?.contextWindow
    const efforts = info.reasoning?.efforts.length ?? 0
    check(true, '模型能力', `上下文窗口 ${window !== undefined ? window : '未知'} · 推理档位 ${efforts > 0 ? efforts : '无'}`)
  } catch (error) {
    check(false, '模型能力', `解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  const hasCredentials = process.env.DEEPSEEK_API_KEY !== undefined || existsSync(join(dshHome, '.credentials.yaml'))
  check(hasCredentials, 'API 凭证', hasCredentials ? '可用（DEEPSEEK_API_KEY 或 dsh 凭证文件）' : '未找到（DEEPSEEK_API_KEY 未设置且无 ~/.dsh/.credentials.yaml）')
  check(true, '设置文件', `${c.settings.location}${existsSync(c.settings.location) ? '' : '（尚未生成，首次修改设置时创建）'}`)
  check(true, '输入历史', `${c.historyEntries.length} 条（$DSH_HOME/fx-tui-input-history.json）`)
  check(process.stdout.isTTY === true, '终端', `TTY=${process.stdout.isTTY === true ? '是' : '否'} · ${process.stdout.columns ?? '?'}×${process.stdout.rows ?? '?'} · TERM=${process.env.TERM ?? '(未设置)'}`)
  check(existsSync(process.cwd()), '工作目录', process.cwd())
  c.store.addPanel('环境自检 /doctor', lines)
}
