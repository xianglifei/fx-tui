import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME } from 'cli-highlight'
import { contrastRatio, hexLuminance, isThemeSetting, paletteFor, resolveTheme } from './theme.js'
import type { ThemeName } from './theme.js'
import { GHOSTTY_THEME_IDS, ghosttyThemeDef } from './ghostty-themes.js'

const ALL_THEME_NAMES: readonly ThemeName[] = ['light', 'dark', ...GHOSTTY_THEME_IDS]

const HEX_RE = /^#[0-9a-f]{6}$/i

describe('palette syntax groups', () => {
  it('every palette carries a full 9-role syntax group of hex colors', () => {
    for (const name of ALL_THEME_NAMES) {
      const syntax = paletteFor(name).syntax
      for (const [role, hex] of Object.entries(syntax)) {
        expect(HEX_RE.test(hex), `${name}.${role} = ${hex}`).toBe(true)
      }
    }
  })

  it('built-in dark uses VS Code Dark+, light uses VS Code Light+', () => {
    expect(paletteFor('dark').syntax.keyword).toBe('#569cd6')
    expect(paletteFor('dark').syntax.string).toBe('#ce9178')
    expect(paletteFor('light').syntax.keyword).toBe('#0000ff')
    expect(paletteFor('light').syntax.string).toBe('#a31515')
  })

  it('Ghostty syntax layers pass through their official editor palettes verbatim', () => {
    expect(paletteFor('catppuccin-mocha').syntax.string).toBe(ghosttyThemeDef('catppuccin-mocha').syntax.string)
    expect(paletteFor('catppuccin-mocha').syntax.string).toBe('#a6e3a1')
    // Dracula's signature: yellow strings, pink keywords, green functions.
    expect(paletteFor('dracula').syntax.string).toBe('#f1fa8c')
    expect(paletteFor('dracula').syntax.keyword).toBe('#ff79c6')
    expect(paletteFor('dracula').syntax.function).toBe('#50fa7b')
    expect(paletteFor('nord').syntax.keyword).toBe('#81a1c1')
  })

  it('every syntax role reads against its own theme background (Ghostty)', () => {
    // Sanity floor, not design authority: the palettes are verbatim editor
    // ports and soft ones (Rosé Pine Dawn's gold on cream) legitimately sit
    // near 2.0. The assertion catches transcription errors, which crater the
    // ratio far below anything an official palette ships.
    for (const id of GHOSTTY_THEME_IDS) {
      const def = ghosttyThemeDef(id)
      for (const [role, hex] of Object.entries(def.syntax)) {
        const ratio = contrastRatio(hex, def.background)
        expect(ratio, `${id}.${role} = ${hex} → ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(2.0)
      }
    }
  })

  it('highlight is built from the syntax group on every palette (no cli-highlight default left)', () => {
    for (const name of ALL_THEME_NAMES) {
      expect(paletteFor(name).highlight.keyword).not.toBe(DEFAULT_THEME.keyword)
      expect(paletteFor(name).highlight.string).not.toBe(DEFAULT_THEME.string)
    }
  })
})

describe('palette domains', () => {
  const darkGhostty = GHOSTTY_THEME_IDS.filter(id => hexLuminance(ghosttyThemeDef(id).background) <= 0.5)
  const lightGhostty = GHOSTTY_THEME_IDS.filter(id => hexLuminance(ghosttyThemeDef(id).background) > 0.5)

  it('Ghostty palettes pin the interface domain to the brand, by tone', () => {
    const darkBrand = paletteFor('dark')
    const lightBrand = paletteFor('light')
    for (const token of ['accent', 'warning', 'success', 'danger', 'info', 'approval', 'muted'] as const) {
      for (const id of darkGhostty) {
        expect(paletteFor(id)[token], `${id}.${token}`).toBe(darkBrand[token])
      }
      for (const id of lightGhostty) {
        expect(paletteFor(id)[token], `${id}.${token}`).toBe(lightBrand[token])
      }
    }
  })

  it('background-tinted tokens still lean on the theme background', () => {
    for (const id of GHOSTTY_THEME_IDS) {
      const def = ghosttyThemeDef(id)
      const pal = paletteFor(id)
      // The user bar and the selection are brand-hued mixes over the theme's
      // own background, so they still harmonize with the terminal.
      expect(pal.userBarBackground).not.toBe(paletteFor('dark').userBarBackground)
      expect(pal.userBarForeground).toBe(def.foreground)
      expect(HEX_RE.test(pal.selectedBg), `${id}.selectedBg = ${pal.selectedBg}`).toBe(true)
      expect(contrastRatio(pal.selectedBg, def.background), `${id} selection lift`).toBeGreaterThan(1.1)
    }
  })

  it('every palette defines the expanded interface and markdown tokens', () => {
    for (const name of ALL_THEME_NAMES) {
      const pal = paletteFor(name)
      expect(typeof pal.borderAccent).toBe('string')
      expect(typeof pal.borderMuted).toBe('string')
      expect(typeof pal.dim).toBe('function')
      for (const style of ['heading', 'codespan', 'link', 'linkUrl', 'image', 'codeBlockBorder', 'quote', 'quoteBorder', 'hr', 'listBullet'] as const) {
        expect(typeof pal.md[style], `${name}.md.${style}`).toBe('function')
      }
    }
  })
})

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
