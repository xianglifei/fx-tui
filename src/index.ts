/**
 * fx-tui — interactive terminal surface for DeepSeek Harness.
 *
 * An out-of-tree dsh bundle: this runner mounts on top of dsh-base, creates
 * (or resumes) one persistent Agent, renders an Ink app over the session
 * event stream, answers approval requests from the keyboard (with
 * session/persistent memory), answers agent questions through the
 * user-questions seam, dispatches slash commands (built-ins plus the dsh
 * command registry), completes @-file references, attaches images to the
 * next message, and shows live context pressure.
 *
 * @module fx-tui
 */

import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import { createElement } from 'react'
import { render } from 'ink'
import type { Instance } from 'ink'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
// Declaration-merge carriers: importing these types registers the ctx keys and
// events we consume (agents, agentDefaultModel, sessions, session/event,
// approval/request, userQuestions, tokenMeter, cmdlineArgs, appExit).
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'

import { ApprovalMemory } from './approval-memory.js'
import { TuiStore } from './store.js'
import type { ToolPresenter } from './store.js'
import { blocksToTextOf, formatToolArgs, toolResultCallIdOf, toolResultTextOf } from './store.js'
import { App } from './ui/App.js'
import type { MenuEntry } from './ui/Input.js'
import type { ToolResult } from '@deepseek-ai/dsh-tools'

export const FX_TUI_VERSION = '0.7.0'

/** Stable Cordis plugin name. */
export const name = 'fx-tui-runner'

/** Core services required before the TUI can drive an agent. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'userQuestions', 'attachments', 'commands', 'llm', 'sessionQuery']

const USAGE = `fx-tui v${FX_TUI_VERSION} — DeepSeek Harness 的交互式终端界面

用法：fx [选项]（即 dsh --profile fx）

选项：
  --resume <sessionId>   恢复一个已持久化的会话
  -h, --help             显示帮助
  -v, --version          显示版本

按键：Enter 发送 · Ctrl+J 换行 · ↑↓ 历史/菜单 · Tab 补全 · Shift+Tab 权限模式 · Esc 中断 · Ctrl+O 工具详情 · Ctrl+C 清空/双击退出
`

const IMAGE_MEDIA_TYPES: Record<string, ImageMediaType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

interface CliOptions {
  resume?: string
}

function readCliOptions(ctx: Context, exit: (code: number) => void | Promise<void>): CliOptions | null {
  const raw: readonly string[] = ctx.get('cmdlineArgs')?.get() ?? []
  const options: CliOptions = {}
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i] ?? ''
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE)
      void exit(0)
      return null
    }
    if (arg === '--version' || arg === '-v') {
      process.stdout.write(`fx-tui v${FX_TUI_VERSION}\n`)
      void exit(0)
      return null
    }
    if (arg === '--resume') {
      const value = raw[++i]
      if (value === undefined || value.startsWith('-')) {
        throw new Error('--resume 需要一个会话 id')
      }
      options.resume = value
      continue
    }
    if (arg.startsWith('--resume=')) {
      const value = arg.slice('--resume='.length)
      if (value === '') throw new Error('--resume 需要一个会话 id')
      options.resume = value
      continue
    }
    throw new Error(`未知参数：${arg}（可用：--resume <id>，--help 查看帮助）`)
  }
  return options
}

/** dsh core version from the installed harness (display-only; blank when unreadable). */
function readDshVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require('@deepseek-ai/dsh-agent/package.json') as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/** Mount the interactive terminal surface. */
export function apply(ctx: Context): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('fx-tui-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  void main(ctx, exit).catch((error: unknown) => {
    process.stderr.write(`fx-tui: ${error instanceof Error ? error.message : String(error)}\n`)
    void exit(1)
  })
}

