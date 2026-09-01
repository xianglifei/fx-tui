import { describe, expect, it } from 'vitest'
import { ApprovalBridge } from './approval-bridge.js'

const hooks = { commit: () => {}, addNotice: () => {} }

describe('ApprovalBridge', () => {
  it('resolves the answered choice and clears the prompt', async () => {
    const bridge = new ApprovalBridge(hooks)
    const pending = bridge.ask({ toolName: 'bash', reason: '', command: 'ls' })
    expect(bridge.current?.toolName).toBe('bash')
    bridge.answer('session')
    expect(await pending).toBe('session')
    expect(bridge.current).toBeNull()
  })

  it('cancel resolves fail-closed as reject', async () => {
    const bridge = new ApprovalBridge(hooks)
    const pending = bridge.ask({ toolName: 'bash', reason: '' })
    bridge.cancel()
    expect(await pending).toBe('reject')
    expect(bridge.current).toBeNull()
  })

  it('answers without a pending ask are no-ops', async () => {
    const bridge = new ApprovalBridge(hooks)
    bridge.answer('once')
    bridge.cancel()
    const pending = bridge.ask({ toolName: 't', reason: '' })
    bridge.cancel()
    expect(await pending).toBe('reject')
  })

  it('a second ask supersedes the pending prompt; the newest resolver answers', async () => {
    const bridge = new ApprovalBridge(hooks)
    // The superseded ask's promise can no longer settle — identical to the
    // store's pre-extraction behavior; per-agent approval waterfalls never
    // overlap asks, so the orphan case is unreachable in practice.
    bridge.ask({ toolName: 'a', reason: '' })
    const second = bridge.ask({ toolName: 'b', reason: '' })
    expect(bridge.current?.toolName).toBe('b')
    bridge.answer('once')
    expect(await second).toBe('once')
    expect(bridge.current).toBeNull()
  })
})
