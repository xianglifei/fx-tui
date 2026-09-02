import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it } from 'vitest'
import { runContext, runHelp, runStatus } from './info.js'
import { cleanupTempHomes, makeCtx } from './test-helpers.js'

afterEach(cleanupTempHomes)

/** An agent whose session log holds the events a command wants to read. */
function agentWithEvents(events: readonly unknown[]): Agent {
  return {
    id: 'agent-1',
    session: { id: 's1', header: { cwd: '/tmp/work' }, events, deriveMessages: () => [] },
  } as unknown as Agent
}

describe('/help', () => {
  it('renders the key bindings and the command list', () => {
    const { c, log } = makeCtx()
    runHelp(c)

    const body = log.panels[0]?.lines.join('\n') ?? ''
    expect(log.panels[0]?.title).toContain('按键与命令')
    expect(body).toContain('Ctrl+O')
    expect(body).toContain('/config')
    expect(body).toContain('fx-tui-input-history.json')
  })
})

describe('/context', () => {
  it('reports the water level and admits the split is an estimate', async () => {
    const { c, log } = makeCtx({ agent: () => agentWithEvents([]) })
    runContext(c)

    const body = log.panels[0]?.lines.join('\n') ?? ''
    expect(log.panels[0]?.title).toBe('已加载上下文')
    expect(body).toContain('上下文水位')
    expect(body).toContain('启发式估算')
    expect(body).toContain('尚无用量记录')
  })

  it('reads the newest request header for the system and tool split', async () => {
    const events = [
      { type: 'request/header', data: { header: { system: 'x'.repeat(300), tools: [{ name: 'bash' }] } } },
    ]
    const { c, log } = makeCtx({ agent: () => agentWithEvents(events) })
    runContext(c)

    const body = log.panels[0]?.lines.join('\n') ?? ''
    expect(body).toContain('300 字符')
    expect(body).toContain('1 个')
  })

  it('prefers the token meter when the kernel offers one', async () => {
    const ctx = {
      get: (key: string) => (key === 'tokenMeter' ? { measure: () => ({ totalTokens: 4321 }) } : undefined),
    } as unknown as Context
    const { c, log } = makeCtx({ ctx, agent: () => agentWithEvents([]) })
    runContext(c)

    expect(log.panels[0]?.lines[0]).toContain('4321')
  })
})

describe('/status', () => {
  it('summarises version, model, permissions and the plugin tree', async () => {
    const ctx = {
      registry: { forEach: (visit: (runtime: { name?: string }) => void) => {
        visit({ name: 'dsh-tools' })
        visit({ name: 'fx-tui' })
      } },
    } as unknown as Context
    const { c, log } = makeCtx({ ctx })
    await runStatus(c)

    const body = log.panels[0]?.lines.join('\n') ?? ''
    expect(log.panels[0]?.title).toBe('运行状态')
    expect(body).toContain('fx-tui v')
    expect(body).toContain('权限模式')
    expect(body).toContain('已加载插件（2）')
  })

  it('survives a registry that refuses to be walked', async () => {
    const ctx = {
      registry: { forEach: () => { throw new Error('locked') } },
    } as unknown as Context
    const { c, log } = makeCtx({ ctx })
    await runStatus(c)

    expect(log.panels[0]?.lines.join('\n')).toContain('已加载插件（0）')
  })
})
