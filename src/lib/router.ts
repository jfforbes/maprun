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
  pathCompactness,
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
  /** When true, pathfinding does not avoid traffic lights. Ranking still prefers fewer. */
  allowLights?: boolean
  /** How many auto-route alternatives to return (default 3). */
  optionCount?: number
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
  /** Why this auto-route option was offered (e.g. lowest climb). */
  optionLabel?: string
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
  leftover: RankedCandidate[]
  minDistanceMiles: number
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
let editHistory: Array<{
  nodePath: number[]
  controlIndexes: number[]
  kind: RouteKind
}> = []

const MAX_ROUTE_OPTIONS = 9

export function getActiveSession(): RouteSession | null {
  return activeSession
}

export function isManualDrawing(): boolean {
  return manualDraw !== null
}

export function clearPlannedRoutes(): void {
  plannedBundle = null
  editHistory = []
}

function pushEditSnapshot(): void {
  if (!activeSession) return
  editHistory.push({
    nodePath: [...activeSession.nodePath],
    controlIndexes: [...activeSession.controlIndexes],
    kind: activeSession.kind,
  })
  if (editHistory.length > 30) editHistory.shift()
}

export function canUndoRouteEdit(): boolean {
  return editHistory.length > 0
}

export type RoutingSnapshot = {
  session: RouteSession
  planned: PlannedBundle | null
}

export function snapshotRoutingState(): RoutingSnapshot | null {
  if (!activeSession) return null
  return {
    session: {
      ...activeSession,
      nodePath: [...activeSession.nodePath],
      controlIndexes: [...activeSession.controlIndexes],
    },
    planned: plannedBundle,
  }
}

export function restoreRoutingState(snap: RoutingSnapshot): void {
  manualDraw = null
  activeSession = snap.session
  plannedBundle = snap.planned
  editHistory = []
}

export function hasMorePlannedRoutes(): boolean {
  return Boolean(
    plannedBundle &&
      plannedBundle.leftover.length > 0 &&
      plannedBundle.options.length < MAX_ROUTE_OPTIONS,
  )
}

/** Switch the active auto-route option (updates edit session). */
export function selectPlannedRoute(index: number): RouteResult {
  if (!plannedBundle || index < 0 || index >= plannedBundle.options.length) {
    throw new Error('That route option is no longer available.')
  }
  const opt = plannedBundle.options[index]
  editHistory = []
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
  const loopBonus = stats.kind === 'loop' ? 40 : 0

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
  let path = mergePaths(parts.map((p) => p.path))
  if (kind === 'loop') path = pruneRetraceSpikes(path)
  if (path.length < 4) {
    return {
      kind,
      path,
      lengthM: 0,
      elevGainM: 0,
      elevLossM: 0,
      signals: 0,
      crossings: 0,
      turns: 0,
    }
  }
  return candidateFromNodePath(graph, path, kind)
}

/** Remove A→B→A spikes (mid-block turnarounds that pad distance). */
function pruneRetraceSpikes(path: number[]): number[] {
  const stack: number[] = []
  for (const id of path) {
    if (stack.length >= 1 && stack[stack.length - 1] === id) continue
    if (stack.length >= 2 && stack[stack.length - 2] === id) {
      stack.pop()
      continue
    }
    stack.push(id)
  }
  return stack
}

