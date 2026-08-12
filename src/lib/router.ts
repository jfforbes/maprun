import { fetchElevationsSoft } from './elevation'
import {
  destinationPoint,
  displayMiles,
  elevationChangeFeet,
  elevationGainFeet,
  elevationLossFeet,
  haversineMeters,
  metersToFeet,
  milesToMeters,
  pathLengthMeters,
  turnAngleDegrees,
  type LatLng,
} from './geo'
import {
  buildGraph,
  collectEdgeKeys,
  createDijkstraCache,
  DEFAULT_WEIGHTS,
  nearestGraphNodeId,
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
  elevationLossFeet: number
  elevationChangeFeet: number
  elevationRangeFeet: number
  signals: number
  crossings: number
  turns: number
  label: string
  /** Mid-route handles the user can drag (excludes fixed start/end). */
  controlPoints: LatLng[]
}

type RouteKind = 'loop' | 'out-and-back' | 'edited'

type RouteCandidate = {
  kind: RouteKind
  path: number[]
  lengthM: number
  elevGainM: number
  elevLossM: number
  signals: number
  crossings: number
  turns: number
}

type DijkstraFn = (
  graph: RunGraph,
  startId: number,
  endId: number,
  weights?: PathCostWeights,
  avoidEdgeKeys?: Set<string>,
) => DijkstraResult | null

export type RouteSession = {
  graph: RunGraph
  nodePath: number[]
  kind: RouteKind
  /** Indexes into nodePath for all handles, including start/end. */
  controlIndexes: number[]
  start: LatLng
}

let activeSession: RouteSession | null = null

export function getActiveSession(): RouteSession | null {
  return activeSession
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
    elevLossM: number
    signals: number
    crossings: number
    turns: number
  },
  minM: number,
  maxM: number,
  maxElevChangeM: number,
): number {
  const under = Math.max(0, minM - stats.lengthM)
  const over = Math.max(0, stats.lengthM - maxM)
  const elevChange = stats.elevGainM + stats.elevLossM
  const elevOver = Math.max(0, elevChange - maxElevChangeM)

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
    elevLossM: parts.reduce((s, p) => s + p.elevLossM, 0),
    signals: parts.reduce((s, p) => s + p.signals, 0),
    crossings: parts.reduce((s, p) => s + p.crossings, 0),
    turns: parts.reduce((s, p) => s + p.turns, 0),
  }
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

function elevAlongPath(
  graph: RunGraph,
  path: number[],
): { gain: number; loss: number } {
  let gain = 0
  let loss = 0
  for (let i = 0; i < path.length - 1; i++) {
    const edge = (graph.adj.get(path[i]) ?? []).find((e) => e.to === path[i + 1])
    if (edge) {
      gain += edge.elevGainM
      loss += edge.elevLossM
    }
  }
  return { gain, loss }
}

