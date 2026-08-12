import { fetchElevationsSoft } from './elevation'
import {
  destinationPoint,
  elevationGainFeet,
  haversineMeters,
  metersToFeet,
  milesToMeters,
  pathLengthMeters,
  type LatLng,
} from './geo'
import {
  buildGraph,
  collectEdgeKeys,
  DEFAULT_WEIGHTS,
  dijkstra,
  pathToLatLng,
  type DijkstraResult,
  type PathCostWeights,
  type RunGraph,
} from './graph'
import {
  connectedNodeIds,
  fetchOsmNetwork,
  nearestNodeId,
  type OsmNetwork,
} from './osm'

export type RouteRequest = {
  start: LatLng
  distanceMiles: number
  varianceMiles: number
  maxElevationChangeFeet: number
  onStatus?: (message: string) => void
}

export type RouteResult = {
  coordinates: LatLng[]
  elevationsM: number[]
  distanceMiles: number
  elevationGainFeet: number
  elevationRangeFeet: number
  signals: number
  crossings: number
  turns: number
  label: string
}

function densify(points: LatLng[], maxStepM = 40): LatLng[] {
  if (points.length < 2) return points
  const out: LatLng[] = [points[0]]
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const d = haversineMeters(a, b)
    const steps = Math.max(1, Math.ceil(d / maxStepM))
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      out.push({
        lat: a.lat + (b.lat - a.lat) * t,
        lng: a.lng + (b.lng - a.lng) * t,
      })
    }
  }
  return out
}

function mergePaths(paths: number[][]): number[] {
  const merged: number[] = []
  for (const path of paths) {
    if (!path.length) continue
    if (!merged.length) {
      merged.push(...path)
      continue
    }
    const start = path[0] === merged[merged.length - 1] ? 1 : 0
    for (let i = start; i < path.length; i++) merged.push(path[i])
  }
  return merged
}

function scoreRoute(
  stats: {
    lengthM: number
    elevGainM: number
    signals: number
    crossings: number
    turns: number
  },
  minM: number,
  maxM: number,
  maxElevGainM: number,
): number {
  // Soft preference: never reward under-distance, but keep a finite score so
  // the search can still track the closest attempt.
  const under = Math.max(0, minM - stats.lengthM)
  const over = Math.max(0, stats.lengthM - maxM)
  const elevOver = Math.max(0, stats.elevGainM - maxElevGainM)

  const lengthTarget = minM + Math.min(maxM - minM, minM * 0.08) * 0.5
  const lengthScore = -Math.abs(stats.lengthM - lengthTarget) / 40

  return (
    lengthScore -
    under * 2.5 -
    over / 18 -
    elevOver * 5 -
    stats.signals * 10 -
    stats.crossings * 5 -
    stats.turns * 1.5
  )
}

function summarizePath(
  parts: DijkstraResult[],
  kind: RouteKind = 'loop',
): RouteCandidate {
  return {
    kind,
    path: mergePaths(parts.map((p) => p.path)),
    lengthM: parts.reduce((s, p) => s + p.lengthM, 0),
    elevGainM: parts.reduce((s, p) => s + p.elevGainM, 0),
    signals: parts.reduce((s, p) => s + p.signals, 0),
    crossings: parts.reduce((s, p) => s + p.crossings, 0),
    turns: parts.reduce((s, p) => s + p.turns, 0),
  }
}

type RouteKind = 'loop' | 'out-and-back'

type RouteCandidate = {
  kind: RouteKind
  path: number[]
  lengthM: number
  elevGainM: number
  signals: number
  crossings: number
  turns: number
}

function findNearbyNodes(
  graph: RunGraph,
  target: LatLng,
  limit = 8,
): number[] {
  const scored: { id: number; d: number }[] = []
  for (const [id, pos] of graph.nodePos) {
    const d = haversineMeters(target, pos)
    if (d < 700) scored.push({ id, d })
  }
  scored.sort((a, b) => a.d - b.d)
  return scored.slice(0, limit).map((s) => s.id)
}

function elevGainAlongPath(graph: RunGraph, path: number[]): number {
  let gain = 0
  for (let i = 0; i < path.length - 1; i++) {
    const edge = (graph.adj.get(path[i]) ?? []).find((e) => e.to === path[i + 1])
    if (edge) gain += edge.elevGainM
  }
  return gain
}

/** Same path out and back — classic turnaround run */
function tryOutAndBack(
  graph: RunGraph,
  startId: number,
  farId: number,
  weights: PathCostWeights,
): RouteCandidate | null {
  const out = dijkstra(graph, startId, farId, weights)
  if (!out || out.path.length < 2) return null

  const backPath = [...out.path].reverse()
  const path = mergePaths([out.path, backPath])
  const backGain = elevGainAlongPath(graph, backPath)

  return {
    kind: 'out-and-back',
    path,
    lengthM: out.lengthM * 2,
    elevGainM: out.elevGainM + backGain,
    signals: out.signals * 2,
    crossings: out.crossings * 2,
    turns: out.turns * 2 + 1,
  }
}

