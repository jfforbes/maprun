import {
  bearingDegrees,
  haversineMeters,
  turnAngleDegrees,
  type LatLng,
} from './geo'
import type { OsmNetwork } from './osm'
import { connectedNodeIds } from './osm'

export type GraphEdge = {
  to: number
  lengthM: number
  bearing: number
  elevGainM: number
  elevLossM: number
  /** True when arriving at a traffic-signal node */
  entersSignal: boolean
  /** True when arriving at a crossing node */
  entersCrossing: boolean
  highway: string
}

export type RunGraph = {
  adj: Map<number, GraphEdge[]>
  nodePos: Map<number, LatLng>
  elevations: Map<number, number>
  signalNodes: Set<number>
  crossingNodes: Set<number>
}

const FOOT_PREF: Record<string, number> = {
  footway: 0.85,
  path: 0.9,
  pedestrian: 0.85,
  living_street: 0.95,
  residential: 1,
  cycleway: 0.95,
  track: 1.05,
  bridleway: 1.05,
  unclassified: 1.1,
  service: 1.15,
  tertiary: 1.2,
  secondary: 1.35,
  primary: 1.5,
  steps: 1.8,
}

export function buildGraph(
  network: OsmNetwork,
  elevations: Map<number, number>,
): RunGraph {
  const connected = connectedNodeIds(network)
  const adj = new Map<number, GraphEdge[]>()
  const nodePos = new Map<number, LatLng>()
  const signalNodes = new Set<number>()
  const crossingNodes = new Set<number>()

  for (const id of connected) {
    const n = network.nodes.get(id)
    if (!n) continue
    nodePos.set(id, { lat: n.lat, lng: n.lng })
    adj.set(id, [])
    if (n.isSignal) signalNodes.add(id)
    if (n.isCrossing) crossingNodes.add(id)
  }

  const addEdge = (from: number, edge: GraphEdge) => {
    const list = adj.get(from)
    if (list) list.push(edge)
  }

  for (const way of network.ways) {
    const ids = way.nodeIds.filter((id) => connected.has(id) && network.nodes.has(id))
    for (let i = 0; i < ids.length - 1; i++) {
      const aId = ids[i]
      const bId = ids[i + 1]
      const a = network.nodes.get(aId)!
      const b = network.nodes.get(bId)!
      const lengthM = haversineMeters(a, b)
      if (lengthM < 0.5) continue

      const elevA = elevations.get(aId) ?? 0
      const elevB = elevations.get(bId) ?? 0
      const delta = elevB - elevA
      const bearing = bearingDegrees(a, b)
      const reverseBearing = bearingDegrees(b, a)

      addEdge(aId, {
        to: bId,
        lengthM,
        bearing,
        elevGainM: Math.max(0, delta),
        elevLossM: Math.max(0, -delta),
        entersSignal: signalNodes.has(bId),
        entersCrossing: crossingNodes.has(bId),
        highway: way.highway,
      })
      addEdge(bId, {
        to: aId,
        lengthM,
        bearing: reverseBearing,
        elevGainM: Math.max(0, -delta),
        elevLossM: Math.max(0, delta),
        entersSignal: signalNodes.has(aId),
        entersCrossing: crossingNodes.has(aId),
        highway: way.highway,
      })
    }
  }

  return { adj, nodePos, elevations, signalNodes, crossingNodes }
}

export type PathCostWeights = {
  turnPenalty: number
  signalPenalty: number
  crossingPenalty: number
  elevGainPenalty: number
  /** When true, ignore footway-vs-road preference and route by length. */
  shortestPath?: boolean
}

export const DEFAULT_WEIGHTS: PathCostWeights = {
  // Strong preference to keep going straight; only big bends count as turns
  turnPenalty: 90,
  signalPenalty: 1000,
  // Crossings matter much less than lights/turns
  crossingPenalty: 15,
  elevGainPenalty: 14,
}

