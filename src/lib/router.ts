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
  countPathHazards,
  createDijkstraCache,
  DEFAULT_WEIGHTS,
  MIN_TURN_DEGREES,
  nearestGraphNodeId,
  pathToLatLng,
  SHORTEST_WEIGHTS,
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
  /** Max cumulative climb (elevation gain only), in feet */
  maxClimbFeet: number
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
  /** Explicit click waypoints while drawing manually (includes start). */
  waypoints?: LatLng[]
}

export type PlanRunResult = {
  routes: RouteResult[]
  selectedIndex: number
}

type RouteKind = 'loop' | 'out-and-back' | 'edited' | 'manual'

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

type RankedCandidate = {
  candidate: RouteCandidate
  score: number
}

type PlannedOption = {
  candidate: RouteCandidate
  result: RouteResult
  controlIndexes: number[]
}

type PlannedBundle = {
  graph: RunGraph
  start: LatLng
  options: PlannedOption[]
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

type ManualDrawState = {
  graph: RunGraph
  start: LatLng
  startId: number
  /** Waypoint node ids in click order (starts with startId). */
  waypointIds: number[]
  nodePath: number[]
}

let activeSession: RouteSession | null = null
let manualDraw: ManualDrawState | null = null
let plannedBundle: PlannedBundle | null = null

export function getActiveSession(): RouteSession | null {
  return activeSession
}

export function isManualDrawing(): boolean {
  return manualDraw !== null
}

export function clearPlannedRoutes(): void {
  plannedBundle = null
}

/** Switch the active auto-route option (updates edit session). */
export function selectPlannedRoute(index: number): RouteResult {
  if (!plannedBundle || index < 0 || index >= plannedBundle.options.length) {
    throw new Error('That route option is no longer available.')
  }
  const opt = plannedBundle.options[index]
  activeSession = {
    graph: plannedBundle.graph,
    nodePath: opt.candidate.path,
    kind: opt.candidate.kind,
    controlIndexes: opt.controlIndexes,
    start: plannedBundle.start,
  }
  return opt.result
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
    kind?: RouteKind
  },
  minM: number,
  maxM: number,
  maxClimbM: number,
): number {
  const under = Math.max(0, minM - stats.lengthM)
  const over = Math.max(0, stats.lengthM - maxM)
  const climbOver = Math.max(0, stats.elevGainM - maxClimbM)

  const inRange = under < 1 && over < 1
  const lengthTarget = minM + Math.min(maxM - minM, minM * 0.08) * 0.5
  // Tiny length preference once distance is satisfied
  const lengthScore = inRange
    ? -Math.abs(stats.lengthM - lengthTarget) / 500
    : -Math.abs(stats.lengthM - lengthTarget) / 40
  const loopBonus = stats.kind === 'loop' ? 5 : 0

  // Near-lexicographic preference once distance works:
  // climb >> lights >> turns >> crossings
  const W_DIST = 1_000_000
  const W_CLIMB = 10_000
  const W_LIGHT = 300
  const W_TURN = 8
  const W_CROSS = 1

  return (
    lengthScore +
    loopBonus -
    under * W_DIST -
    over / 18 -
    // Prefer less absolute climb; extra hit for exceeding the budget
    stats.elevGainM * W_CLIMB -
    climbOver * W_CLIMB * 2 -
    stats.signals * W_LIGHT -
    stats.turns * W_TURN -
    stats.crossings * W_CROSS
  )
}

function hazardsForCandidate(
  graph: RunGraph,
  path: number[],
): { signals: number; crossings: number } {
  return countPathHazards(graph, path)
}

