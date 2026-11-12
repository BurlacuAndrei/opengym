import {
  haversineDistance,
  EARTH_RADIUS_METERS,
  getPointLat,
  getPointLon,
  getPointEle,
  getPointTime,
} from './track-math.js'

export const DEFAULT_OFF_COURSE_THRESHOLD_METERS = 100
export const DEFAULT_OFF_COURSE_THROTTLE_MS = 30000 // 30 seconds

/**
 * Format standard spoken off-course alert.
 *
 * @param {number} distanceMeters
 * @returns {string}
 */
export function formatOffCourseAlert(distanceMeters) {
  const rounded = Math.round(Number(distanceMeters) || 0)
  return `Off course: ${rounded} meters`
}

/**
 * Project a GPS point onto a line segment between segStart and segEnd.
 * Uses equirectangular local tangent projection for sub-millimeter precision on local segments,
 * then computes accurate geodesic cross-track distance using haversine.
 *
 * @param {Object|Array} point - Current GPS point
 * @param {Object|Array} segStart - Segment start point
 * @param {Object|Array} segEnd - Segment end point
 * @returns {{ closestPoint: { lat: number, lon: number, ele?: number }, t: number, distance: number, rawT: number }}
 */
export function projectPointOnSegment(point, segStart, segEnd) {
  const latP = getPointLat(point)
  const lonP = getPointLon(point)
  const latA = getPointLat(segStart)
  const lonA = getPointLon(segStart)
  const latB = getPointLat(segEnd)
  const lonB = getPointLon(segEnd)

  if (latA == null || lonA == null || latB == null || lonB == null) {
    return {
      closestPoint: { lat: latA ?? 0, lon: lonA ?? 0 },
      t: 0,
      rawT: 0,
      distance: Infinity,
    }
  }

  const eleA = getPointEle(segStart)
  const eleB = getPointEle(segEnd)

  if (latP == null || lonP == null) {
    return {
      closestPoint: {
        lat: latA,
        lon: lonA,
        ...(eleA != null ? { ele: eleA } : {}),
      },
      t: 0,
      rawT: 0,
      distance: 0,
    }
  }

  // Handle zero-length segment
  if (latA === latB && lonA === lonB) {
    const dist = haversineDistance({ lat: latP, lon: lonP }, { lat: latA, lon: lonA })
    return {
      closestPoint: {
        lat: latA,
        lon: lonA,
        ...(eleA != null ? { ele: eleA } : {}),
      },
      t: 0,
      rawT: 0,
      distance: dist,
    }
  }

  // Equirectangular local projection around segment midpoint
  const midLat = (latA + latB) / 2
  const cosMidLat = Math.cos((midLat * Math.PI) / 180)
  const radConst = (Math.PI / 180) * EARTH_RADIUS_METERS

  let dLonB = lonB - lonA
  if (dLonB > 180) dLonB -= 360
  if (dLonB < -180) dLonB += 360

  let dLonP = lonP - lonA
  if (dLonP > 180) dLonP -= 360
  if (dLonP < -180) dLonP += 360

  const dxB = dLonB * cosMidLat * radConst
  const dyB = (latB - latA) * radConst

  const dxP = dLonP * cosMidLat * radConst
  const dyP = (latP - latA) * radConst

  const segLenSq = dxB * dxB + dyB * dyB

  let rawT = 0
  if (segLenSq > 0) {
    rawT = (dxP * dxB + dyP * dyB) / segLenSq
  }

  const t = Math.max(0, Math.min(1, rawT))

  const closestLat = latA + t * (latB - latA)
  const closestLon = lonA + t * dLonB
  let closestEle = null
  if (eleA != null && eleB != null) {
    closestEle = eleA + t * (eleB - eleA)
  } else if (eleA != null) {
    closestEle = eleA
  } else if (eleB != null) {
    closestEle = eleB
  }

  const closestPoint = {
    lat: closestLat,
    lon: closestLon,
    ...(closestEle != null ? { ele: closestEle } : {}),
  }

  const distance = haversineDistance(
    { lat: latP, lon: lonP },
    { lat: closestLat, lon: closestLon }
  )

  return {
    closestPoint,
    t,
    rawT,
    distance,
  }
}

