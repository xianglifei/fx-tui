/**
 * User-questions waterfall bridge: a queue of question cards walked one at a
 * time, with the arrow-key/digit cursor model over a sliding visible window
 * and the plan-review one-press default. Extracted from the store; the store
 * forwards to the bridge and surfaces `current` in its snapshot.
 */

import type { AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { BridgeHooks } from './approval-bridge.js'

export interface ActiveQuestion {
  readonly item: AskUserQuestionItem
  readonly selected: readonly string[]
  readonly index: number
  readonly total: number
  /** Highlighted option (arrow-key channel); digits jump-select through the
   * visible window. Lives here — not in the view — because the estimator
   * budgets the visible option window and must agree with the render. */
  readonly cursor: number
  /** First visible option of the QUESTION_WINDOW sliding window. */
  readonly scroll: number
}

/** Options visible at once in a question card; a longer list scrolls through
 * this window instead of being capped (which used to strand /sessions at the
 * newest 9 and force /theme into 8-per-page pagination). */
export const QUESTION_WINDOW = 9

export class QuestionBridge {
  private queue: AskUserQuestionItem[] = []
  private answers: AskUserQuestionAnswerItem[] = []
  private active: ActiveQuestion | null = null
  private resolve: ((answer: AskUserQuestionAnswer) => void) | null = null

  constructor(private readonly hooks: BridgeHooks) {}

  get current(): ActiveQuestion | null {
    return this.active
  }

  ask(items: readonly AskUserQuestionItem[]): Promise<AskUserQuestionAnswer> {
    return new Promise(resolve => {
      this.queue = [...items]
      this.answers = []
      this.resolve = resolve
      this.advance()
    })
  }

  toggleOption(label: string): void {
    const active = this.active
    if (active === null) return
    const selected = active.item.multiSelect === true
      ? (active.selected.includes(label)
          ? active.selected.filter(l => l !== label)
          : [...active.selected, label])
      : [label]
    this.active = { ...active, selected }
    this.hooks.commit()
  }

  /** Move the option highlight one step (wraps around); the visible window
   * slides only when the cursor would leave it. */
  moveCursor(delta: 1 | -1): void {
    const active = this.active
    if (active === null) return
    const count = (active.item.options ?? []).length
    if (count === 0) return
    const cursor = ((active.cursor + delta) % count + count) % count
    this.place(cursor)
  }

  /** Point the highlight at an absolute option index (digit keys map to
   * positions within the visible window; the view resolves that mapping). */
  pointCursor(index: number): void {
    const active = this.active
    if (active === null) return
    const count = (active.item.options ?? []).length
    if (count === 0) return
    this.place(Math.min(Math.max(0, index), count - 1))
  }

  /** Confirm the option selection for the active question; a default label
   * (plan-review's approve option) applies when nothing is selected. */
  confirm(defaultLabel?: string): void {
    const active = this.active
    if (active === null) return
    const selected = active.selected.length > 0
      ? [...active.selected]
      : defaultLabel !== undefined ? [defaultLabel] : []
    if (selected.length === 0) return
    this.answers.push({ id: active.item.id, selected })
    this.advance()
  }

  /** Free-text answer for the active question (typed in the main input box). */
  submitFreeText(text: string): void {
    const active = this.active
    if (active === null) return
    const trimmed = text.trim()
    if (trimmed === '') return
    this.answers.push({ id: active.item.id, selected: [], custom: trimmed })
    this.advance()
  }

  /** Skip the active question with no selection. */
  skip(): void {
    const active = this.active
    if (active === null) return
    this.answers.push({ id: active.item.id, selected: [] })
    this.advance()
  }

  /** Withdraw the whole pending questionnaire (request aborted upstream). */
  cancel(): void {
    if (this.resolve === null) return
    const resolve = this.resolve
    this.resolve = null
    this.active = null
    this.queue = []
    this.answers = []
    this.hooks.commit()
    resolve({ answers: [] })
  }

  private advance(): void {
    const next = this.queue.shift()
    if (next === undefined) {
      const resolve = this.resolve
      this.resolve = null
      this.active = null
      this.hooks.commit()
      resolve?.({ answers: this.answers })
      return
    }
    // A plan review starts on its approve option so bare Enter approves —
    // the same one-press default the digit-era card had.
    const options = next.options ?? []
    const approveLabel = next.intent?.kind === 'plan-review' ? next.intent.approve : undefined
    const approveIndex = approveLabel !== undefined ? options.findIndex(option => option.label === approveLabel) : -1
    this.active = {
      item: next,
      selected: [],
      index: this.answers.length + 1,
      total: this.answers.length + 1 + this.queue.length,
      cursor: approveIndex >= 0 ? approveIndex : 0,
      scroll: 0,
    }
    this.hooks.commit()
  }

  private place(cursor: number): void {
    const active = this.active
    if (active === null) return
    const count = (active.item.options ?? []).length
    let scroll = Math.min(Math.max(0, active.scroll), Math.max(0, count - QUESTION_WINDOW))
    if (cursor < scroll) scroll = cursor
    if (cursor >= scroll + QUESTION_WINDOW) scroll = cursor - QUESTION_WINDOW + 1
    this.active = { ...active, cursor, scroll }
    this.hooks.commit()
  }
}
