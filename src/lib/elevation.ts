import type { LatLng } from './geo'

const TERRARIUM_Z = 14
const TERRARIUM_URL =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'

const tileCache = new Map<string, ImageData>()
const tileLoads = new Map<string, Promise<ImageData>>()

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`
}

function lngToTileX(lng: number, z: number): number {
  return ((lng + 180) / 360) * 2 ** z
}

function latToTileY(lat: number, z: number): number {
  const s = Math.sin((lat * Math.PI) / 180)
  return (
    (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z
  )
}

function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768
}

async function loadTerrariumTile(x: number, y: number): Promise<ImageData> {
  const key = tileKey(TERRARIUM_Z, x, y)
  const cached = tileCache.get(key)
  if (cached) return cached
  const pending = tileLoads.get(key)
  if (pending) return pending

  const request = (async () => {
    const url = `${TERRARIUM_URL}/${TERRARIUM_Z}/${x}/${y}.png`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Elevation tile ${res.status}`)
    const blob = await res.blob()
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Could not read elevation tile.')
    ctx.drawImage(bitmap, 0, 0)
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    tileCache.set(key, data)
    tileLoads.delete(key)
    return data
  })()

  tileLoads.set(key, request)
  try {
    return await request
  } catch (err) {
    tileLoads.delete(key)
    throw err
  }
}

function pixelElevation(data: ImageData, px: number, py: number): number {
  const x = Math.max(0, Math.min(data.width - 1, px))
  const y = Math.max(0, Math.min(data.height - 1, py))
  const i = (y * data.width + x) * 4
  return decodeTerrarium(data.data[i], data.data[i + 1], data.data[i + 2])
}

function sampleLoadedTile(lat: number, lng: number): number | null {
  const fx = lngToTileX(lng, TERRARIUM_Z)
  const fy = latToTileY(lat, TERRARIUM_Z)
  const tx = Math.floor(fx)
  const ty = Math.floor(fy)
  const data = tileCache.get(tileKey(TERRARIUM_Z, tx, ty))
  if (!data) return null

  const px = (fx - tx) * data.width
  const py = (fy - ty) * data.height
  const x0 = Math.floor(px)
  const y0 = Math.floor(py)
  const x1 = x0 + 1
  const y1 = y0 + 1
  const txw = px - x0
  const tyw = py - y0
  const e00 = pixelElevation(data, x0, y0)
  const e10 = pixelElevation(data, x1, y0)
  const e01 = pixelElevation(data, x0, y1)
  const e11 = pixelElevation(data, x1, y1)
  return (
    e00 * (1 - txw) * (1 - tyw) +
    e10 * txw * (1 - tyw) +
    e01 * (1 - txw) * tyw +
    e11 * txw * tyw
  )
}

async function ensureTerrariumTiles(points: LatLng[]): Promise<void> {
  const needed = new Set<string>()
  for (const p of points) {
    const x = Math.floor(lngToTileX(p.lng, TERRARIUM_Z))
    const y = Math.floor(latToTileY(p.lat, TERRARIUM_Z))
    needed.add(`${x},${y}`)
  }
  const jobs: Promise<ImageData>[] = []
  for (const key of needed) {
    const [x, y] = key.split(',').map(Number)
    if (x === undefined || y === undefined) continue
    jobs.push(loadTerrariumTile(x, y))
  }
  await Promise.all(jobs)
}

async function elevationsFromTerrarium(points: LatLng[]): Promise<number[]> {
  await ensureTerrariumTiles(points)
  return points.map((p) => {
    const z = sampleLoadedTile(p.lat, p.lng)
    if (z === null || !Number.isFinite(z)) {
      throw new Error('Missing elevation sample.')
    }
    return z
  })
}

async function elevationsFromOpenElevation(points: LatLng[]): Promise<number[]> {
  const elevations = new Array<number>(points.length)
  const chunkSize = 80
  for (let i = 0; i < points.length; i += chunkSize) {
    const chunk = points.slice(i, i + chunkSize)
    const res = await fetch('https://api.open-elevation.com/api/v1/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        locations: chunk.map((p) => ({
          latitude: p.lat,
          longitude: p.lng,
        })),
      }),
    })
    if (!res.ok) throw new Error(`Open-Elevation ${res.status}`)
    const data = (await res.json()) as {
      results?: Array<{ elevation?: number }>
    }
    if (!data.results || data.results.length !== chunk.length) {
      throw new Error('Open-Elevation returned incomplete data.')
    }
    for (let j = 0; j < chunk.length; j++) {
      elevations[i + j] = data.results[j]?.elevation ?? 0
    }
    if (i + chunkSize < points.length) await sleep(200)
  }
  return elevations
}

async function elevationsFromOpenMeteo(points: LatLng[]): Promise<number[]> {
  const elevations = new Array<number>(points.length)
  const chunkSize = 100
  for (let i = 0; i < points.length; i += chunkSize) {
    const chunk = points.slice(i, i + chunkSize)
    const url = new URL('https://api.open-meteo.com/v1/elevation')
    url.searchParams.set('latitude', chunk.map((p) => p.lat.toFixed(5)).join(','))
    url.searchParams.set(
      'longitude',
      chunk.map((p) => p.lng.toFixed(5)).join(','),
    )
    const res = await fetch(url.toString())
    const data = (await res.json()) as {
      elevation?: number[]
      error?: boolean
      reason?: string
    }
    if (!res.ok || data.error || !data.elevation) {
      throw new Error(data.reason ?? `Open-Meteo ${res.status}`)
    }
    for (let j = 0; j < chunk.length; j++) {
      elevations[i + j] = data.elevation[j] ?? 0
    }
    if (i + chunkSize < points.length) await sleep(120)
  }
  return elevations
}

/** Fetch elevations, preferring local DEM tiles over quota-limited APIs. */
export async function fetchElevations(points: LatLng[]): Promise<number[]> {
  if (points.length === 0) return []
  try {
    return await elevationsFromTerrarium(points)
  } catch (err) {
    if (points.length > 220) throw err
    try {
      return await elevationsFromOpenElevation(points)
    } catch {
      return await elevationsFromOpenMeteo(points)
    }
  }
}

/** Best-effort elevations — returns zeros only if every source fails */
export async function fetchElevationsSoft(points: LatLng[]): Promise<number[]> {
  try {
    return await fetchElevations(points)
  } catch {
    return points.map(() => 0)
  }
}
