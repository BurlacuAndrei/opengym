// GPX 1.1 Parser & Serializer (Issue #57).
//
// Self-contained, zero-dependency GPX 1.1 parser and serializer with lossless round-trip
// support for tracks (<trk><trkseg><trkpt>) and routes (<rte><rtept>), including
// elevation, ISO timestamps, and Garmin TrackPointExtension (heart rate & cadence).
//
// Conforms strictly to TopoGrafix GPX 1.1 schema and Garmin TrackPointExtension v1.

export const GPX_VERSION = '1.1'
export const GPX_XMLNS = 'http://www.topografix.com/GPX/1/1'
export const GPX_TPX_XMLNS = 'http://www.garmin.com/xmlschemas/TrackPointExtension/v1'

/* ----------------------------------------------------------------- XML Escaping ---- */

/**
 * Escape XML special characters in text and attribute values.
 */
export function escapeXML(str) {
  if (str == null) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Decode XML entities back to plain text.
 * Note: &amp; is replaced last to prevent double-unescaping.
 */
export function unescapeXML(str) {
  if (str == null) return ''
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}

/* ----------------------------------------------------------------- XML Parser ---- */

/**
 * Lightweight, zero-dependency, non-validating XML-to-DOM parser.
 * Handles XML declarations, comments, CDATA, namespaces, self-closing tags, and entity decoding.
 * Throws an Error on corrupt, malformed, or unclosed XML.
 */
function parseXMLToTree(xml) {
  if (xml == null || typeof xml !== 'string') {
    throw new Error('Invalid GPX: input must be a non-empty string')
  }
  const trimmed = xml.trim()
  if (!trimmed) {
    throw new Error('Invalid GPX: XML string is empty')
  }

  const rootNodes = []
  const stack = []
  let i = 0
  const len = trimmed.length

  while (i < len) {
    const nextLt = trimmed.indexOf('<', i)
    if (nextLt === -1) {
      const text = trimmed.slice(i).trim()
      if (text && stack.length > 0) {
        stack[stack.length - 1].children.push({ type: 'text', text: unescapeXML(text) })
      }
      break
    }

    if (nextLt > i) {
      const text = trimmed.slice(i, nextLt).trim()
      if (text && stack.length > 0) {
        stack[stack.length - 1].children.push({ type: 'text', text: unescapeXML(text) })
      }
    }

    i = nextLt

    // 1. Comment: <!-- ... -->
    if (trimmed.startsWith('<!--', i)) {
      const end = trimmed.indexOf('-->', i + 4)
      if (end === -1) throw new Error('Invalid GPX: unclosed comment')
      i = end + 3
      continue
    }

    // 2. CDATA: <![CDATA[ ... ]]>
    if (trimmed.startsWith('<![CDATA[', i)) {
      const end = trimmed.indexOf(']]>', i + 9)
      if (end === -1) throw new Error('Invalid GPX: unclosed CDATA')
      const cdata = trimmed.slice(i + 9, end)
      if (stack.length > 0) {
        stack[stack.length - 1].children.push({ type: 'text', text: cdata })
      }
      i = end + 3
      continue
    }

    // 3. DOCTYPE or declaration: <! ... >
    if (trimmed.startsWith('<!', i)) {
      const end = trimmed.indexOf('>', i + 2)
      if (end === -1) throw new Error('Invalid GPX: malformed declaration')
      i = end + 1
      continue
    }

    // 4. Processing Instruction: <? ... ?>
    if (trimmed.startsWith('<?', i)) {
      const end = trimmed.indexOf('?>', i + 2)
      if (end === -1) throw new Error('Invalid GPX: unclosed processing instruction')
      i = end + 2
      continue
    }

    // 5. Closing tag: </tag>
    if (trimmed.startsWith('</', i)) {
      const end = trimmed.indexOf('>', i + 2)
      if (end === -1) throw new Error('Invalid GPX: malformed closing tag')
      const closeTag = trimmed.slice(i + 2, end).trim()
      if (stack.length === 0) {
        throw new Error(`Invalid GPX: unexpected closing tag </${closeTag}>`)
      }
      const top = stack.pop()
      if (top.tag !== closeTag) {
        throw new Error(`Invalid GPX: mismatched closing tag </${closeTag}>, expected </${top.tag}>`)
      }
      i = end + 1
      continue
    }

    // 6. Opening or self-closing tag: <tag ...> or <tag ... />
    let endTag = -1
    let inQuote = null
    for (let j = i + 1; j < len; j++) {
      const ch = trimmed[j]
      if (inQuote) {
        if (ch === inQuote && trimmed[j - 1] !== '\\') inQuote = null
      } else if (ch === '"' || ch === "'") {
        inQuote = ch
      } else if (ch === '>') {
        endTag = j
        break
      }
    }
    if (endTag === -1) {
      throw new Error('Invalid GPX: unclosed tag')
    }

    const rawTag = trimmed.slice(i + 1, endTag).trim()
    const isSelfClosing = rawTag.endsWith('/')
    const tagContent = isSelfClosing ? rawTag.slice(0, -1).trim() : rawTag

    const match = tagContent.match(/^([^\s/>]+)([\s\S]*)$/)
    if (!match) {
      throw new Error(`Invalid GPX: invalid tag <${rawTag}>`)
    }
    const tagName = match[1]
    const attrs = {}
    const attrRegex = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g
    let m
    while ((m = attrRegex.exec(match[2])) !== null) {
      const val = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4])
      attrs[m[1]] = unescapeXML(val)
    }

    const node = { type: 'element', tag: tagName, attrs, children: [] }
    if (stack.length === 0) {
      rootNodes.push(node)
    } else {
      stack[stack.length - 1].children.push(node)
    }

    if (!isSelfClosing) {
      stack.push(node)
    }
    i = endTag + 1
  }

  if (stack.length > 0) {
    throw new Error(`Invalid GPX: unclosed tag <${stack[stack.length - 1].tag}>`)
  }

  return rootNodes
}