function tryTwoLegLoop(
  graph: RunGraph,
  startId: number,
  farId: number,
  weights: PathCostWeights,
): RouteCandidate | null {
  const out = dijkstra(graph, startId, farId, weights)
  if (!out || out.path.length < 2) return null

  const avoid = collectEdgeKeys(out.path)
  const back = dijkstra(graph, farId, startId, weights, avoid)
  if (!back || back.path.length < 2) {
    // No distinct return path — treat as out-and-back instead
    return tryOutAndBack(graph, startId, farId, weights)
  }
  return summarizePath([out, back], 'loop')
}

function tryThreeLegLoop(
  graph: RunGraph,
  startId: number,
  aId: number,
  bId: number,
  weights: PathCostWeights,
): RouteCandidate | null {
  const leg1 = dijkstra(graph, startId, aId, weights)
  if (!leg1) return null
  const avoid1 = collectEdgeKeys(leg1.path)
  const leg2 = dijkstra(graph, aId, bId, weights, avoid1)
  if (!leg2) return null
  const avoid2 = new Set([...avoid1, ...collectEdgeKeys(leg2.path)])
  const leg3 = dijkstra(graph, bId, startId, weights, avoid2)
  if (!leg3) {
    const leg3Any = dijkstra(graph, bId, startId, weights)
    if (!leg3Any) return null
    return summarizePath([leg1, leg2, leg3Any], 'loop')
  }
  return summarizePath([leg1, leg2, leg3], 'loop')
}