/** Same path out and back — reverse the outbound polyline exactly */
function tryOutAndBack(
  graph: RunGraph,
  startId: number,
  farId: number,
  weights: PathCostWeights,
  findPath: DijkstraFn,
): RouteCandidate | null {
  const out = findPath(graph, startId, farId, weights)
  if (!out || out.path.length < 2) return null

  const backPath = [...out.path].reverse()
  const path = mergePaths([out.path, backPath])
  const back = elevAlongPath(graph, backPath)

  return {
    kind: 'out-and-back',
    path,
    lengthM: out.lengthM * 2,
    elevGainM: out.elevGainM + back.gain,
    elevLossM: out.elevLossM + back.loss,
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
  findPath: DijkstraFn,
): RouteCandidate | null {
  const out = findPath(graph, startId, farId, weights)
  if (!out || out.path.length < 2) return null

  const avoid = collectEdgeKeys(out.path)
  const back = findPath(graph, farId, startId, weights, avoid)
  if (!back || back.path.length < 2) {
    return tryOutAndBack(graph, startId, farId, weights, findPath)
  }
  return summarizePath([out, back], 'loop')
}

function tryThreeLegLoop(
  graph: RunGraph,
  startId: number,
  aId: number,
  bId: number,
  weights: PathCostWeights,
  findPath: DijkstraFn,
): RouteCandidate | null {
  const leg1 = findPath(graph, startId, aId, weights)
  if (!leg1) return null
  const avoid1 = collectEdgeKeys(leg1.path)
  const leg2 = findPath(graph, aId, bId, weights, avoid1)
  if (!leg2) return null
  const avoid2 = new Set([...avoid1, ...collectEdgeKeys(leg2.path)])
  const leg3 = findPath(graph, bId, startId, weights, avoid2)
  if (!leg3) {
    const leg3Any = findPath(graph, bId, startId, weights)
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

  const maxSamples = 180
  const elevMap = new Map<number, number>()
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

function buildControlIndexes(graph: RunGraph, path: number[], spacingM = 480): number[] {
  if (path.length < 2) return path.map((_, i) => i)
  const indexes = [0]
  let acc = 0
  for (let i = 1; i < path.length - 1; i++) {
    const a = graph.nodePos.get(path[i - 1])
    const b = graph.nodePos.get(path[i])
    if (!a || !b) continue
    acc += haversineMeters(a, b)
    if (acc >= spacingM) {
      indexes.push(i)
      acc = 0
    }
  }
  indexes.push(path.length - 1)
  return indexes
}

function controlPointsFromSession(session: RouteSession): LatLng[] {
  const points: LatLng[] = []
  // Skip first/last — those stay fixed at the start
  for (let i = 1; i < session.controlIndexes.length - 1; i++) {
    const nodeId = session.nodePath[session.controlIndexes[i]]
    const pos = session.graph.nodePos.get(nodeId)
    if (pos) points.push(pos)
  }
  return points
}

async function finalizeRoute(
  graph: RunGraph,
  candidate: RouteCandidate,
  start: LatLng,
  minDistanceMiles: number,
): Promise<RouteResult> {
  let coordinates = pathToLatLng(graph, candidate.path)
  if (
    coordinates.length &&
    haversineMeters(coordinates[0], coordinates[coordinates.length - 1]) > 15
  ) {
    coordinates = [...coordinates, coordinates[0]]
  }

  const dense = densify(coordinates, 60)
  const sampleEvery = Math.max(1, Math.ceil(dense.length / 120))
  const samplePts = dense.filter(
    (_, i) => i % sampleEvery === 0 || i === dense.length - 1,
  )
  const sampleElevs = await fetchElevationsSoft(samplePts)
  const elevationsM = dense.map((_, i) => {
    const idx = Math.min(sampleElevs.length - 1, Math.round(i / sampleEvery))
    return sampleElevs[idx] ?? 0
  })
  const distanceMiles = displayMiles(pathLengthMeters(dense))
  const elevGain = elevationGainFeet(elevationsM)
  const elevLoss = elevationLossFeet(elevationsM)
  const elevChange = elevationChangeFeet(elevationsM)
  const elevMin = Math.min(...elevationsM)
  const elevMax = Math.max(...elevationsM)

  if (distanceMiles < minDistanceMiles) {
    throw new Error(
      `Routed distance came out under target (${distanceMiles.toFixed(2)} mi). Try increasing variance slightly.`,
    )
  }

  const controlIndexes = buildControlIndexes(graph, candidate.path)
  activeSession = {
    graph,
    nodePath: candidate.path,
    kind: candidate.kind,
    controlIndexes,
    start,
  }

  const label =
    candidate.kind === 'out-and-back'
      ? 'Out and back'
      : candidate.kind === 'edited'
        ? 'Edited route'
        : 'Loop'

  return {
    coordinates: dense,
    elevationsM,
    distanceMiles,
    elevationGainFeet: elevGain,
    elevationLossFeet: elevLoss,
    elevationChangeFeet: elevChange,
    elevationRangeFeet: metersToFeet(elevMax - elevMin),
    signals: candidate.signals,
    crossings: candidate.crossings,
    turns: candidate.turns,
    label,
    controlPoints: controlPointsFromSession(activeSession),
  }
}

export async function planRunRoute(req: RouteRequest): Promise<RouteResult> {
  const status = req.onStatus ?? (() => {})
  const minM = milesToMeters(req.distanceMiles)
  const maxM = milesToMeters(req.distanceMiles + req.varianceMiles)
  const maxElevChangeM = req.maxElevationChangeFeet / 3.28084

  const radiusM = Math.min(5000, Math.max(1100, minM * 0.7))

  status('Loading streets & paths…')
  const network = await fetchOsmNetwork(req.start, radiusM)
  if (network.ways.length < 5) {
    throw new Error('Not enough walkable roads near that start point.')
  }

  status('Reading elevation…')
  const elevByNode = await elevationsForNetwork(network)
  const graph = buildGraph(network, elevByNode)
  const findPath = createDijkstraCache()

  const startId = nearestNodeId(network, req.start, 300)
  if (startId === null || !graph.adj.has(startId)) {
    throw new Error('Could not snap the start point to a walkable road.')
  }

  status('Searching for a quiet route…')

  const outAndBackRadii = [minM * 0.45, minM * 0.5, minM * 0.55]
  const loopRadii = [minM * 0.42, minM * 0.5, maxM / (2 * Math.PI) * 1.2]

  const bearings: number[] = []
  for (let b = 0; b < 360; b += 30) bearings.push(b)

  const weightSets: PathCostWeights[] = [
    DEFAULT_WEIGHTS,
    { ...DEFAULT_WEIGHTS, signalPenalty: 260, crossingPenalty: 140, turnPenalty: 35 },
  ]

  const search = {
    best: null as RouteCandidate | null,
    bestScore: -Infinity,
    closest: null as RouteCandidate | null,
    closestGap: Infinity,
  }

  const consider = (
    candidate: RouteCandidate | null,
    scoreMaxM = maxM,
    scoreElev = maxElevChangeM,
  ) => {
    if (!candidate || candidate.path.length < 3) return
    const gap =
      displayMiles(candidate.lengthM) < req.distanceMiles
        ? minM - candidate.lengthM
        : 0
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

  let attempts = 0

  // Pass 1: same-path out-and-backs only (fast + matches classic turnaround runs)
  for (const weights of weightSets) {
    for (const bearing of bearings) {
      if (++attempts % 8 === 0) await yieldToUi()
      for (const radius of outAndBackRadii) {
        const farPoint = destinationPoint(req.start, bearing, radius)
        for (const farId of findNearbyNodes(graph, farPoint, 3)) {
          if (farId === startId) continue
          consider(tryOutAndBack(graph, startId, farId, weights, findPath))
        }
      }
    }
    if (
      search.best &&
      displayMiles(search.best.lengthM) >= req.distanceMiles &&
      search.best.lengthM <= maxM
    ) {
      break
    }
  }

  // Pass 2: loops only if out-and-back didn't land in range
  if (
    !search.best ||
    displayMiles(search.best.lengthM) < req.distanceMiles ||
    search.best.lengthM > maxM
  ) {
    status('Trying loop alternatives…')
    for (const weights of weightSets) {
      for (const bearing of bearings) {
        if (++attempts % 6 === 0) await yieldToUi()
        for (const radius of loopRadii) {
          const farPoint = destinationPoint(req.start, bearing, radius)
          for (const farId of findNearbyNodes(graph, farPoint, 2)) {
            if (farId === startId) continue
            consider(tryTwoLegLoop(graph, startId, farId, weights, findPath))
          }

          const aPoint = destinationPoint(req.start, bearing, radius)
          const bPoint = destinationPoint(req.start, bearing + 100, radius * 0.95)
          const aIds = findNearbyNodes(graph, aPoint, 2)
          const bIds = findNearbyNodes(graph, bPoint, 2)
          for (const aId of aIds) {
            for (const bId of bIds) {
              if (aId === startId || bId === startId || aId === bId) continue
              consider(tryThreeLegLoop(graph, startId, aId, bId, weights, findPath))
            }
          }
        }
      }
      if (
        search.best &&
        displayMiles(search.best.lengthM) >= req.distanceMiles &&
        search.best.lengthM <= maxM
      ) {
        break
      }
    }
  }

  if (!search.best || displayMiles(search.best.lengthM) < req.distanceMiles) {
    status('Stretching the route to meet distance…')
    const softWeights: PathCostWeights = {
      turnPenalty: 10,
      signalPenalty: 80,
      crossingPenalty: 40,
      elevGainPenalty: 2,
    }
    for (let bearing = 0; bearing < 360; bearing += 20) {
      for (const factor of [0.48, 0.55, 0.62]) {
        const farPoint = destinationPoint(req.start, bearing, minM * factor)
        for (const farId of findNearbyNodes(graph, farPoint, 3)) {
          consider(
            tryOutAndBack(graph, startId, farId, softWeights, findPath),
            maxM * 1.25,
            maxElevChangeM * 1.4,
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

  if (displayMiles(best.lengthM) < req.distanceMiles) {
    throw new Error(
      `Best route found was ${displayMiles(best.lengthM).toFixed(2)} mi — under your ${req.distanceMiles} mi minimum. Increase variance or pick a denser street/path area.`,
    )
  }

  status('Building map & elevation profile…')
  return finalizeRoute(graph, best, req.start, req.distanceMiles)
}

/**
 * Drag a mid-route handle. `handleIndex` is into the visible controlPoints array
 * (not including start/end).
 */
export async function dragRouteHandle(
  handleIndex: number,
  to: LatLng,
): Promise<RouteResult> {
  const session = activeSession
  if (!session) throw new Error('No active route to edit. Route a run first.')

  // controlIndexes: [start, h0, h1, ..., end] — visible handles are middle ones
  const controlIdx = handleIndex + 1
  if (controlIdx <= 0 || controlIdx >= session.controlIndexes.length - 1) {
    throw new Error('That handle cannot be moved.')
  }

  const prevPathIdx = session.controlIndexes[controlIdx - 1]
  const nextPathIdx = session.controlIndexes[controlIdx + 1]
  const prevNode = session.nodePath[prevPathIdx]
  const nextNode = session.nodePath[nextPathIdx]

  const snapped = nearestGraphNodeId(session.graph, to, 300)
  if (snapped === null) {
    throw new Error('Could not snap that point to a nearby path.')
  }

  const findPath = createDijkstraCache()
  const leg1 = findPath(session.graph, prevNode, snapped, DEFAULT_WEIGHTS)
  const leg2 = findPath(session.graph, snapped, nextNode, DEFAULT_WEIGHTS)
  if (!leg1 || !leg2) {
    throw new Error('Could not re-route through that point.')
  }

  const newSlice = mergePaths([leg1.path, leg2.path])
  const nodePath = [
    ...session.nodePath.slice(0, prevPathIdx),
    ...newSlice,
    ...session.nodePath.slice(nextPathIdx + 1),
  ]

  // Recompute simple stats from path edges
  const elev = elevAlongPath(session.graph, nodePath)
  let lengthM = 0
  let signals = 0
  let crossings = 0
  let turns = 0
  let prevBearing: number | null = null
  for (let i = 0; i < nodePath.length - 1; i++) {
    const edge = (session.graph.adj.get(nodePath[i]) ?? []).find(
      (e) => e.to === nodePath[i + 1],
    )
    if (!edge) continue
    lengthM += edge.lengthM
    if (edge.hasSignal) signals += 1
    if (edge.hasCrossing) crossings += 1
    if (prevBearing !== null) {
      const delta = turnAngleDegrees(prevBearing, edge.bearing)
      if (delta > 25) turns += 1
    }
    prevBearing = edge.bearing
  }

  const candidate: RouteCandidate = {
    kind: 'edited',
    path: nodePath,
    lengthM,
    elevGainM: elev.gain,
    elevLossM: elev.loss,
    signals,
    crossings,
    turns,
  }

  return finalizeRoute(session.graph, candidate, session.start, 0)
}
