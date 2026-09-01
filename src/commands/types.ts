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
import type { FxSettings } from '../settings.js'
import type { TuiStore } from '../store.js'
import type { ThemeName } from '../ui/theme.js'

/** The model/route selection carried by {@link ModelSelectionRef.current}. */
export type ModelSelection = NonNullable<ModelSelectionRef['current']>

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
