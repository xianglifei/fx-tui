import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandPath, imageMediaTypeOf, isExistingImagePath, parsePathChunk, tokenizePathList } from './path-drops.js'

describe('tokenizePathList', () => {
  it('splits on whitespace', () => {
    expect(tokenizePathList('/a.png /b.png')).toEqual(['/a.png', '/b.png'])
    expect(tokenizePathList('/a.png\n/b.png\t/c.png')).toEqual(['/a.png', '/b.png', '/c.png'])
  })

  it('keeps quoted spaces intact', () => {
    expect(tokenizePathList("'/my shot.png'")).toEqual(['/my shot.png'])
    expect(tokenizePathList('"/a b.png" /c.png')).toEqual(['/a b.png', '/c.png'])
  })

  it('honors backslash escapes and double-quote escapes', () => {
    expect(tokenizePathList('my\\ shot.png')).toEqual(['my shot.png'])
    expect(tokenizePathList('"/a\\"b.png"')).toEqual(['/a"b.png'])
  })

  it('folds unterminated quotes into the open token', () => {
    expect(tokenizePathList("'/a b")).toEqual(['/a b'])
  })

  it('decodes file:// URIs, with or without a host', () => {
    expect(tokenizePathList('file:///Users/x/a%20b.png')).toEqual(['/Users/x/a b.png'])
    expect(tokenizePathList('file://localhost/Users/x/a.png')).toEqual(['/Users/x/a.png'])
  })

  it('returns nothing for empty input', () => {
    expect(tokenizePathList('')).toEqual([])
    expect(tokenizePathList('   ')).toEqual([])
  })
})

describe('expandPath', () => {
  it('expands ~ and ~/ and anchors relative paths at cwd', () => {
    expect(expandPath('~')).toBe(homedir())
    expect(expandPath('~/x.png')).toBe(join(homedir(), 'x.png'))
    expect(expandPath('/abs/x.png')).toBe('/abs/x.png')
    expect(expandPath('rel.png')).toBe(resolve(process.cwd(), 'rel.png'))
  })
})

describe('imageMediaTypeOf / isExistingImagePath', () => {
  it('maps extensions case-insensitively', () => {
    expect(imageMediaTypeOf('/a/x.png')).toBe('image/png')
    expect(imageMediaTypeOf('/a/x.PNG')).toBe('image/png')
    expect(imageMediaTypeOf('/a/x.webp')).toBe('image/webp')
    expect(imageMediaTypeOf('/a/x.txt')).toBeUndefined()
  })

  it('requires the file to exist', () => {
    expect(isExistingImagePath('/definitely/not/here/x.png')).toBe(false)
    const dir = mkdtempSync(join(tmpdir(), 'fx-tui-test-'))
    try {
      const p = join(dir, 'x.png')
      writeFileSync(p, 'x')
      expect(isExistingImagePath(p)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('parsePathChunk', () => {
  it('verdicts all-images chunks', () => {
    expect(parsePathChunk('/a.png /b.jpg')).toEqual({ paths: ['/a.png', '/b.jpg'], allImages: true })
    expect(parsePathChunk('a.txt b.png')).toEqual({ paths: [resolve(process.cwd(), 'a.txt'), resolve(process.cwd(), 'b.png')], allImages: false })
    expect(parsePathChunk('')).toEqual({ paths: [], allImages: false })
  })
})
