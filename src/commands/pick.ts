/** Interactive single-choice picker reusing the question UI; resolves
 * undefined when skipped. Options render in a scrolling window, so lists
 * beyond nine no longer need slicing. */

import type { CommandCtx } from './types.js'

export async function pick(
  c: CommandCtx,
  title: string,
  options: readonly { label: string; description?: string }[],
): Promise<string | undefined> {
  if (options.length === 0) return undefined
  const answer = await c.store.askQuestions([{
    id: `fx-tui-pick-${Date.now()}`,
    question: title,
    options: options.map(option => ({
      label: option.label,
      ...(option.description !== undefined ? { description: option.description } : {}),
    })),
  }])
  return answer.answers[0]?.selected[0]
}
