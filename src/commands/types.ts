/**
 * Dependency surface of the slash-command layer.
 *
 * Handlers live in the sibling modules and receive a CommandCtx per call —
 * they never reach for runner-owned state themselves: the live agent
 * binding, the persisted settings, and the lifecycle callbacks (session
 * switch, external editor, shutdown, theme remount) are injected here so
 * src/index.ts stays the only owner of process lifecycle and the terminal.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { FxSettings } from '../settings.js'
import type { TuiStore } from '../store.js'
import type { ThemeName } from '../ui/theme.js'

/** The model/route selection carried by {@link ModelSelectionRef.current}. */
export type ModelSelection = NonNullable<ModelSelectionRef['current']>

/** A fork's lineage, carried from a command to {@link CommandCtx.startSession}.
 *
 * `events` must satisfy the agent factory's seed contract: contiguous from
 * seq 0 and balanced — no open turn, no open step, no dangling tool call.
 * {@link isSeedable} is the check that establishes it. */
export interface SessionForkSeed {
  /** Session the events were sliced from; becomes the new session's parent. */
  readonly parentSession: string
  /** The balanced prefix to replay into the new session. */
  readonly events: readonly SessionEvent[]
}

/** One reasoning effort tier as reported by the provider adapter. */
export interface EffortTier {
  readonly id: ReasoningEffortId
  readonly name: string
  readonly description?: string
}

export interface CommandCtx {
  readonly ctx: Context
  readonly store: TuiStore
  /** Live agent binding — reassigned by session switches. */
  agent(): Agent
  /** Persisted startup defaults ($DSH_HOME/fx-tui-settings.json). */
  readonly settings: FxSettings
  /** Live model selection; mutating `.current` switches from the next step. */
  readonly selectionRef: ModelSelectionRef
  /** Startup selection (fallback while the ref holds nothing). */
  readonly selection: ModelSelection
  /** provider/model label of the live agent (picker titles, /status, /export). */
  modelLabel(): string
  /** Persisted input history entries (read-only view for /status). */
  readonly historyEntries: readonly string[]
  /** fx-tui display version (banner, /status, /update). */
  readonly fxVersion: string
  /** Terminal background tone detected at startup; null = undetermined. */
  detectedTheme(): ThemeName | null
  /** dsh kernel version ('' when unreadable). */
  dshVersion(): string
  /** fx-tui debug channel; a no-op without FX_TUI_DEBUG. */
  debugLog(label: string, data?: unknown): void
  /** Submit a plain user message (the /skill-name gesture passthrough). */
  submitMessage(text: string): void
  /** Runner-owned lifecycle operations. */
  switchSession(sessionId: string): Promise<void>
  /**
   * Start a brand-new session and adopt it, optionally forked from the live
   * one: no seed means an unrelated blank session; a seed replays that prefix
   * under the current model selection.
   *
   * Resolves with the new session id, or `undefined` after a failure the
   * runner has already reported — a successful start is deliberately silent so
   * the command can name what it just did ("回退 3 轮", not "已切换到会话").
   */
  startSession(seed: SessionForkSeed | undefined): Promise<string | undefined>
  openExternalEditor(): Promise<void>
  exit(): Promise<void>
  /** Full-replay remount that recolors the transcript after a theme switch. */
  remountForThemeChange(): Promise<void>
  /** /update busy flag, shared with the background auto-update pass. */
  updating(): boolean
  setUpdating(value: boolean): void
  /** Persist a selection as the startup default (best-effort). */
  saveDefaultSelection(sel: ModelSelection): Promise<void>
}
