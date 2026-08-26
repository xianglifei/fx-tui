/**
 * fx-tui — interactive terminal surface for DeepSeek Harness.
 *
 * An out-of-tree dsh bundle: this runner mounts on top of dsh-base, creates
 * (or resumes) one persistent Agent, renders an Ink app over the session
 * event stream, and answers approval requests from the keyboard.
 *
 * @module fx-tui
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { createElement } from 'react'
import { render } from 'ink'
import type { Instance } from 'ink'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
// Declaration-merge carriers: importing these types registers the ctx keys and
// events we consume (agents, agentDefaultModel, sessions, session/event,
// approval/request, cmdlineArgs, appExit).
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'

import { TuiStore } from './store.js'
import { App } from './ui/App.js'

export const FX_TUI_VERSION = '0.1.0'

/** Stable Cordis plugin name. */
export const name = 'fx-tui-runner'

/** Core services required before the TUI can drive an agent. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

const USAGE = `fx-tui v${FX_TUI_VERSION} — DeepSeek Harness 的交互式终端界面

用法：dsh --profile fx [选项]

选项：
  --resume <sessionId>   恢复一个已持久化的会话
  -h, --help             显示帮助
  -v, --version          显示版本

按键：Enter 发送 · Ctrl+J 换行 · ↑↓ 历史 · Esc 中断 · Ctrl+C 清空/双击退出
`

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
  if (debug) {
    debugLog('stdin', { isTTY: process.stdin.isTTY === true })
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

  const selection = defaultModel.currentSelection()
  const agentOptions = { provider: selection.provider, model: selection.model }
  const setup = (agentCtx: Context): void => {
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    installModelSelection(agentCtx, selected)
  }

  const handle = options.resume !== undefined
    ? await agents.resume({ resumeSessionId: SessionId(options.resume), agentOptions, setup })
    : await agents.create({
        sessionId: SessionId(`session-${randomUUID()}`),
        meta: { cwd: process.cwd() },
        agentOptions,
        setup,
      })
  const agent: Agent = handle.agent

  const model = `${agent.options.provider ?? selection.provider}/${agent.options.model ?? selection.model}`
  const store = new TuiStore(agent.id, model)
  store.addNotice(
    `fx-tui v${FX_TUI_VERSION} · ${model} · 会话 ${agent.id}` +
    (options.resume !== undefined ? ' · 已恢复历史会话' : ''),
  )
  store.replay(agent.session.events)
  store.finishReplay()

  ctx.on('session/event', (session, event) => {
    if (session.id !== agent.session.id) return
    debugLog('event', event.type)
    store.onEvent(event)
  })

  ctx.on('approval/request', async (req, next) => {
    if (req.agent.id !== agent.id) return next()
    debugLog('approval-request', { toolName: req.toolName, reason: req.reason })
    return await store.askApproval({ toolName: req.toolName, reason: req.reason ?? '' })
  })

  const history: string[] = []
  let instance: Instance | null = null

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

  instance = render(
    createElement(App, {
      store,
      history,
      actions: {
        onSubmit(text: string): void {
          debugLog('submit', text)
          history.push(text)
          const message = createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          })
          store.echoUser(message.id, text)
          agent.followup(message)
        },
        onInterrupt(): void {
          store.setInterrupting()
          agent.cancel({ kind: 'user' })
        },
        onExit(): void {
          debugLog('exit')
          void shutdown()
        },
      },
    }),
    { exitOnCtrlC: false },
  )

  store.start()

  ctx.effect(() => () => {
    store.dispose()
    instance?.unmount()
  })
}
