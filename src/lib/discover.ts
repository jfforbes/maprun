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
  allowLights?: boolean
  onStatus?: (message: string) => void
  onProgress?: (fraction: number) => void
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
  kind: 'lot' | 'street'
  named: boolean
}

const STREET_PARKING_KINDS = new Set([
  'street_side',
  'lane',
  'on_kerb',
  'layby',
  'on_street',
  'shoulder',
])

const STREET_LANE_YES =
  /^(parallel|diagonal|perpendicular|marked|yes|parking)$/i
const STREET_PARKING_YES = /^(lane|street_side|on_street|yes)$/i

function parkingKindLabel(kind: string, streetName?: string): string {
  if (streetName) return `Street parking · ${streetName}`
  if (STREET_PARKING_KINDS.has(kind) || kind === 'street') return 'Street parking'
  if (kind === 'park_and_ride') return 'Park & ride'
  if (kind === 'surface' || kind === 'lot' || !kind) return 'Parking lot'
  return 'Parking lot'
}

function hasStreetParkingTags(tags: Record<string, string>): boolean {
  const keys = [
    'parking:lane:both',
    'parking:lane:left',
    'parking:lane:right',
  ]
  for (const key of keys) {
    if (STREET_LANE_YES.test(tags[key] ?? '')) return true
  }
  for (const key of ['parking:both', 'parking:left', 'parking:right']) {
    if (STREET_PARKING_YES.test(tags[key] ?? '')) return true
  }
  return false
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
  const access = (tags.access ?? '').toLowerCase()
  if (['private', 'no', 'customers', 'permit'].includes(access)) return null
  if ((tags.parking ?? '').toLowerCase() === 'private') return null

  const center = placeCenter(el)
  if (!center) return null

  const amenityKind = (tags.parking ?? '').toLowerCase()
  if (['garage', 'multi-storey', 'underground', 'rooftop'].includes(amenityKind)) {
    return null
  }

  const streetFromLane = hasStreetParkingTags(tags)
  const isStreetAmenity =
    tags.amenity === 'parking' && STREET_PARKING_KINDS.has(amenityKind)
  const isLot = tags.amenity === 'parking' && !isStreetAmenity

  if (!isLot && !isStreetAmenity && !streetFromLane) return null

  const kind: 'lot' | 'street' =
    isLot && !streetFromLane ? 'lot' : 'street'
  const streetName =
    kind === 'street'
      ? tags.name?.trim() || tags['name:en']?.trim()
      : undefined
  const named = Boolean(
    (kind === 'lot' && tags.name?.trim()) ||
      (kind === 'street' && streetName),
  )
  const label =
    kind === 'lot'
      ? tags.name?.trim() || parkingKindLabel(amenityKind || 'lot')
      : parkingKindLabel(amenityKind || 'street', streetName)

  return {
    id: `${el.type}-${el.id}`,
    label,
    location: center,
    kind,
    named,
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
  way["highway"]["name"]["parking:lane:both"~"^(parallel|diagonal|perpendicular|marked|yes)$"](around:${r},${home.lat},${home.lng});
  way["highway"]["name"]["parking:lane:left"~"^(parallel|diagonal|perpendicular|marked|yes)$"](around:${r},${home.lat},${home.lng});
  way["highway"]["name"]["parking:lane:right"~"^(parallel|diagonal|perpendicular|marked|yes)$"](around:${r},${home.lat},${home.lng});
  way["highway"]["name"]["parking:both"~"^(lane|street_side|on_street)$"](around:${r},${home.lat},${home.lng});
  way["highway"]["name"]["parking:left"~"^(lane|street_side|on_street)$"](around:${r},${home.lat},${home.lng});
  way["highway"]["name"]["parking:right"~"^(lane|street_side|on_street)$"](around:${r},${home.lat},${home.lng});
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
      if (a.spot.named !== b.spot.named) return a.spot.named ? -1 : 1
      return Math.abs(a.driveM - targetRing) - Math.abs(b.driveM - targetRing)
    })

  const hubs: ParkingSpot[] = []
  const sectorUsed = new Set<number>()
  const sectors = 8

  const wantStreet = Math.min(
    2,
    candidates.filter((c) => c.spot.kind === 'street').length,
  )

  for (const { spot } of candidates) {
    if (hubs.length >= maxHubs) break
    const sector = Math.floor(bearingFrom(home, spot.location) / (360 / sectors))
    if (sectorUsed.has(sector) && hubs.length < sectors) continue
    if (hubs.some((h) => haversineMeters(h.location, spot.location) < minSeparationM)) {
      continue
    }
    const streetCount = hubs.filter((h) => h.kind === 'street').length
    if (
      spot.kind === 'lot' &&
      streetCount < wantStreet &&
      hubs.length >= maxHubs - (wantStreet - streetCount)
    ) {
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
  const progress = req.onProgress ?? (() => {})
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
    progress(i / hubs.length)
    try {
      const planned = await planRunRoute({
        start: hub.location,
        distanceMiles: req.distanceMiles,
        varianceMiles: req.varianceMiles,
        maxClimbFeet: req.maxClimbFeet,
        allowLights: req.allowLights,
        optionCount: 1,
        onStatus: (m) => status(`${hub.label}: ${m}`),
        onProgress: (p) => progress((i + p) / hubs.length),
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
