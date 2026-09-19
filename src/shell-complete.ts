/**
 * Completion candidates for the `!` shell passthrough: PATH command names in
 * command position, real filesystem paths (with `~` expansion and directory
 * suffixes) elsewhere. A command name is whatever a readdir of each PATH
 * entry (plus the workspace's node_modules/.bin) yields — no per-candidate
 * executable-bit stat; a completion popup may safely over-offer.
 */

import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export interface ShellWord {
  /** Code-point index of the word start inside the line. */
  readonly start: number
  /** The partial word text up to the cursor. */
  readonly query: string
  /** True when the word sits in command position (no shell text before it). */
  readonly command: boolean
}

/** Word under the cursor of a `!`-prefixed line; undefined when the line is
 * not a bang gesture or the cursor sits inside the `!`/`!!` prefix itself. */
export function shellWordAt(text: string, col: number): ShellWord | undefined {
  if (!text.startsWith('!')) return undefined
  const bang = text.startsWith('!!') ? 2 : 1
  if (col < bang) return undefined
  const chars = Array.from(text)
  const before = chars.slice(bang, col)
  let ws = -1
  for (let i = before.length - 1; i >= 0; i--) {
    const ch = before[i]
    if (ch === ' ' || ch === '\t') {
      ws = i
      break
    }
  }
  const start = bang + ws + 1
  const query = chars.slice(start, col).join('')
  const command = before.slice(0, ws + 1).join('').trim() === ''
  return { start, query, command }
}

/** True when the partial word addresses a path rather than a bare command
 * name — `./bin/x`, `node_modules/.bin/vit`, `~/.`, `/usr/lo`. */
export function isPathLikeWord(query: string): boolean {
  return query.includes('/') || query.startsWith('.') || query.startsWith('~')
}

// -- Command names ----------------------------------------------------------

const COMMANDS_TTL_MS = 30_000
let commandsCache: { key: string; at: number; names: string[] } | null = null

/** Every name found in the PATH entries plus the workspace's
 * node_modules/.bin, sorted; cached briefly per PATH+cwd. */
export async function listPathCommands(
  opts: { pathEnv?: string; cwd?: string } = {},
): Promise<readonly string[]> {
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? ''
  const cwd = opts.cwd ?? process.cwd()
  const key = `${pathEnv}\u0000${cwd}`
  if (commandsCache !== null && commandsCache.key === key && Date.now() - commandsCache.at < COMMANDS_TTL_MS) {
    return commandsCache.names
  }
  const dirs = [...pathEnv.split(':').filter(dir => dir !== ''), join(cwd, 'node_modules', '.bin')]
  const names = new Set<string>()
  await Promise.all(dirs.map(async dir => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // unreadable or missing PATH entry: skip
    }
    for (const entry of entries) {
      if (entry.isFile() || entry.isSymbolicLink()) names.add(entry.name)
    }
  }))
  const sorted = [...names].toSorted()
  commandsCache = { key, at: Date.now(), names: sorted }
  return sorted
}

/** Command-name candidates for a partial first word: shell-style prefix
 * match, alphabetical. */
export function completeShellCommand(query: string, names: readonly string[], limit = 50): readonly string[] {
  const matches: string[] = []
  for (const name of names) {
    if (name.startsWith(query)) {
      matches.push(name)
      if (matches.length >= limit) break
    }
  }
  return matches
}

// -- Filesystem paths ---------------------------------------------------------

export interface ShellPathMatch {
  readonly label: string
  readonly directory: boolean
}

/** Real-filesystem candidates for a partial path word: one readdir of the
 * word's directory part, prefix-filtered on the basename, directories marked
 * with a trailing `/`. `~` expands to `home` for the directory READ only —
 * labels keep the text the user typed, so completion never rewrites `~/`
 * into an absolute path. */
export async function completeShellPath(
  query: string,
  cwd: string,
  opts: { limit?: number; home?: string } = {},
): Promise<readonly ShellPathMatch[]> {
  // Split the typed word into the directory reference (kept verbatim for
  // labels) and the partial basename (the filter). A bare `~` names the home
  // directory itself, so it becomes the dir part, not the filter.
  let dirRef = ''
  let rest = query
  const slash = query.lastIndexOf('/')
  if (slash >= 0) {
    dirRef = query.slice(0, slash + 1)
    rest = query.slice(slash + 1)
  } else if (query === '~') {
    dirRef = '~/'
    rest = ''
  }
  const expandedDir = dirRef === ''
    ? cwd
    : dirRef.startsWith('~')
      ? dirRef.replace(/^~/u, opts.home ?? homedir())
      : isAbsolute(dirRef) ? dirRef : resolve(cwd, dirRef)
  let entries
  try {
    entries = await readdir(expandedDir, { withFileTypes: true })
  } catch {
    return [] // nonexistent or unreadable directory: no candidates
  }
  const matches: ShellPathMatch[] = []
  for (const entry of entries) {
    if (!entry.name.startsWith(rest)) continue
    const directory = entry.isDirectory()
    matches.push({ label: `${dirRef}${entry.name}${directory ? '/' : ''}`, directory })
  }
  matches.sort((a, b) => (a.directory === b.directory ? a.label.localeCompare(b.label) : a.directory ? -1 : 1))
  return matches.slice(0, opts.limit ?? 60)
}

/** Quote a completed word for the shell when it carries characters the shell
 * would otherwise split or glob (POSIX single quotes; embedded quotes are
 * escaped the standard `'\''` way). */
export function quoteShellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`
}