/**
 * Recursively collect text from text & element children.
 */
function getNodeText(node) {
  if (!node || !node.children) return ''
  let text = ''
  for (const child of node.children) {
    if (child.type === 'text') {
      text += child.text
    } else if (child.type === 'element') {
      text += getNodeText(child)
    }
  }
  return text.trim()
}

/**
 * Find first direct child element matching tag name (case-insensitive, optional namespace prefix).
 */
function findChild(node, name) {
  if (!node || !node.children) return null
  const target = name.toLowerCase()
  return node.children.find(
    c => c.type === 'element' && (c.tag.toLowerCase() === target || c.tag.toLowerCase().endsWith(':' + target))
  ) || null
}

/**
 * Find all direct child elements matching tag name.
 */
function findChildren(node, name) {
  if (!node || !node.children) return []
  const target = name.toLowerCase()
  return node.children.filter(
    c => c.type === 'element' && (c.tag.toLowerCase() === target || c.tag.toLowerCase().endsWith(':' + target))
  )
}

/**
 * Deep search for first descendant element matching any of the candidate tag names.
 */
function findDeepChild(node, names) {
  if (!node || !node.children) return null
  const list = Array.isArray(names) ? names : [names]
  for (const child of node.children) {
    if (child.type === 'element') {
      const lower = child.tag.toLowerCase()
      for (const name of list) {
        const target = name.toLowerCase()
        if (lower === target || lower.endsWith(':' + target)) return child
      }
      const deep = findDeepChild(child, list)
      if (deep) return deep
    }
  }
  return null
}

/* ----------------------------------------------------------------- Time Formatting ---- */

/**
 * Formats date/timestamp as ISO 8601 string or returns existing valid ISO string.
 */
function formatTime(val) {
  if (val == null) return null
  if (val instanceof Date) return val.toISOString()
  if (typeof val === 'number') {
    const ms = val >= 1000000000 && val <= 3000000000 ? val * 1000 : val
    return new Date(ms).toISOString()
  }
  if (typeof val === 'string') {
    const trimmed = val.trim()
    if (!trimmed) return null
    return trimmed
  }
  return null
}

/* ----------------------------------------------------------------- Point Parsing ---- */

/**
 * Parses coordinates, elevation, time, and heart rate / cadence extensions from a point node.
 */
