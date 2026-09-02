/** Model commands: /model (provider/model picker) and /effort (reasoning
 * tiers). Both ride the same live selection ref — next request wins — and
 * persist through the default-model service. */

import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { truncateLine } from '../ui/estimate.js'
import type { CommandCtx, EffortTier, ModelSelection } from './types.js'
import { pick } from './pick.js'

export async function listModelChoices(c: CommandCtx): Promise<void> {
  const providers = c.ctx.llm.listProviders()
  if (providers.length === 0) {
    c.store.addNotice('没有已注册的模型 provider')
    return
  }
  const options: { label: string; description?: string }[] = []
  for (const provider of providers) {
    let models: readonly { id: string }[] = []
    try {
      models = await c.ctx.llm.listModels(provider.id)
    } catch { /* provider without a listing stays absent */ }
    for (const model of models) {
      options.push({ label: `${provider.id}/${model.id}` })
    }
  }
  if (options.length === 0) {
    c.store.addNotice('没有可列举的模型')
    return
  }
  const chosen = await pick(c, `切换模型（当前 ${c.modelLabel()}）`, options)
  if (chosen === undefined) return
  const [provider, ...rest] = chosen.split('/')
  const model = rest.join('/')
  if (provider === undefined || model === '') return
  c.selectionRef.current = { provider, model }
  c.store.setModel(`${provider}/${model}`)
  c.store.addNotice(`模型已切换为 ${provider}/${model}（下一步请求生效）`)
  await c.saveDefaultSelection({ provider, model })
}

/** `/effort`: picker over the model's adapter-owned effort tiers, or a
 * direct one-shot form (`/effort <id|name>`, `/effort status`). Switching
 * rides the same model-selection ref as /model — next request wins. */
export async function runEffort(c: CommandCtx, arg: string): Promise<void> {
  const current = c.selectionRef.current ?? c.selection
  let reasoning: { efforts: readonly EffortTier[]; defaultEffort?: ReasoningEffortId } | undefined
  try {
    const info = await c.ctx.llm.resolveModelInfo(current.provider, current.model)
    reasoning = info.reasoning
  } catch { /* route without reasoning metadata reports below */ }
  if (reasoning === undefined || reasoning.efforts.length === 0) {
    c.store.addNotice(`当前模型 ${current.provider}/${current.model} 没有可切换的推理强度档位`, 'warn')
    return
  }
  const active = current.reasoningEffort ?? reasoning.defaultEffort
  const activeName = reasoning.efforts.find(effort => effort.id === active)?.name ?? active ?? '(模型默认)'
  const raw = arg.trim()
  if (raw !== '' && raw.toLowerCase() !== 'status') {
    const key = raw.toLowerCase()
    const matched = reasoning.efforts.find(effort => effort.id.toLowerCase() === key || effort.name.toLowerCase() === key)
    if (matched === undefined) {
      c.store.addNotice(`未知档位：${raw}（可用：${reasoning.efforts.map(effort => effort.id).join(' / ')}）`, 'warn')
      return
    }
    applyEffort(c, current, matched.id, matched.name)
    return
  }
  if (raw.toLowerCase() === 'status') {
    c.store.addPanel('推理强度', [
      `当前：${activeName}${active === undefined ? '（未显式设置）' : ''}`,
      ...reasoning.efforts.map(effort =>
        `· ${effort.name}（${effort.id}${effort.id === active ? ' · 当前' : effort.id === reasoning?.defaultEffort ? ' · 默认' : ''}）${effort.description !== undefined ? ` — ${effort.description}` : ''}`),
    ])
    return
  }
  const chosen = await pick(c, `推理强度（当前 ${activeName}）`, reasoning.efforts.map(effort => ({
    label: effort.name,
    description: `${effort.id === active ? '当前' : effort.id === reasoning?.defaultEffort ? '默认' : effort.id}${effort.description !== undefined ? ` · ${truncateLine(effort.description, 26)}` : ''}`,
  })))
  if (chosen === undefined) return
  const effort = reasoning.efforts.find(tier => tier.name === chosen)
  if (effort !== undefined) applyEffort(c, current, effort.id, effort.name)
}

function applyEffort(c: CommandCtx, current: ModelSelection, effortId: ReasoningEffortId, name: string): void {
  c.selectionRef.current = { provider: current.provider, model: current.model, reasoningEffort: effortId }
  void c.saveDefaultSelection({ provider: current.provider, model: current.model, reasoningEffort: effortId })
  c.store.addNotice(`推理强度已切换为 ${name}（下一步请求生效，已存为启动默认）`)
}
