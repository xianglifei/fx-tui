/**
 * Terminal file-drop and slash-command path parsing.
 *
 * Dropping a file onto a terminal window makes the terminal paste that file's
 * path at the cursor — single- or double-quoted when it contains whitespace,
 * backslash-escaped, occasionally as a file:// URI, and possibly several
 * space-separated paths at once. These pure helpers recover clean absolute
 * paths from such chunks; they are shared by the drop-to-attach input shortcut
 * and the `/image` command's argument parsing.
 *
 * @module path-drops
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, isAbsolute, resolve } from 'node:path'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** Extensions the harness attachment pipeline accepts, keyed lowercase. */
export const IMAGE_MEDIA_TYPES: Record<string, ImageMediaType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** Media type of a path's extension, or undefined for unsupported formats. */
export function imageMediaTypeOf(path: string): ImageMediaType | undefined {
  return IMAGE_MEDIA_TYPES[extname(path).toLowerCase()]
}

/** Expand `~` and `~/…`, and anchor relative paths at the working directory. */
export function expandPath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2))
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

/** An image-format path (by extension) that also exists on disk. */
export function isExistingImagePath(path: string): boolean {
  return imageMediaTypeOf(path) !== undefined && existsSync(path)
}

/** Parse a pasted/dropped chunk into expanded absolute paths plus a strict
 * "every token is an image" verdict used by the drop-to-attach gate. */
export function parsePathChunk(text: string): { paths: string[]; allImages: boolean } {
  const paths = tokenizePathList(text)
    .filter(path => path !== '')
    .map(expandPath)
  const allImages = paths.length > 0 && paths.every(path => imageMediaTypeOf(path) !== undefined)
  return { paths, allImages }
}

/**
 * Shell-lite splitter: whitespace-separated tokens honoring single/double
 * quotes and backslash escapes (`'my shot.png'`, `"a b.png"`, `my\ shot.png`).
 * Unterminated quotes fold their tail into the open token rather than losing
 * it; inside double quotes only `\"` and `\\` count as escapes — like most
 * shells — which keeps Windows drive-letter backslashes intact when the
 * terminal wraps the path in quotes.
 */
export function tokenizePathList(text: string): string[] {
  const tokens: string[] = []
  let current = ''
  let building = false
  let quote: "'" | '"' | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? ''
    if (quote !== null) {
      if (ch === quote) {
        quote = null
        continue
      }
      if (ch === '\\' && quote === '"') {
        const next = text[i + 1]
        if (next === '"' || next === '\\') {
          current += next
          i++
          continue
        }
      }
      current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      building = true
      continue
    }
    if (ch === '\\') {
      current += text[i + 1] ?? ''
      i++
      building = true
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (building) tokens.push(current)
      current = ''
      building = false
      continue
    }
    current += ch
    building = true
  }
  if (building) tokens.push(current)
  return tokens.map(decodeLocalUri)
}

/** `file:///abs/path` URIs → filesystem paths, percent-decoded; non-URIs pass through. */
function decodeLocalUri(token: string): string {
  if (!token.startsWith('file://')) return token
  let body = token.slice('file://'.length)
  if (!body.startsWith('/')) {
    const separator = body.indexOf('/')
    if (separator < 0) return token // opaque host without a path; leave verbatim
    body = body.slice(separator)
  }
  try {
    return decodeURIComponent(body)
  } catch {
    return body
  }
}