function findNearbyNodes(
  graph: RunGraph,
  target: LatLng,
  limit = 8,
  minDegree = 1,
): number[] {
  const collect = (degree: number) => {
    const scored: { id: number; d: number }[] = []
    for (const [id, pos] of graph.nodePos) {
      if (degree > 1 && (graph.adj.get(id)?.length ?? 0) < degree) continue
      const d = haversineMeters(target, pos)
      if (d < 700) scored.push({ id, d })
    }
    scored.sort((a, b) => a.d - b.d)
    return scored.slice(0, limit).map((s) => s.id)
  }
  const preferred = collect(minDegree)
  return preferred.length ? preferred : collect(1)
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
  if (!back || back.path.length < 2) return null
  const loop = summarizePath(graph, [out, back], 'loop')
  if (loopRetraceRatio(loop.path) > 0.02) return null
  return loop
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
  if (!leg3) return null
  const loop = summarizePath(graph, [leg1, leg2, leg3], 'loop')
  if (loopRetraceRatio(loop.path) > 0.02) return null
  return loop
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
      if (elevMap.has(ids[i])) continue
      let nearest = 0
      let nearestD = Infinity
      for (let s = 0; s < samplePts.length; s++) {
        const d = haversineMeters(points[i], samplePts[s])
        if (d < nearestD) {
          nearestD = d
          nearest = s
        }
      }
      elevMap.set(ids[i], elevs[nearest] ?? 0)
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

function normalizeControlIndexes(indexes: number[], pathLen: number): number[] {
  const uniq = new Set<number>([0, pathLen - 1])
  for (const i of indexes) {
    if (i > 0 && i < pathLen - 1) uniq.add(i)
  }
  return [...uniq].sort((a, b) => a - b)
}

function closestPathIndex(graph: RunGraph, path: number[], point: LatLng): {
  index: number
  distM: number
} {
  let best = 1
  let bestDist = Infinity
  const last = Math.max(1, path.length - 2)
  for (let i = 1; i <= last; i++) {
    const pos = graph.nodePos.get(path[i])
    if (!pos) continue
    const d = haversineMeters(point, pos)
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  }
  return { index: best, distM: bestDist }
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

function loopRetraceRatio(path: number[]): number {
  const seen = new Set<string>()
  let reuse = 0
  for (let i = 1; i < path.length; i++) {
    const key = `${Math.min(path[i - 1], path[i])}-${Math.max(path[i - 1], path[i])}`
    if (seen.has(key)) reuse += 1
    else seen.add(key)
  }
  return seen.size === 0 ? 0 : reuse / seen.size
}

function pathServiceRatio(graph: RunGraph, path: number[]): number {
  let serviceM = 0
  let totalM = 0
  for (let i = 0; i < path.length - 1; i++) {
    const edge = (graph.adj.get(path[i]) ?? []).find((e) => e.to === path[i + 1])
    if (!edge) continue
    totalM += edge.lengthM
    if (edge.highway === 'service') serviceM += edge.lengthM
  }
  return totalM > 0 ? serviceM / totalM : 0
}

/** Drop skinny lollipops, parking-lot crawls, and hyper-jagged traces. */
function isPoorRun(graph: RunGraph, candidate: RouteCandidate): boolean {
  const km = candidate.lengthM / 1000
  if (km > 0.4 && candidate.turns / km > 10) return true
  if (pathServiceRatio(graph, candidate.path) > 0.22) return true
  if (candidate.kind === 'loop') {
    if (loopRetraceRatio(candidate.path) > 0.02) return true
    const compact = pathCompactness(pathToLatLng(graph, candidate.path))
    if (compact < 0.1) return true
  }
  return false
}

function similarToAny(candidate: RouteCandidate, used: RouteCandidate[]): boolean {
  const edges = collectEdgeKeys(candidate.path)
  return used.some(
    (u) => edgeOverlapRatio(edges, collectEdgeKeys(u.path)) > 0.55,
  )
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
  exclude: RouteCandidate[] = [],
): RouteCandidate[] {
  const eligible = ranked
    .map((r) => r.candidate)
    .filter((c) => displayMiles(c.lengthM) >= minDistanceMiles)

  const tooSimilar = (a: RouteCandidate, b: RouteCandidate) =>
    edgeOverlapRatio(collectEdgeKeys(a.path), collectEdgeKeys(b.path)) > 0.55

  const alreadyPicked = (c: RouteCandidate, picked: RouteCandidate[]) =>
    picked.some((p) => tooSimilar(p, c))

  const picked: RouteCandidate[] = [...exclude]
  const want = exclude.length + count
  const room = () => picked.length < want

  if (exclude.length === 0) {
    const byClimb = [...eligible].sort(
      (a, b) =>
        a.elevGainM - b.elevGainM ||
        a.signals - b.signals ||
        a.turns - b.turns ||
        a.crossings - b.crossings,
    )
    if (byClimb[0]) picked.push(byClimb[0])

    if (room()) {
      const byLights = [...eligible].sort(
        (a, b) =>
          a.signals - b.signals ||
          a.elevGainM - b.elevGainM ||
          a.turns - b.turns ||
          a.crossings - b.crossings,
      )
      const quiet = byLights.find((c) => !alreadyPicked(c, picked))
      if (quiet) picked.push(quiet)
    }

    if (room()) {
      const byTurns = [...eligible].sort(
        (a, b) =>
          a.turns - b.turns ||
          a.elevGainM - b.elevGainM ||
          a.signals - b.signals ||
          a.crossings - b.crossings,
      )
      const smooth = byTurns.find((c) => !alreadyPicked(c, picked))
      if (smooth) picked.push(smooth)
    }
  }

  const byScore = [...ranked]
    .sort((a, b) => b.score - a.score)
    .map((r) => r.candidate)
    .filter((c) => displayMiles(c.lengthM) >= minDistanceMiles)
  for (const c of byScore) {
    if (!room()) break
    if (alreadyPicked(c, picked)) continue
    picked.push(c)
  }

  return picked.slice(exclude.length, want)
}

function optionBlurb(picked: RouteCandidate[], index: number): string {
  if (index === 0) return 'Lowest climb'
  const c = picked[index]
  const flattest = picked[0]
  if (!flattest) return `Option ${index + 1}`
  if (c.signals < flattest.signals) return 'Fewer lights'
  if (c.turns < flattest.turns) return 'Fewer turns'
  if (c.elevGainM + 1 < flattest.elevGainM) return 'Lower climb'
  return 'Alternate'
}

async function buildRouteResult(
  graph: RunGraph,
  candidate: RouteCandidate,
  minDistanceMiles: number,
  options?: { waypoints?: LatLng[]; controlIndexes?: number[] },
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

  const controlIndexes = options?.controlIndexes?.length
    ? normalizeControlIndexes(options.controlIndexes, candidate.path.length)
    : buildControlIndexes(graph, candidate.path)
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
  options?: { waypoints?: LatLng[]; controlIndexes?: number[] },
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
  editHistory = []
  const minM = milesToMeters(req.distanceMiles)
  const maxM = milesToMeters(req.distanceMiles + req.varianceMiles)
  const maxClimbM = req.maxClimbFeet / 3.28084
  const optionCount = Math.max(1, Math.min(9, req.optionCount ?? 3))
  const allowLights = Boolean(req.allowLights)

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

  status(
    allowLights
      ? 'Searching for route options…'
      : 'Searching for quiet route options…',
  )

  const outAndBackRadii = [minM * 0.45, minM * 0.5, minM * 0.55]
  // Far-point distance for a round loop is ~circumference / 2π, not ~half the run.
  const roundR = minM / (2 * Math.PI)
  const loopRadii = [roundR, minM * 0.22, minM * 0.3]

  const bearings: number[] = []
  for (let b = 0; b < 360; b += 30) bearings.push(b)

  const weightSets: PathCostWeights[] = [
    // Climb-first, but still keep the line runnable
    {
      elevGainPenalty: 90,
      signalPenalty: allowLights ? 0 : 60,
      turnPenalty: 55,
      crossingPenalty: 4,
    },
    // Balanced
    {
      ...DEFAULT_WEIGHTS,
      signalPenalty: allowLights ? 0 : DEFAULT_WEIGHTS.signalPenalty,
    },
    // Smooth / quiet
    {
      elevGainPenalty: 40,
      signalPenalty: allowLights ? 0 : 900,
      turnPenalty: allowLights ? 120 : 100,
      crossingPenalty: 8,
    },
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
    stretch = false,
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
    if (!stretch) {
      const miles = displayMiles(candidate.lengthM)
      if (miles > req.distanceMiles + req.varianceMiles + 0.3) return
      if (isPoorRun(graph, candidate)) return
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
  for (let wi = 0; wi < weightSets.length; wi++) {
    const weights = weightSets[wi]
    if (!weights) continue
    for (const bearing of bearings) {
      if (++attempts % 6 === 0) await yieldToUi()
      for (const radius of loopRadii) {
        const farPoint = destinationPoint(req.start, bearing, radius)
        for (const farId of findNearbyNodes(graph, farPoint, 3, 3)) {
          if (farId === startId) continue
          consider(tryTwoLegLoop(graph, startId, farId, weights, findPath))
        }

        const aPoint = destinationPoint(req.start, bearing, radius)
        const bPoint = destinationPoint(req.start, bearing + 120, radius * 0.95)
        const aIds = findNearbyNodes(graph, aPoint, 2, 3)
        const bIds = findNearbyNodes(graph, bPoint, 2, 3)
        for (const aId of aIds) {
          for (const bId of bIds) {
            if (aId === startId || bId === startId || aId === bId) continue
            consider(tryThreeLegLoop(graph, startId, aId, bId, weights, findPath))
          }
        }
      }
    }
    if (
      wi >= 1 &&
      hasEnoughOptions() &&
      search.best &&
      search.best.kind === 'loop' &&
      displayMiles(search.best.lengthM) >= req.distanceMiles &&
      search.best.lengthM <= maxM
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
    search.best.lengthM > maxM
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
        search.best.lengthM <= maxM
      ) {
        break
      }
    }
  }

  if (!search.best || displayMiles(search.best.lengthM) < req.distanceMiles) {
    status('Stretching the route to meet distance…')
    const softWeights: PathCostWeights = {
      turnPenalty: 70,
      signalPenalty: allowLights ? 0 : 80,
      crossingPenalty: 5,
      elevGainPenalty: 50,
    }
    for (let bearing = 0; bearing < 360; bearing += 20) {
      for (const factor of [0.2, 0.28, 0.48, 0.55]) {
        const farPoint = destinationPoint(req.start, bearing, minM * factor)
        for (const farId of findNearbyNodes(graph, farPoint, 3)) {
          consider(
            tryTwoLegLoop(graph, startId, farId, softWeights, findPath),
            maxM * 1.25,
            maxClimbM * 1.4,
            true,
          )
          if (factor >= 0.45) {
            consider(
              tryOutAndBack(graph, startId, farId, softWeights, findPath),
              maxM * 1.25,
              maxClimbM * 1.4,
              true,
            )
          }
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
  for (let i = 0; i < selected.length; i++) {
    const candidate = selected[i]
    try {
      const built = await buildRouteResult(graph, candidate, req.distanceMiles)
      options.push({
        candidate,
        result: {
          ...built.result,
          optionLabel: optionBlurb(selected, i),
        },
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

  const finalized = options.map((o) => o.candidate)
  options.forEach((opt, i) => {
    opt.result = {
      ...opt.result,
      optionLabel: optionBlurb(finalized, i),
    }
  })

  const used = options.map((o) => o.candidate)

  plannedBundle = {
    graph,
    start: req.start,
    options,
    leftover: ranked.filter((r) => !similarToAny(r.candidate, used)),
    minDistanceMiles: req.distanceMiles,
  }
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

/** Finalize a few more distinct auto-route options from leftover candidates. */
export async function morePlannedRoutes(
  extraCount = 2,
): Promise<PlanRunResult> {
  const bundle = plannedBundle
  if (!bundle) throw new Error('No auto-route to expand. Route a run first.')

  const room = MAX_ROUTE_OPTIONS - bundle.options.length
  if (room <= 0 || bundle.leftover.length === 0) {
    return {
      routes: bundle.options.map((o) => o.result),
      selectedIndex: 0,
    }
  }

  const used = bundle.options.map((o) => o.candidate)
  const next = pickDiverseCandidates(
    bundle.leftover,
    Math.min(extraCount, room),
    bundle.minDistanceMiles,
    used,
  )

  for (const candidate of next) {
    try {
      const built = await buildRouteResult(
        bundle.graph,
        candidate,
        bundle.minDistanceMiles,
      )
      bundle.options.push({
        candidate,
        result: {
          ...built.result,
          optionLabel: 'Alternate',
        },
        controlIndexes: built.controlIndexes,
      })
    } catch {
      // skip
    }
  }

  const usedNow = bundle.options.map((o) => o.candidate)
  bundle.leftover = bundle.leftover.filter(
    (r) => !similarToAny(r.candidate, usedNow),
  )

  const all = bundle.options.map((o) => o.candidate)
  bundle.options.forEach((opt, i) => {
    opt.result = {
      ...opt.result,
      optionLabel: optionBlurb(all, i),
    }
  })

  return {
    routes: bundle.options.map((o) => o.result),
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

  pushEditSnapshot()

  const newSlice = mergePaths([leg1.path, leg2.path])
  const nodePath = [
    ...session.nodePath.slice(0, prevPathIdx),
    ...newSlice,
    ...session.nodePath.slice(nextPathIdx + 1),
  ]
  const snapAt = Math.max(0, newSlice.indexOf(snapped))
  const delta = newSlice.length - (nextPathIdx - prevPathIdx + 1)
  const controlIndexes = session.controlIndexes.map((idx, i) => {
    if (i === controlIdx) return prevPathIdx + snapAt
    if (idx >= nextPathIdx) return idx + delta
    return idx
  })

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

  return finalizeRoute(session.graph, candidate, session.start, 0, {
    controlIndexes,
  })
}

/** Click the route line to insert a draggable waypoint. */
export async function addRouteWaypoint(at: LatLng): Promise<RouteResult | null> {
  const session = activeSession
  if (!session) throw new Error('No active route to edit. Route a run first.')

  const { index, distM } = closestPathIndex(session.graph, session.nodePath, at)
  if (distM > 250) {
    throw new Error('Click on the route to add a waypoint.')
  }

  const already = session.controlIndexes.some((i) => Math.abs(i - index) <= 1)
  if (already) return null

  pushEditSnapshot()
  const controlIndexes = normalizeControlIndexes(
    [...session.controlIndexes, index],
    session.nodePath.length,
  )
  const candidate = candidateFromNodePath(
    session.graph,
    session.nodePath,
    'edited',
  )
  return finalizeRoute(session.graph, candidate, session.start, 0, {
    controlIndexes,
  })
}

export async function undoRouteEdit(): Promise<RouteResult> {
  const session = activeSession
  const snap = editHistory.pop()
  if (!session || !snap) {
    throw new Error('Nothing to undo.')
  }
  const candidate = candidateFromNodePath(session.graph, snap.nodePath, snap.kind)
  return finalizeRoute(session.graph, candidate, session.start, 0, {
    controlIndexes: snap.controlIndexes,
  })
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
  editHistory = []
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