async function main(ctx: Context, exit: (code: number) => void | Promise<void>): Promise<void> {
  const debug = process.env.FX_TUI_DEBUG !== undefined
  const debugLog = (label: string, data?: unknown): void => {
    if (!debug) return
    try {
      appendFileSync('/tmp/fx-debug.log', `${Date.now()} ${label} ${JSON.stringify(data) ?? ''}\n`)
    } catch { /* debug logging is best-effort */ }
  }

  // Loader siblings mount concurrently: await the complete application before
  // creating an Agent so its scoped tools and adapters are fully composed.
  await ctx.get('loader')?.await()

  const options = readCliOptions(ctx, exit)
  if (options === null) return
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  // Early process shutdown can dispose the tree while we are starting up.
  if (agents === undefined || defaultModel === undefined) return
  const registry = agents
  const defaultModelService = defaultModel

  const selection = defaultModelService.currentSelection()
  // The live selection ref: mutating `current` switches the model from the next step.
  let selectionRef: ModelSelectionRef = { current: selection, assembled: undefined }
  const agentOptions = { provider: selection.provider, model: selection.model }
  const setup = (agentCtx: Context): void => {
    selectionRef = { current: selectionRef.current ?? selection, assembled: undefined }
    installModelSelection(agentCtx, selectionRef)
  }

  let handle = options.resume !== undefined
    ? await registry.resume({ resumeSessionId: SessionId(options.resume), agentOptions, setup })
    : await registry.create({
        sessionId: SessionId(`session-${randomUUID()}`),
        meta: { cwd: process.cwd() },
        agentOptions,
        setup,
      })
  let agent: Agent = handle.agent

  const modelLabel = (): string =>
    `${agent.options.provider ?? selectionRef.current?.provider ?? ''}/${agent.options.model ?? selectionRef.current?.model ?? ''}`
  const presenter = createPresenter(ctx)
  const store = new TuiStore(agent.id, modelLabel(), presenter)
  const memory = new ApprovalMemory(process.env.DSH_HOME)
  store.addBanner({
    fxVersion: FX_TUI_VERSION,
    dshVersion: readDshVersion(),
    model: modelLabel(),
    sessionId: agent.id,
    cwd: process.cwd(),
    resumed: options.resume !== undefined,
  })
  store.replay(agent.session.events)
  store.finishReplay()

  // Live subagent tracking: children created against this session show a badge.
  const childAgents = new Set<string>()
  const syncChildCount = (): void => { store.setChildAgentCount(childAgents.size) }
  ctx.on('agent/created', payload => {
    if (payload.agent.session.header.parentSession === agent.session.id) {
      childAgents.add(payload.agent.id)
      syncChildCount()
    }
  })
  ctx.on('agent/disposed', payload => {
    if (childAgents.delete(payload.agent.id)) syncChildCount()
  })

  ctx.on('session/event', (session, event) => {
    if (session.id !== agent.session.id) return
    debugLog('event', event.type)
    store.onEvent(event)
    // Refresh context pressure once per completed step: the meter is O(surface)
    // and the next request's size is what the user cares about.
    if (event.type === 'assistant/message' || event.type === 'turn/end') {
      const meter = ctx.get('tokenMeter')
      if (meter !== undefined) {
        try {
          store.setContextPressure(meter.measure(agent.session).totalTokens)
        } catch { /* metering is display-only */ }
      }
    }
  })

  ctx.on('approval/request', async (req, next) => {
    if (req.agent.id !== agent.id) return next()
    // Auto mode (Shift+Tab) answers every ask without prompting.
    if (store.getSnapshot().approvalMode === 'auto') return 'allowed-once'
    debugLog('approval-request', { toolName: req.toolName, reason: req.reason })
    const pending = store.pendingToolFor(req.callId)
    const key = ApprovalMemory.key(req.toolName, pending?.args ?? '')
    if (pending !== undefined && memory.isAllowed(key)) {
      store.addNotice(`已按记忆规则自动允许 ${req.toolName}（总是授权可删除 $DSH_HOME/fx-tui-allowlist.json 清除）`)
      return 'allowed-once'
    }
    const withdraw = (): void => { store.cancelApproval() }
    req.signal?.addEventListener('abort', withdraw, { once: true })
    const choice = await store.askApproval({
      toolName: req.toolName,
      reason: req.reason ?? '',
      command: pending !== undefined ? formatToolArgs(pending.args, 120) : undefined,
    })
    req.signal?.removeEventListener('abort', withdraw)
    if (choice === 'session') memory.allowSession(key)
    if (choice === 'always') memory.allowAlways(key)
    return choice === 'reject' ? 'rejected' : 'allowed-once'
  })

  const unregisterQuestions = ctx.userQuestions.registerProvider({
    ask: (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => {
      debugLog('question', request.questions.map(q => q.id))
      const withdraw = (): void => { store.cancelQuestions() }
      request.signal?.addEventListener('abort', withdraw, { once: true })
      return store.askQuestions(request.questions).then(answer => {
        request.signal?.removeEventListener('abort', withdraw)
        return answer
      })
    },
  })
  ctx.effect(() => () => { unregisterQuestions() })

  const history: string[] = []
  let instance: Instance | null = null

  // -- Slash commands ---------------------------------------------------------

  const builtinCommands: readonly MenuEntry[] = [
    { name: 'help', description: '查看按键与命令帮助', kind: 'builtin' },
    { name: 'status', description: '查看运行状态与插件树', kind: 'builtin' },
    { name: 'sessions', description: '切换到另一个会话', kind: 'builtin' },
    { name: 'model', description: '切换模型 / provider', kind: 'builtin' },
    { name: 'export', description: '导出当前会话为 Markdown', kind: 'builtin' },
    { name: 'edit', description: '用 $EDITOR 编写长消息', kind: 'builtin' },
    { name: 'image', description: '附加图片：<路径>，随下一条消息发送', kind: 'builtin' },
    { name: 'exit', description: '退出 fx-tui', kind: 'builtin' },
  ]

  /** Interactive single-choice picker reusing the question UI; resolves undefined when skipped. */
  async function pick(title: string, options: readonly { label: string; description?: string }[]): Promise<string | undefined> {
    if (options.length === 0) return undefined
    const answer = await store.askQuestions([{
      id: `fx-tui-pick-${Date.now()}`,
      question: title,
      options: options.slice(0, 9).map(option => ({
        label: option.label,
        ...(option.description !== undefined ? { description: option.description } : {}),
      })),
    }])
    return answer.answers[0]?.selected[0]
  }

  async function switchSession(sessionId: string): Promise<void> {
    if (agent.session.id === sessionId) {
      store.addNotice('已在当前会话中')
      return
    }
    if (agent.status === 'running') {
      store.addNotice('当前任务运行中：先等它完成或按 Esc 中断，再切换会话', 'warn')
      return
    }
    try {
      await ctx.get('sessions')?.flush(agent.session)
    } catch { /* best-effort durability before switching */ }
    try {
      await handle.dispose()
      handle = await registry.resume({ resumeSessionId: SessionId(sessionId), agentOptions: agent.options, setup })
      agent = handle.agent
      childAgents.clear()
      syncChildCount()
      store.reset(agent.id, modelLabel(), agent.session.events)
      store.addNotice(`已切换到会话 ${agent.id}`)
    } catch (error) {
      store.addNotice(`切换会话失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  async function listSessionChoices(): Promise<void> {
    let records
    try {
      records = await ctx.sessionQuery.listSessions()
    } catch (error) {
      store.addNotice(`读取会话列表失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      return
    }
    const choices = records
      .filter(record => !record.header.parentSession && record.header.origin !== 'subagent')
      .slice(0, 9)
      .map(record => {
        const created = new Date(record.header.createdAt)
        const stamp = `${created.getMonth() + 1}-${created.getDate()} ${String(created.getHours()).padStart(2, '0')}:${String(created.getMinutes()).padStart(2, '0')}`
        const dir = record.header.cwd !== undefined ? basename(record.header.cwd) : '?'
        return {
          label: `${stamp} · ${dir}${record.live ? ' · 运行中' : ''}`,
          description: record.header.id.slice(0, 21),
          id: record.header.id,
        }
      })
    if (choices.length === 0) {
      store.addNotice('没有可切换的会话')
      return
    }
    const chosen = await pick('选择要切换到的会话', choices)
    const target = choices.find(choice => choice.label === chosen)
    if (target === undefined) return
    await switchSession(target.id)
  }

  async function listModelChoices(): Promise<void> {
    const providers = ctx.llm.listProviders()
    if (providers.length === 0) {
      store.addNotice('没有已注册的模型 provider')
      return
    }
    const options: { label: string; description?: string }[] = []
    for (const provider of providers) {
      let models: readonly { id: string }[] = []
      try {
        models = await ctx.llm.listModels(provider.id)
      } catch { /* provider without a listing stays absent */ }
      for (const model of models) {
        options.push({ label: `${provider.id}/${model.id}` })
      }
    }
    if (options.length === 0) {
      store.addNotice('没有可列举的模型')
      return
    }
    const chosen = await pick(`切换模型（当前 ${modelLabel()}）`, options)
    if (chosen === undefined) return
    const [provider, ...rest] = chosen.split('/')
    const model = rest.join('/')
    if (provider === undefined || model === '') return
    selectionRef.current = { provider, model }
    store.setModel(`${provider}/${model}`)
    store.addNotice(`模型已切换为 ${provider}/${model}（下一步请求生效）`)
    try {
      await defaultModelService.saveSelection({ provider, model })
    } catch { /* persisting the default is best-effort */ }
  }

  async function exportSession(): Promise<void> {
    const lines: string[] = [
      `# fx-tui 会话导出 · ${agent.id}`,
      '',
      `- 模型：${modelLabel()}`,
      `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
      '',
      '---',
      '',
    ]
    const pendingNames = new Map<string, string>()
    for (const event of agent.session.events) {
      if (event.type === 'tool/call') {
        try {
          const parsed = JSON.parse(event.data.arguments) as Record<string, unknown>
          const summary = typeof parsed.command === 'string' ? parsed.command
            : typeof parsed.path === 'string' ? parsed.path : ''
          pendingNames.set(event.data.callId, `${event.data.name}${summary !== '' ? `（${summary}）` : ''}`)
        } catch {
          pendingNames.set(event.data.callId, event.data.name)
        }
      } else if (event.type === 'tool/result') {
        const callId = toolResultCallIdOf(event.data.message)
        const name = callId !== undefined ? pendingNames.get(callId) : undefined
        if (callId !== undefined) pendingNames.delete(callId)
        lines.push(`> 🔧 **工具** ${name ?? '(unknown)'}：${toolResultTextOf(event.data.message, undefined).split('\n')[0] ?? ''}`, '')
      } else if (event.type === 'user/message') {
        if (event.data.source.kind === 'user') {
          lines.push(`## 👤 用户`, '', blocksToTextOf(event.data.content), '')
        }
      } else if (event.type === 'assistant/message') {
        const text = blocksToTextOf(event.data.message.content)
        if (text !== '') lines.push(`## 🤖 助手`, '', text, '')
      }
    }
    const file = resolve(process.cwd(), `fx-tui-export-${agent.id.slice(0, 13)}.md`)
    try {
      writeFileSync(file, lines.join('\n'), { encoding: 'utf8' })
      store.addPanel('会话已导出', [file])
    } catch (error) {
      store.addNotice(`导出失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  function listCommands(): readonly MenuEntry[] {
    const dsh: MenuEntry[] = []
    try {
      for (const descriptor of ctx.commands.list(agent)) {
        if (builtinCommands.some(builtin => builtin.name === descriptor.name)) continue
        dsh.push({ name: descriptor.name, description: descriptor.description, kind: 'dsh' })
      }
    } catch { /* the registry is display-optional */ }
    return [...builtinCommands, ...dsh]
  }

  async function runCommand(line: string): Promise<void> {
    const trimmed = line.trim()
    const name = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase() ?? ''
    const rest = trimmed.slice(1 + name.length).trim()
    debugLog('command', trimmed)
    try {
      switch (name) {
        case 'help':
          store.addPanel('fx-tui 按键与命令', [
            'Enter 发送消息 · Ctrl+J 或 Opt+Enter 换行 · ↑↓ 输入历史/菜单导航',
            'Tab 补全菜单高亮项（/ 命令、@ 文件路径） · Esc 中断轮次/清空/关闭菜单/跳过',
            'Shift+Tab 切换权限模式（每次询问 ⇄ 自动允许） · Ctrl+O 工具详情 摘要⇄完整',
            'Ctrl+C 清空输入（空输入双击退出）',
            '',
            '内置命令：/help 帮助 · /edit 用 $EDITOR 写长消息 · /image <路径> 附加图片 · /exit 退出',
            'dsh 命令（来自注册表）：/compact 压缩历史 · /goal 长任务目标 ·',
            '  /feedback 反馈（输入 / 查看全部）',
          ])
          return
        case 'exit': case 'quit': case 'bye':
          await shutdown()
          return
        case 'status': {
          const plugins: string[] = []
          try {
            ctx.registry.forEach(runtime => {
              if (runtime.name !== undefined) plugins.push(runtime.name)
            })
          } catch { /* registry inspection is display-optional */ }
          const snapshot = store.getSnapshot()
          const context = snapshot.contextWindow !== undefined && snapshot.contextWindow > 0
            ? `${snapshot.contextTokens} / ${snapshot.contextWindow} tokens`
            : `${snapshot.contextTokens} tokens`
          const pluginLines = plugins.slice(0, 15).map(name => `· ${name}`)
          if (plugins.length > 15) pluginLines.push(`…（共 ${plugins.length} 个插件）`)
          store.addPanel('运行状态', [
            `fx-tui v${FX_TUI_VERSION} · Node ${process.version} · ${process.platform}/${process.arch}`,
            `模型：${modelLabel()} · 会话：${agent.id}`,
            `权限模式：${snapshot.approvalMode === 'auto' ? '自动允许（shift+tab 切换）' : '每次询问（shift+tab 切换）'}`,
            `上下文：${context} · 工作区：${process.cwd()}`,
            '',
            `已加载插件（${plugins.length}）：`,
            ...pluginLines,
          ])
          return
        }
        case 'sessions':
          await listSessionChoices()
          return
        case 'model':
          await listModelChoices()
          return
        case 'export':
          await exportSession()
          return
        case 'edit':
          await openExternalEditor()
          return
        case 'image':
          await attachImage(rest)
          return
        case 'forget': case 'forget-approvals':
          store.addNotice('总是授权记录在 $DSH_HOME/fx-tui-allowlist.json，删除该文件即可清除（本会话记忆随进程结束失效）', 'warn')
          return
        default: {
          const commands = ctx.commands
          if (commands.find(agent, name) !== undefined) {
            const execution = await commands.execute(agent, trimmed, [], new AbortController().signal)
            if (execution === undefined) {
              store.addNotice(`/${name}：命令未执行（语法或名称未解析）`, 'warn')
            } else if (execution.result.kind === 'error') {
              store.addPanel(`/${name} 执行失败`, [execution.result.text])
            } else if (execution.result.text !== undefined && execution.result.text !== '') {
              store.addPanel(`/${name}`, [execution.result.text])
            } else {
              store.addNotice(`/${name} 完成`)
            }
          } else {
            store.addNotice(`未知命令：/${name}（输入 / 查看可用命令）`, 'warn')
          }
          return
        }
      }
    } catch (error) {
      store.addNotice(`命令执行失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  async function attachImage(pathArg: string): Promise<void> {
    if (pathArg === '') {
      store.addNotice('用法：/image <图片路径>（支持 png / jpeg / webp / gif）', 'warn')
      return
    }
    const expanded = pathArg.startsWith('~/') ? resolve(process.env.HOME ?? '~', pathArg.slice(2)) : pathArg
    const absolute = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded)
    const mediaType = IMAGE_MEDIA_TYPES[extname(absolute).toLowerCase()]
    if (mediaType === undefined) {
      store.addNotice(`不支持的图片格式：${basename(absolute)}（支持 png / jpeg / webp / gif）`, 'error')
      return
    }
    let data: Uint8Array
    try {
      data = new Uint8Array(readFileSync(absolute))
    } catch (error) {
      store.addNotice(`读取图片失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      return
    }
    const name = basename(absolute)
    try {
      const [ref] = await ctx.attachments.saveImages([{ data, mediaType, name }])
      if (ref === undefined) {
        store.addNotice('图片保存失败：未返回引用', 'error')
        return
      }
      store.addPendingImage(ref, `${name}（${ref.width}×${ref.height}）`)
      store.addNotice(`已附加图片 ${name}（${ref.width}×${ref.height}），将随下一条消息发送`)
    } catch (error) {
      store.addNotice(`图片校验失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  /** Open $EDITOR on a scratch file; the edited text seeds the input box after re-mount. */
  async function openExternalEditor(): Promise<void> {
    const editor = process.env.EDITOR ?? process.env.VISUAL ?? 'vi'
    const scratch = resolve(tmpdir(), `fx-tui-${randomUUID()}.md`)
    try {
      writeFileSync(scratch, '', { encoding: 'utf8' })
    } catch (error) {
      store.addNotice(`无法创建临时文件：${error instanceof Error ? error.message : String(error)}`, 'error')
      return
    }
    instance?.unmount()
    try {
      await instance?.waitUntilExit()
    } catch { /* unmount already settled */ }
    store.discardRenderedItems()
    spawnSync(editor, [scratch], { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' })
    let seed: string | undefined
    try {
      const text = readFileSync(scratch, 'utf8').replace(/\s+$/, '')
      seed = text === '' ? undefined : text
    } catch { /* an unreadable scratch file just seeds nothing */ }
    try {
      unlinkSync(scratch)
    } catch { /* cleanup is best-effort */ }
    bottomFlush()
    instance = render(
      createElement(App, { store, history, actions, listCommands, seed }),
      { exitOnCtrlC: false, incrementalRendering: true },
    )
    store.start()
  }

async function shutdown(): Promise<void> {
  instance?.unmount()
  store.dispose()
  if (agent.status === 'running') {
    agent.cancel({ kind: 'user' })
    await Promise.race([
      agent.whenIdle().catch(() => {}),
      new Promise(resolve => { setTimeout(resolve, 3000) }),
    ])
  }
  try {
    await ctx.get('sessions')?.flush(agent.session)
  } catch {
    // flushing on exit is best-effort
  }
  await exit(0)
}

/**
 * Park the cursor at the viewport's home position so the first Ink frame
 * renders top-down OVER the startup screen and lands with the input box on
 * the terminal's bottom row, like Claude Code. The frame is exactly one row
 * shorter than the viewport (the filler reserves it), so writing it never
 * scrolls: newline padding here would push a full page of blank rows into
 * the scrollback buffer, leaving an empty screenful above the banner when
 * the user scrolls their mouse wheel up. Scrolling up instead reveals the
 * pre-launch shell history (nothing at all in a fresh tab).
 */
function homeCursor(): void {
  const out = process.stdout
  if (out.isTTY === true) {
    out.write('\x1b[H')
  }
}

/**
 * Scroll the current on-screen content into the scrollback buffer before a
 * re-mount (external editor): the visible transcript above the input exists
 * only in the viewport — it has never scrolled — so a plain repaint would
 * erase it from view. Deliberately uses newline padding; the blank rows it
 * adds below are repainted by the next mount.
 */
function bottomFlush(): void {
  const out = process.stdout
  const rows = out.rows
  if (out.isTTY === true && typeof rows === 'number' && rows > 0 && rows < 1000) {
    out.write('\n'.repeat(rows))
  }
}

  const actions = {
    onSubmit(text: string): void {
      debugLog('submit', text)
      const images = store.consumePendingImages()
      const content: ContentBlock[] = []
      if (text !== '') content.push({ type: 'text', text })
      for (const image of images) content.push({ type: 'image', attachment: image.ref })
      if (content.length === 0) return
      history.push(text)
      const message = createUserMessage({ content, source: { kind: 'user' } })
      store.echoUser(
        message.id,
        text,
        images.map(image => image.label),
      )
      agent.followup(message)
    },
    runCommand(line: string): void {
      void runCommand(line)
    },
    onInterrupt(): void {
      store.setInterrupting()
      agent.cancel({ kind: 'user' })
    },
    onExit(): void {
      debugLog('exit')
      void shutdown()
    },
  }

  homeCursor()
  instance = render(
    createElement(App, { store, history, actions, listCommands }),
    { exitOnCtrlC: false, incrementalRendering: true },
  )

  store.start()

  ctx.effect(() => () => {
    store.dispose()
    instance?.unmount()
  })
}

/** Bridge the tools registry's presentation layer into the store. */
function createPresenter(ctx: Context): ToolPresenter {
  return {
    presentCall(name: string, rawArgs: string) {
      const definition = ctx.get('tools')?.get(name)
      if (definition?.presentCall === undefined) return undefined
      try {
        return definition.presentCall(parseArgs(rawArgs))
      } catch {
        return undefined
      }
    },
    presentResult(name: string, rawArgs: string, result: {
      content: readonly ContentBlock[]
      isError: boolean
      meta: unknown
    }) {
      const definition = ctx.get('tools')?.get(name)
      if (definition?.presentResult === undefined) return undefined
      try {
        const toolResult: ToolResult = {
          content: [...result.content],
          isError: result.isError,
          ...(result.meta === undefined ? {} : { meta: result.meta as ToolResult['meta'] }),
        }
        return definition.presentResult(parseArgs(rawArgs), toolResult)
      } catch {
        return undefined
      }
    },
  }
}

function parseArgs(rawArgs: string): unknown {
  if (rawArgs === '') return {}
  return JSON.parse(rawArgs)
}
