import { describe, expect, it } from 'vitest'
import { ApprovalMemory } from './approval-memory.js'

describe('ApprovalMemory.key', () => {
  it('keys bash-shaped tools by the exact command string', () => {
    expect(ApprovalMemory.key('bash', '{"command":"git status"}')).toBe('bash:command:git status')
  })

  it('keys path-shaped tools by the path', () => {
    expect(ApprovalMemory.key('read', '{"path":"/a/b.txt"}')).toBe('read:path:/a/b.txt')
  })

  it('command takes precedence over path when both exist', () => {
    expect(ApprovalMemory.key('t', '{"command":"x","path":"y"}')).toBe('t:command:x')
  })

  it('falls back to the raw args for non-object payloads', () => {
    expect(ApprovalMemory.key('t', '')).toBe('t:')
    expect(ApprovalMemory.key('t', 'not json')).toBe('t:not json')
    expect(ApprovalMemory.key('t', '{"command":123,"path":null}')).toBe('t:{"command":123,"path":null}')
  })
})
