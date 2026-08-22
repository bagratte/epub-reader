import { DEFAULTS, resolveTheme, type Settings } from '../settings.ts'

type Change = (patch: Partial<Settings>) => void

/**
 * Type controls. This is the one panel worth spending detail on — everything
 * here changes how the book reads, so each control shows its current value
 * rather than hiding it behind an icon.
 */
export class DisplayPanel {
  #root: HTMLElement
  #onChange: Change
  #settings: Settings

  constructor(root: HTMLElement, settings: Settings, onChange: Change) {
    this.#root = root
    this.#settings = settings
    this.#onChange = onChange
    this.#build()
  }

  get isOpen() { return !this.#root.hidden }
  open() { this.#root.hidden = false }
  close() { this.#root.hidden = true }
  toggle() { this.isOpen ? this.close() : this.open() }

  update(settings: Settings) {
    this.#settings = settings
    this.#sync()
  }

  #emit(patch: Partial<Settings>) {
    this.#settings = { ...this.#settings, ...patch }
    this.#onChange(patch)
    this.#sync()
  }

  #sync() {
    for (const button of this.#root.querySelectorAll<HTMLButtonElement>('[data-key]')) {
      const key = button.dataset.key as keyof Settings
      button.setAttribute(
        'aria-pressed',
        String(String(this.#settings[key]) === button.dataset.value),
      )
    }
    // The image controls only do anything in dark, where a bright plate is a
    // problem; showing them under a light theme would be three dead rows.
    const dark = resolveTheme(this.#settings.theme) === 'dark'
    for (const row of this.#root.querySelectorAll<HTMLElement>('[data-dark-only]')) {
      row.hidden = !dark
    }
    for (const out of this.#root.querySelectorAll<HTMLElement>('[data-readout]')) {
      const key = out.dataset.readout as keyof Settings
      out.textContent = out.dataset.suffix
        ? `${this.#settings[key]}${out.dataset.suffix}`
        : String(this.#settings[key])
    }
  }

  #group(label: string, key: keyof Settings, options: [string, string][]) {
    const row = document.createElement('div')
    row.className = 'setting'
    row.innerHTML = `<span class="setting-label">${label}</span>`
    const choices = document.createElement('div')
    choices.className = 'choices'
    for (const [value, text] of options) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = text
      button.dataset.key = key
      button.dataset.value = value
      button.addEventListener('click', () => {
        const parsed = value === 'true' ? true : value === 'false' ? false
          : /^\d+$/.test(value) ? Number(value) : value
        this.#emit({ [key]: parsed } as unknown as Partial<Settings>)
      })
      choices.append(button)
    }
    row.append(choices)
    return row
  }

  #stepper(label: string,
           key: 'fontSize' | 'lineHeight' | 'margin' | 'gap'
              | 'textBrightness' | 'imageBrightness' | 'imageOpacity',
           step: number, min: number, max: number, suffix = '') {
    const row = document.createElement('div')
    row.className = 'setting'
    row.innerHTML = `<span class="setting-label">${label}</span>`

    const controls = document.createElement('div')
    controls.className = 'stepper'
    const make = (text: string, delta: number, aria: string) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = text
      button.setAttribute('aria-label', `${aria} ${label.toLowerCase()}`)
      button.addEventListener('click', () => {
        // Round to the step to avoid 1.5000000000000002 from float addition.
        const next = Math.min(max, Math.max(min,
          Math.round((this.#settings[key] + delta) / step) * step))
        this.#emit({ [key]: next } as unknown as Partial<Settings>)
      })
      return button
    }
    const readout = document.createElement('span')
    readout.className = 'readout'
    readout.dataset.readout = key
    if (suffix) readout.dataset.suffix = suffix

    controls.append(make('−', -step, 'Decrease'), readout, make('+', step, 'Increase'))
    row.append(controls)
    return row
  }

  /** Marks a row for `#sync` to hide when the resolved theme is not dark. */
  #darkOnly(row: HTMLElement) {
    row.dataset.darkOnly = ''
    return row
  }

  #build() {
    const reset = document.createElement('button')
    reset.type = 'button'
    reset.className = 'reset'
    reset.textContent = 'Reset to defaults'
    reset.addEventListener('click', () => this.#emit({ ...DEFAULTS }))

    this.#root.replaceChildren(
      this.#group('Theme', 'theme', [
        ['auto', 'Auto'], ['light', 'Light'], ['sepia', 'Sepia'], ['dark', 'Dark'],
      ]),
      this.#darkOnly(this.#stepper('Text brightness', 'textBrightness', 5, 0, 100, '%')),
      this.#darkOnly(this.#stepper('Image brightness', 'imageBrightness', 5, 0, 100, '%')),
      this.#darkOnly(this.#stepper('Image opacity', 'imageOpacity', 5, 0, 100, '%')),
      this.#darkOnly(this.#group('Invert images', 'invertImages',
        [['true', 'On'], ['false', 'Off']])),
      this.#group('Typeface', 'font', [
        ['default', "Book's own"], ['serif', 'Serif'], ['sans', 'Sans'],
      ]),
      this.#stepper('Text size', 'fontSize', 10, 0, 240, '%'),
      this.#stepper('Line height', 'lineHeight', 0.1, 0, 2.4),
      this.#stepper('Vertical margins', 'margin', 8, 0, 160, 'px'),
      this.#stepper('Horizontal margins', 'gap', 1, 0, 25, '%'),
      this.#group('Layout', 'flow', [['paginated', 'Pages'], ['scrolled', 'Scroll']]),
      this.#group('Columns', 'maxColumns', [['1', 'One'], ['2', 'Up to two']]),
      this.#group('Justify', 'justify', [['true', 'On'], ['false', 'Off']]),
      this.#group('Hyphenate', 'hyphenate', [['true', 'On'], ['false', 'Off']]),
      reset,
    )
    this.#sync()
  }
}
