export type LatLng = { lat: number; lng: number }

const EARTH_RADIUS_M = 6371000

export function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

export function toDeg(rad: number): number {
  return (rad * 180) / Math.PI
}

export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h))
}

export function destinationPoint(
  start: LatLng,
  bearingDeg: number,
  distanceM: number,
): LatLng {
  const δ = distanceM / EARTH_RADIUS_M
  const θ = toRad(bearingDeg)
  const φ1 = toRad(start.lat)
  const λ1 = toRad(start.lng)

  const sinφ1 = Math.sin(φ1)
  const cosφ1 = Math.cos(φ1)
  const sinδ = Math.sin(δ)
  const cosδ = Math.cos(δ)

  const sinφ2 = sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(θ)
  const φ2 = Math.asin(sinφ2)
  const y = Math.sin(θ) * sinδ * cosφ1
  const x = cosδ - sinφ1 * sinφ2
  const λ2 = λ1 + Math.atan2(y, x)

  return { lat: toDeg(φ2), lng: ((toDeg(λ2) + 540) % 360) - 180 }
}

export function bearingDegrees(a: LatLng, b: LatLng): number {
  const φ1 = toRad(a.lat)
  const φ2 = toRad(b.lat)
  const Δλ = toRad(b.lng - a.lng)
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

export function turnAngleDegrees(prevBearing: number, nextBearing: number): number {
  let delta = Math.abs(nextBearing - prevBearing) % 360
  if (delta > 180) delta = 360 - delta
  return delta
}

export function milesToMeters(miles: number): number {
  return miles * 1609.344
}

export function metersToMiles(meters: number): number {
  return meters / 1609.344
}

export function pathLengthMeters(points: LatLng[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += haversineMeters(points[i - 1], points[i])
  }
  return total
}

export function elevationGainFeet(elevationsM: number[]): number {
  let gain = 0
  for (let i = 1; i < elevationsM.length; i++) {
    const d = elevationsM[i] - elevationsM[i - 1]
    if (d > 0.5) gain += d
  }
  return gain * 3.28084
}

export function metersToFeet(m: number): number {
  return m * 3.28084
}