/** Direct street distance between clicks — used for manual drawing. */
export const SHORTEST_WEIGHTS: PathCostWeights = {
  turnPenalty: 0,
  signalPenalty: 0,
  crossingPenalty: 0,
  elevGainPenalty: 0,
  shortestPath: true,
}

export type DijkstraResult = {
  path: number[]
  lengthM: number
  elevGainM: number
  elevLossM: number
  signals: number
  crossings: number
  turns: number
}

class MinHeap<T> {
  private data: T[] = []
  private score: (item: T) => number

  constructor(score: (item: T) => number) {
    this.score = score
  }

  get size() {
    return this.data.length
  }

  push(item: T) {
    this.data.push(item)
    this.bubbleUp(this.data.length - 1)
  }

  pop(): T | undefined {
    if (!this.data.length) return undefined
    const top = this.data[0]
    const last = this.data.pop()!
    if (this.data.length) {
      this.data[0] = last
      this.bubbleDown(0)
    }
    return top
  }

  private bubbleUp(i: number) {
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.score(this.data[i]) >= this.score(this.data[p])) break
      ;[this.data[i], this.data[p]] = [this.data[p], this.data[i]]
      i = p
    }
  }

  private bubbleDown(i: number) {
    for (;;) {
      const l = i * 2 + 1
      const r = l + 1
      let smallest = i
      if (l < this.data.length && this.score(this.data[l]) < this.score(this.data[smallest])) {
        smallest = l
      }
      if (r < this.data.length && this.score(this.data[r]) < this.score(this.data[smallest])) {
        smallest = r
      }
      if (smallest === i) break
      ;[this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]]
      i = smallest
    }
  }
}

/** Only count bends sharper than this as turns (degrees). */
export const MIN_TURN_DEGREES = 60

export function dijkstra(
  graph: RunGraph,
  startId: number,
  endId: number,
  weights: PathCostWeights = DEFAULT_WEIGHTS,
  avoidEdgeKeys?: Set<string>,
): DijkstraResult | null {
  if (startId === endId) {
    return {
      path: [startId],
      lengthM: 0,
      elevGainM: 0,
      elevLossM: 0,
      signals: 0,
      crossings: 0,
      turns: 0,
    }
  }

  type State = {
    id: number
    cost: number
    lengthM: number
    elevGainM: number
    elevLossM: number
    signals: number
    crossings: number
    turns: number
    bearing: number | null
  }

  const best = new Map<number, number>()
  const prev = new Map<number, number | null>()
  const meta = new Map<number, Omit<State, 'id' | 'cost'>>()
  const heap = new MinHeap<State>((s) => s.cost)

  heap.push({
    id: startId,
    cost: 0,
    lengthM: 0,
    elevGainM: 0,
    elevLossM: 0,
    signals: 0,
    crossings: 0,
    turns: 0,
    bearing: null,
  })
  best.set(startId, 0)
  prev.set(startId, null)
  meta.set(startId, {
    lengthM: 0,
    elevGainM: 0,
    elevLossM: 0,
    signals: 0,
    crossings: 0,
    turns: 0,
    bearing: null,
  })

  while (heap.size) {
    const cur = heap.pop()!
    if ((best.get(cur.id) ?? Infinity) < cur.cost - 1e-6) continue
    if (cur.id === endId) break

    const edges = graph.adj.get(cur.id) ?? []
    for (const edge of edges) {
      const ek = edgeKey(cur.id, edge.to)
      if (avoidEdgeKeys?.has(ek)) continue

      const highwayMul = weights.shortestPath
        ? 1
        : (FOOT_PREF[edge.highway] ?? 1.2)
      let turn = 0
      let turnCount = 0
      if (cur.bearing !== null) {
        turn = turnAngleDegrees(cur.bearing, edge.bearing)
        if (turn > MIN_TURN_DEGREES) turnCount = 1
      }

      const stepCost = weights.shortestPath
        ? edge.lengthM
        : edge.lengthM * highwayMul +
          // Only apply turn cost for real bends (>60°)
          (turn > MIN_TURN_DEGREES ? (turn / 90) * weights.turnPenalty : 0) +
          (edge.entersSignal ? weights.signalPenalty : 0) +
          (edge.entersCrossing ? weights.crossingPenalty : 0) +
          edge.elevGainM * weights.elevGainPenalty

      const nextCost = cur.cost + stepCost
      if (nextCost + 1e-6 >= (best.get(edge.to) ?? Infinity)) continue

      const nextMeta = {
        lengthM: cur.lengthM + edge.lengthM,
        elevGainM: cur.elevGainM + edge.elevGainM,
        elevLossM: cur.elevLossM + edge.elevLossM,
        signals: cur.signals + (edge.entersSignal ? 1 : 0),
        crossings: cur.crossings + (edge.entersCrossing ? 1 : 0),
        turns: cur.turns + turnCount,
        bearing: edge.bearing,
      }

      best.set(edge.to, nextCost)
      prev.set(edge.to, cur.id)
      meta.set(edge.to, nextMeta)
      heap.push({
        id: edge.to,
        cost: nextCost,
        ...nextMeta,
      })
    }
  }

  if (!prev.has(endId)) return null
  const endMeta = meta.get(endId)
  if (!endMeta) return null

  const path: number[] = []
  let walk: number | null = endId
  while (walk !== null) {
    path.push(walk)
    walk = prev.get(walk) ?? null
  }
  path.reverse()

  return {
    path,
    lengthM: endMeta.lengthM,
    elevGainM: endMeta.elevGainM,
    elevLossM: endMeta.elevLossM,
    signals: endMeta.signals,
    crossings: endMeta.crossings,
    turns: endMeta.turns,
  }
}

