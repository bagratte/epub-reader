/** Shared between client and server. Keep it free of runtime imports. */

export interface Book {
  /** sha256 of file content. Never derive this from the path — see CLAUDE.md. */
  id: string
  filename: string
  size: number
  title?: string
  author?: string
  language?: string
  hasCover: boolean
  /** Omitted when the book has never been opened. */
  progress?: ProgressSummary
}

export interface ProgressSummary {
  fraction: number
  furthest: number
  updatedAt: number
}

export interface Progress {
  bookId: string
  /** EPUB CFI from foliate-js's `relocate` event. */
  cfi: string
  /** 0..1 through the whole book. */
  fraction: number
  /** Monotonic high-water mark. */
  furthest: number
  /** Server-assigned epoch ms. Device clocks are not trusted. */
  updatedAt: number
  device?: string
}