/**
 * Finds the closest segment on a polyline to the given point.
 *
 * @param {Object|Array} point - Current GPS position
 * @param {Array} routePoints - Reference route points
 * @param {Object} [options={}] - Options (e.g., preferredSegmentIndex)
 * @returns {{ segmentIndex: number, segmentT: number, closestPoint: Object, distance: number } | null}
 */
export function findNearestSegment(point, routePoints, options = {}) {
  if (!routePoints || !routePoints.length) {
    return null
  }

  if (routePoints.length === 1) {
    const p0 = routePoints[0]
    const lat = getPointLat(p0) ?? 0
    const lon = getPointLon(p0) ?? 0
    const ele = getPointEle(p0)
    const closestPoint = { lat, lon, ...(ele != null ? { ele } : {}) }
    const dist = haversineDistance(point, closestPoint)
    return {
      segmentIndex: 0,
      segmentT: 0,
      closestPoint,
      distance: dist,
    }
  }

  let bestIndex = 0
  let bestT = 0
  let bestClosest = null
  let minDistance = Infinity

  const preferredIdx = options.preferredSegmentIndex ?? -1

  for (let i = 0; i < routePoints.length - 1; i++) {
    const p1 = routePoints[i]
    const p2 = routePoints[i + 1]
    const proj = projectPointOnSegment(point, p1, p2)

    // Bias slightly towards forward progression if distance is virtually identical (< 0.5m)
    const isPreferred =
      preferredIdx >= 0 &&
      i >= preferredIdx &&
      Math.abs(proj.distance - minDistance) <= 0.5

    if (proj.distance < minDistance || isPreferred) {
      minDistance = proj.distance
      bestIndex = i
      bestT = proj.t
      bestClosest = proj.closestPoint
    }
  }

  return {
    segmentIndex: bestIndex,
    segmentT: bestT,
    closestPoint: bestClosest,
    distance: minDistance,
  }
}

/**
 * RouteFollower
 *
 * Live GPX breadcrumb route following state machine.
 * Tracks cross-track error, remaining distance along route, remaining elevation gain,
 * and detects off-course status (>100m) with throttled TTS alerts (max once every 30s).
 */
export class RouteFollower {
  /**
   * @param {Array} [routePoints=[]] - Reference route points [{ lat, lon, ele }]
   * @param {Object} [options={}] - Configuration options
   * @param {number} [options.offCourseThresholdMeters=100] - Off-course distance threshold
   * @param {number} [options.ttsThrottleMs=30000] - Throttle time between TTS off-course alerts (ms)
   * @param {Function} [options.onOffCourseAlert] - Callback for off-course alerts
   * @param {Function} [options.speak] - Speech synthesis callback
   * @param {Function} [options.now] - Clock function for timestamps
   */
  constructor(routePoints = [], options = {}) {
    this.options = options
    this.offCourseThresholdMeters =
      options.offCourseThresholdMeters ?? DEFAULT_OFF_COURSE_THRESHOLD_METERS
    this.ttsThrottleMs =
      options.ttsThrottleMs ?? DEFAULT_OFF_COURSE_THROTTLE_MS
    this.onOffCourseAlert = options.onOffCourseAlert || null
    this.speak = options.speak || null
    this.nowFn = options.now || null

    this.routePoints = []
    this.cumulativeDistances = []
    this.elevationGainsSuffix = []
    this.totalDistance = 0
    this.totalElevationGain = 0

    this.lastAlertTime = null
    this.currentPosition = null
    this.closestPoint = null
    this.segmentIndex = 0
    this.segmentT = 0
    this.progressIndex = 0
    this.crossTrackDistance = 0
    this.alongTrackDistance = 0
    this.remainingDistance = 0
    this.remainingElevationGain = 0
    this.isOffCourse = false

    if (routePoints && routePoints.length) {
      this.setRoute(routePoints)
    }
  }