function parsePointNode(ptNode) {
  const latStr = ptNode.attrs.lat ?? ptNode.attrs.latitude
  const lonStr = ptNode.attrs.lon ?? ptNode.attrs.lng ?? ptNode.attrs.longitude
  if (latStr == null || lonStr == null) return null

  const lat = parseFloat(latStr)
  const lon = parseFloat(lonStr)
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null

  const point = { lat, lon }

  // Elevation <ele>
  const eleNode = findChild(ptNode, 'ele')
  if (eleNode) {
    const eleText = getNodeText(eleNode)
    if (eleText !== '') {
      const ele = parseFloat(eleText)
      if (!Number.isNaN(ele)) point.ele = ele
    }
  }

  // Timestamp <time>
  const timeNode = findChild(ptNode, 'time')
  if (timeNode) {
    const timeText = getNodeText(timeNode)
    if (timeText !== '') point.time = timeText
  }

  // Heart Rate (<gpxtpx:hr>, <hr>, <heartrate>)
  const hrNode = findDeepChild(ptNode, ['hr', 'heartrate'])
  if (hrNode) {
    const hrVal = parseInt(getNodeText(hrNode), 10)
    if (!Number.isNaN(hrVal)) point.hr = hrVal
  }

  // Cadence (<gpxtpx:cad>, <cad>, <cadence>)
  const cadNode = findDeepChild(ptNode, ['cad', 'cadence'])
  if (cadNode) {
    const cadVal = parseInt(getNodeText(cadNode), 10)
    if (!Number.isNaN(cadVal)) point.cad = cadVal
  }

  return point
}

/* ----------------------------------------------------------------- Public API ---- */

/**
 * Parses a GPX 1.1 XML string into an object representation.
 * Supports tracks (<trk><trkseg><trkpt>), routes (<rte><rtept>), and waypoints (<wpt>).
 *
 * @param {string} xmlString - Valid GPX XML content
 * @returns {{ name: string, desc: string, points: Array<{ lat: number, lon: number, ele?: number, time?: string, hr?: number, cad?: number }>, creator: string }}
 * @throws {Error} When XML is empty, malformed, or missing the <gpx> root element.
 */
export function parseGPX(xmlString) {
  const nodes = parseXMLToTree(xmlString)
  const gpxNode = nodes.find(
    n => n.type === 'element' && (n.tag.toLowerCase() === 'gpx' || n.tag.toLowerCase().endsWith(':gpx'))
  )
  if (!gpxNode) {
    throw new Error('Invalid GPX: missing <gpx> root element')
  }

  const metaNode = findChild(gpxNode, 'metadata')
  const trks = findChildren(gpxNode, 'trk')
  const rtes = findChildren(gpxNode, 'rte')

  // Extract name: metadata -> first track -> first route
  let name = ''
  if (metaNode && findChild(metaNode, 'name')) {
    name = getNodeText(findChild(metaNode, 'name'))
  } else if (trks.length > 0 && findChild(trks[0], 'name')) {
    name = getNodeText(findChild(trks[0], 'name'))
  } else if (rtes.length > 0 && findChild(rtes[0], 'name')) {
    name = getNodeText(findChild(rtes[0], 'name'))
  }

  // Extract description: metadata -> first track -> first route
  let desc = ''
  if (metaNode && findChild(metaNode, 'desc')) {
    desc = getNodeText(findChild(metaNode, 'desc'))
  } else if (trks.length > 0 && findChild(trks[0], 'desc')) {
    desc = getNodeText(findChild(trks[0], 'desc'))
  } else if (rtes.length > 0 && findChild(rtes[0], 'desc')) {
    desc = getNodeText(findChild(rtes[0], 'desc'))
  }

  const creator = gpxNode.attrs.creator || ''
  const points = []

  // Extract points: tracks prioritized, then routes, then waypoints
  if (trks.length > 0) {
    for (const trk of trks) {
      const segs = findChildren(trk, 'trkseg')
      if (segs.length > 0) {
        for (const seg of segs) {
          for (const pt of findChildren(seg, 'trkpt')) {
            const p = parsePointNode(pt)
            if (p) points.push(p)
          }
        }
      } else {
        for (const pt of findChildren(trk, 'trkpt')) {
          const p = parsePointNode(pt)
          if (p) points.push(p)
        }
      }
    }
  } else if (rtes.length > 0) {
    for (const rte of rtes) {
      for (const pt of findChildren(rte, 'rtept')) {
        const p = parsePointNode(pt)
        if (p) points.push(p)
      }
    }
  } else {
    for (const wpt of findChildren(gpxNode, 'wpt')) {
      const p = parsePointNode(wpt)
      if (p) points.push(p)
    }
  }

  return { name, desc, points, creator }
}

/**
 * Serializes activity data to a valid GPX 1.1 XML string.
 * Strictly adheres to GPX 1.1 schema element ordering (<ele>, <time>, <extensions>).
 *
 * @param {Object} options
 * @param {string} [options.name=''] - Track or route name
 * @param {string} [options.desc=''] - Track or route description
 * @param {Array<Object>} [options.points=[]] - Array of points ({lat, lon, ele, time, hr, cad})
 * @param {string} [options.creator='OpenGym'] - Creator attribute
 * @param {('track'|'route')} [options.type='track'] - Whether to emit <trk> or <rte>
 * @param {string|Date|number} [options.time=null] - Top-level timestamp for metadata
 * @returns {string} Schema-compliant GPX 1.1 XML string
 */
