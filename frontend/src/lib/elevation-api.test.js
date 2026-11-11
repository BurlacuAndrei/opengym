import { describe, it, expect, vi } from 'vitest'
import {
  OPEN_METEO_ELEVATION_URL,
  DEFAULT_CHUNK_SIZE,
  ELEVATION_FEATURE_ID,
  ElevationConsentError,
  ElevationApiError,
  hasConsent,
  hasElevationConsent,
  chunkArray,
  buildElevationUrl,
  fetchElevations,
  enrichTrackElevation,
  lookupTrackElevation,
  enhanceTrackElevation,
  createMockElevationFetch
} from './elevation-api.js'

describe('Open-Meteo DEM Elevation Lookup API (Issue #67)', () => {
  const consentedState = {
    privacy: {
      consents: {
        elevation_lookup: {
          agreedAt: '2026-11-11T12:00:00.000Z',
          version: 1,
          recipient: 'Open-Meteo'
        }
      }
    }
  }

  const revokedState = {
    privacy: {
      consents: {
        elevation_lookup: {
          agreedAt: '2026-11-11T10:00:00.000Z',
          revokedAt: '2026-11-11T11:00:00.000Z',
          version: 1
        }
      }
    }
  }

  const unconsentedState = {
    privacy: {
      consents: {}
    }
  }

  describe('Privacy Consent Gating', () => {
    it('verifies consent correctly across argument patterns', () => {
      // hasConsent('elevation_lookup', state)
      expect(hasConsent('elevation_lookup', consentedState)).toBe(true)
      expect(hasConsent('elevation_lookup', unconsentedState)).toBe(false)
      expect(hasConsent('elevation_lookup', revokedState)).toBe(false)
      expect(hasConsent('elevation_lookup', null)).toBe(false)
      expect(hasConsent('elevation_lookup', {})).toBe(false)

      // hasConsent(state, 'elevation_lookup')
      expect(hasConsent(consentedState, 'elevation_lookup')).toBe(true)
      expect(hasConsent(unconsentedState, 'elevation_lookup')).toBe(false)
      expect(hasConsent(revokedState, 'elevation_lookup')).toBe(false)

      // hasConsent(state) defaults to elevation_lookup
      expect(hasConsent(consentedState)).toBe(true)
      expect(hasConsent(unconsentedState)).toBe(false)

      // hasElevationConsent helper
      expect(hasElevationConsent(consentedState)).toBe(true)
      expect(hasElevationConsent(unconsentedState)).toBe(false)
      expect(hasElevationConsent(revokedState)).toBe(false)
    })

    it('rejects fetchElevations if privacy consent is not granted', async () => {
      const mockFetch = vi.fn()
      const coords = [{ lat: 46.5, lon: 8.5 }]

      // Missing state
      await expect(fetchElevations(coords, { fetch: mockFetch }))
        .rejects.toThrow(ElevationConsentError)

      // Unconsented state
      await expect(fetchElevations(coords, { state: unconsentedState, fetch: mockFetch }))
        .rejects.toThrow('Privacy consent for "elevation_lookup" is not granted')

      // Revoked consent
      await expect(fetchElevations(coords, { state: revokedState, fetch: mockFetch }))
        .rejects.toThrow(ElevationConsentError)

      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('allows bypassing consent check when skipConsentCheck is true', async () => {
      const mockFetch = createMockElevationFetch([123.4])
      const coords = [{ lat: 46.5, lon: 8.5 }]

      const res = await fetchElevations(coords, { skipConsentCheck: true, fetch: mockFetch })
      expect(res).toEqual([123.4])
    })
  })

  describe('URL-Safe Chunking & Batching', () => {
    it('correctly chunks arrays into configured batch sizes', () => {
      expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
      expect(chunkArray([1, 2, 3], 5)).toEqual([[1, 2, 3]])
      expect(chunkArray([], 10)).toEqual([])
      expect(chunkArray(null, 10)).toEqual([])
    })

    it('builds URL-safe query params with rounded coordinates', () => {
      const coords = [
        { lat: 46.123456789, lon: 8.987654321 },
        { lat: 46.2, lon: 8.3 }
      ]
      const urlStr = buildElevationUrl(coords)
      const url = new URL(urlStr)

      expect(url.origin + url.pathname).toBe(OPEN_METEO_ELEVATION_URL)
      expect(url.searchParams.get('latitude')).toBe('46.123457,46.2')
      expect(url.searchParams.get('longitude')).toBe('8.987654,8.3')
    })

    it('splits large tracks across multiple batch requests', async () => {
      const requestedUrls = []
      const fakeFetch = async (url) => {
        requestedUrls.push(url)
        const parsed = new URL(url)
        const count = parsed.searchParams.get('latitude').split(',').length
        return {
          ok: true,
          status: 200,
          json: async () => ({ elevation: new Array(count).fill(500) })
        }
      }

      // Generate 250 points
      const points = []
      for (let i = 0; i < 250; i++) {
        points.push({ lat: 45.0 + i * 0.001, lon: 9.0 + i * 0.001 })
      }

      const results = await fetchElevations(points, {
        state: consentedState,
        chunkSize: 100,
        fetch: fakeFetch
      })

      expect(requestedUrls.length).toBe(3) // 100 + 100 + 50
      expect(results.length).toBe(250)
      expect(results.every(e => e === 500)).toBe(true)
    })

    it('handles invalid and null points while preserving 1:1 index alignment', async () => {
      const coords = [
        { lat: 46.0, lon: 8.0 },
        { lat: null, lon: 8.1 }, // invalid
        { lat: 46.2, lon: 8.2 },
        { lat: 'not-a-number', lon: 8.3 }, // invalid
        [46.4, 8.4], // tuple format
        null // null point
      ]

      const mockFetch = createMockElevationFetch([100, 200, 300])
      const res = await fetchElevations(coords, {
        state: consentedState,
        fetch: mockFetch
      })

      expect(res.length).toBe(6)
      expect(res[0]).toBe(100)
      expect(res[1]).toBeNull()
      expect(res[2]).toBe(200)
      expect(res[3]).toBeNull()
      expect(res[4]).toBe(300)
      expect(res[5]).toBeNull()
    })
  })

  describe('Track Elevation Enrichment & Smoothing', () => {
    it('enriches points with DEM elevations and calculates gain & loss', async () => {
      // 5 points climbing 10m each step: 100 -> 110 -> 120 -> 130 -> 140
      const mockElevations = [100, 110, 120, 130, 140]
      const points = [
        { lat: 46.0, lon: 8.0, ele: 0 },
        { lat: 46.001, lon: 8.001, ele: 0 },
        { lat: 46.002, lon: 8.002, ele: 0 },
        { lat: 46.003, lon: 8.003, ele: 0 },
        { lat: 46.004, lon: 8.004, ele: 0 }
      ]

      const mockFetch = createMockElevationFetch(mockElevations)
      const result = await enrichTrackElevation(points, {
        state: consentedState,
        smooth: false, // test raw first
        fetch: mockFetch,
        preserveOriginal: true
      })

      expect(result.points.length).toBe(5)
      expect(result.points.map(p => p.ele)).toEqual(mockElevations)
      expect(result.points.every(p => p.originalEle === 0)).toBe(true)
      expect(result.stats.gain).toBe(40)
      expect(result.stats.loss).toBe(0)
      expect(result.stats.min).toBe(100)
      expect(result.stats.max).toBe(140)
      expect(result.gain).toBe(40)
      expect(result.loss).toBe(0)

      // Ensure original points were not mutated
      expect(points[0].ele).toBe(0)
      expect(points[0].originalEle).toBeUndefined()
    })

    it('smooths noisy elevations when smooth is true', async () => {
      // Noisy profile with erratic spikes: 100, 150, 102, 148, 101
      const noisyElevations = [100, 150, 102, 148, 101]
      const points = noisyElevations.map((_, i) => ({
        lat: 46.0 + i * 0.001,
        lon: 8.0 + i * 0.001,
        ele: 0
      }))

      const mockFetch = createMockElevationFetch(noisyElevations)
      const smoothedResult = await enrichTrackElevation(points, {
        state: consentedState,
        smooth: true,
        smoothOptions: { windowSize: 3 },
        fetch: mockFetch
      })

      // The smoothed values should be less extreme than 150
      expect(smoothedResult.points[1].ele).toBeLessThan(150)
      expect(smoothedResult.points[1].ele).toBeGreaterThan(100)
      expect(smoothedResult.stats.gain).toBeLessThan(100)
    })

    it('supports track object input and preserves track metadata', async () => {
      const track = {
        id: 'track-123',
        name: 'Alpine Hike',
        points: [
          { lat: 46.0, lon: 8.0, ele: 50 },
          { lat: 46.01, lon: 8.01, ele: 60 }
        ]
      }

      const mockFetch = createMockElevationFetch([250, 300])
      const enrichedTrack = await enrichTrackElevation(track, {
        state: consentedState,
        smooth: false,
        fetch: mockFetch
      })

      expect(enrichedTrack.id).toBe('track-123')
      expect(enrichedTrack.name).toBe('Alpine Hike')
      expect(enrichedTrack.points[0].ele).toBe(250)
      expect(enrichedTrack.points[1].ele).toBe(300)
      expect(enrichedTrack.elevationGainM).toBe(50)
      expect(enrichedTrack.elevationLossM).toBe(0)
    })

    it('supports array tuples [lat, lon, ele]', async () => {
      const tuples = [
        [46.0, 8.0, 10],
        [46.01, 8.01, 20]
      ]

      const mockFetch = createMockElevationFetch([500, 520])
      const res = await enrichTrackElevation(tuples, {
        state: consentedState,
        smooth: false,
        fetch: mockFetch
      })

      expect(res.points[0]).toEqual([46.0, 8.0, 500])
      expect(res.points[1]).toEqual([46.01, 8.01, 520])
      expect(res.stats.gain).toBe(20)
    })

    it('aliases lookupTrackElevation and enhanceTrackElevation', () => {
      expect(lookupTrackElevation).toBe(enrichTrackElevation)
      expect(enhanceTrackElevation).toBe(enrichTrackElevation)
    })
  })

  describe('Offline, Mocking & Error Recovery', () => {
    it('createMockElevationFetch supports generator function and constants', async () => {
      // Function-based generator
      const fnFetch = createMockElevationFetch((lat, lon, i) => 1000 + i * 5)
      const res1 = await fetchElevations(
        [{ lat: 45, lon: 7 }, { lat: 45.1, lon: 7.1 }],
        { state: consentedState, fetch: fnFetch }
      )
      expect(res1).toEqual([1000, 1005])

      // Constant number generator
      const constFetch = createMockElevationFetch(750)
      const res2 = await fetchElevations(
        [{ lat: 45, lon: 7 }, { lat: 45.1, lon: 7.1 }],
        { state: consentedState, fetch: constFetch }
      )
      expect(res2).toEqual([750, 750])
    })

    it('throws ElevationApiError on HTTP error status from API', async () => {
      const errorFetch = createMockElevationFetch({ status: 500, body: 'Internal Server Error' })
      const points = [{ lat: 45, lon: 7 }]

      await expect(
        fetchElevations(points, { state: consentedState, fetch: errorFetch })
      ).rejects.toThrow(ElevationApiError)
    })

    it('throws ElevationApiError on network failure', async () => {
      const failingFetch = createMockElevationFetch({ networkError: 'Failed to fetch (offline)' })
      const points = [{ lat: 45, lon: 7 }]

      await expect(
        fetchElevations(points, { state: consentedState, fetch: failingFetch })
      ).rejects.toThrow(ElevationApiError)
    })

    it('supports fallback: "original" in enrichTrackElevation on API failure', async () => {
      const failingFetch = createMockElevationFetch({ networkError: 'Network down' })
      const points = [
        { lat: 45.0, lon: 7.0, ele: 100 },
        { lat: 45.01, lon: 7.01, ele: 150 }
      ]

      const result = await enrichTrackElevation(points, {
        state: consentedState,
        fetch: failingFetch,
        fallback: 'original',
        smooth: false
      })

      // Fell back to original points and computed their gain
      expect(result.points[0].ele).toBe(100)
      expect(result.points[1].ele).toBe(150)
      expect(result.gain).toBe(50)
      expect(result.error).toBeInstanceOf(ElevationApiError)
    })

    it('handles empty points or empty track gracefully', async () => {
      const resEmpty = await enrichTrackElevation([], { state: consentedState })
      expect(resEmpty.points).toEqual([])
      expect(resEmpty.stats.gain).toBe(0)
      expect(resEmpty.elevations).toEqual([])

      const resTrackEmpty = await enrichTrackElevation({ points: [] }, { state: consentedState })
      expect(resTrackEmpty.points).toEqual([])
      expect(resTrackEmpty.stats.gain).toBe(0)
    })
  })
})