async function elevationsForNetwork(
  network: OsmNetwork,
): Promise<Map<number, number>> {
  const connected = [...connectedNodeIds(network)]
  const points: LatLng[] = []
  const ids: number[] = []
  for (const id of connected) {
    const n = network.nodes.get(id)
    if (!n) continue
    ids.push(id)
    points.push({ lat: n.lat, lng: n.lng })
  }

  // Subsample for very large graphs, then nearest-fill
  const maxSamples = 180
  let elevMap = new Map<number, number>()
  if (points.length <= maxSamples) {
    const elevs = await fetchElevationsSoft(points)
    ids.forEach((id, i) => elevMap.set(id, elevs[i] ?? 0))
  } else {
    const step = Math.ceil(points.length / maxSamples)
    const samplePts: LatLng[] = []
    const sampleIds: number[] = []
    for (let i = 0; i < points.length; i += step) {
      samplePts.push(points[i])
      sampleIds.push(ids[i])
    }
    const elevs = await fetchElevationsSoft(samplePts)
    sampleIds.forEach((id, i) => elevMap.set(id, elevs[i] ?? 0))
    for (let i = 0; i < ids.length; i++) {
      if (!elevMap.has(ids[i])) {
        const nearestSample = Math.min(
          sampleIds.length - 1,
          Math.round(i / step),
        )
        elevMap.set(ids[i], elevMap.get(sampleIds[nearestSample]) ?? 0)
      }
    }
  }
  return elevMap
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export async function planRunRoute(req: RouteRequest): Promise<RouteResult> {
  const status = req.onStatus ?? (() => {})
  const minM = milesToMeters(req.distanceMiles)
  const maxM = milesToMeters(req.distanceMiles + req.varianceMiles)
  const maxElevGainM = req.maxElevationChangeFeet / 3.28084

  // Search radius: enough area for a loop of this length
  const radiusM = Math.min(5000, Math.max(1100, minM * 0.7))

  status('Loading streets & paths…')
  const network = await fetchOsmNetwork(req.start, radiusM)
  if (network.ways.length < 5) {
    throw new Error('Not enough walkable roads near that start point.')
  }

  status('Reading elevation…')
  const elevByNode = await elevationsForNetwork(network)
  const graph = buildGraph(network, elevByNode)

  const startId = nearestNodeId(network, req.start, 300)
  if (startId === null || !graph.adj.has(startId)) {
    throw new Error('Could not snap the start point to a walkable road.')
  }

  status('Searching for a quiet route…')

  // Out-and-back turnarounds sit near half the target distance;
  // loops sit nearer circumference/(2π) or similar.
  const idealLoopRadius = maxM / (2 * Math.PI)
  const outAndBackRadii = [minM * 0.42, minM * 0.5, minM * 0.58]
  const loopRadii = [
    minM * 0.42,
    minM * 0.5,
    idealLoopRadius * 1.1,
    idealLoopRadius * 1.4,
  ]

  const bearings: number[] = []
  for (let b = 0; b < 360; b += 24) bearings.push(b)

  const weightSets: PathCostWeights[] = [
    DEFAULT_WEIGHTS,
    { ...DEFAULT_WEIGHTS, signalPenalty: 260, crossingPenalty: 140, turnPenalty: 35 },
    { turnPenalty: 12, signalPenalty: 100, crossingPenalty: 50, elevGainPenalty: 3 },
  ]

  const search = {
    best: null as RouteCandidate | null,
    bestScore: -Infinity,
    closest: null as RouteCandidate | null,
    closestGap: Infinity,
  }
  let attempts = 0
  const maxAttempts = 140

  const consider = (
    candidate: RouteCandidate | null,
    scoreMaxM = maxM,
    scoreElev = maxElevGainM,
  ) => {
    if (!candidate || candidate.path.length < 3) return
    const gap = candidate.lengthM < minM ? minM - candidate.lengthM : 0
    if (gap < search.closestGap) {
      search.closestGap = gap
      search.closest = candidate
    }
    const s = scoreRoute(candidate, minM, scoreMaxM, scoreElev)
    if (s > search.bestScore) {
      search.bestScore = s
      search.best = candidate
    }
  }

  for (const weights of weightSets) {
    for (const bearing of bearings) {
      if (attempts++ > maxAttempts) break
      if (attempts % 6 === 0) await yieldToUi()

      // Prefer true out-and-backs — same path out, turn around, same path back
      for (const radius of outAndBackRadii) {
        const farPoint = destinationPoint(req.start, bearing, radius)
        for (const farId of findNearbyNodes(graph, farPoint, 4)) {
          if (farId === startId) continue
          consider(tryOutAndBack(graph, startId, farId, weights))
        }
      }

      // Alternate-return loops (two-leg) and triangle loops
      for (const radius of loopRadii) {
        const farPoint = destinationPoint(req.start, bearing, radius)
        for (const farId of findNearbyNodes(graph, farPoint, 3)) {
          if (farId === startId) continue
          consider(tryTwoLegLoop(graph, startId, farId, weights))
        }

        const aPoint = destinationPoint(req.start, bearing, radius)
        const bPoint = destinationPoint(req.start, bearing + 100, radius * 0.95)
        const aIds = findNearbyNodes(graph, aPoint, 2)
        const bIds = findNearbyNodes(graph, bPoint, 2)
        for (const aId of aIds) {
          for (const bId of bIds) {
            if (aId === startId || bId === startId || aId === bId) continue
            consider(tryThreeLegLoop(graph, startId, aId, bId, weights))
          }
        }
      }
    }
    if (attempts > maxAttempts) break
    if (
      search.best &&
      search.best.lengthM >= minM &&
      search.best.lengthM <= maxM
    ) {
      break
    }
  }

  // Fallback: stretch farther if everything was too short
  if (!search.best || search.best.lengthM < minM) {
    status('Stretching the route to meet distance…')
    const softWeights: PathCostWeights = {
      turnPenalty: 10,
      signalPenalty: 80,
      crossingPenalty: 40,
      elevGainPenalty: 2,
    }
    for (let bearing = 0; bearing < 360; bearing += 15) {
      for (const factor of [0.48, 0.55, 0.62, 0.7]) {
        const farPoint = destinationPoint(req.start, bearing, minM * factor)
        for (const farId of findNearbyNodes(graph, farPoint, 4)) {
          consider(
            tryOutAndBack(graph, startId, farId, softWeights),
            maxM * 1.25,
            maxElevGainM * 1.4,
          )
          consider(
            tryTwoLegLoop(graph, startId, farId, softWeights),
            maxM * 1.25,
            maxElevGainM * 1.4,
          )
        }
      }
    }
  }

  const best = search.best ?? search.closest

  if (!best || best.path.length < 3) {
    throw new Error(
      'Could not build a route with those constraints. Try a larger variance or elevation budget.',
    )
  }

  if (best.lengthM < minM) {
    throw new Error(
      `Best route found was ${(best.lengthM / 1609.344).toFixed(2)} mi — under your ${req.distanceMiles} mi minimum. Increase variance or pick a denser street/path area.`,
    )
  }

  status('Building map & elevation profile…')
  let coordinates = pathToLatLng(graph, best.path)
  // Ensure we finish at the start when the graph path is slightly open
  if (
    coordinates.length &&
    haversineMeters(coordinates[0], coordinates[coordinates.length - 1]) > 15
  ) {
    coordinates = [...coordinates, coordinates[0]]
  }

  const dense = densify(coordinates, 60)
  // Sample elevation along the route without hammering the API
  const sampleEvery = Math.max(1, Math.ceil(dense.length / 120))
  const samplePts = dense.filter((_, i) => i % sampleEvery === 0 || i === dense.length - 1)
  const sampleElevs = await fetchElevationsSoft(samplePts)
  const elevationsM = dense.map((_, i) => {
    const idx = Math.min(sampleElevs.length - 1, Math.round(i / sampleEvery))
    return sampleElevs[idx] ?? 0
  })
  const distanceMiles = pathLengthMeters(dense) / 1609.344
  const elevGain = elevationGainFeet(elevationsM)
  const elevMin = Math.min(...elevationsM)
  const elevMax = Math.max(...elevationsM)

  if (distanceMiles < req.distanceMiles) {
    throw new Error(
      `Routed distance came out under target (${distanceMiles.toFixed(2)} mi). Try increasing variance slightly.`,
    )
  }

  return {
    coordinates: dense,
    elevationsM,
    distanceMiles,
    elevationGainFeet: elevGain,
    elevationRangeFeet: metersToFeet(elevMax - elevMin),
    signals: best.signals,
    crossings: best.crossings,
    turns: best.turns,
    label: best.kind === 'out-and-back' ? 'Out and back' : 'Loop',
  }
}
