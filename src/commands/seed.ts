/** Pure seed arithmetic for the session-lifecycle commands (/fork, /rewind,
 * /clear): which event-log prefixes the agent factory accepts as a fork seed,
 * and where the rewind points are.
 *
 * The factory's contract is the whole constraint behind this module: a seed
 * must be contiguous from seq 0, carry only lossless-JSON data, and contain
 * no open turn, no open step, and no dangling tool call. Checking that here
 * turns a factory rejection into a sentence the user can act on.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { blocksToTextOf, toolResultCallIdOf } from '../store.js'

/** Whether `events` is a prefix the agent factory would accept as a seed. */
export type SeedCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/** One user-authored turn — a rewind candidate. */
export interface UserTurn {
  /** seq of the `turn/start` that opened the turn; rewinding drops it and everything after. */
  readonly seq: number
  readonly time: number
  /** First line of the user's text, for the picker label. */
  readonly preview: string
}

/**
 * Whether `events` ends in a balanced state.
 *
 * The three brackets are tracked independently rather than nested: a turn may
 * legitimately close with no step at all (empty input, a rejected turn), and
 * event types this module does not know about are plugin-owned and skipped —
 * an unrecognized type is not evidence of an open bracket.
 */
export function isSeedable(events: readonly SessionEvent[]): SeedCheck {
  let turnOpen = false
  let stepOpen = false
  const openCalls = new Set<string>()
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        turnOpen = true
        break
      case 'turn/end':
        turnOpen = false
        break
      case 'step/start':
        stepOpen = true
        break
      case 'step/end':
        stepOpen = false
        break
      case 'tool/call':
        openCalls.add(event.data.callId)
        break
      case 'tool/result': {
        // Parallel tool calls interleave, so pairing is by callId, not by order.
        const callId = toolResultCallIdOf(event.data.message)
        if (callId === undefined || !openCalls.delete(callId)) {
          return { ok: false, reason: '存在没有对应调用的工具结果' }
        }
        break
      }
      default:
        break
    }
  }
  if (turnOpen) return { ok: false, reason: '最后一轮还没有结束' }
  if (stepOpen) return { ok: false, reason: '最后一个步骤还没有结束' }
  if (openCalls.size > 0) return { ok: false, reason: '还有工具调用没有返回结果' }
  return { ok: true }
}

/** The seed prefix ending at `boundary` (inclusive); seq equals the array
 * index, so any prefix is contiguous from seq 0. */
export function sliceThrough(events: readonly SessionEvent[], boundary: number): SessionEvent[] {
  return events.filter(event => event.seq <= boundary)
}

/** Every closed turn that carries a user message, oldest first. */
export function userTurns(events: readonly SessionEvent[]): UserTurn[] {
  const turns: UserTurn[] = []
  let open: { seq: number; time: number; preview: string } | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      open = { seq: event.seq, time: event.time, preview: '' }
    } else if (event.type === 'user/message' && event.data.source.kind === 'user' && open !== undefined && open.preview === '') {
      open = { ...open, preview: firstLine(blocksToTextOf(event.data.content)) }
    } else if (event.type === 'turn/end' && open !== undefined) {
      // Turns with no user text at all are not rewind targets: there is nothing
      // for the user to recognize them by.
      if (open.preview !== '') turns.push(open)
      open = undefined
    }
  }
  return turns
}

/** Whether truncating at `boundary` discards a compaction replace — rewinding
 * there revives the history the compaction had folded away, which is legal but
 * can push the context back over the window. */
export function dropsCompaction(events: readonly SessionEvent[], boundary: number): boolean {
  for (const event of events) {
    if (event.seq <= boundary) continue
    if (isReplace(event)) return true
  }
  return false
}

function isReplace(event: SessionEvent): boolean {
  if (event.type !== 'user/message' && event.type !== 'assistant/message' && event.type !== 'tool/result') return false
  const op = event.surfaceOp
  return op !== undefined && op !== 'append'
}

function firstLine(text: string): string {
  const line = text.trim().split('\n').find(candidate => candidate.trim() !== '') ?? ''
  return line.trim()
}
