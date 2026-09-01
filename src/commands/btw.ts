/** /btw: a side question over the live conversation surface. */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { renderMarkdownLines } from '../markdown.js'
import { truncateLine } from '../ui/estimate.js'
import type { CommandCtx } from './types.js'

let btwController: AbortController | null = null

/** `/btw <question>`: one no-tools model call over the current conversation
 * surface. It never touches the session log (no history, no token meter),
 * never interrupts the main turn, and supersedes any in-flight side ask.
 * Guarded to idle turns only: deriveMessages() mid-turn would snapshot a
 * half-streamed message surface. */
export async function runBtw(c: CommandCtx, question: string): Promise<void> {
  const trimmed = question.trim()
  if (trimmed === '') {
    c.store.addNotice('用法：/btw <问题>（复用当前上下文的单轮侧问，不打断主任务、不写入会话）', 'warn')
    return
  }
  if (c.store.getSnapshot().phase !== 'idle') {
    c.store.addNotice('侧问需要在回合结束时使用（运行中的回合消息面还不完整）', 'warn')
    return
  }
  if (btwController !== null) btwController.abort()
  const controller = new AbortController()
  btwController = controller
  c.store.addNotice(`侧问中（不打断主任务）：${truncateLine(trimmed, 50)}`)
  try {
    const route = c.selectionRef.current ?? c.selection
    const message = createUserMessage({
      content: [{ type: 'text', text: `（侧问，请直接简要回答）${trimmed}` }],
      source: { kind: 'user' },
    })
    const chunks = c.ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {}),
      messages: [...c.agent().session.deriveMessages(), message],
      signal: controller.signal,
    })
    let answer = ''
    let failure = ''
    for await (const chunk of chunks) {
      if (chunk.type === 'text-delta') answer += chunk.text
      else if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error') failure = '模型返回错误'
        else if (chunk.reason.kind === 'aborted') failure = '已中止'
      }
    }
    if (controller.signal.aborted) return // superseded by a newer side ask
    if (failure !== '') {
      c.store.addNotice(`侧问失败：${failure}`, 'error')
      return
    }
    if (answer.trim() === '') {
      c.store.addNotice('侧问没有返回内容', 'warn')
      return
    }
    const width = Math.max(24, (process.stdout.columns ?? 80) - 6)
    c.store.addPanel(`侧问：${trimmed}`, [
      '',
      ...renderMarkdownLines(answer, width),
      '',
      '（侧问不写入会话历史，也不计入 token 统计）',
    ])
  } catch (error) {
    if (controller.signal.aborted) return
    c.store.addNotice(`侧问失败：${error instanceof Error ? error.message : String(error)}`, 'error')
  } finally {
    if (btwController === controller) btwController = null
  }
}
