/**
 * Approval waterfall bridge: one pending prompt at a time, answered from the
 * keyboard. Extracted from the store so the reducer and the React plumbing
 * stay separate — the store forwards to the bridge and surfaces `current`
 * in its snapshot. Cancel resolves fail-closed: a promise left pending would
 * hang the awaiting approval/request waterfall forever.
 */

/** Tool-approval prompt as rendered in the live region. */
export interface ApprovalPrompt {
  readonly seq: number
  readonly toolName: string
  readonly reason: string
  readonly command?: string
}

export type ApprovalChoice = 'once' | 'session' | 'always' | 'reject'

/** Shared callbacks a bridge uses to touch store state. */
export interface BridgeHooks {
  commit(): void
  addNotice(text: string, tone?: 'info' | 'error' | 'warn'): void
}

export class ApprovalBridge {
  private prompt: ApprovalPrompt | null = null
  private resolve: ((choice: ApprovalChoice) => void) | null = null
  private seq = 0

  constructor(private readonly hooks: BridgeHooks) {}

  get current(): ApprovalPrompt | null {
    return this.prompt
  }

  ask(req: { toolName: string; reason: string; command?: string }): Promise<ApprovalChoice> {
    return new Promise(resolve => {
      this.seq += 1
      this.prompt = { seq: this.seq, toolName: req.toolName, reason: req.reason, command: req.command }
      this.resolve = resolve
      this.hooks.commit()
    })
  }

  answer(choice: ApprovalChoice): void {
    if (this.resolve === null) return
    const resolve = this.resolve
    const toolName = this.prompt?.toolName ?? '(tool)'
    this.resolve = null
    this.prompt = null
    const label = choice === 'once' ? '已允许（本次）'
      : choice === 'session' ? '已允许（本会话内同类调用不再询问）'
        : choice === 'always' ? '已允许（已写入记忆，之后自动放行）'
          : '已拒绝'
    this.hooks.addNotice(`${label} ${toolName}`, choice === 'reject' ? 'warn' : 'info')
    resolve(choice)
  }

  /** Withdraw a pending approval prompt (request aborted upstream). Resolves
   * fail-closed: leaving the promise pending would hang the awaiting
   * approval/request waterfall forever. */
  cancel(): void {
    if (this.resolve === null) return
    const resolve = this.resolve
    const toolName = this.prompt?.toolName ?? '(tool)'
    this.resolve = null
    this.prompt = null
    this.hooks.addNotice(`审批请求已撤销，按拒绝处理：${toolName}`, 'warn')
    resolve('reject')
  }

  /** Fail-closed cleanup without a user-facing notice — for store reset and
   * dispose, where the transcript carrying the notice is discarded anyway. */
  cancelQuiet(): void {
    if (this.resolve === null) return
    const resolve = this.resolve
    this.resolve = null
    this.prompt = null
    resolve('reject')
  }
}
