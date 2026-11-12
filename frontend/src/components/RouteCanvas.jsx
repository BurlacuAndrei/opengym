import { useEffect, useRef } from 'react'

/**
 * Extracts numeric latitude and longitude from a point in various shapes:
 * - { lat, lon } or { latitude, longitude } or { lat, lng }
 * - [lat, lon] tuple
 *
 * @param {Object|Array} p
 * @returns {{ lat: number, lon: number } | null}
 */
export function getCoord(p) {
  if (!p) return null
  let lat = null
  let lon = null

  if (Array.isArray(p)) {
    lat = Number(p[0])
    lon = Number(p[1])
  } else if (typeof p === 'object') {
    lat = Number(p.lat ?? p.latitude)
    lon = Number(p.lon ?? p.lng ?? p.longitude)
  }

  if (
    lat == null ||
    lon == null ||
    isNaN(lat) ||
    isNaN(lon) ||
    !isFinite(lat) ||
    !isFinite(lon)
  ) {
    return null
  }

  // Basic latitude/longitude bounds check
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null
  }

  return { lat, lon }
}

/**
 * Computes min/max bounds for an array of track points.
 *
 * @param {Array} points
 * @returns {{ minLat: number, maxLat: number, minLon: number, maxLon: number, count: number } | null}
 */
export function getRouteBounds(points) {
  if (!points || !points.length) return null

  let minLat = Infinity
  let maxLat = -Infinity
  let minLon = Infinity
  let maxLon = -Infinity
  let count = 0

  for (const p of points) {
    const c = getCoord(p)
    if (!c) continue
    count++
    if (c.lat < minLat) minLat = c.lat
    if (c.lat > maxLat) maxLat = c.lat
    if (c.lon < minLon) minLon = c.lon
    if (c.lon > maxLon) maxLon = c.lon
  }

  if (count === 0) return null

  return { minLat, maxLat, minLon, maxLon, count }
}

/**
 * Normalizes GPS lat/lon points to 2D canvas pixel coordinates,
 * preserving geographic aspect ratio and applying padding.
 *
 * @param {Array} points
 * @param {Object} [options={}]
 * @returns {Array<{ x: number, y: number, lat: number, lon: number }>}
 */
export function normalizeRouteCoordinates(
  points,
  { width = 300, height = 200, padding = 16 } = {}
) {
  const coords = (points || []).map(getCoord).filter(Boolean)
  if (!coords.length) return []

  const bounds = getRouteBounds(coords)
  if (!bounds) return []

  // Single point or zero span: place at center
  if (
    coords.length === 1 ||
    (bounds.minLat === bounds.maxLat && bounds.minLon === bounds.maxLon)
  ) {
    return coords.map(c => ({
      x: width / 2,
      y: height / 2,
      lat: c.lat,
      lon: c.lon,
    }))
  }

  const drawWidth = Math.max(1, width - padding * 2)
  const drawHeight = Math.max(1, height - padding * 2)

  // Geographic projection compensation for latitude
  const midLat = (bounds.minLat + bounds.maxLat) / 2
  const cosLat = Math.cos((midLat * Math.PI) / 180)
  const aspectCorrection = Math.abs(cosLat) > 0.001 ? Math.abs(cosLat) : 1

  const lonSpan = bounds.maxLon - bounds.minLon
  const latSpan = bounds.maxLat - bounds.minLat

  const geoWidth = lonSpan * aspectCorrection
  const geoHeight = latSpan

  // Uniform scale to prevent map distortion
  const scaleX = geoWidth > 0 ? drawWidth / geoWidth : 1
  const scaleY = geoHeight > 0 ? drawHeight / geoHeight : 1
  const scale = Math.min(
    geoWidth > 0 ? scaleX : scaleY,
    geoHeight > 0 ? scaleY : scaleX
  )

  const usedWidth = geoWidth * scale
  const usedHeight = geoHeight * scale

  // Centering offsets inside padded drawing area
  const offsetX = padding + (drawWidth - usedWidth) / 2
  const offsetY = padding + (drawHeight - usedHeight) / 2

  return coords.map(c => {
    const x = offsetX + (c.lon - bounds.minLon) * aspectCorrection * scale
    // Canvas Y is inverted (0 is top), so maxLat maps to top offset
    const y = offsetY + (bounds.maxLat - c.lat) * scale
    return {
      x,
      y,
      lat: c.lat,
      lon: c.lon,
    }
  })
}

