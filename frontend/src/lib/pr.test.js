import { describe, it, expect } from 'vitest'
import {
  STANDARD_PR_DISTANCES,
  STANDARD_PR_LABELS,
  STANDARD_PR_DISPLAY_NAMES,
  PR_RANKS,
  getRankMeta,
  formatPrTime,
  formatPrPace,
  extractTrackPoints,
  getActivityEfforts,
  computePersonalRecords,
  detectActivityPRs,
  tagActivityWithPRs,
} from './pr.js'
import { EARTH_RADIUS_METERS } from './track-math.js'

describe('Personal Records (Issue #66)', () => {
  const metersPerDegLat = (EARTH_RADIUS_METERS * Math.PI) / 180

  function createTrack(totalMeters, speedMps, startLat = 45.0, startLon = 9.0) {
    const track = []
    const totalTimeSec = totalMeters / speedMps
    const count = Math.floor(totalTimeSec) + 1
    const t0 = 1700000000000

    for (let i = 0; i < count; i++) {
      const elapsed = Math.min(totalTimeSec, i)
      const dist = elapsed * speedMps
      const lat = startLat + dist / metersPerDegLat
      const t = t0 + elapsed * 1000
      track.push({ lat, lon: startLon, time: t })
    }
    if (track[track.length - 1].time !== t0 + totalTimeSec * 1000) {
      track.push({ lat: startLat + totalMeters / metersPerDegLat, lon: startLon, time: t0 + totalTimeSec * 1000 })
    }
    return track
  }

  describe('Standard Constants and Metadata', () => {
    it('defines standard PR distances for 1k, 1mi, 5k, 10k, half marathon, marathon', () => {
      expect(STANDARD_PR_DISTANCES).toEqual([
        1000,
        1609.344,
        5000,
        10000,
        21097.5,
        42195,
      ])
    })

    it('maps canonical labels correctly', () => {
      expect(STANDARD_PR_LABELS[1000]).toBe('1k')
      expect(STANDARD_PR_LABELS[1609.344]).toBe('1mi')
      expect(STANDARD_PR_LABELS[5000]).toBe('5k')
      expect(STANDARD_PR_LABELS[10000]).toBe('10k')
      expect(STANDARD_PR_LABELS[21097.5]).toBe('half-marathon')
      expect(STANDARD_PR_LABELS[42195]).toBe('marathon')
    })

    it('defines ranks 1, 2, and 3 with gold, silver, bronze metadata', () => {
      const gold = getRankMeta(1)
      const silver = getRankMeta(2)
      const bronze = getRankMeta(3)

      expect(gold.name).toBe('gold')
      expect(gold.label).toBe('PR')
      expect(gold.color).toContain('yellow')

      expect(silver.name).toBe('silver')
      expect(silver.label).toBe('2nd')

      expect(bronze.name).toBe('bronze')
      expect(bronze.label).toBe('3rd')

      expect(getRankMeta(4)).toBeNull()
    })
  })

  describe('Formatting Helpers', () => {
    it('formatPrTime formats seconds into m:ss and h:mm:ss', () => {
      expect(formatPrTime(45)).toBe('0:45')
      expect(formatPrTime(245)).toBe('4:05')
      expect(formatPrTime(1200)).toBe('20:00')
      expect(formatPrTime(3600)).toBe('1:00:00')
      expect(formatPrTime(3665)).toBe('1:01:05')
      expect(formatPrTime(7325)).toBe('2:02:05')
      expect(formatPrTime(null)).toBe('—')
      expect(formatPrTime(0)).toBe('—')
      expect(formatPrTime(-10)).toBe('—')
    })

    it('formatPrPace formats metric and imperial pace', () => {
      // 240 seconds for 1000m = 4:00 min/km
      expect(formatPrPace(240, 1000, 'kg')).toBe('4:00 /km')

      // Imperial: 480 seconds for 1609.344m = 8:00 min/mi
      expect(formatPrPace(480, 1609.344, 'lbs')).toBe('8:00 /mi')

      expect(formatPrPace(0, 1000)).toBe('—')
      expect(formatPrPace(240, 0)).toBe('—')
    })
  })

  describe('Effort Extraction: getActivityEfforts', () => {
    it('returns pre-computed bestEfforts if present on activity', () => {
      const activity = {
        id: 'a1',
        bestEfforts: [
          { target: 1000, label: '1k', elapsedTime: 240 },
          { target: 5000, label: '5k', elapsedTime: 1250 },
        ],
      }
      const efforts = getActivityEfforts(activity)
      expect(efforts).toHaveLength(2)
      expect(efforts[0].elapsedTime).toBe(240)
    })

    it('computes best efforts from GPS track points', () => {
      // 5 km at 4 m/s (1250s total)
      const points = createTrack(5000, 4.0)
      const activity = { id: 'a2', points }
      const efforts = getActivityEfforts(activity)

      expect(efforts.length).toBeGreaterThanOrEqual(3) // 1k, 1mi, 5k
      const eff1k = efforts.find(e => e.label === '1k' || e.target === 1000)
      const eff5k = efforts.find(e => e.label === '5k' || e.target === 5000)

      expect(eff1k).toBeDefined()
      expect(Math.round(eff1k.elapsedTime)).toBe(250) // 1000m / 4mps = 250s
      expect(eff5k).toBeDefined()
      expect(Math.round(eff5k.elapsedTime)).toBe(1250) // 5000m / 4mps = 1250s
    })

    it('derives efforts for manual cardio activities from distanceM and durationMs', () => {
      const activity = {
        id: 'manual-1',
        distanceM: 6000,
        durationMs: 1800000, // 30 min = 1800s (pace 300s/km = 5:00/km)
      }
      const efforts = getActivityEfforts(activity)

      // Should cover 1k, 1mi, 5k (since distanceM 6000 >= 5000, but < 10000)
      expect(efforts.map(e => e.label)).toEqual(['1k', '1mi', '5k'])
      const eff1k = efforts.find(e => e.label === '1k')
      expect(eff1k.elapsedTime).toBe(300) // 1000 * (1800 / 6000) = 300s
      const eff5k = efforts.find(e => e.label === '5k')
      expect(eff5k.elapsedTime).toBe(1500) // 5000 * (1800 / 6000) = 1500s
    })
  })

  describe('Personal Records Computation: computePersonalRecords', () => {
    it('aggregates all-time personal records and top 3 for each distance', () => {
      const activities = [
        {
          id: 'act-1',
          startTime: '2026-01-01T10:00:00Z',
          bestEfforts: [
            { target: 1000, label: '1k', elapsedTime: 260 },
            { target: 5000, label: '5k', elapsedTime: 1400 },
          ],
        },
        {
          id: 'act-2',
          startTime: '2026-01-05T10:00:00Z',
          bestEfforts: [
            { target: 1000, label: '1k', elapsedTime: 240 }, // faster 1k!
            { target: 5000, label: '5k', elapsedTime: 1450 }, // slower 5k
          ],
        },
        {
          id: 'act-3',
          startTime: '2026-01-10T10:00:00Z',
          bestEfforts: [
            { target: 1000, label: '1k', elapsedTime: 250 }, // between act-1 and act-2
            { target: 5000, label: '5k', elapsedTime: 1350 }, // fastest 5k!
          ],
        },
      ]

      const { records, top3 } = computePersonalRecords(activities)

      // 1k best record should be act-2 with 240s
      expect(records['1k'].elapsedTime).toBe(240)
      expect(records['1k'].activityId).toBe('act-2')

      // 1k top 3 should be [240 (act-2), 250 (act-3), 260 (act-1)]
      expect(top3['1k']).toHaveLength(3)
      expect(top3['1k'][0].elapsedTime).toBe(240)
      expect(top3['1k'][0].rank).toBe(1)
      expect(top3['1k'][1].elapsedTime).toBe(250)
      expect(top3['1k'][1].rank).toBe(2)
      expect(top3['1k'][2].elapsedTime).toBe(260)
      expect(top3['1k'][2].rank).toBe(3)

      // 5k best record should be act-3 with 1350s
      expect(records['5k'].elapsedTime).toBe(1350)
      expect(records['5k'].activityId).toBe('act-3')
    })
  })

  describe('PR Detection and Ranking: detectActivityPRs', () => {
    it('tags first activity efforts as Rank 1 (Gold PR)', () => {
      const activity = {
        id: 'first-run',
        startTime: '2026-01-01T10:00:00Z',
        bestEfforts: [
          { target: 1000, label: '1k', elapsedTime: 250 },
          { target: 5000, label: '5k', elapsedTime: 1350 },
        ],
      }

      const prs = detectActivityPRs(activity, [])
      expect(prs).toHaveLength(2)

      expect(prs[0].label).toBe('1k')
      expect(prs[0].rank).toBe(1)
      expect(prs[0].rankName).toBe('gold')
      expect(prs[0].rankLabel).toBe('PR')

      expect(prs[1].label).toBe('5k')
      expect(prs[1].rank).toBe(1)
      expect(prs[1].rankName).toBe('gold')

      expect(prs.hasPr).toBe(true)
      expect(prs.bestRank).toBe(1)
      expect(prs.goldCount).toBe(2)
    })

    it('assigns Rank 2 (Silver) and Rank 3 (Bronze) to subsequent podium efforts', () => {
      const act1 = {
        id: 'run-1',
        startTime: '2026-01-01T10:00:00Z',
        bestEfforts: [{ target: 5000, label: '5k', elapsedTime: 1200 }],
      }
      const act2 = {
        id: 'run-2',
        startTime: '2026-01-02T10:00:00Z',
        bestEfforts: [{ target: 5000, label: '5k', elapsedTime: 1250 }], // slower than act1
      }
      const act3 = {
        id: 'run-3',
        startTime: '2026-01-03T10:00:00Z',
        bestEfforts: [{ target: 5000, label: '5k', elapsedTime: 1300 }], // slower than act1 & act2
      }
      const act4 = {
        id: 'run-4',
        startTime: '2026-01-04T10:00:00Z',
        bestEfforts: [{ target: 5000, label: '5k', elapsedTime: 1350 }], // 4th best -> no badge
      }

      const history = [act1, act2, act3]

      // Evaluate act2: should be rank 2 (silver)
      const prs2 = detectActivityPRs(act2, [act1])
      expect(prs2).toHaveLength(1)
      expect(prs2[0].rank).toBe(2)
      expect(prs2[0].rankName).toBe('silver')
      expect(prs2[0].rankLabel).toBe('2nd')
      expect(prs2.hasPr).toBe(false)
      expect(prs2.hasPodium).toBe(true)
      expect(prs2.bestRank).toBe(2)

      // Evaluate act3: should be rank 3 (bronze)
      const prs3 = detectActivityPRs(act3, [act1, act2])
      expect(prs3).toHaveLength(1)
      expect(prs3[0].rank).toBe(3)
      expect(prs3[0].rankName).toBe('bronze')
      expect(prs3[0].rankLabel).toBe('3rd')
      expect(prs3.bestRank).toBe(3)

      // Evaluate act4: should not get a podium PR rank
      const prs4 = detectActivityPRs(act4, history)
      expect(prs4).toHaveLength(0)
      expect(prs4.hasPr).toBe(false)
      expect(prs4.hasPodium).toBe(false)
      expect(prs4.bestRank).toBeNull()
    })

    it('assigns Rank 1 (Gold PR) when a new run beats previous best', () => {
      const act1 = {
        id: 'run-1',
        startTime: '2026-01-01T10:00:00Z',
        bestEfforts: [{ target: 5000, label: '5k', elapsedTime: 1250 }],
      }
      const act2 = {
        id: 'run-2',
        startTime: '2026-01-05T10:00:00Z',
        bestEfforts: [{ target: 5000, label: '5k', elapsedTime: 1190 }], // Faster!
      }

      const prs = detectActivityPRs(act2, [act1])
      expect(prs).toHaveLength(1)
      expect(prs[0].rank).toBe(1)
      expect(prs[0].rankName).toBe('gold')
      expect(prs[0].rankLabel).toBe('PR')
      expect(prs.hasPr).toBe(true)
    })

    it('supports evaluating against an existing records object', () => {
      const existingRecords = {
        '5k': { target: 5000, label: '5k', elapsedTime: 1300 },
      }
      const activity = {
        id: 'new-run',
        bestEfforts: [{ target: 5000, label: '5k', elapsedTime: 1200 }],
      }

      const prs = detectActivityPRs(activity, existingRecords)
      expect(prs).toHaveLength(1)
      expect(prs[0].rank).toBe(1)
      expect(prs[0].rankName).toBe('gold')
    })

    it('returns empty PR list safely when activity is empty or null', () => {
      const empty1 = detectActivityPRs(null)
      expect(empty1).toHaveLength(0)
      expect(empty1.hasPr).toBe(false)
      expect(empty1.hasPodium).toBe(false)

      const empty2 = detectActivityPRs({})
      expect(empty2).toHaveLength(0)
      expect(empty2.hasPr).toBe(false)

      const empty3 = detectActivityPRs({ distanceM: 0, durationMs: 0 })
      expect(empty3).toHaveLength(0)
      expect(empty3.hasPr).toBe(false)
    })

    it('extractTrackPoints handles all track structures', () => {
      expect(extractTrackPoints(null)).toEqual([])
      expect(extractTrackPoints({ points: [{ lat: 1, lon: 2 }] })).toEqual([{ lat: 1, lon: 2 }])
      expect(extractTrackPoints({ track: { points: [{ lat: 3, lon: 4 }] } })).toEqual([{ lat: 3, lon: 4 }])
      expect(extractTrackPoints({ trackPoints: [{ lat: 5, lon: 6 }] })).toEqual([{ lat: 5, lon: 6 }])
      expect(extractTrackPoints({ track: [{ lat: 7, lon: 8 }] })).toEqual([{ lat: 7, lon: 8 }])
    })
  })

  describe('tagActivityWithPRs', () => {
    it('returns an immutable cloned activity tagged with PR metadata', () => {
      const original = Object.freeze({
        id: 'run-orig',
        startTime: '2026-01-01T10:00:00Z',
        bestEfforts: Object.freeze([{ target: 1000, label: '1k', elapsedTime: 240 }]),
      })

      const tagged = tagActivityWithPRs(original, [])
      expect(tagged).not.toBe(original)
      expect(tagged.id).toBe('run-orig')
      expect(tagged.prs).toBeDefined()
      expect(tagged.hasPr).toBe(true)
      expect(tagged.bestPrRank).toBe(1)
    })
  })
})
