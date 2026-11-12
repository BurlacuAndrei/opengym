import { describe, it, expect, vi } from 'vitest'
import {
  RouteFollower,
  createRouteFollower,
  projectPointOnSegment,
  findNearestSegment,
  formatOffCourseAlert,
  DEFAULT_OFF_COURSE_THRESHOLD_METERS,
  DEFAULT_OFF_COURSE_THROTTLE_MS,
} from './route-follower.js'
import { haversineDistance } from './track-math.js'

describe('RouteFollower (Issue #79)', () => {
  // Test reference route: 3 segments along 45.0N latitude
  // Point 0: (45.0, 9.0, ele: 100m)
  // Point 1: (45.0, 9.01, ele: 200m)
  // Point 2: (45.0, 9.02, ele: 150m)
  // Point 3: (45.0, 9.03, ele: 250m)
  const sampleRoute = [
    { lat: 45.0, lon: 9.0, ele: 100 },
    { lat: 45.0, lon: 9.01, ele: 200 },
    { lat: 45.0, lon: 9.02, ele: 150 },
    { lat: 45.0, lon: 9.03, ele: 250 },
  ]

  // ---------------------------------------------------------------------------
  // 1. Segment Projection Math
  // ---------------------------------------------------------------------------
  describe('projectPointOnSegment', () => {
    const pA = { lat: 45.0, lon: 9.0, ele: 100 }
    const pB = { lat: 45.0, lon: 9.01, ele: 200 }

    it('projects point directly at start of segment (t = 0)', () => {
      const proj = projectPointOnSegment({ lat: 45.0, lon: 9.0 }, pA, pB)
      expect(proj.t).toBeCloseTo(0, 5)
      expect(proj.closestPoint.lat).toBeCloseTo(45.0, 5)
      expect(proj.closestPoint.lon).toBeCloseTo(9.0, 5)
      expect(proj.closestPoint.ele).toBeCloseTo(100, 2)
      expect(proj.distance).toBeCloseTo(0, 2)
    })

    it('projects point directly at end of segment (t = 1)', () => {
      const proj = projectPointOnSegment({ lat: 45.0, lon: 9.01 }, pA, pB)
      expect(proj.t).toBeCloseTo(1, 5)
      expect(proj.closestPoint.lat).toBeCloseTo(45.0, 5)
      expect(proj.closestPoint.lon).toBeCloseTo(9.01, 5)
      expect(proj.closestPoint.ele).toBeCloseTo(200, 2)
      expect(proj.distance).toBeCloseTo(0, 2)
    })

    it('projects point midway along segment (t = 0.5) with interpolated elevation', () => {
      const proj = projectPointOnSegment({ lat: 45.0, lon: 9.005 }, pA, pB)
      expect(proj.t).toBeCloseTo(0.5, 4)
      expect(proj.closestPoint.lat).toBeCloseTo(45.0, 5)
      expect(proj.closestPoint.lon).toBeCloseTo(9.005, 5)
      expect(proj.closestPoint.ele).toBeCloseTo(150, 2)
      expect(proj.distance).toBeCloseTo(0, 2)
    })

    it('projects perpendicular point offset from segment and computes cross-track distance', () => {
      // 0.001 degrees latitude north of segment midpoint is approx 111.2 meters
      const offsetPoint = { lat: 45.001, lon: 9.005 }
      const proj = projectPointOnSegment(offsetPoint, pA, pB)

      expect(proj.t).toBeCloseTo(0.5, 4)
      expect(proj.closestPoint.lat).toBeCloseTo(45.0, 5)
      expect(proj.closestPoint.lon).toBeCloseTo(9.005, 5)
      expect(proj.distance).toBeGreaterThan(110)
      expect(proj.distance).toBeLessThan(113)
    })

    it('clamps t to 0 when point is before segment start', () => {
      const beforePoint = { lat: 45.0, lon: 8.99 }
      const proj = projectPointOnSegment(beforePoint, pA, pB)
      expect(proj.t).toBe(0)
      expect(proj.rawT).toBeLessThan(0)
      expect(proj.closestPoint.lat).toBeCloseTo(pA.lat, 5)
      expect(proj.closestPoint.lon).toBeCloseTo(pA.lon, 5)
      expect(proj.closestPoint.ele).toBe(100)
    })

    it('clamps t to 1 when point is after segment end', () => {
      const afterPoint = { lat: 45.0, lon: 9.02 }
      const proj = projectPointOnSegment(afterPoint, pA, pB)
      expect(proj.t).toBe(1)
      expect(proj.rawT).toBeGreaterThan(1)
      expect(proj.closestPoint.lat).toBeCloseTo(pB.lat, 5)
      expect(proj.closestPoint.lon).toBeCloseTo(pB.lon, 5)
      expect(proj.closestPoint.ele).toBe(200)
    })

    it('handles zero-length segments safely', () => {
      const pSame = { lat: 45.0, lon: 9.0, ele: 100 }
      const proj = projectPointOnSegment({ lat: 45.001, lon: 9.0 }, pSame, pSame)
      expect(proj.t).toBe(0)
      expect(proj.distance).toBeGreaterThan(100)
      expect(proj.closestPoint.lat).toBe(45.0)
    })
  })

  // ---------------------------------------------------------------------------
  // 2. Nearest Segment Selection on Polyline
  // ---------------------------------------------------------------------------
  describe('findNearestSegment', () => {
    it('returns null for empty route', () => {
      expect(findNearestSegment({ lat: 45.0, lon: 9.0 }, [])).toBeNull()
    })

    it('selects correct closest segment for points along route', () => {
      // Point near segment 0
      const nearSeg0 = findNearestSegment({ lat: 45.0, lon: 9.003 }, sampleRoute)
      expect(nearSeg0.segmentIndex).toBe(0)
      expect(nearSeg0.segmentT).toBeCloseTo(0.3, 2)
      expect(nearSeg0.distance).toBeCloseTo(0, 2)

      // Point near segment 1
      const nearSeg1 = findNearestSegment({ lat: 45.0, lon: 9.017 }, sampleRoute)
      expect(nearSeg1.segmentIndex).toBe(1)
      expect(nearSeg1.segmentT).toBeCloseTo(0.7, 2)
      expect(nearSeg1.distance).toBeCloseTo(0, 2)

      // Point near segment 2
      const nearSeg2 = findNearestSegment({ lat: 45.0, lon: 9.025 }, sampleRoute)
      expect(nearSeg2.segmentIndex).toBe(2)
      expect(nearSeg2.segmentT).toBeCloseTo(0.5, 2)
      expect(nearSeg2.distance).toBeCloseTo(0, 2)
    })
  })

  // ---------------------------------------------------------------------------
  // 3. Progress Index & Remaining Distance Calculation
  // ---------------------------------------------------------------------------
  describe('Remaining Distance & Along-Track Progress', () => {
    it('computes total distance and remaining distance from start to finish', () => {
      const follower = new RouteFollower(sampleRoute)
      const totalDist = follower.totalDistance
      expect(totalDist).toBeGreaterThan(2000)

      // 1. At start of route
      const atStart = follower.updatePosition({ lat: 45.0, lon: 9.0 })
      expect(atStart.segmentIndex).toBe(0)
      expect(atStart.progressIndex).toBeCloseTo(0, 4)
      expect(atStart.alongTrackDistance).toBeCloseTo(0, 2)
      expect(atStart.remainingDistance).toBeCloseTo(totalDist, 2)

      // 2. Midway along segment 0 (lon: 9.005)
      const midSeg0 = follower.updatePosition({ lat: 45.0, lon: 9.005 })
      expect(midSeg0.segmentIndex).toBe(0)
      expect(midSeg0.segmentT).toBeCloseTo(0.5, 3)
      expect(midSeg0.progressIndex).toBeCloseTo(0.5, 3)
      expect(midSeg0.alongTrackDistance + midSeg0.remainingDistance).toBeCloseTo(totalDist, 1)

      // 3. Exactly at waypoint 1 (segment 0 end / segment 1 start)
      const atPt1 = follower.updatePosition({ lat: 45.0, lon: 9.01 })
      const distSeg0 = haversineDistance(sampleRoute[0], sampleRoute[1])
      expect(atPt1.alongTrackDistance).toBeCloseTo(distSeg0, 1)
      expect(atPt1.remainingDistance).toBeCloseTo(totalDist - distSeg0, 1)

      // 4. At final waypoint (end of route)
      const atEnd = follower.updatePosition({ lat: 45.0, lon: 9.03 })
      expect(atEnd.remainingDistance).toBeCloseTo(0, 2)
      expect(atEnd.alongTrackDistance).toBeCloseTo(totalDist, 1)
    })
  })

  // ---------------------------------------------------------------------------
  // 4. Remaining Elevation Gain (Ascent)
  // ---------------------------------------------------------------------------
  describe('Remaining Elevation Gain', () => {
    it('computes total ascent and remaining cumulative ascent accurately', () => {
      // Route elevations: 100 -> 200 (+100), 200 -> 150 (descent, 0 gain), 150 -> 250 (+100)
      // Total cumulative ascent = 200m
      const follower = new RouteFollower(sampleRoute)
      expect(follower.totalElevationGain).toBe(200)

      // At start (ele: 100m)
      const atStart = follower.updatePosition({ lat: 45.0, lon: 9.0 })
      expect(atStart.remainingElevationGain).toBe(200)

      // Halfway along segment 0 (interpolated ele: 150m)
      // Remaining on seg 0: 200 - 150 = 50m.
      // After seg 0: seg 1 gives 0, seg 2 gives 100m.
      // Total remaining ascent = 50 + 100 = 150m.
      const atMidSeg0 = follower.updatePosition({ lat: 45.0, lon: 9.005 })
      expect(atMidSeg0.remainingElevationGain).toBeCloseTo(150, 1)

      // At waypoint 1 (ele: 200m)
      // Remaining ascent: seg 1 (200 -> 150 = 0 gain), seg 2 (150 -> 250 = 100m gain) -> 100m
      const atPt1 = follower.updatePosition({ lat: 45.0, lon: 9.01 })
      expect(atPt1.remainingElevationGain).toBeCloseTo(100, 1)

      // On downhill segment 1 (e.g. at ele: 175m)
      // Next point is 150m, so remaining on seg 1 is 0.
      // seg 2 still adds 100m.
      const onDownhill = follower.updatePosition({ lat: 45.0, lon: 9.015 })
      expect(onDownhill.remainingElevationGain).toBeCloseTo(100, 1)

      // Halfway along final climb on seg 2 (ele: 200m)
      // Remaining on seg 2: 250 - 200 = 50m.
      const onFinalClimb = follower.updatePosition({ lat: 45.0, lon: 9.025 })
      expect(onFinalClimb.remainingElevationGain).toBeCloseTo(50, 1)

      // At summit / end of route (ele: 250m)
      const atEnd = follower.updatePosition({ lat: 45.0, lon: 9.03 })
      expect(atEnd.remainingElevationGain).toBe(0)
    })

    it('returns 0 remaining elevation gain when route has no elevation data', () => {
      const flatRoute = [
        { lat: 45.0, lon: 9.0 },
        { lat: 45.0, lon: 9.01 },
      ]
      const follower = new RouteFollower(flatRoute)
      expect(follower.totalElevationGain).toBe(0)

      const res = follower.updatePosition({ lat: 45.0, lon: 9.005 })
      expect(res.remainingElevationGain).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // 5. Off-Course Detection & TTS Alert Throttling
  // ---------------------------------------------------------------------------
  describe('Off-Course Detection & 30s Alert Throttling', () => {
    it('sets isOffCourse=false and emits no alert when within 100m', () => {
      const alertSpy = vi.fn()
      const speakSpy = vi.fn()
      const follower = new RouteFollower(sampleRoute, {
        onOffCourseAlert: alertSpy,
        speak: speakSpy,
      })

      // Point offset north by ~55m (0.0005 deg latitude)
      const res = follower.updatePosition({
        lat: 45.0005,
        lon: 9.005,
        time: 1000000,
      })

      expect(res.crossTrackDistance).toBeGreaterThan(50)
      expect(res.crossTrackDistance).toBeLessThan(60)
      expect(res.isOffCourse).toBe(false)
      expect(res.offCourseAlert).toBeNull()
      expect(alertSpy).not.toHaveBeenCalled()
      expect(speakSpy).not.toHaveBeenCalled()
    })

    it('triggers off-course alert when cross-track distance exceeds 100m', () => {
      const alertSpy = vi.fn()
      const speakSpy = vi.fn()
      const follower = new RouteFollower(sampleRoute, {
        onOffCourseAlert: alertSpy,
        speak: speakSpy,
      })

      // Point offset north by ~167m (0.0015 deg latitude)
      const res = follower.updatePosition({
        lat: 45.0015,
        lon: 9.005,
        time: 1000000,
      })

      expect(res.crossTrackDistance).toBeGreaterThan(160)
      expect(res.isOffCourse).toBe(true)
      expect(res.offCourseAlert).not.toBeNull()
      expect(res.offCourseAlert.text).toMatch(/^Off course: \d+ meters$/)
      expect(res.offCourseAlert.distance).toBeCloseTo(res.crossTrackDistance, 2)

      expect(alertSpy).toHaveBeenCalledTimes(1)
      expect(alertSpy).toHaveBeenCalledWith(res.offCourseAlert)

      expect(speakSpy).toHaveBeenCalledTimes(1)
      expect(speakSpy).toHaveBeenCalledWith(res.offCourseAlert.text, { duck: true })
    })

    it('throttles off-course alerts to at most once every 30 seconds', () => {
      const alertSpy = vi.fn()
      const follower = new RouteFollower(sampleRoute, {
        onOffCourseAlert: alertSpy,
      })

      const baseTime = 1000000 // t = 0s

      // 1. Initial off-course trigger at t = 0s
      const u1 = follower.updatePosition({
        lat: 45.002,
        lon: 9.005,
        time: baseTime,
      })
      expect(u1.isOffCourse).toBe(true)
      expect(u1.offCourseAlert).not.toBeNull()
      expect(alertSpy).toHaveBeenCalledTimes(1)

      // 2. Still off-course 10 seconds later (t = 10s) -> THROTTLED
      const u2 = follower.updatePosition({
        lat: 45.0025,
        lon: 9.005,
        time: baseTime + 10000,
      })
      expect(u2.isOffCourse).toBe(true)
      expect(u2.offCourseAlert).toBeNull()
      expect(alertSpy).toHaveBeenCalledTimes(1) // Still 1

      // 3. Still off-course 25 seconds later (t = 25s) -> THROTTLED (< 30s)
      const u3 = follower.updatePosition({
        lat: 45.0022,
        lon: 9.005,
        time: baseTime + 25000,
      })
      expect(u3.isOffCourse).toBe(true)
      expect(u3.offCourseAlert).toBeNull()
      expect(alertSpy).toHaveBeenCalledTimes(1)

      // 4. Still off-course 31 seconds later (t = 31s) -> FIRES NEW ALERT!
      const u4 = follower.updatePosition({
        lat: 45.0021,
        lon: 9.005,
        time: baseTime + 31000,
      })
      expect(u4.isOffCourse).toBe(true)
      expect(u4.offCourseAlert).not.toBeNull()
      expect(alertSpy).toHaveBeenCalledTimes(2)
      expect(u4.offCourseAlert.timestamp).toBe(baseTime + 31000)

      // 5. Back on course at t = 35s
      const u5 = follower.updatePosition({
        lat: 45.0,
        lon: 9.005,
        time: baseTime + 35000,
      })
      expect(u5.isOffCourse).toBe(false)
      expect(u5.offCourseAlert).toBeNull()

      // 6. Stray off-course again at t = 40s (only 9s after last alert at t=31s) -> THROTTLED
      const u6 = follower.updatePosition({
        lat: 45.002,
        lon: 9.005,
        time: baseTime + 40000,
      })
      expect(u6.isOffCourse).toBe(true)
      expect(u6.offCourseAlert).toBeNull()
      expect(alertSpy).toHaveBeenCalledTimes(2)

      // 7. Stray off-course at t = 62s (>30s after t=31s) -> FIRES
      const u7 = follower.updatePosition({
        lat: 45.002,
        lon: 9.005,
        time: baseTime + 62000,
      })
      expect(u7.isOffCourse).toBe(true)
      expect(u7.offCourseAlert).not.toBeNull()
      expect(alertSpy).toHaveBeenCalledTimes(3)
    })

    it('resets alert throttle manually when resetAlertThrottle is called', () => {
      const alertSpy = vi.fn()
      const follower = new RouteFollower(sampleRoute, {
        onOffCourseAlert: alertSpy,
      })

      const baseTime = 1000000
      follower.updatePosition({ lat: 45.002, lon: 9.005, time: baseTime })
      expect(alertSpy).toHaveBeenCalledTimes(1)

      // Reset throttle explicitly
      follower.resetAlertThrottle()

      // Immediate alert now fires even after only 5 seconds
      follower.updatePosition({ lat: 45.002, lon: 9.005, time: baseTime + 5000 })
      expect(alertSpy).toHaveBeenCalledTimes(2)
    })
  })

  // ---------------------------------------------------------------------------
  // 6. Formats & Edge Cases
  // ---------------------------------------------------------------------------
  describe('Edge cases and helpers', () => {
    it('formatOffCourseAlert produces standard voice string', () => {
      expect(formatOffCourseAlert(123.4)).toBe('Off course: 123 meters')
      expect(formatOffCourseAlert(99.6)).toBe('Off course: 100 meters')
    })

    it('createRouteFollower factory works identically to new RouteFollower', () => {
      const f = createRouteFollower(sampleRoute, { offCourseThresholdMeters: 50 })
      expect(f).toBeInstanceOf(RouteFollower)
      expect(f.offCourseThresholdMeters).toBe(50)
    })

    it('handles empty route points without errors', () => {
      const follower = new RouteFollower([])
      const res = follower.updatePosition({ lat: 45.0, lon: 9.0 })
      expect(res.isOffCourse).toBe(false)
      expect(res.remainingDistance).toBe(0)
      expect(res.remainingElevationGain).toBe(0)
    })

    it('handles single-point route', () => {
      const follower = new RouteFollower([{ lat: 45.0, lon: 9.0, ele: 120 }])
      const res = follower.updatePosition({ lat: 45.0, lon: 9.0 })
      expect(res.isOffCourse).toBe(false)
      expect(res.remainingDistance).toBe(0)
      expect(res.crossTrackDistance).toBe(0)

      const far = follower.updatePosition({ lat: 45.005, lon: 9.0 })
      expect(far.isOffCourse).toBe(true)
      expect(far.crossTrackDistance).toBeGreaterThan(100)
    })

    it('supports alternative point formats (lat/lng, latitude/longitude, array)', () => {
      const routeWithDifferentKeys = [
        { latitude: 45.0, longitude: 9.0, elevation: 100 },
        { latitude: 45.0, longitude: 9.01, elevation: 200 },
      ]
      const follower = new RouteFollower(routeWithDifferentKeys)
      const res = follower.updatePosition([45.0, 9.005, 150])
      expect(res.segmentIndex).toBe(0)
      expect(res.crossTrackDistance).toBeCloseTo(0, 1)
      expect(res.remainingElevationGain).toBeCloseTo(50, 1)
    })
  })
})
