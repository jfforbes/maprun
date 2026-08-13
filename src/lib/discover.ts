import { haversineMeters, milesToMeters, type LatLng } from './geo'
import { overpassQuery } from './osm'
import { planRunRoute, snapshotRoutingState, type RouteResult, type RoutingSnapshot } from './router'

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
  natureKind: string
  natureScore: number
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

type NaturePlace = {
  id: string
  name: string
  kind: string
  score: number
  center: LatLng
}

type ParkingSpot = {
  id: string
  label: string
  location: LatLng
}

const NATURE_WEIGHTS: Record<string, number> = {
  nature_reserve: 100,
  national_park: 98,
  protected_area: 92,
  forest: 88,
  wood: 84,
  park: 72,
  recreation_ground: 55,
  garden: 48,
  grassland: 42,
}

function placeCenter(el: OsmCenterEl): LatLng | null {
  if (el.center) return { lat: el.center.lat, lng: el.center.lon }
  if (el.lat != null && el.lon != null) return { lat: el.lat, lng: el.lon }
  return null
}

function natureFromElement(el: OsmCenterEl): NaturePlace | null {
  const tags = el.tags ?? {}
  const center = placeCenter(el)
  if (!center) return null

  let kind = ''
  let score = 0
  if (tags.boundary === 'national_park' || tags.protect_class === '2') {
    kind = 'national_park'
    score = NATURE_WEIGHTS.national_park
  } else if (tags.leisure === 'nature_reserve' || tags.boundary === 'protected_area') {
    kind = tags.leisure === 'nature_reserve' ? 'nature_reserve' : 'protected_area'
    score = NATURE_WEIGHTS[kind]
  } else if (tags.landuse === 'forest' || tags.natural === 'wood') {
    kind = tags.landuse === 'forest' ? 'forest' : 'wood'
    score = NATURE_WEIGHTS[kind]
  } else if (tags.leisure === 'park') {
    kind = 'park'
    score = NATURE_WEIGHTS.park
  } else if (tags.leisure === 'garden') {
    kind = 'garden'
    score = NATURE_WEIGHTS.garden
  } else if (tags.leisure === 'recreation_ground') {
    kind = 'recreation_ground'
    score = NATURE_WEIGHTS.recreation_ground
  } else if (tags.natural === 'grassland') {
    kind = 'grassland'
    score = NATURE_WEIGHTS.grassland
  } else {
    return null
  }

  const name =
    tags.name?.trim() ||
    tags['name:en']?.trim() ||
    `${kind.replace(/_/g, ' ')} area`

  // Named places are much more useful as drive-to destinations
  if (tags.name || tags['name:en']) score += 18
  // Prefer larger tagged areas when we can see them
  if (el.type === 'relation') score += 8
  else if (el.type === 'way') score += 3

  return {
    id: `${el.type}-${el.id}`,
    name,
    kind,
    score,
    center,
  }
}

function parkingFromElement(el: OsmCenterEl): ParkingSpot | null {
  const tags = el.tags ?? {}
  if (tags.amenity !== 'parking') return null
  const center = placeCenter(el)
  if (!center) return null
  const label =
    tags.name?.trim() ||
    tags['parking']?.replace(/_/g, ' ') ||
    'Parking'
  return {
    id: `${el.type}-${el.id}`,
    label,
    location: center,
  }
}

async function fetchNatureAndParking(
  home: LatLng,
  radiusM: number,
  onStatus: (m: string) => void,
): Promise<{ places: NaturePlace[]; parking: ParkingSpot[] }> {
  const r = Math.ceil(Math.min(radiusM, 45000))
  onStatus('Finding parks, trails & parking…')

  const query = `
[out:json][timeout:60];
(
  way["leisure"="park"](around:${r},${home.lat},${home.lng});
  relation["leisure"="park"](around:${r},${home.lat},${home.lng});
  way["leisure"="nature_reserve"](around:${r},${home.lat},${home.lng});
  relation["leisure"="nature_reserve"](around:${r},${home.lat},${home.lng});
  way["boundary"="national_park"](around:${r},${home.lat},${home.lng});
  relation["boundary"="national_park"](around:${r},${home.lat},${home.lng});
  way["boundary"="protected_area"](around:${r},${home.lat},${home.lng});
  relation["boundary"="protected_area"](around:${r},${home.lat},${home.lng});
  way["landuse"="forest"](around:${r},${home.lat},${home.lng});
  relation["landuse"="forest"](around:${r},${home.lat},${home.lng});
  way["natural"="wood"](around:${r},${home.lat},${home.lng});
  way["leisure"="garden"]["name"](around:${r},${home.lat},${home.lng});
  node["amenity"="parking"](around:${r},${home.lat},${home.lng});
  way["amenity"="parking"](around:${r},${home.lat},${home.lng});
);
out center tags;
`.trim()

  const elements = (await overpassQuery(query)) as OsmCenterEl[]
  const places: NaturePlace[] = []
  const parking: ParkingSpot[] = []

  for (const el of elements) {
    const nature = natureFromElement(el)
    if (nature) places.push(nature)
    const lot = parkingFromElement(el)
    if (lot) parking.push(lot)
  }

  return { places, parking }
}

