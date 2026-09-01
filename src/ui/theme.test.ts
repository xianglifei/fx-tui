import { describe, expect, it } from 'vitest'
import { contrastRatio, hexLuminance, isThemeSetting, resolveTheme } from './theme.js'

describe('hexLuminance', () => {
  it('pins black to 0 and white to 1', () => {
    expect(hexLuminance('#000000')).toBe(0)
    expect(hexLuminance('#ffffff')).toBe(1)
  })

  it('maps mid-gray into the expected sRGB range', () => {
    expect(hexLuminance('#808080')).toBeCloseTo(0.216, 2)
  })
})

describe('contrastRatio', () => {
  it('black vs white is the 21:1 ceiling, symmetric', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBe(21)
    expect(contrastRatio('#ffffff', '#000000')).toBe(21)
  })

  it('a color against itself is 1', () => {
    expect(contrastRatio('#67e8f9', '#67e8f9')).toBe(1)
  })
})

describe('resolveTheme', () => {
  it('explicit choices win over detection', () => {
    expect(resolveTheme('light', 'dark')).toBe('light')
    expect(resolveTheme('nord', 'light')).toBe('nord')
  })

  it('auto follows detection and falls back to light', () => {
    expect(resolveTheme('auto', 'dark')).toBe('dark')
    expect(resolveTheme('auto', null)).toBe('light')
  })
})

describe('isThemeSetting', () => {
  it('accepts built-ins and Ghostty ids, rejects everything else', () => {
    expect(isThemeSetting('auto')).toBe(true)
    expect(isThemeSetting('light')).toBe(true)
    expect(isThemeSetting('dark')).toBe(true)
    expect(isThemeSetting('nord')).toBe(true)
    expect(isThemeSetting('catppuccin-mocha')).toBe(true)
    expect(isThemeSetting('nope')).toBe(false)
    expect(isThemeSetting(42)).toBe(false)
    expect(isThemeSetting(null)).toBe(false)
  })
})