/**
 * Draws normalized route path on a 2D HTML Canvas.
 * - Draws path line with padding and stroke
 * - Draws start green dot
 * - Draws end red dot
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Array} points
 * @param {Object} [options={}]
 * @returns {boolean} Success status
 */
export function drawRouteOnCanvas(canvas, points, options = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    return false
  }

  const ctx = canvas.getContext('2d')
  if (!ctx) return false

  const {
    width = canvas.width || 300,
    height = canvas.height || 200,
    padding = 16,
    strokeColor = '#10b981',
    lineWidth = 3,
    startColor = '#22c55e', // Green dot for start
    endColor = '#ef4444',   // Red dot for end
    dotRadius = 5,
    backgroundColor = null,
  } = options

  // Clear canvas
  ctx.clearRect(0, 0, width, height)

  if (backgroundColor) {
    ctx.fillStyle = backgroundColor
    ctx.fillRect(0, 0, width, height)
  }

  const projected = normalizeRouteCoordinates(points, {
    width,
    height,
    padding,
  })

  if (!projected.length) {
    return true
  }

  // Single point: draw a single start dot
  if (projected.length === 1) {
    const pt = projected[0]
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, dotRadius, 0, Math.PI * 2)
    ctx.fillStyle = startColor
    ctx.fill()
    return true
  }

  // 1. Draw route path polyline
  ctx.beginPath()
  ctx.strokeStyle = strokeColor
  ctx.lineWidth = lineWidth
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.moveTo(projected[0].x, projected[0].y)

  for (let i = 1; i < projected.length; i++) {
    ctx.lineTo(projected[i].x, projected[i].y)
  }
  ctx.stroke()

  // 2. Draw green start dot at first point
  const startPt = projected[0]
  ctx.beginPath()
  ctx.arc(startPt.x, startPt.y, dotRadius, 0, Math.PI * 2)
  ctx.fillStyle = startColor
  ctx.fill()

  // 3. Draw red end dot at last point
  const endPt = projected[projected.length - 1]
  ctx.beginPath()
  ctx.arc(endPt.x, endPt.y, dotRadius, 0, Math.PI * 2)
  ctx.fillStyle = endColor
  ctx.fill()

  return true
}

/**
 * RouteCanvas Component
 * Renders normalized GPS lat/lon track on a 2D canvas with start green dot and end red dot.
 */
export default function RouteCanvas({
  points = [],
  width = 300,
  height = 200,
  padding = 16,
  strokeColor = '#10b981',
  lineWidth = 3,
  startColor = '#22c55e',
  endColor = '#ef4444',
  dotRadius = 5,
  backgroundColor = null,
  className = 'route-canvas',
  style,
  dataTestId = 'route-canvas',
  ...props
}) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    drawRouteOnCanvas(canvas, points, {
      width,
      height,
      padding,
      strokeColor,
      lineWidth,
      startColor,
      endColor,
      dotRadius,
      backgroundColor,
    })
  }, [
    points,
    width,
    height,
    padding,
    strokeColor,
    lineWidth,
    startColor,
    endColor,
    dotRadius,
    backgroundColor,
  ])

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className={className}
      style={{
        display: 'block',
        maxWidth: '100%',
        borderRadius: 8,
        ...style,
      }}
      data-testid={dataTestId}
      aria-label="Route map"
      {...props}
    />
  )
}