  /**
   * Set or update reference route points and precompute distance & elevation gain tables.
   *
   * @param {Array} points
   */
  setRoute(points = []) {
    this.routePoints = Array.isArray(points) ? points : []
    const n = this.routePoints.length

    this.cumulativeDistances = new Array(n).fill(0)
    this.elevationGainsSuffix = new Array(n).fill(0)
    this.totalDistance = 0
    this.totalElevationGain = 0

    if (n === 0) return

    // 1. Precompute cumulative distance prefix sum
    for (let i = 1; i < n; i++) {
      const segDist = haversineDistance(this.routePoints[i - 1], this.routePoints[i])
      this.cumulativeDistances[i] = this.cumulativeDistances[i - 1] + segDist
    }
    this.totalDistance = this.cumulativeDistances[n - 1] || 0

    // 2. Precompute elevation ascent suffix sum
    for (let i = n - 2; i >= 0; i--) {
      const ele1 = getPointEle(this.routePoints[i])
      const ele2 = getPointEle(this.routePoints[i + 1])
      const gain = ele1 != null && ele2 != null ? Math.max(0, ele2 - ele1) : 0
      this.elevationGainsSuffix[i] = this.elevationGainsSuffix[i + 1] + gain
    }
    this.totalElevationGain = this.elevationGainsSuffix[0] || 0
  }

  /**
   * Reset follower state and alert throttling.
   */
  reset() {
    this.lastAlertTime = null
    this.currentPosition = null
    this.closestPoint = null
    this.segmentIndex = 0
    this.segmentT = 0
    this.progressIndex = 0
    this.crossTrackDistance = 0
    this.alongTrackDistance = 0
    this.remainingDistance = this.totalDistance
    this.remainingElevationGain = this.totalElevationGain
    this.isOffCourse = false
  }

  /**
   * Reset only the alert throttle timer.
   */
  resetAlertThrottle() {
    this.lastAlertTime = null
  }