function summarizePath(
  graph: RunGraph,
  parts: DijkstraResult[],
  kind: RouteKind = 'loop',
): RouteCandidate {
  const path = mergePaths(parts.map((p) => p.path))
  const hazards = hazardsForCandidate(graph, path)
  return {
    kind,
    path,
    lengthM: parts.reduce((s, p) => s + p.lengthM, 0),
    elevGainM: parts.reduce((s, p) => s + p.elevGainM, 0),
    elevLossM: parts.reduce((s, p) => s + p.elevLossM, 0),
    signals: hazards.signals,
    crossings: hazards.crossings,
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
  const hazards = hazardsForCandidate(graph, path)

  return {
    kind: 'out-and-back',
    path,
    lengthM: out.lengthM * 2,
    elevGainM: out.elevGainM + back.gain,
    elevLossM: out.elevLossM + back.loss,
    signals: hazards.signals,
    crossings: hazards.crossings,
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
  return summarizePath(graph, [out, back], 'loop')
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
    return summarizePath(graph, [leg1, leg2, leg3Any], 'loop')
  }
  return summarizePath(graph, [leg1, leg2, leg3], 'loop')
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

function controlPointsFromIndexes(
  graph: RunGraph,
  nodePath: number[],
  controlIndexes: number[],
): LatLng[] {
  const points: LatLng[] = []
  for (let i = 1; i < controlIndexes.length - 1; i++) {
    const nodeId = nodePath[controlIndexes[i]]
    const pos = graph.nodePos.get(nodeId)
    if (pos) points.push(pos)
  }
  return points
}

function routeLabel(kind: RouteKind): string {
  if (kind === 'out-and-back') return 'Out and back'
  if (kind === 'edited') return 'Edited route'
  if (kind === 'manual') return 'Manual route'
  return 'Loop'
}

function edgeOverlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  for (const key of a) {
    if (b.has(key)) inter += 1
  }
  const union = a.size + b.size - inter
  return union === 0 ? 1 : inter / union
}

function pathFingerprint(path: number[]): string {
  if (path.length <= 24) return path.join(',')
  const step = Math.max(1, Math.floor(path.length / 20))
  const sample: number[] = []
  for (let i = 0; i < path.length; i += step) sample.push(path[i])
  sample.push(path[path.length - 1])
  return `${path.length}:${sample.join(',')}`
}

function pickDiverseCandidates(
  ranked: RankedCandidate[],
  count: number,
  minDistanceMiles: number,
): RouteCandidate[] {
  const sorted = [...ranked].sort((a, b) => b.score - a.score)
  const picked: { candidate: RouteCandidate; edges: Set<string> }[] = []

  const tryPick = (maxOverlap: number, requireDistance: boolean) => {
    for (const entry of sorted) {
      if (picked.length >= count) return
      if (
        requireDistance &&
        displayMiles(entry.candidate.lengthM) < minDistanceMiles
      ) {
        continue
      }
      const edges = collectEdgeKeys(entry.candidate.path)
      if (picked.some((p) => edgeOverlapRatio(p.edges, edges) > maxOverlap)) {
        continue
      }
      picked.push({ candidate: entry.candidate, edges })
    }
  }

  tryPick(0.45, true)
  if (picked.length < count) tryPick(0.65, true)
  if (picked.length < count) tryPick(0.8, false)

  return picked.map((p) => p.candidate)
}

async function buildRouteResult(
  graph: RunGraph,
  candidate: RouteCandidate,
  minDistanceMiles: number,
  options?: { waypoints?: LatLng[] },
): Promise<{ result: RouteResult; controlIndexes: number[] }> {
  let coordinates = pathToLatLng(graph, candidate.path)
  // Only force-close auto loops that didn't quite snap back
  if (
    candidate.kind === 'loop' &&
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

  if (minDistanceMiles > 0 && distanceMiles < minDistanceMiles) {
    throw new Error(
      `Routed distance came out under target (${distanceMiles.toFixed(2)} mi). Try increasing variance slightly.`,
    )
  }

  const controlIndexes = buildControlIndexes(graph, candidate.path)
  const result: RouteResult = {
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
    label: routeLabel(candidate.kind),
    controlPoints: controlPointsFromIndexes(
      graph,
      candidate.path,
      controlIndexes,
    ),
    waypoints: options?.waypoints,
  }

  return { result, controlIndexes }
}

async function finalizeRoute(
  graph: RunGraph,
  candidate: RouteCandidate,
  start: LatLng,
  minDistanceMiles: number,
  options?: { waypoints?: LatLng[] },
): Promise<RouteResult> {
  plannedBundle = null
  const built = await buildRouteResult(
    graph,
    candidate,
    minDistanceMiles,
    options,
  )
  activeSession = {
    graph,
    nodePath: candidate.path,
    kind: candidate.kind,
    controlIndexes: built.controlIndexes,
    start,
  }
  return built.result
}

export async function planRunRoute(req: RouteRequest): Promise<PlanRunResult> {
  const status = req.onStatus ?? (() => {})
  manualDraw = null
  plannedBundle = null
  const minM = milesToMeters(req.distanceMiles)
  const maxM = milesToMeters(req.distanceMiles + req.varianceMiles)
  const maxClimbM = req.maxClimbFeet / 3.28084
  const optionCount = 3

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

  status('Searching for quiet route options…')

  const outAndBackRadii = [minM * 0.45, minM * 0.5, minM * 0.55]
  const loopRadii = [minM * 0.42, minM * 0.5, maxM / (2 * Math.PI) * 1.2]

  const bearings: number[] = []
  for (let b = 0; b < 360; b += 30) bearings.push(b)

  const weightSets: PathCostWeights[] = [
    DEFAULT_WEIGHTS,
    { ...DEFAULT_WEIGHTS, elevGainPenalty: 180, signalPenalty: 400, turnPenalty: 50 },
  ]

  const ranked: RankedCandidate[] = []
  const bestByFingerprint = new Map<string, number>()
  const search = {
    best: null as RouteCandidate | null,
    bestScore: -Infinity,
    closest: null as RouteCandidate | null,
    closestGap: Infinity,
  }

  const trimRanked = () => {
    if (ranked.length <= 60) return
    ranked.sort((a, b) => b.score - a.score)
    ranked.length = 45
  }

  const consider = (
    candidate: RouteCandidate | null,
    scoreMaxM = maxM,
    scoreClimb = maxClimbM,
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
    const s = scoreRoute(
      { ...candidate, kind: candidate.kind },
      minM,
      scoreMaxM,
      scoreClimb,
    )
    const fingerprint = pathFingerprint(candidate.path)
    const prev = bestByFingerprint.get(fingerprint)
    if (prev !== undefined && prev >= s) return
    bestByFingerprint.set(fingerprint, s)
    ranked.push({ candidate, score: s })
    if (ranked.length % 25 === 0) trimRanked()

    if (s > search.bestScore) {
      search.bestScore = s
      search.best = candidate
    }
  }

  const hasEnoughOptions = () =>
    pickDiverseCandidates(ranked, optionCount, req.distanceMiles).length >=
    optionCount

  let attempts = 0

  // Pass 1: loops first (two-leg + triangle)
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
      hasEnoughOptions() &&
      search.best &&
      search.best.kind === 'loop' &&
      displayMiles(search.best.lengthM) >= req.distanceMiles &&
      search.best.lengthM <= maxM &&
      search.best.signals <= 1
    ) {
      break
    }
  }

  // Pass 2: same-path out-and-back only if not enough good options
  if (
    !hasEnoughOptions() ||
    !search.best ||
    search.best.kind !== 'loop' ||
    displayMiles(search.best.lengthM) < req.distanceMiles ||
    search.best.lengthM > maxM ||
    search.best.signals > 2
  ) {
    status('Trying out-and-back as backup…')
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
        hasEnoughOptions() &&
        search.best &&
        displayMiles(search.best.lengthM) >= req.distanceMiles &&
        search.best.lengthM <= maxM &&
        search.best.signals <= 1
      ) {
        break
      }
    }
  }

  if (!search.best || displayMiles(search.best.lengthM) < req.distanceMiles) {
    status('Stretching the route to meet distance…')
    const softWeights: PathCostWeights = {
      turnPenalty: 40,
      signalPenalty: 500,
      crossingPenalty: 8,
      elevGainPenalty: 18,
    }
    for (let bearing = 0; bearing < 360; bearing += 20) {
      for (const factor of [0.48, 0.55, 0.62]) {
        const farPoint = destinationPoint(req.start, bearing, minM * factor)
        for (const farId of findNearbyNodes(graph, farPoint, 3)) {
          consider(
            tryTwoLegLoop(graph, startId, farId, softWeights, findPath),
            maxM * 1.25,
            maxClimbM * 1.4,
          )
          consider(
            tryOutAndBack(graph, startId, farId, softWeights, findPath),
            maxM * 1.25,
            maxClimbM * 1.4,
          )
        }
      }
    }
  }

  let selected = pickDiverseCandidates(ranked, optionCount, req.distanceMiles)
  if (selected.length === 0 && search.best) selected = [search.best]
  if (selected.length === 0 && search.closest) selected = [search.closest]

  const best = selected[0] ?? null

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

  // Keep only options that meet the distance floor
  selected = selected.filter(
    (c) => displayMiles(c.lengthM) >= req.distanceMiles,
  )
  if (selected.length === 0) selected = [best]

  status(
    selected.length > 1
      ? `Building ${selected.length} route options…`
      : 'Building map & elevation profile…',
  )

  const options: PlannedOption[] = []
  for (const candidate of selected) {
    try {
      const built = await buildRouteResult(graph, candidate, req.distanceMiles)
      options.push({
        candidate,
        result: built.result,
        controlIndexes: built.controlIndexes,
      })
    } catch {
      // Skip a candidate that failed densify/elev validation
    }
  }

  if (options.length === 0) {
    throw new Error(
      'Could not finalize a route with those constraints. Try a larger variance.',
    )
  }

  // Re-rank by final measured climb, then lights, turns, crossings
  options.sort((a, b) => {
    const climb = a.result.elevationGainFeet - b.result.elevationGainFeet
    if (Math.abs(climb) > 1) return climb
    const lights = a.result.signals - b.result.signals
    if (lights !== 0) return lights
    const turns = a.result.turns - b.result.turns
    if (turns !== 0) return turns
    return a.result.crossings - b.result.crossings
  })

  plannedBundle = { graph, start: req.start, options }
  activeSession = {
    graph,
    nodePath: options[0].candidate.path,
    kind: options[0].candidate.kind,
    controlIndexes: options[0].controlIndexes,
    start: req.start,
  }

  return {
    routes: options.map((o) => o.result),
    selectedIndex: 0,
  }
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
  const leg1 = findPath(session.graph, prevNode, snapped, SHORTEST_WEIGHTS)
  const leg2 = findPath(session.graph, snapped, nextNode, SHORTEST_WEIGHTS)
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
  const hazards = countPathHazards(session.graph, nodePath)
  let lengthM = 0
  let turns = 0
  let prevBearing: number | null = null
  for (let i = 0; i < nodePath.length - 1; i++) {
    const edge = (session.graph.adj.get(nodePath[i]) ?? []).find(
      (e) => e.to === nodePath[i + 1],
    )
    if (!edge) continue
    lengthM += edge.lengthM
    if (prevBearing !== null) {
      const delta = turnAngleDegrees(prevBearing, edge.bearing)
      if (delta > MIN_TURN_DEGREES) turns += 1
    }
    prevBearing = edge.bearing
  }

  const candidate: RouteCandidate = {
    kind: 'edited',
    path: nodePath,
    lengthM,
    elevGainM: elev.gain,
    elevLossM: elev.loss,
    signals: hazards.signals,
    crossings: hazards.crossings,
    turns,
  }

  return finalizeRoute(session.graph, candidate, session.start, 0)
}

