import { unzipSync, type Unzipped } from 'fflate'
import { DOMParser } from '@xmldom/xmldom'
import { dirname, posix } from 'node:path'

const NS = {
  CONTAINER: 'urn:oasis:names:tc:opendocument:xmlns:container',
  OPF: 'http://www.idpf.org/2007/opf',
  DC: 'http://purl.org/dc/elements/1.1/',
}

export interface EpubMeta {
  title?: string
  author?: string
  language?: string
  identifier?: string
  cover?: { data: Uint8Array; mediaType: string }
}

const parse = (bytes: Uint8Array) =>
  new DOMParser().parseFromString(Buffer.from(bytes).toString('utf8'), 'text/xml')

/** Unzip only what we ask for — EPUBs carry a lot we don't need. */
const entry = (zip: Unzipped, name: string) => zip[name]

const textOf = (doc: any, ns: string, tag: string): string | undefined => {
  const el = doc.getElementsByTagNameNS(ns, tag)[0]
  const text = el?.textContent?.trim()
  return text || undefined
}

/**
 * Locate the cover image. EPUB 3 marks it with properties="cover-image";
 * EPUB 2 points at a manifest id via <meta name="cover">. Plenty of files in
 * the wild do neither, so fall back to an id/href that looks like a cover.
 */
function findCoverHref(opf: any): string | undefined {
  const items = [...opf.getElementsByTagNameNS(NS.OPF, 'item')]

  const byProperties = items.find((i: any) =>
    i.getAttribute('properties')?.split(/\s+/).includes('cover-image'))
  if (byProperties) return byProperties.getAttribute('href')

  const metaCover = [...opf.getElementsByTagNameNS(NS.OPF, 'meta')]
    .find((m: any) => m.getAttribute('name') === 'cover')
    ?.getAttribute('content')
  if (metaCover) {
    const item = items.find((i: any) => i.getAttribute('id') === metaCover)
    if (item) return item.getAttribute('href')
  }

  return items.find((i: any) =>
    i.getAttribute('media-type')?.startsWith('image/')
    && /cover/i.test((i.getAttribute('id') ?? '') + (i.getAttribute('href') ?? '')),
  )?.getAttribute('href')
}

export function readEpubMeta(bytes: Uint8Array): EpubMeta {
  // container.xml is the only entry whose path the spec fixes.
  const container = unzipSync(bytes, { filter: f => f.name === 'META-INF/container.xml' })
  const containerXml = entry(container, 'META-INF/container.xml')
  if (!containerXml) throw new Error('not an EPUB: META-INF/container.xml missing')

  const opfPath = parse(containerXml)
    .getElementsByTagNameNS(NS.CONTAINER, 'rootfile')[0]
    ?.getAttribute('full-path')
  if (!opfPath) throw new Error('container.xml has no rootfile')

  const opfZip = unzipSync(bytes, { filter: f => f.name === opfPath })
  const opfBytes = entry(opfZip, opfPath)
  if (!opfBytes) throw new Error(`OPF not found at ${opfPath}`)
  const opf = parse(opfBytes)

  const meta: EpubMeta = {
    title: textOf(opf, NS.DC, 'title'),
    author: textOf(opf, NS.DC, 'creator'),
    language: textOf(opf, NS.DC, 'language'),
    identifier: textOf(opf, NS.DC, 'identifier'),
  }

  const coverHref = findCoverHref(opf)
  if (coverHref) {
    // Manifest hrefs are relative to the OPF, which is rarely at the zip root.
    const base = dirname(opfPath)
    const coverPath = posix.normalize(
      base === '.' ? coverHref : posix.join(base, decodeURIComponent(coverHref)))
    const coverZip = unzipSync(bytes, { filter: f => f.name === coverPath })
    const data = entry(coverZip, coverPath)
    if (data) {
      const item = [...opf.getElementsByTagNameNS(NS.OPF, 'item')]
        .find((i: any) => i.getAttribute('href') === coverHref)
      meta.cover = {
        data,
        mediaType: item?.getAttribute('media-type') ?? 'application/octet-stream',
      }
    }
  }

  return meta
}
