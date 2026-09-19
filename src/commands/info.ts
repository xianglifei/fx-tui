/** Read-only introspection commands: /help, /status, /context, /doctor —
 * plus the three cheap lifecycle helpers /init, /cost and /restart. */

import { existsSync, writeFileSync } from 'node:fs'
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
    '! <命令> 终端直通执行（!! 同义）：本地运行并显示结果，不进入对话上下文；首词补全命令、其余补全路径',
    '',
    '内置命令：/help 帮助 · /status 运行状态 · /sessions [关键词] 切换会话 · /rename <标题> 重命名 ·',
    '  /model 模型 · /effort 推理强度 · /btw <问题> 侧问 · /context 上下文明细 · /cost 会话用量 · /doctor 自检 ·',
    '  /config 设置（权限/更新/通知/自动压缩） · /theme 主题 · /export 导出 · /copy 复制最后回复 ·',
    '  /edit 外部编辑器 · /image <路径…> 附加图片 · /init 生成 AGENTS.md 骨架 · /restart 重启并恢复当前会话 ·',
    '  /update 升级自身 · /exit 退出',
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
export async function runContext(c: CommandCtx): Promise<void> {
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
  // dsh 0.1.5 dropped `header.system`: the assembled prompt lives only in the
  // system-prompt service, so re-assemble on demand for the heuristic split.
  let systemChars = 0
  let systemAvailable = true
  try {
    const prompt = c.ctx.get('systemPrompt')
    if (prompt === undefined) throw new Error('system-prompt service not loaded')
    const assembly = await prompt.assemble()
    systemChars = [...assembly.sections, ...assembly.contexts].reduce((sum, part) => sum + part.text.length, 0)
  } catch { /* the split is a display heuristic; degrade to unavailable */ systemAvailable = false }
  // Newest request/header reconstructs the tool envelope the next request sends.
  let toolCount = 0
  let toolChars = 0
  const events = c.agent().session.snapshotEvents()
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type !== 'request/header') continue
    const tools = event.data.header.tools ?? []
    toolCount = tools.length
    toolChars = tools.reduce((sum: number, tool) => sum + JSON.stringify(tool).length, 0)
    break
  }
  const estimate = (chars: number): number => Math.round(chars / 3)
  const usage = snapshot.lastUsage
  const lines = [
    `上下文水位：${total} tokens${window !== undefined && window > 0 ? ` / ${window}` : ''}${percent}`,
    '',
    '组成（启发式估算，仅看大致占比）：',
    `· 系统提示：${systemAvailable ? `约 ${estimate(systemChars)} tokens（${systemChars} 字符）` : '不可估算（system-prompt 服务未加载）'}`,
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

/** `/init`: drop a generic AGENTS.md skeleton into the working directory so
 * the agent has something to fill in — never overwrites an existing file. */
export function runInit(c: CommandCtx): void {
  const target = join(process.cwd(), 'AGENTS.md')
  if (existsSync(target)) {
    c.store.addNotice(`已存在 ${target}，未改动`)
    return
  }
  const template = [
    '# AGENTS.md',
    '',
    '（项目说明：用几句话描述这个仓库是什么、给谁用、整体结构如何。）',
    '',
    '## 构建与验证',
    '',
    '（写清构建、测试、静态检查的具体命令；任何改动提交前先全部跑通。）',
    '',
    '## 协作约定',
    '',
    '- 动手前先读完本文件；约定与实际代码冲突时，以代码为准并向维护者确认',
    '- 改动保持最小聚焦，不顺手重构无关代码',
    '- 提交信息说明动机与影响面，不写无 CHANGELOG 条目的提交（如项目有此约定）',
    '',
  ].join('\n')
  try {
    writeFileSync(target, template, 'utf8')
  } catch (error) {
    c.store.addNotice(`创建 AGENTS.md 失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    return
  }
  c.store.addPanel('/init', [
    `已创建 ${target}`,
    '内容是通用骨架：把项目说明和构建/测试命令填成实际值后再提交入库。',
  ])
}

/** `/cost`: cumulative session spend folded from the usage reports carried by
 * completed assistant messages — /context shows the live water level and the
 * last request, this shows the whole session. Counts are DISJOINT per the
 * provider contract: billed input = uncached input + cache read + cache write. */
export function runCost(c: CommandCtx): void {
  let calls = 0
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let reasoning = 0
  for (const event of c.agent().session.snapshotEvents()) {
    if (event.type !== 'assistant/message') continue
    const usage = (event.data as { usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number } }).usage
    if (usage === undefined) continue
    calls += 1
    input += usage.inputTokens
    output += usage.outputTokens
    cacheRead += usage.cacheReadTokens ?? 0
    cacheWrite += usage.cacheWriteTokens ?? 0
    reasoning += usage.reasoningTokens ?? 0
  }
  if (calls === 0) {
    c.store.addNotice('本会话还没有用量记录（还没有完成过一次请求）')
    return
  }
  const billedInput = input + cacheRead + cacheWrite
  const rate = billedInput > 0 ? ((cacheRead / billedInput) * 100).toFixed(1) : '0.0'
  const snapshot = c.store.getSnapshot()
  const window = snapshot.contextWindow
  const level = window !== undefined && window > 0
    ? `${snapshot.contextTokens} / ${window}（${Math.round((snapshot.contextTokens / window) * 100)}%）`
    : `${snapshot.contextTokens}`
  const lines = [
    `完成调用：${calls} 次`,
    `输入合计（计费口径）：${billedInput} · 其中未命中缓存 ${input} · 缓存读 ${cacheRead} · 缓存写 ${cacheWrite}`,
    `输出合计：${output}${reasoning > 0 ? ` · 推理 ${reasoning}` : ''}`,
    `缓存命中率：${rate}%`,
    `当前上下文水位：${level}`,
    '（/context 可看水位组成估算与最近一次请求的明细）',
  ]
  c.store.addPanel('会话用量 /cost', lines)
}

/** `/restart`: respawn the host with the same profile and `--resume` the live
 * session id, then exit. The pure argv rebuild is exported for tests. */
export function buildRestartArgs(hostArgv: readonly string[], bundleArgs: readonly string[], sessionId: string): string[] {
  // The profile pair is consumed by the launcher before the bundle sees the
  // command line, so recover it from the host argv (bin/fx always passes one).
  let profile = 'fx'
  for (let i = 0; i < hostArgv.length - 1; i++) {
    if (hostArgv[i] === '--profile') {
      const value = hostArgv[i + 1]
      if (value !== undefined && !value.startsWith('-')) profile = value
    }
  }
  // Bundle args keep everything except a previous --resume (both spellings);
  // the live session id is what a restart wants to land on.
  const rest: string[] = []
  for (let i = 0; i < bundleArgs.length; i++) {
    const arg = bundleArgs[i] ?? ''
    if (arg === '--resume') {
      i++
      continue
    }
    if (arg.startsWith('--resume=')) continue
    rest.push(arg)
  }
  return ['--profile', profile, ...rest, '--resume', sessionId]
}

/** `/restart`: guard the busy case (a cancelled turn would defeat the point),
 * then hand off to the runner-owned respawn. */
export async function runRestart(c: CommandCtx): Promise<void> {
  if (c.store.getSnapshot().phase !== 'idle') {
    c.store.addNotice('当前任务运行中：先等它完成或按 Esc 中断，再重启', 'warn')
    return
  }
  c.store.addNotice('正在重启进程并恢复当前会话…')
  await c.restart()
}