export function serializeGPX({
  name = '',
  desc = '',
  points = [],
  creator = 'OpenGym',
  type = 'track',
  time = null
} = {}) {
  const safeCreator = creator || 'OpenGym'
  const isRoute = type === 'route'
  const tag = isRoute ? 'rte' : 'trk'
  const ptTag = isRoute ? 'rtept' : 'trkpt'

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${escapeXML(safeCreator)}" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd http://www.garmin.com/xmlschemas/TrackPointExtension/v1 http://www.garmin.com/xmlschemas/TrackPointExtensionv1.xsd">`
  ]

  // Metadata block (order: name, desc, time)
  const metaTime = time || (points && points.length > 0 ? points[0].time : null)
  const isoMetaTime = metaTime != null ? formatTime(metaTime) : null
  const hasMeta = Boolean(name || desc || isoMetaTime)

  if (hasMeta) {
    lines.push('  <metadata>')
    if (name) lines.push(`    <name>${escapeXML(name)}</name>`)
    if (desc) lines.push(`    <desc>${escapeXML(desc)}</desc>`)
    if (isoMetaTime) lines.push(`    <time>${isoMetaTime}</time>`)
    lines.push('  </metadata>')
  }

  lines.push(`  <${tag}>`)
  if (name) lines.push(`    <name>${escapeXML(name)}</name>`)
  if (desc) lines.push(`    <desc>${escapeXML(desc)}</desc>`)

  if (!isRoute) lines.push('    <trkseg>')

  const indent = isRoute ? '    ' : '      '
  if (Array.isArray(points)) {
    for (const pt of points) {
      if (!pt) continue

      const lat = Array.isArray(pt) ? pt[0] : (pt.lat ?? pt.latitude)
      const lon = Array.isArray(pt) ? pt[1] : (pt.lon ?? pt.lng ?? pt.longitude)
      if (lat == null || lon == null || Number.isNaN(Number(lat)) || Number.isNaN(Number(lon))) {
        continue
      }

      const ele = Array.isArray(pt) ? pt[2] : (pt.ele ?? pt.elevation ?? pt.alt)
      const hasEle = ele != null && !Number.isNaN(Number(ele)) && Number.isFinite(Number(ele))

      const rawTime = Array.isArray(pt) ? pt[3] : pt.time
      const isoTime = rawTime != null ? formatTime(rawTime) : null

      const hr = pt.hr ?? pt.heartRate ?? pt.heart_rate
      const cad = pt.cad ?? pt.cadence
      const hasHr = hr != null && !Number.isNaN(Number(hr)) && Number.isFinite(Number(hr))
      const hasCad = cad != null && !Number.isNaN(Number(cad)) && Number.isFinite(Number(cad))
      const hasExtensions = hasHr || hasCad

      if (!hasEle && !isoTime && !hasExtensions) {
        lines.push(`${indent}<${ptTag} lat="${lat}" lon="${lon}"/>`)
      } else {
        lines.push(`${indent}<${ptTag} lat="${lat}" lon="${lon}">`)
        // Strict GPX 1.1 schema sequence: <ele>, <time>, <extensions>
        if (hasEle) {
          lines.push(`${indent}  <ele>${Number(ele)}</ele>`)
        }
        if (isoTime) {
          lines.push(`${indent}  <time>${isoTime}</time>`)
        }
        if (hasExtensions) {
          lines.push(`${indent}  <extensions>`)
          lines.push(`${indent}    <gpxtpx:TrackPointExtension>`)
          if (hasHr) lines.push(`${indent}      <gpxtpx:hr>${Math.round(Number(hr))}</gpxtpx:hr>`)
          if (hasCad) lines.push(`${indent}      <gpxtpx:cad>${Math.round(Number(cad))}</gpxtpx:cad>`)
          lines.push(`${indent}    </gpxtpx:TrackPointExtension>`)
          lines.push(`${indent}  </extensions>`)
        }
        lines.push(`${indent}</${ptTag}>`)
      }
    }
  }

  if (!isRoute) lines.push('    </trkseg>')
  lines.push(`  </${tag}>`)
  lines.push('</gpx>')

  return lines.join('\n')
}