function weightsKey(weights: PathCostWeights): string {
  return [
    weights.turnPenalty,
    weights.signalPenalty,
    weights.crossingPenalty,
    weights.elevGainPenalty,
    weights.shortestPath ? 1 : 0,
  ].join(',')
}

/** Cache plain A→B searches (no avoid-set). Huge win during multi-bearing search. */
export function createDijkstraCache() {
  const cache = new Map<string, DijkstraResult | null>()

  return function cachedDijkstra(
    graph: RunGraph,
    startId: number,
    endId: number,
    weights: PathCostWeights = DEFAULT_WEIGHTS,
    avoidEdgeKeys?: Set<string>,
  ): DijkstraResult | null {
    const canCache = !avoidEdgeKeys || avoidEdgeKeys.size === 0
    const key = canCache
      ? `${startId}>${endId}|${weightsKey(weights)}`
      : null
    if (key && cache.has(key)) return cache.get(key) ?? null

    const result = dijkstra(graph, startId, endId, weights, avoidEdgeKeys)
    if (key) cache.set(key, result)
    return result
  }
}

export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`
}

export function pathToLatLng(graph: RunGraph, path: number[]): LatLng[] {
  return path
    .map((id) => graph.nodePos.get(id))
    .filter((p): p is LatLng => Boolean(p))
}

export function nearestGraphNodeId(
  graph: RunGraph,
  point: LatLng,
  maxM = 250,
): number | null {
  let bestId: number | null = null
  let bestDist = Infinity
  for (const [id, pos] of graph.nodePos) {
    const d = haversineMeters(point, pos)
    if (d < bestDist) {
      bestDist = d
      bestId = id
    }
  }
  if (bestId === null || bestDist > maxM) return null
  return bestId
}

export function countPathHazards(
  graph: RunGraph,
  path: number[],
): { signals: number; crossings: number } {
  let signals = 0
  let crossings = 0
  const seen = new Set<number>()
  for (const id of path) {
    if (seen.has(id)) continue
    seen.add(id)
    if (graph.signalNodes.has(id)) signals += 1
    if (graph.crossingNodes.has(id)) crossings += 1
  }
  return { signals, crossings }
}

/** Soften repeated edge use when stitching loop legs */
export function collectEdgeKeys(path: number[]): Set<string> {
  const keys = new Set<string>()
  for (let i = 1; i < path.length; i++) {
    keys.add(edgeKey(path[i - 1], path[i]))
  }
  return keys
}