type HubCandidate = {
  place: NaturePlace
  parking: ParkingSpot
  parkingDistM: number
  driveMiles: number
  rank: number
}

function buildHubs(
  home: LatLng,
  places: NaturePlace[],
  parking: ParkingSpot[],
  maxHubs: number,
): HubCandidate[] {
  const maxParkingWalkM = 700
  const minSeparationM = 1800
  const hubs: HubCandidate[] = []

  const scored = places
    .map((place) => {
      let best: ParkingSpot | null = null
      let bestDist = Infinity
      for (const lot of parking) {
        const d = haversineMeters(place.center, lot.location)
        if (d < bestDist) {
          bestDist = d
          best = lot
        }
      }
      if (!best || bestDist > maxParkingWalkM) return null
      const driveMiles = haversineMeters(home, best.location) / 1609.344
      // Prefer nature quality, then nearby parking, slight preference for closer drives
      const rank =
        place.score * 10 -
        bestDist / 40 -
        driveMiles * 2
      return {
        place,
        parking: best,
        parkingDistM: bestDist,
        driveMiles,
        rank,
      } satisfies HubCandidate
    })
    .filter((h): h is HubCandidate => h !== null)
    .sort((a, b) => b.rank - a.rank)

  for (const hub of scored) {
    if (hubs.length >= maxHubs) break
    if (
      hubs.some(
        (h) =>
          haversineMeters(h.place.center, hub.place.center) < minSeparationM,
      )
    ) {
      continue
    }
    hubs.push(hub)
  }

  return hubs
}

function hitScore(hit: DiscoverHit, maxClimbFeet: number): number {
  const climbOver = Math.max(0, hit.route.elevationGainFeet - maxClimbFeet)
  // Destination ranking: nature first, then climb, lights, turns, drive time
  return (
    hit.natureScore * 20 -
    hit.route.elevationGainFeet * 2 -
    climbOver * 4 -
    hit.route.signals * 25 -
    hit.route.turns * 1.5 -
    hit.route.crossings * 0.5 -
    hit.driveMiles * 3
  )
}

/**
 * Find drive-to nature runs with nearby parking that match distance/climb prefs.
 */
export async function discoverRuns(
  req: DiscoverRequest,
): Promise<DiscoverHit[]> {
  const status = req.onStatus ?? (() => {})
  const radiusM = milesToMeters(req.searchRadiusMiles)

  if (req.searchRadiusMiles <= 0 || req.searchRadiusMiles > 40) {
    throw new Error('Search radius should be between 1 and 40 miles.')
  }

  const { places, parking } = await fetchNatureAndParking(
    req.home,
    radiusM,
    status,
  )

  if (places.length < 3) {
    throw new Error(
      'Not enough parks or nature areas found in that radius. Try a larger search radius.',
    )
  }
  if (parking.length < 3) {
    throw new Error(
      'Not enough mapped parking near nature areas. Try a larger search radius.',
    )
  }

  const hubs = buildHubs(req.home, places, parking, 6)
  if (hubs.length === 0) {
    throw new Error(
      'Found nature areas, but none with parking close enough to start a run.',
    )
  }

  const hits: DiscoverHit[] = []

  for (let i = 0; i < hubs.length; i++) {
    const hub = hubs[i]
    status(
      `Routing ${i + 1}/${hubs.length}: ${hub.place.name}…`,
    )
    try {
      const planned = await planRunRoute({
        start: hub.parking.location,
        distanceMiles: req.distanceMiles,
        varianceMiles: req.varianceMiles,
        maxClimbFeet: req.maxClimbFeet,
        optionCount: 1,
        onStatus: (m) => status(`${hub.place.name}: ${m}`),
      })
      const route = planned.routes[0]
      if (!route) continue
      const routingSnap = snapshotRoutingState()
      if (!routingSnap) continue
      hits.push({
        id: hub.place.id,
        name: hub.place.name,
        natureKind: hub.place.kind.replace(/_/g, ' '),
        natureScore: hub.place.score,
        hub: hub.place.center,
        parking: hub.parking.location,
        parkingLabel: hub.parking.label,
        driveMiles: Math.round(hub.driveMiles * 10) / 10,
        route,
        routingSnap,
      })
    } catch {
      // Skip hubs that can't meet distance/climb — try the next nature spot
    }
  }

  if (hits.length === 0) {
    throw new Error(
      'Found nature parking spots, but none produced a run matching your distance/climb. Loosen climb or distance a bit.',
    )
  }

  hits.sort(
    (a, b) => hitScore(b, req.maxClimbFeet) - hitScore(a, req.maxClimbFeet),
  )
  return hits.slice(0, 5)
}
