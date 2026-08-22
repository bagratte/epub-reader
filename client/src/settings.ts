export type ThemeName = 'auto' | 'light' | 'sepia' | 'dark'
export type FlowMode = 'paginated' | 'scrolled'
export type FontChoice = 'default' | 'serif' | 'sans'

export interface Settings {
  theme: ThemeName
  flow: FlowMode
  font: FontChoice
  /** Percent of the browser's default body size. */
  fontSize: number
  lineHeight: number
  /**
   * Top and bottom margin in px. foliate's `margin` attribute feeds only the
   * paginator's grid-template-rows, so it is vertical alone.
   */
  margin: number
  /**
   * Left and right margin, as a percent of the view — foliate's `gap`, which
   * is both the outer horizontal padding and the space between columns.
   */
  gap: number
  maxColumns: 1 | 2
  justify: boolean
  hyphenate: boolean
  /**
   * Image treatment, dark theme only — a white plate on a dark page is a
   * torch, and these three are the knobs for taming it. Percentages, so the
   * readout has something to show and the CSS can take them verbatim.
   */
  imageBrightness: number
  imageOpacity: number
  /**
   * Naive: every image, no questions asked. Right for a book of diagrams,
   * wrong for a book of photographs, and nothing in CSS can tell them apart —
   * so it is a choice the reader makes, not one we make for them.
   */
  invertImages: boolean
}

export const DEFAULTS: Settings = {
  theme: 'auto',
  flow: 'scrolled',
  font: 'default',
  fontSize: 100,
  lineHeight: 1.5,
  margin: 48,
  gap: 6,
  maxColumns: 2,
  justify: true,
  hyphenate: true,
  imageBrightness: 75,
  imageOpacity: 90,
  invertImages: false,
}

export interface Palette {
  bg: string
  fg: string
  muted: string
  line: string
  accent: string
  raise: string
}

/**
 * One palette table drives both the app chrome and the book's own iframe, so a
 * theme can never half-apply. CSS gets these as custom properties; foliate gets
 * them as injected content CSS.
 */
export const PALETTES: Record<Exclude<ThemeName, 'auto'>, Palette> = {
  light: {
    bg: '#faf9f7', fg: '#1a1a1a', muted: '#8a8580',
    line: '#e4e0da', accent: '#9a5b2c', raise: 'rgba(0,0,0,0.12)',
  },
  sepia: {
    bg: '#f2e8d5', fg: '#463524', muted: '#8c7a60',
    line: '#e0d2b8', accent: '#a35f28', raise: 'rgba(70,53,36,0.16)',
  },
  dark: {
    bg: '#16151a', fg: '#e8e6e3', muted: '#7d7787',
    line: '#2a2833', accent: '#c98a52', raise: 'rgba(0,0,0,0.5)',
  },
}

const FONT_STACKS: Record<FontChoice, string> = {
  default: '',
  serif: 'Iowan Old Style, Palatino, Palatino Linotype, Georgia, serif',
  sans: 'system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif',
}

const KEY = 'reader.settings'

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    // Spread over defaults so a settings file written by an older build, or
    // hand-edited, can't leave a field undefined.
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    // Private mode, quota, whatever — the reader still works, it just forgets.
  }
}

const prefersDark = () =>
  matchMedia('(prefers-color-scheme: dark)').matches

export const resolveTheme = (theme: ThemeName): Exclude<ThemeName, 'auto'> =>
  theme === 'auto' ? (prefersDark() ? 'dark' : 'light') : theme

/** Paints the app chrome. The book's iframe is handled by `contentCSS`. */
export function applyTheme(settings: Settings) {
  const palette = PALETTES[resolveTheme(settings.theme)]
  const root = document.documentElement
  root.dataset.theme = resolveTheme(settings.theme)
  for (const [key, value] of Object.entries(palette)) {
    root.style.setProperty(`--${key}`, value)
  }
}

/** CSS injected into the book's document via foliate's `setStyles`. */
export function contentCSS(settings: Settings): string {
  const theme = resolveTheme(settings.theme)
  const palette = PALETTES[theme]
  const family = FONT_STACKS[settings.font]
  return `
    @namespace epub "http://www.idpf.org/2007/ops";

    html, body {
      color: ${palette.fg};
      background: ${palette.bg};
    }
    html {
      font-size: ${settings.fontSize}%;
    }

    /* A chosen face has to be !important, and has to reach every element.
       Calibre and its kin put font-family on a class — .p, .calibre — which
       outranks any element selector we can write, so the polite version of
       this rule silently did nothing on most books.
       'Book's own' injects none of it, which is what makes it a real third
       choice rather than a synonym for Serif. */
    ${family ? `
    * { font-family: ${family} !important; }
    pre, pre *, code, code *, kbd, samp, tt {
      font-family: ui-monospace, monospace !important;
    }` : ''}

    a:any-link { color: ${palette.accent}; }

    p, li, blockquote, dd {
      line-height: ${settings.lineHeight};
      text-align: ${settings.justify ? 'justify' : 'start'};
      -webkit-hyphens: ${settings.hyphenate ? 'auto' : 'manual'};
      hyphens: ${settings.hyphenate ? 'auto' : 'manual'};
      hanging-punctuation: allow-end last;
      widows: 2;
      orphans: 2;
    }

    /* Don't let the rule above override an explicit align attribute. */
    [align="left"] { text-align: left; }
    [align="right"] { text-align: right; }
    [align="center"] { text-align: center; }
    [align="justify"] { text-align: justify; }

    pre { white-space: pre-wrap !important; }

    /* Images, dark theme only. Brightness pulls the whole plate down; opacity
       blends it toward the page behind it, so white falls toward this theme's
       dark rather than toward a flat grey. Invert comes first in the filter
       chain so the dimming applies to the inverted result — hue-rotate puts
       the hues back, which matters for a coloured diagram and costs a
       greyscale one nothing. */
    ${theme === 'dark' ? `
    img, svg, video {
      filter: ${settings.invertImages ? 'invert(1) hue-rotate(180deg) ' : ''}brightness(${settings.imageBrightness}%);
      opacity: ${settings.imageOpacity}%;
    }` : ''}

    /* Footnotes are shown in a popover instead of interrupting the page. */
    aside[epub|type~="endnote"],
    aside[epub|type~="footnote"],
    aside[epub|type~="note"],
    aside[epub|type~="rearnote"] { display: none; }
  `
}
