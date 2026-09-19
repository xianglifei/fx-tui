import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildStatusSegments, clampCustomInterval, customCommandFirstLine, parseStatusLineItems, readGitBranch, StatusLineWatcher } from './statusline.js'
import type { StatusLineItemId } from './statusline.js'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fx-tui-statusline-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe('parseStatusLineItems', () => {
  it('falls back to the shipped default for anything that is not a list', () => {
    expect(parseStatusLineItems(undefined)).toEqual(['context', 'usage', 'effort'])
    expect(parseStatusLineItems('git')).toEqual(['context', 'usage', 'effort'])
    expect(parseStatusLineItems({})).toEqual(['context', 'usage', 'effort'])
  })

  it('keeps order, drops unknown ids and duplicates', () => {
    expect(parseStatusLineItems(['git', 'bogus', 'context', 'git'])).toEqual(['git', 'context'])
    expect(parseStatusLineItems([])).toEqual([])
  })
})

describe('readGitBranch', () => {
  it('reads the branch from a normal .git directory', () => {
    const cwd = tempDir()
    mkdirSync(join(cwd, '.git'))
    writeFileSync(join(cwd, '.git', 'HEAD'), 'ref: refs/heads/feat/statusline\n')
    expect(readGitBranch(cwd)).toBe('feat/statusline')
  })

  it('degrades a detached HEAD to the short sha', () => {
    const cwd = tempDir()
    mkdirSync(join(cwd, '.git'))
    writeFileSync(join(cwd, '.git', 'HEAD'), 'abc1234abcdef7890\n')
    expect(readGitBranch(cwd)).toBe('abc1234')
  })

  it('follows a worktree-style .git pointer file to its gitdir', () => {
    const cwd = tempDir()
    const gitdir = tempDir()
    writeFileSync(join(cwd, '.git'), `gitdir: ${gitdir}\n`)
    writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/work\n')
    expect(readGitBranch(cwd)).toBe('work')
  })

  it('returns null outside a repository', () => {
    expect(readGitBranch(tempDir())).toBeNull()
  })
})

describe('customCommandFirstLine', () => {
  it('takes the first non-empty line, trimmed', () => {
    expect(customCommandFirstLine('  hello out\nsecond\n')).toBe('hello out')
    expect(customCommandFirstLine('\n\n  \nvalue\n')).toBe('value')
    expect(customCommandFirstLine('')).toBe('')
  })
})

describe('clampCustomInterval', () => {
  it('clamps into 0..3600 and floors', () => {
    expect(clampCustomInterval(-5)).toBe(0)
    expect(clampCustomInterval(7.9)).toBe(7)
    expect(clampCustomInterval(9999)).toBe(3600)
  })
})

describe('buildStatusSegments', () => {
  const base = {
    contextTokens: 0,
    contextWindow: undefined,
    usage: '',
    effortLabel: '',
    model: 'p/m',
    gitBranch: '',
    customStatus: null,
    compacting: false,
  }

  it('hides every unavailable source', () => {
    expect(buildStatusSegments(['context', 'usage', 'effort', 'model', 'git', 'compaction', 'custom'], { ...base, model: '' })).toEqual([])
  })

  it('renders in configuration order', () => {
    const segments = buildStatusSegments(['git', 'context'], { ...base, contextTokens: 100, contextWindow: 1000, gitBranch: 'main' })
    expect(segments.map(segment => segment.text)).toEqual(['main', '上下文 10% (100/1.0k)'])
  })

  it('surfaces compaction only while it runs', () => {
    expect(buildStatusSegments(['compaction'], base)).toEqual([])
    const segments = buildStatusSegments(['compaction'], { ...base, compacting: true })
    expect(segments).toEqual([{ text: '压缩中', priority: 2, tone: 'warning' }])
  })

  it('keeps the shipped default rendering', () => {
    const segments = buildStatusSegments(['context', 'usage', 'effort'], {
      ...base,
      contextTokens: 100,
      contextWindow: 1000,
      usage: '↑1 ↓2',
      effortLabel: 'high',
    })
    expect(segments.map(segment => segment.text)).toEqual(['上下文 10% (100/1.0k)', '↑1 ↓2', '推理 high'])
    expect(segments.map(segment => segment.priority)).toEqual([3, 2, 1])
  })
})

describe('StatusLineWatcher', () => {
  interface Recording {
    gitBranch: string
    customStatus: string | null
  }

  function makeWatcher(items: StatusLineItemId[], command: { command: string; intervalSeconds?: number } | undefined, cwd = tempDir()): {
    watcher: StatusLineWatcher
    recording: Recording
    setItems(next: StatusLineItemId[]): void
    setCommand(next: { command: string; intervalSeconds?: number } | undefined): void
  } {
    const recording: Recording = { gitBranch: '', customStatus: null }
    let currentItems = items
    let currentCommand = command
    const watcher = new StatusLineWatcher({
      cwd,
      store: {
        setGitBranch: branch => { recording.gitBranch = branch },
        setCustomStatus: text => { recording.customStatus = text },
      },
      getItems: () => currentItems,
      getCustomCommand: () => currentCommand,
    })
    return {
      watcher,
      recording,
      setItems: next => { currentItems = next },
      setCommand: next => { currentCommand = next },
    }
  }

  async function waitFor(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('condition not reached')
  }

  const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

  it('runs the custom command and keeps the last value on failure', async () => {
    const harness = makeWatcher(['custom'], { command: 'printf "  live value\\nsecond line\\n"' })
    harness.watcher.start()
    await waitFor(() => harness.recording.customStatus === 'live value')
    harness.setCommand({ command: 'exit 3' })
    harness.watcher.refresh('turn-end')
    await sleep(200)
    expect(harness.recording.customStatus).toBe('live value')
    harness.watcher.dispose()
  })

  it('clears the cached output on a session switch before rerunning', async () => {
    const harness = makeWatcher(['custom'], { command: 'printf "v1\\n"' })
    harness.watcher.start()
    await waitFor(() => harness.recording.customStatus === 'v1')
    harness.setCommand({ command: 'printf "v2\\n"' })
    harness.watcher.refresh('session-switch')
    expect(harness.recording.customStatus).toBeNull()
    await waitFor(() => harness.recording.customStatus === 'v2')
    harness.watcher.dispose()
  })

  it('hides disabled sources immediately on applyConfig', async () => {
    const harness = makeWatcher(['git', 'custom'], { command: 'printf "x\\n"' })
    harness.watcher.start()
    await waitFor(() => harness.recording.customStatus !== null)
    harness.setItems([])
    harness.watcher.applyConfig()
    expect(harness.recording.customStatus).toBeNull()
    expect(harness.recording.gitBranch).toBe('')
    harness.watcher.dispose()
  })

  it('polls the git branch for the git item only', () => {
    const cwd = tempDir()
    const harness = makeWatcher(['git'], undefined, cwd)
    harness.watcher.start()
    expect(harness.recording.gitBranch).toBe('')
    mkdirSync(join(cwd, '.git'))
    writeFileSync(join(cwd, '.git', 'HEAD'), 'ref: refs/heads/dev\n')
    harness.watcher.refresh('manual')
    expect(harness.recording.gitBranch).toBe('dev')
    harness.setItems(['custom'])
    harness.watcher.applyConfig()
    expect(harness.recording.gitBranch).toBe('')
    harness.watcher.dispose()
  })
})