  /**
   * Updates current GPS position against reference route.
   *
   * @param {Object|Array} currentPoint - { lat, lon, ele, time? }
   * @param {Object} [options={}] - Per-update options (e.g. now, throttleMs)
   * @returns {{
   *   isOffCourse: boolean,
   *   crossTrackDistance: number,
   *   alongTrackDistance: number,
   *   remainingDistance: number,
   *   remainingElevationGain: number,
   *   segmentIndex: number,
   *   segmentT: number,
   *   progressIndex: number,
   *   closestPoint: Object,
   *   offCourseAlert: Object|null
   * }}
   */
  updatePosition(currentPoint, options = {}) {
    if (!this.routePoints || !this.routePoints.length) {
      return {
        isOffCourse: false,
        crossTrackDistance: 0,
        alongTrackDistance: 0,
        remainingDistance: 0,
        remainingElevationGain: 0,
        segmentIndex: -1,
        segmentT: 0,
        progressIndex: 0,
        closestPoint: null,
        offCourseAlert: null,
      }
    }

    const n = this.routePoints.length

    // Single point route
    if (n === 1) {
      const p0 = this.routePoints[0]
      const lat = getPointLat(p0) ?? 0
      const lon = getPointLon(p0) ?? 0
      const ele = getPointEle(p0)
      const closestPoint = { lat, lon, ...(ele != null ? { ele } : {}) }
      const crossTrackDistance = haversineDistance(currentPoint, closestPoint)
      const isOffCourse = crossTrackDistance > this.offCourseThresholdMeters

      const now =
        getPointTime(currentPoint) ??
        (options.now ? options.now() : this.nowFn ? this.nowFn() : Date.now())

      let offCourseAlert = null
      if (isOffCourse) {
        if (
          this.lastAlertTime == null ||
          now - this.lastAlertTime >= this.ttsThrottleMs
        ) {
          this.lastAlertTime = now
          const text = formatOffCourseAlert(crossTrackDistance)
          offCourseAlert = {
            text,
            distance: crossTrackDistance,
            timestamp: now,
          }
          if (typeof this.onOffCourseAlert === 'function') {
            this.onOffCourseAlert(offCourseAlert)
          }
          if (typeof this.speak === 'function') {
            this.speak(text, { duck: true })
          }
        }
      }

      this.currentPosition = currentPoint
      this.closestPoint = closestPoint
      this.segmentIndex = 0
      this.segmentT = 0
      this.progressIndex = 0
      this.crossTrackDistance = crossTrackDistance
      this.alongTrackDistance = 0
      this.remainingDistance = 0
      this.remainingElevationGain = 0
      this.isOffCourse = isOffCourse

      return {
        isOffCourse,
        crossTrackDistance,
        alongTrackDistance: 0,
        remainingDistance: 0,
        remainingElevationGain: 0,
        segmentIndex: 0,
        segmentT: 0,
        progressIndex: 0,
        closestPoint,
        offCourseAlert,
      }
    }

    // Multi-point polyline route: find closest segment
    const nearest = findNearestSegment(currentPoint, this.routePoints, {
      preferredSegmentIndex: this.segmentIndex,
    })

    const {
      segmentIndex,
      segmentT,
      closestPoint,
      distance: crossTrackDistance,
    } = nearest

    // Compute along-track distance and remaining distance
    const distToEndOfSegment = haversineDistance(
      closestPoint,
      this.routePoints[segmentIndex + 1]
    )
    const distFromStartOfSegment = haversineDistance(
      this.routePoints[segmentIndex],
      closestPoint
    )

    const distRemainingAfterSegment =
      this.cumulativeDistances[n - 1] -
      this.cumulativeDistances[segmentIndex + 1]
    const remainingDistance = distToEndOfSegment + distRemainingAfterSegment

    const alongTrackDistance =
      this.cumulativeDistances[segmentIndex] + distFromStartOfSegment

    // Compute remaining elevation gain (cumulative ascent from projected point to end)
    const eleClosest = getPointEle(closestPoint)
    const eleNext = getPointEle(this.routePoints[segmentIndex + 1])
    const segAscent =
      eleClosest != null && eleNext != null
        ? Math.max(0, eleNext - eleClosest)
        : 0
    const remainingElevationGain =
      segAscent + (this.elevationGainsSuffix[segmentIndex + 1] || 0)

    // Detect off-course condition
    const isOffCourse = crossTrackDistance > this.offCourseThresholdMeters

    // Throttle TTS alert: at most once every ttsThrottleMs (default 30 seconds)
    const now =
      getPointTime(currentPoint) ??
      (options.now ? options.now() : this.nowFn ? this.nowFn() : Date.now())

    let offCourseAlert = null
    if (isOffCourse) {
      if (
        this.lastAlertTime == null ||
        now - this.lastAlertTime >= this.ttsThrottleMs
      ) {
        this.lastAlertTime = now
        const text = formatOffCourseAlert(crossTrackDistance)
        offCourseAlert = {
          text,
          distance: crossTrackDistance,
          timestamp: now,
        }
        if (typeof this.onOffCourseAlert === 'function') {
          this.onOffCourseAlert(offCourseAlert)
        }
        if (typeof this.speak === 'function') {
          this.speak(text, { duck: true })
        }
      }
    }

    // Update state
    this.currentPosition = currentPoint
    this.closestPoint = closestPoint
    this.segmentIndex = segmentIndex
    this.segmentT = segmentT
    this.progressIndex = segmentIndex + segmentT
    this.crossTrackDistance = crossTrackDistance
    this.alongTrackDistance = alongTrackDistance
    this.remainingDistance = remainingDistance
    this.remainingElevationGain = remainingElevationGain
    this.isOffCourse = isOffCourse

    return {
      isOffCourse,
      crossTrackDistance,
      alongTrackDistance,
      remainingDistance,
      remainingElevationGain,
      segmentIndex,
      segmentT,
      progressIndex: segmentIndex + segmentT,
      closestPoint,
      offCourseAlert,
    }
  }
}

/**
 * Factory helper to create a RouteFollower instance.
 *
 * @param {Array} routePoints
 * @param {Object} options
 * @returns {RouteFollower}
 */
export function createRouteFollower(routePoints, options) {
  return new RouteFollower(routePoints, options)
}
