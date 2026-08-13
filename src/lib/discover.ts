import { haversineMeters, milesToMeters, type LatLng } from './geo'
import { overpassQuery } from './osm'
import {
  planRunRoute,
  snapshotRoutingState,
  type RouteResult,
  type RoutingSnapshot,
} from './router'

export type DiscoverRequest = {
  home: LatLng
  /** How far you're willing to drive, in miles. */
  searchRadiusMiles: number
  distanceMiles: number
  varianceMiles: number
  maxClimbFeet: number
  onStatus?: (message: string) => void
}

export type DiscoverHit = {
  id: string
  name: string
  hub: LatLng
  parking: LatLng
  parkingLabel: string
  driveMiles: number
  route: RouteResult
  routingSnap: RoutingSnapshot
}

type OsmCenterEl = {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

type ParkingSpot = {
  id: string
  label: string
  location: LatLng
}

function placeCenter(el: OsmCenterEl): LatLng | null {
  if (el.center) return { lat: el.center.lat, lng: el.center.lon }
  if (el.lat != null && el.lon != null) return { lat: el.lat, lng: el.lon }
  return null
}

function bearingFrom(home: LatLng, point: LatLng): number {
  const dLng = ((point.lng - home.lng) * Math.PI) / 180
  const lat1 = (home.lat * Math.PI) / 180
  const lat2 = (point.lat * Math.PI) / 180
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

function parkingFromElement(el: OsmCenterEl): ParkingSpot | null {
  const tags = el.tags ?? {}
  if (tags.amenity !== 'parking') return null

  const access = (tags.access ?? '').toLowerCase()
  if (['private', 'no', 'customers', 'permit'].includes(access)) return null
  if ((tags.parking ?? '').toLowerCase() === 'private') return null

  const kind = (tags.parking ?? '').toLowerCase()
  if (['garage', 'multi-storey', 'underground', 'rooftop'].includes(kind)) {
    return null
  }

  const center = placeCenter(el)
  if (!center) return null

  const label =
    tags.name?.trim() ||
    (kind ? `${kind.replace(/_/g, ' ')} parking` : 'Parking')

  return {
    id: `${el.type}-${el.id}`,
    label,
    location: center,
  }
}

async function fetchParking(
  home: LatLng,
  radiusM: number,
  onStatus: (m: string) => void,
): Promise<ParkingSpot[]> {
  const r = Math.ceil(Math.min(radiusM, 45000))
  onStatus('Finding parking within driving range…')

  const query = `
[out:json][timeout:60];
(
  node["amenity"="parking"](around:${r},${home.lat},${home.lng});
  way["amenity"="parking"](around:${r},${home.lat},${home.lng});
);
out center tags;
`.trim()

  const elements = (await overpassQuery(query)) as OsmCenterEl[]
  const spots: ParkingSpot[] = []
  const seen = new Set<string>()
  for (const el of elements) {
    const lot = parkingFromElement(el)
    if (!lot) continue
    const key = `${lot.location.lat.toFixed(4)},${lot.location.lng.toFixed(4)}`
    if (seen.has(key)) continue
    seen.add(key)
    spots.push(lot)
  }
  return spots
}

function pickSpreadHubs(
  home: LatLng,
  spots: ParkingSpot[],
  radiusM: number,
  maxHubs: number,
): ParkingSpot[] {
  const minDriveM = Math.min(700, radiusM * 0.08)
  const minSeparationM = Math.max(1600, radiusM * 0.18)
  const targetRing = radiusM * 0.55

  const candidates = spots
    .map((spot) => {
      const driveM = haversineMeters(home, spot.location)
      return { spot, driveM }
    })
    .filter((c) => c.driveM >= minDriveM && c.driveM <= radiusM)
    .sort((a, b) => {
      const namedA = a.spot.label === 'Parking' ? 1 : 0
      const namedB = b.spot.label === 'Parking' ? 1 : 0
      if (namedA !== namedB) return namedA - namedB
      return Math.abs(a.driveM - targetRing) - Math.abs(b.driveM - targetRing)
    })

  const hubs: ParkingSpot[] = []
  const sectorUsed = new Set<number>()
  const sectors = 8

  for (const { spot } of candidates) {
    if (hubs.length >= maxHubs) break
    const sector = Math.floor(bearingFrom(home, spot.location) / (360 / sectors))
    if (sectorUsed.has(sector) && hubs.length < sectors) continue
    if (hubs.some((h) => haversineMeters(h.location, spot.location) < minSeparationM)) {
      continue
    }
    sectorUsed.add(sector)
    hubs.push(spot)
  }

  if (hubs.length < maxHubs) {
    for (const { spot } of candidates) {
      if (hubs.length >= maxHubs) break
      if (hubs.some((h) => h.id === spot.id)) continue
      if (hubs.some((h) => haversineMeters(h.location, spot.location) < minSeparationM)) {
        continue
      }
      hubs.push(spot)
    }
  }

  return hubs
}

function hitScore(hit: DiscoverHit, maxClimbFeet: number): number {
  const climbOver = Math.max(0, hit.route.elevationGainFeet - maxClimbFeet)
  // Same priority as auto-route: climb >> lights >> turns >> crossings
  return (
    hit.route.elevationGainFeet * 10_000 +
    climbOver * 20_000 +
    hit.route.signals * 300 +
    hit.route.turns * 8 +
    hit.route.crossings * 1 +
    hit.driveMiles * 4
  )
}

/**
 * Find drive-to runs with parking that match distance/climb prefs.
 */
export async function discoverRuns(
  req: DiscoverRequest,
): Promise<DiscoverHit[]> {
  const status = req.onStatus ?? (() => {})
  const radiusM = milesToMeters(req.searchRadiusMiles)

  if (req.searchRadiusMiles <= 0 || req.searchRadiusMiles > 40) {
    throw new Error('Search radius should be between 1 and 40 miles.')
  }

  const parking = await fetchParking(req.home, radiusM, status)
  if (parking.length < 4) {
    throw new Error(
      'Not enough mapped parking in that radius. Try a larger search radius.',
    )
  }

  const hubs = pickSpreadHubs(req.home, parking, radiusM, 6)
  if (hubs.length === 0) {
    throw new Error(
      'Could not spread parking start points across that radius. Try a larger search.',
    )
  }

  const hits: DiscoverHit[] = []

  for (let i = 0; i < hubs.length; i++) {
    const hub = hubs[i]
    const driveMiles =
      Math.round((haversineMeters(req.home, hub.location) / 1609.344) * 10) / 10
    status(`Routing ${i + 1}/${hubs.length}: ${hub.label}…`)
    try {
      const planned = await planRunRoute({
        start: hub.location,
        distanceMiles: req.distanceMiles,
        varianceMiles: req.varianceMiles,
        maxClimbFeet: req.maxClimbFeet,
        optionCount: 1,
        onStatus: (m) => status(`${hub.label}: ${m}`),
      })
      const route = planned.routes[0]
      if (!route) continue
      const routingSnap = snapshotRoutingState()
      if (!routingSnap) continue
      hits.push({
        id: hub.id,
        name: hub.label,
        hub: hub.location,
        parking: hub.location,
        parkingLabel: hub.label,
        driveMiles,
        route,
        routingSnap,
      })
    } catch {
      // Skip lots that can't meet distance/climb
    }
  }

  if (hits.length === 0) {
    throw new Error(
      'Found parking, but none produced a run matching your distance/climb. Loosen climb or distance a bit.',
    )
  }

  hits.sort((a, b) => hitScore(a, req.maxClimbFeet) - hitScore(b, req.maxClimbFeet))
  return hits.slice(0, 5)
}