function candidateFromNodePath(
  graph: RunGraph,
  nodePath: number[],
  kind: RouteKind,
): RouteCandidate {
  const elev = elevAlongPath(graph, nodePath)
  const hazards = countPathHazards(graph, nodePath)
  let lengthM = 0
  let turns = 0
  let prevBearing: number | null = null
  for (let i = 0; i < nodePath.length - 1; i++) {
    const edge = (graph.adj.get(nodePath[i]) ?? []).find(
      (e) => e.to === nodePath[i + 1],
    )
    if (!edge) continue
    lengthM += edge.lengthM
    if (prevBearing !== null) {
      const delta = turnAngleDegrees(prevBearing, edge.bearing)
      if (delta > MIN_TURN_DEGREES) turns += 1
    }
    prevBearing = edge.bearing
  }
  return {
    kind,
    path: nodePath,
    lengthM,
    elevGainM: elev.gain,
    elevLossM: elev.loss,
    signals: hazards.signals,
    crossings: hazards.crossings,
    turns,
  }
}

function manualWaypoints(state: ManualDrawState): LatLng[] {
  return state.waypointIds
    .map((id) => state.graph.nodePos.get(id))
    .filter((p): p is LatLng => Boolean(p))
}

async function finalizeManual(state: ManualDrawState): Promise<RouteResult> {
  const candidate = candidateFromNodePath(state.graph, state.nodePath, 'manual')
  return finalizeRoute(state.graph, candidate, state.start, 0, {
    waypoints: manualWaypoints(state),
  })
}

