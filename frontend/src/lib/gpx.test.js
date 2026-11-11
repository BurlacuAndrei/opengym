import { describe, it, expect } from 'vitest'
import {
  parseGPX,
  serializeGPX,
  escapeXML,
  unescapeXML,
  GPX_VERSION,
  GPX_XMLNS,
  GPX_TPX_XMLNS
} from './gpx.js'

describe('GPX 1.1 Parser & Serializer (Issue #57)', () => {
  describe('Constants and XML Helpers', () => {
    it('exports standard GPX constants', () => {
      expect(GPX_VERSION).toBe('1.1')
      expect(GPX_XMLNS).toBe('http://www.topografix.com/GPX/1/1')
      expect(GPX_TPX_XMLNS).toBe('http://www.garmin.com/xmlschemas/TrackPointExtension/v1')
    })

    it('escapes special XML characters', () => {
      expect(escapeXML('Tom & Jerry <cartoon> "rocks" \'today\'')).toBe(
        'Tom &amp; Jerry &lt;cartoon&gt; &quot;rocks&quot; &apos;today&apos;'
      )
      expect(escapeXML('')).toBe('')
      expect(escapeXML(null)).toBe('')
      expect(escapeXML(undefined)).toBe('')
      expect(escapeXML(123)).toBe('123')
    })

    it('unescapes XML entities safely without double decoding', () => {
      expect(unescapeXML('&lt;tag&gt; &amp; &quot;quote&quot; &apos;single&apos;')).toBe(
        '<tag> & "quote" \'single\''
      )
      // Numeric and hex entities
      expect(unescapeXML('&#65;&#66;&#67; &#x44;&#x45;')).toBe('ABC DE')
      // Ensure &amp;lt; does not double decode to <
      expect(unescapeXML('&amp;lt;')).toBe('&lt;')
      expect(unescapeXML(null)).toBe('')
    })
  })

  // ---------------------------------------------------------------------------
  // 1. Parser: Tracks, Routes, Metadata, Extensions
  // ---------------------------------------------------------------------------
  describe('parseGPX', () => {
    it('parses standard GPX 1.1 track with name, desc, creator, ele, time, hr, cad', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Garmin Edge 830"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <metadata>
    <name>Sunday Morning Ride</name>
    <desc>Sunny hill repeats</desc>
    <time>2026-11-11T08:00:00Z</time>
  </metadata>
  <trk>
    <name>Track Name Fallback</name>
    <trkseg>
      <trkpt lat="46.010000" lon="8.950000">
        <ele>275.5</ele>
        <time>2026-11-11T08:00:00Z</time>
        <extensions>
          <gpxtpx:TrackPointExtension>
            <gpxtpx:hr>142</gpxtpx:hr>
            <gpxtpx:cad>88</gpxtpx:cad>
          </gpxtpx:TrackPointExtension>
        </extensions>
      </trkpt>
      <trkpt lat="46.012500" lon="8.953500">
        <ele>285.0</ele>
        <time>2026-11-11T08:00:15Z</time>
        <extensions>
          <gpxtpx:TrackPointExtension>
            <gpxtpx:hr>156</gpxtpx:hr>
            <gpxtpx:cad>92</gpxtpx:cad>
          </gpxtpx:TrackPointExtension>
        </extensions>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`

      const result = parseGPX(xml)
      expect(result.creator).toBe('Garmin Edge 830')
      expect(result.name).toBe('Sunday Morning Ride')
      expect(result.desc).toBe('Sunny hill repeats')
      expect(result.points.length).toBe(2)

      expect(result.points[0]).toEqual({
        lat: 46.01,
        lon: 8.95,
        ele: 275.5,
        time: '2026-11-11T08:00:00Z',
        hr: 142,
        cad: 88
      })

      expect(result.points[1]).toEqual({
        lat: 46.0125,
        lon: 8.9535,
        ele: 285,
        time: '2026-11-11T08:00:15Z',
        hr: 156,
        cad: 92
      })
    })

    it('falls back to <trk><name> and <trk><desc> when <metadata> is absent', () => {
      const xml = `<gpx version="1.1" creator="Strava">
  <trk>
    <name>Trail Odyssey</name>
    <desc>Epic 25k run</desc>
    <trkseg>
      <trkpt lat="45.1" lon="9.2"/>
    </trkseg>
  </trk>
</gpx>`

      const result = parseGPX(xml)
      expect(result.name).toBe('Trail Odyssey')
      expect(result.desc).toBe('Epic 25k run')
      expect(result.creator).toBe('Strava')
      expect(result.points).toEqual([{ lat: 45.1, lon: 9.2 }])
    })

    it('parses routes (<rte> and <rtept>) seamlessly', () => {
      const xml = `<gpx version="1.1" creator="Komoot">
  <rte>
    <name>Alpine Loop Route</name>
    <desc>Scenic gravel tour</desc>
    <rtept lat="46.50" lon="9.80">
      <ele>1820.0</ele>
      <time>2026-06-15T09:00:00Z</time>
    </rtept>
    <rtept lat="46.55" lon="9.85">
      <ele>2150.5</ele>
      <time>2026-06-15T09:45:00Z</time>
    </rtept>
  </rte>
</gpx>`

      const result = parseGPX(xml)
      expect(result.name).toBe('Alpine Loop Route')
      expect(result.desc).toBe('Scenic gravel tour')
      expect(result.creator).toBe('Komoot')
      expect(result.points.length).toBe(2)
      expect(result.points[0]).toEqual({
        lat: 46.5,
        lon: 9.8,
        ele: 1820,
        time: '2026-06-15T09:00:00Z'
      })
      expect(result.points[1]).toEqual({
        lat: 46.55,
        lon: 9.85,
        ele: 2150.5,
        time: '2026-06-15T09:45:00Z'
      })
    })

    it('parses multiple track segments (<trkseg>) sequentially', () => {
      const xml = `<gpx version="1.1">
  <trk>
    <trkseg>
      <trkpt lat="10.0" lon="20.0"/>
      <trkpt lat="10.1" lon="20.1"/>
    </trkseg>
    <trkseg>
      <trkpt lat="10.2" lon="20.2"/>
    </trkseg>
  </trk>
</gpx>`

      const result = parseGPX(xml)
      expect(result.points.length).toBe(3)
      expect(result.points[0]).toEqual({ lat: 10.0, lon: 20.0 })
      expect(result.points[1]).toEqual({ lat: 10.1, lon: 20.1 })
      expect(result.points[2]).toEqual({ lat: 10.2, lon: 20.2 })
    })

    it('extracts heart rate and cadence from direct and legacy tags (<hr>, <heartrate>, <cad>, <cadence>)', () => {
      const xml = `<gpx version="1.1">
  <trk>
    <trkseg>
      <trkpt lat="45" lon="9">
        <extensions>
          <hr>165</hr>
          <cad>95</cad>
        </extensions>
      </trkpt>
      <trkpt lat="45.1" lon="9.1">
        <extensions>
          <heartrate>170</heartrate>
          <cadence>98</cadence>
        </extensions>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`

      const result = parseGPX(xml)
      expect(result.points[0].hr).toBe(165)
      expect(result.points[0].cad).toBe(95)
      expect(result.points[1].hr).toBe(170)
      expect(result.points[1].cad).toBe(98)
    })

    it('handles CDATA sections in metadata name and description', () => {
      const xml = `<gpx version="1.1">
  <metadata>
    <name><![CDATA[Trail & Jog (Fast)]]></name>
    <desc><![CDATA[Distance: <10km> & Elevation: >500m]]></desc>
  </metadata>
  <trk>
    <trkseg>
      <trkpt lat="46.0" lon="8.0"/>
    </trkseg>
  </trk>
</gpx>`

      const result = parseGPX(xml)
      expect(result.name).toBe('Trail & Jog (Fast)')
      expect(result.desc).toBe('Distance: <10km> & Elevation: >500m')
    })

    it('handles Null Island (lat 0, lon 0) and zero elevation/hr/cad correctly', () => {
      const xml = `<gpx version="1.1">
  <trk>
    <trkseg>
      <trkpt lat="0" lon="0">
        <ele>0</ele>
        <extensions>
          <gpxtpx:TrackPointExtension xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
            <gpxtpx:hr>0</gpxtpx:hr>
            <gpxtpx:cad>0</gpxtpx:cad>
          </gpxtpx:TrackPointExtension>
        </extensions>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`

      const result = parseGPX(xml)
      expect(result.points[0]).toEqual({
        lat: 0,
        lon: 0,
        ele: 0,
        hr: 0,
        cad: 0
      })
    })

    it('skips corrupted/missing trackpoint coordinates gracefully without crashing', () => {
      const xml = `<gpx version="1.1">
  <trk>
    <trkseg>
      <trkpt lat="45.0" lon="9.0"/>
      <trkpt lat="invalid" lon="9.0"/>
      <trkpt ele="100"/>
      <trkpt lat="45.2" lon="9.2"/>
    </trkseg>
  </trk>
</gpx>`

      const result = parseGPX(xml)
      expect(result.points.length).toBe(2)
      expect(result.points[0]).toEqual({ lat: 45.0, lon: 9.0 })
      expect(result.points[1]).toEqual({ lat: 45.2, lon: 9.2 })
    })

    it('parses empty GPX with no points', () => {
      const xml = `<gpx version="1.1" creator="EmptyTest">
  <metadata><name>Empty Track</name></metadata>
</gpx>`

      const result = parseGPX(xml)
      expect(result.name).toBe('Empty Track')
      expect(result.creator).toBe('EmptyTest')
      expect(result.points).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------
  // 2. Serializer: Tracks, Routes, Schema Compliance, Attribute Normalization
  // ---------------------------------------------------------------------------
  describe('serializeGPX', () => {
    it('serializes track data into schema-compliant GPX 1.1 XML', () => {
      const data = {
        name: 'Forest Run',
        desc: 'Quiet morning loop',
        creator: 'OpenGym GPX Engine',
        points: [
          {
            lat: 47.3769,
            lon: 8.5417,
            ele: 408.2,
            time: '2026-11-11T09:00:00Z',
            hr: 148,
            cad: 86
          }
        ]
      }

      const xml = serializeGPX(data)
      expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
      expect(xml).toContain('<gpx version="1.1" creator="OpenGym GPX Engine"')
      expect(xml).toContain('xmlns="http://www.topografix.com/GPX/1/1"')
      expect(xml).toContain('xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"')
      expect(xml).toContain('<metadata>')
      expect(xml).toContain('<name>Forest Run</name>')
      expect(xml).toContain('<desc>Quiet morning loop</desc>')
      expect(xml).toContain('<trk>')
      expect(xml).toContain('<trkseg>')
      expect(xml).toContain('<trkpt lat="47.3769" lon="8.5417">')
      expect(xml).toContain('<ele>408.2</ele>')
      expect(xml).toContain('<time>2026-11-11T09:00:00Z</time>')
      expect(xml).toContain('<gpxtpx:hr>148</gpxtpx:hr>')
      expect(xml).toContain('<gpxtpx:cad>86</gpxtpx:cad>')

      // Verify schema sequence order inside <trkpt>: <ele> comes before <time>, <time> comes before <extensions>
      const trkptIdx = xml.indexOf('<trkpt')
      const eleIdx = xml.indexOf('<ele>408.2</ele>', trkptIdx)
      const timeIdx = xml.indexOf('<time>2026-11-11T09:00:00Z</time>', trkptIdx)
      const extIdx = xml.indexOf('<extensions>', trkptIdx)
      expect(eleIdx).toBeLessThan(timeIdx)
      expect(timeIdx).toBeLessThan(extIdx)
    })

    it('serializes routes (<rte> and <rtept>) when type is route', () => {
      const data = {
        name: 'Mountain Pass',
        desc: 'Planned bike route',
        type: 'route',
        points: [
          { lat: 46.5, lon: 8.5, ele: 1200 },
          { lat: 46.6, lon: 8.6, ele: 1500 }
        ]
      }

      const xml = serializeGPX(data)
      expect(xml).toContain('<rte>')
      expect(xml).toContain('<name>Mountain Pass</name>')
      expect(xml).toContain('<rtept lat="46.5" lon="8.5">')
      expect(xml).toContain('<rtept lat="46.6" lon="8.6">')
      expect(xml).not.toContain('<trk>')
      expect(xml).not.toContain('<trkseg>')
    })

    it('accepts alternate coordinate keys (lng, latitude, longitude) and array points', () => {
      const xml = serializeGPX({
        name: 'Flexible Coords',
        points: [
          { lat: 45.1, lng: 9.1 },
          { latitude: 45.2, longitude: 9.2, elevation: 120, time: 1700000000000 },
          [45.3, 9.3, 150, '2026-11-11T12:00:00Z']
        ]
      })

      const parsed = parseGPX(xml)
      expect(parsed.points.length).toBe(3)
      expect(parsed.points[0].lat).toBe(45.1)
      expect(parsed.points[0].lon).toBe(9.1)
      expect(parsed.points[1].lat).toBe(45.2)
      expect(parsed.points[1].lon).toBe(9.2)
      expect(parsed.points[1].ele).toBe(120)
      expect(parsed.points[2].lat).toBe(45.3)
      expect(parsed.points[2].lon).toBe(9.3)
      expect(parsed.points[2].ele).toBe(150)
      expect(parsed.points[2].time).toBe('2026-11-11T12:00:00Z')
    })

    it('emits self-closing trackpoints when no ele, time, or extensions exist', () => {
      const xml = serializeGPX({
        points: [{ lat: 45.0, lon: 9.0 }]
      })
      expect(xml).toContain('<trkpt lat="45" lon="9"/>')
    })

    it('handles empty options object gracefully', () => {
      const xml = serializeGPX()
      expect(xml).toContain('<gpx version="1.1" creator="OpenGym"')
      const parsed = parseGPX(xml)
      expect(parsed.points).toEqual([])
      expect(parsed.creator).toBe('OpenGym')
    })
  })

  // ---------------------------------------------------------------------------
  // 3. Lossless Round-Trip Verification
  // ---------------------------------------------------------------------------
  describe('Lossless Round-Trip', () => {
    it('achieves 100% fidelity on coordinates, elevation, timestamp, hr, and cad', () => {
      const original = {
        name: 'St. Moritz - Piz Nair Trail',
        desc: 'Technical alpine run with steep climb',
        creator: 'OpenGym v1.2.3',
        points: [
          {
            lat: 46.498312,
            lon: 9.839451,
            ele: 1822.4,
            time: '2026-08-10T07:15:00Z',
            hr: 138,
            cad: 82
          },
          {
            lat: 46.502145,
            lon: 9.842109,
            ele: 1910.8,
            time: '2026-08-10T07:15:30Z',
            hr: 162,
            cad: 78
          },
          {
            lat: 46.508921,
            lon: 9.847552,
            ele: 2055.0,
            time: '2026-08-10T07:16:15Z',
            hr: 174,
            cad: 75
          }
        ]
      }

      const xml = serializeGPX(original)
      const parsed = parseGPX(xml)

      expect(parsed.name).toBe(original.name)
      expect(parsed.desc).toBe(original.desc)
      expect(parsed.creator).toBe(original.creator)
      expect(parsed.points.length).toBe(original.points.length)

      for (let i = 0; i < original.points.length; i++) {
        expect(parsed.points[i].lat).toBeCloseTo(original.points[i].lat, 6)
        expect(parsed.points[i].lon).toBeCloseTo(original.points[i].lon, 6)
        expect(parsed.points[i].ele).toBe(original.points[i].ele)
        expect(parsed.points[i].time).toBe(original.points[i].time)
        expect(parsed.points[i].hr).toBe(original.points[i].hr)
        expect(parsed.points[i].cad).toBe(original.points[i].cad)
      }

      // Double round-trip preserves serialized output
      const secondXml = serializeGPX(parsed)
      const secondParsed = parseGPX(secondXml)
      expect(secondParsed).toEqual(parsed)
    })

    it('preserves special characters and quotes without injection or corruption', () => {
      const original = {
        name: 'Rock & Roll <Night> Run "The Best" & \'Fastest\'',
        desc: 'Testing special XML chars: < > & " \' /',
        creator: 'Tester <Alpha & Omega>',
        points: [
          { lat: -33.8688, lon: 151.2093, ele: 15.5, time: '2026-11-11T12:00:00Z' }
        ]
      }

      const xml = serializeGPX(original)
      const parsed = parseGPX(xml)

      expect(parsed.name).toBe(original.name)
      expect(parsed.desc).toBe(original.desc)
      expect(parsed.creator).toBe(original.creator)
      expect(parsed.points[0].lat).toBe(-33.8688)
      expect(parsed.points[0].lon).toBe(151.2093)
      expect(parsed.points[0].ele).toBe(15.5)
      expect(parsed.points[0].time).toBe('2026-11-11T12:00:00Z')
    })

    it('round-trips route type without loss', () => {
      const originalRoute = {
        name: 'Gravel Loop',
        desc: 'Planned weekend course',
        creator: 'RouteBuilder',
        type: 'route',
        points: [
          { lat: 45.1, lon: 9.1, ele: 100 },
          { lat: 45.2, lon: 9.2, ele: 200 }
        ]
      }

      const xml = serializeGPX(originalRoute)
      const parsed = parseGPX(xml)

      expect(parsed.name).toBe(originalRoute.name)
      expect(parsed.desc).toBe(originalRoute.desc)
      expect(parsed.creator).toBe(originalRoute.creator)
      expect(parsed.points.length).toBe(2)
      expect(parsed.points[0]).toEqual(originalRoute.points[0])
      expect(parsed.points[1]).toEqual(originalRoute.points[1])
    })
  })

  // ---------------------------------------------------------------------------
  // 4. Zero & Corrupt XML Error Handling
  // ---------------------------------------------------------------------------
  describe('Zero & Corrupt XML Error Handling', () => {
    it('throws on null or undefined input', () => {
      expect(() => parseGPX(null)).toThrow('Invalid GPX: input must be a non-empty string')
      expect(() => parseGPX(undefined)).toThrow('Invalid GPX: input must be a non-empty string')
    })

    it('throws on non-string input', () => {
      expect(() => parseGPX(12345)).toThrow('Invalid GPX: input must be a non-empty string')
      expect(() => parseGPX({})).toThrow('Invalid GPX: input must be a non-empty string')
      expect(() => parseGPX([])).toThrow('Invalid GPX: input must be a non-empty string')
    })

    it('throws on empty or whitespace-only XML string', () => {
      expect(() => parseGPX('')).toThrow('Invalid GPX: XML string is empty')
      expect(() => parseGPX('   \n\t  ')).toThrow('Invalid GPX: XML string is empty')
    })

    it('throws when root <gpx> element is missing (e.g. KML, SVG, HTML)', () => {
      expect(() => parseGPX('<kml><Document><name>Test</name></Document></kml>')).toThrow(
        'Invalid GPX: missing <gpx> root element'
      )
      expect(() => parseGPX('<svg><path d="M0,0 L10,10"/></svg>')).toThrow(
        'Invalid GPX: missing <gpx> root element'
      )
      expect(() => parseGPX('<html><body>Not a GPX</body></html>')).toThrow(
        'Invalid GPX: missing <gpx> root element'
      )
    })

    it('throws on unclosed XML tags', () => {
      expect(() => parseGPX('<gpx version="1.1"><trk><trkseg>')).toThrow(/unclosed tag/i)
      expect(() => parseGPX('<gpx><trk><trkpt lat="45" lon="9"></trk></gpx>')).toThrow(/mismatched closing tag/i)
    })

    it('throws on mismatched or unexpected closing tags', () => {
      expect(() => parseGPX('<gpx><trk></rte></gpx>')).toThrow(/mismatched closing tag/i)
      expect(() => parseGPX('<gpx></trk></gpx>')).toThrow(/mismatched closing tag/i)
      expect(() => parseGPX('<gpx></gpx></extra>')).toThrow(/unexpected closing tag/i)
    })

    it('throws on truncated tag definitions', () => {
      expect(() => parseGPX('<gpx version="1.1"><trk <trkpt lat="45"/>')).toThrow(/unclosed tag|invalid tag/i)
      expect(() => parseGPX('<gpx><trkpt lat="45" lon="9"')).toThrow(/unclosed tag/i)
    })

    it('throws on unclosed XML comments and CDATA', () => {
      expect(() => parseGPX('<gpx><!-- unclosed comment <trk></trk></gpx>')).toThrow(/unclosed comment/i)
      expect(() => parseGPX('<gpx><![CDATA[ unclosed cdata <trk></trk></gpx>')).toThrow(/unclosed CDATA/i)
    })
  })
})
