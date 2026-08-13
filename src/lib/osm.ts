import type { LatLng } from './geo'
import { haversineMeters } from './geo'

export type OsmNode = {
  id: number
  lat: number
  lng: number
  isSignal: boolean
  isCrossing: boolean
}

export type OsmWay = {
  id: number
  nodeIds: number[]
  highway: string
}

export type OsmNetwork = {
  nodes: Map<number, OsmNode>
  ways: OsmWay[]
  signals: LatLng[]
  crossings: LatLng[]
}

type OverpassElement =
  | {
      type: 'node'
      id: number
      lat: number
      lon: number
      tags?: Record<string, string>
    }
  | {
      type: 'way'
      id: number
      nodes?: number[]
      tags?: Record<string, string>
      geometry?: Array<{ lat: number; lon: number }>
    }

const WALKABLE =
  'footway|path|pedestrian|living_street|residential|unclassified|tertiary|secondary|cycleway|track|service'

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

export async function overpassQuery(query: string): Promise<OverpassElement[]> {
  let lastError: Error | null = null

  for (const endpoint of ENDPOINTS) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 70_000)
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      })
      clearTimeout(timer)

      if (!res.ok) {
        lastError = new Error(`Street data unavailable (${res.status}).`)
        continue
      }

      const text = await res.text()
      if (text.trimStart().startsWith('<')) {
        lastError = new Error('Street data server is busy. Try again.')
        continue
      }

      const data = JSON.parse(text) as { elements: OverpassElement[] }
      return data.elements ?? []
    } catch (err) {
      lastError =
        err instanceof Error
          ? err.name === 'AbortError'
            ? new Error('Street data request timed out. Try again.')
            : err
          : new Error(String(err))
    }
  }

  throw lastError ?? new Error('Failed to load street network.')
}

function coordKey(lat: number, lng: number): string {
  return `${lat.toFixed(6)},${lng.toFixed(6)}`
}

export async function fetchOsmNetwork(
  center: LatLng,
  radiusM: number,
): Promise<OsmNetwork> {
  const r = Math.ceil(Math.min(radiusM, 3500))

  const waysQuery = `
[out:json][timeout:50];
way["highway"~"${WALKABLE}"]["area"!~"yes"](around:${r},${center.lat},${center.lng});
out geom;
`.trim()

  const hazardsQuery = `
[out:json][timeout:25];
(
  node["highway"="traffic_signals"](around:${r},${center.lat},${center.lng});
  node["crossing"="traffic_signals"](around:${r},${center.lat},${center.lng});
  node["traffic_signals"](around:${r},${center.lat},${center.lng});
  node["highway"="crossing"](around:${r},${center.lat},${center.lng});
);
out body;
`.trim()

  const [wayElements, hazardElements] = await Promise.all([
    overpassQuery(waysQuery),
    overpassQuery(hazardsQuery).catch(() => [] as OverpassElement[]),
  ])

  return parseNetwork(wayElements, hazardElements)
}

function parseNetwork(
  wayElements: OverpassElement[],
  hazardElements: OverpassElement[],
): OsmNetwork {
  const nodes = new Map<number, OsmNode>()
  const ways: OsmWay[] = []
  const signals: LatLng[] = []
  const crossings: LatLng[] = []
  const idByCoord = new Map<string, number>()
  let nextId = 1

  const getOrCreateNode = (lat: number, lng: number): number => {
    const key = coordKey(lat, lng)
    const existing = idByCoord.get(key)
    if (existing !== undefined) return existing
    const id = nextId++
    idByCoord.set(key, id)
    nodes.set(id, {
      id,
      lat,
      lng,
      isSignal: false,
      isCrossing: false,
    })
    return id
  }

  for (const el of wayElements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue
    const nodeIds = el.geometry.map((g) => getOrCreateNode(g.lat, g.lon))
    ways.push({
      id: el.id,
      nodeIds,
      highway: el.tags?.highway ?? 'road',
    })
  }

  const markNear = (
    point: LatLng,
    flag: 'isSignal' | 'isCrossing',
    bucket: LatLng[],
  ) => {
    bucket.push(point)
    // Tag every nearby graph vertex — intersections often have several nodes
    for (const node of nodes.values()) {
      if (haversineMeters(point, node) <= 45) {
        node[flag] = true
      }
    }
  }

  for (const el of hazardElements) {
    if (el.type !== 'node') continue
    const point = { lat: el.lat, lng: el.lon }
    const tags = el.tags ?? {}
    const isSignal =
      tags.highway === 'traffic_signals' ||
      tags.crossing === 'traffic_signals' ||
      tags.traffic_signals !== undefined
    if (isSignal) {
      markNear(point, 'isSignal', signals)
    }
    if (tags.highway === 'crossing' || tags.crossing !== undefined) {
      markNear(point, 'isCrossing', crossings)
    }
  }

  return { nodes, ways, signals, crossings }
}

export function nearestNodeId(
  network: OsmNetwork,
  point: LatLng,
  maxM = 250,
): number | null {
  const connected = connectedNodeIds(network)
  let bestId: number | null = null
  let bestDist = Infinity

  for (const id of connected) {
    const node = network.nodes.get(id)
    if (!node) continue
    const d = haversineMeters(point, node)
    if (d < bestDist) {
      bestDist = d
      bestId = id
    }
  }

  if (bestId === null || bestDist > maxM) return null
  return bestId
}

export function connectedNodeIds(network: OsmNetwork): Set<number> {
  const connected = new Set<number>()
  for (const way of network.ways) {
    for (const id of way.nodeIds) connected.add(id)
  }
  return connected
}