/** Load the street graph and start click-to-draw from this start point. */
export async function beginManualRoute(
  start: LatLng,
  distanceHintMiles = 5,
  onStatus?: (message: string) => void,
): Promise<void> {
  const status = onStatus ?? (() => {})
  plannedBundle = null
  activeSession = null
  const radiusM = Math.min(
    6000,
    Math.max(1500, milesToMeters(distanceHintMiles) * 0.75),
  )

  status('Loading streets for drawing…')
  const network = await fetchOsmNetwork(start, radiusM)
  if (network.ways.length < 5) {
    throw new Error('Not enough walkable roads near that start point.')
  }

  status('Reading elevation…')
  const elevByNode = await elevationsForNetwork(network)
  const graph = buildGraph(network, elevByNode)
  const startId = nearestNodeId(network, start, 300)
  if (startId === null || !graph.adj.has(startId)) {
    throw new Error('Could not snap the start point to a walkable road.')
  }

  manualDraw = {
    graph,
    start,
    startId,
    waypointIds: [startId],
    nodePath: [startId],
  }
  activeSession = null
  status('Click the map to add waypoints along streets.')
}

/** Add a clicked waypoint; routes along streets from the previous point. */
export async function addManualWaypoint(point: LatLng): Promise<RouteResult> {
  if (!manualDraw) {
    throw new Error('Start drawing first.')
  }

  const snapped = nearestGraphNodeId(manualDraw.graph, point, 300)
  if (snapped === null) {
    throw new Error('Could not snap that click to a nearby path.')
  }

  const fromId = manualDraw.waypointIds[manualDraw.waypointIds.length - 1]
  if (snapped === fromId) {
    throw new Error('Pick a point farther along the route.')
  }

  const findPath = createDijkstraCache()
  const leg = findPath(manualDraw.graph, fromId, snapped, SHORTEST_WEIGHTS)
  if (!leg || leg.path.length < 2) {
    throw new Error('Could not route to that point on the street network.')
  }

  manualDraw.waypointIds.push(snapped)
  manualDraw.nodePath = mergePaths([manualDraw.nodePath, leg.path])
  return finalizeManual(manualDraw)
}

