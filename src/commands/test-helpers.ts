/**
 * Test doubles for the slash-command layer.
 *
 * Handlers receive a CommandCtx and never reach for runner-owned state
 * themselves, so a plain stub is enough to drive them: the real TuiStore
 * records what the user would see (notices / panels) through a recording
 * proxy, the kernel Context defaults to empty non-throwing seams a test can
 * override, and every lifecycle callback is counted instead of performed.
 *
 * Excluded from the build by tsconfig.json — nothing outside tests imports
 * this module.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ActiveQuestion } from '../question-bridge.js'
import { FxSettings } from '../settings.js'
import { TuiStore } from '../store.js'
import type { CommandCtx, ModelSelection } from './types.js'

const tempHomes: string[] = []

/** A throwaway $DSH_HOME so settings tests never touch the real one. */
export function tempDshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fx-tui-test-'))
  tempHomes.push(dir)
  return dir
}

/** Remove every home handed out by {@link tempDshHome}. */
export function cleanupTempHomes(): void {
  while (tempHomes.length > 0) {
    const dir = tempHomes.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
}

export interface CommandLog {
  readonly notices: string[]
  readonly panels: { title: string; lines: readonly string[] }[]
  readonly submitted: string[]
  readonly switched: string[]
  readonly savedSelections: ModelSelection[]
  exitCount: number
  editorCount: number
  remountCount: number
}

export interface CtxHarness {
  readonly c: CommandCtx
  readonly store: TuiStore
  readonly settings: FxSettings
  readonly agent: Agent
  readonly log: CommandLog
}

/** Build a CommandCtx whose every seam is inert and observable. */
export function makeCtx(overrides: Partial<CommandCtx> = {}): CtxHarness {
  const store = new TuiStore('s1', 'p/m')
  const settings = new FxSettings(tempDshHome())
  const log: CommandLog = {
    notices: [],
    panels: [],
    submitted: [],
    switched: [],
    savedSelections: [],
    exitCount: 0,
    editorCount: 0,
    remountCount: 0,
  }

  const recording = new Proxy(store, {
    get(target: TuiStore, prop: string | symbol): unknown {
      const value = Reflect.get(target, prop, target)
      if (prop === 'addNotice') {
        return (text: string, tone?: 'info' | 'error' | 'warn'): void => {
          log.notices.push(text)
          target.addNotice(text, tone)
        }
      }
      if (prop === 'addPanel') {
        return (title: string, lines: readonly string[]): void => {
          log.panels.push({ title, lines })
          target.addPanel(title, lines)
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as TuiStore

  const agent = {
    id: 'agent-1',
    session: {
      id: 's1',
      header: { cwd: process.cwd() },
      events: [],
      deriveMessages: () => [],
    },
    steer: () => {},
    followup: () => {},
  } as unknown as Agent

  const selection: ModelSelection = { provider: 'p', model: 'm' }

  const ctx = {
    commands: {
      list: (): readonly { name: string; description: string }[] => [],
      find: (): undefined => undefined,
      execute: async (): Promise<undefined> => undefined,
    },
    skills: {
      list: async (): Promise<readonly unknown[]> => [],
      get: async (): Promise<undefined> => undefined,
    },
    llm: {
      listProviders: (): readonly { id: string }[] => [],
      listModels: async (): Promise<readonly { id: string }[]> => [],
      resolveModelInfo: async (): Promise<{ reasoning?: unknown }> => ({}),
      stream: async function* (): AsyncGenerator<never> {},
    },
    attachments: { saveImages: async (): Promise<readonly never[]> => [] },
    sessionQuery: {
      listSessions: async (): Promise<readonly never[]> => [],
      readTitle: async (): Promise<undefined> => undefined,
      readTitleSnapshots: async (): Promise<readonly never[]> => [],
    },
    get: (): undefined => undefined,
    registry: { forEach: (): void => {} },
  } as unknown as Context

  const c: CommandCtx = {
    ctx,
    store: recording,
    agent: () => agent,
    settings,
    selectionRef: { current: selection } as ModelSelectionRef,
    selection,
    modelLabel: () => 'p/m',
    historyEntries: [],
    fxVersion: 'test',
    detectedTheme: () => null,
    dshVersion: () => '0.0.0-test',
    debugLog: () => {},
    submitMessage: (text: string): void => {
      log.submitted.push(text)
    },
    switchSession: async (sessionId: string): Promise<void> => {
      log.switched.push(sessionId)
    },
    openExternalEditor: async (): Promise<void> => {
      log.editorCount += 1
    },
    exit: async (): Promise<void> => {
      log.exitCount += 1
    },
    remountForThemeChange: async (): Promise<void> => {
      log.remountCount += 1
    },
    updating: () => false,
    setUpdating: () => {},
    saveDefaultSelection: async (sel: ModelSelection): Promise<void> => {
      log.savedSelections.push(sel)
    },
    ...overrides,
  }

  return { c, store, settings, agent, log }
}

/** Wait until a command has opened a question card, and return it. */
export async function awaitCard(store: TuiStore): Promise<ActiveQuestion> {
  for (let i = 0; i < 200; i++) {
    const question = store.getSnapshot().question
    if (question !== null) return question
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('no question card was opened')
}

/** Select an option by label in the picker the command just opened. */
export async function answerPick(store: TuiStore, label: string): Promise<void> {
  await awaitCard(store)
  store.toggleQuestionOption(label)
  store.confirmQuestion()
}

/** Dismiss the picker without choosing (Esc / skip). */
export async function skipPick(store: TuiStore): Promise<void> {
  await awaitCard(store)
  store.skipQuestion()
}

/** Drive the store out of idle so the busy guards engage. */
export function makeBusy(store: TuiStore): void {
  store.onEvent({ type: 'turn/start', data: {}, time: 0 } as unknown as SessionEvent)
}