/** Remove the last clicked waypoint (keeps start). */
export async function undoManualWaypoint(): Promise<RouteResult | null> {
  if (!manualDraw) return null
  if (manualDraw.waypointIds.length <= 1) {
    manualDraw.nodePath = [manualDraw.startId]
    return null
  }

  manualDraw.waypointIds.pop()
  // Rebuild path from remaining waypoints
  const findPath = createDijkstraCache()
  let path = [manualDraw.waypointIds[0]]
  for (let i = 1; i < manualDraw.waypointIds.length; i++) {
    const leg = findPath(
      manualDraw.graph,
      manualDraw.waypointIds[i - 1],
      manualDraw.waypointIds[i],
      SHORTEST_WEIGHTS,
    )
    if (!leg) throw new Error('Could not rebuild the route after undo.')
    path = mergePaths([path, leg.path])
  }
  manualDraw.nodePath = path

  if (manualDraw.waypointIds.length === 1) return null
  return finalizeManual(manualDraw)
}

/** Route from the last waypoint back to the start to close a loop. */
export async function finishManualAtStart(): Promise<RouteResult> {
  if (!manualDraw) throw new Error('Start drawing first.')
  if (manualDraw.waypointIds.length < 2) {
    throw new Error('Add at least one waypoint before returning to start.')
  }

  const fromId = manualDraw.waypointIds[manualDraw.waypointIds.length - 1]
  if (fromId === manualDraw.startId) {
    return finalizeManual(manualDraw)
  }

  const findPath = createDijkstraCache()
  const leg = findPath(
    manualDraw.graph,
    fromId,
    manualDraw.startId,
    SHORTEST_WEIGHTS,
  )
  if (!leg || leg.path.length < 2) {
    throw new Error('Could not route back to the start.')
  }

  manualDraw.waypointIds.push(manualDraw.startId)
  manualDraw.nodePath = mergePaths([manualDraw.nodePath, leg.path])
  const result = await finalizeManual(manualDraw)
  // Keep session for dragging; leave draw mode so further clicks don't add points
  manualDraw = null
  return result
}

export function cancelManualRoute(): void {
  manualDraw = null
  plannedBundle = null
}
