import type { LatLng } from './geo'

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** Open-Meteo elevation API — batch with retries for rate limits */
export async function fetchElevations(points: LatLng[]): Promise<number[]> {
  if (points.length === 0) return []

  const elevations: number[] = new Array(points.length)
  const chunkSize = 40

  for (let i = 0; i < points.length; i += chunkSize) {
    const chunk = points.slice(i, i + chunkSize)
    const chunkElevs = await fetchElevationChunk(chunk)
    for (let j = 0; j < chunk.length; j++) {
      elevations[i + j] = chunkElevs[j] ?? 0
    }
    if (i + chunkSize < points.length) await sleep(120)
  }

  return elevations
}

async function fetchElevationChunk(chunk: LatLng[]): Promise<number[]> {
  const url = new URL('https://api.open-meteo.com/v1/elevation')
  url.searchParams.set('latitude', chunk.map((p) => p.lat.toFixed(5)).join(','))
  url.searchParams.set('longitude', chunk.map((p) => p.lng.toFixed(5)).join(','))

  let lastError: Error | null = null
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url.toString())
      if (res.status === 429) {
        await sleep(1100 * (attempt + 1))
        continue
      }
      if (!res.ok) {
        lastError = new Error(`Elevation lookup failed (${res.status}).`)
        await sleep(400 * (attempt + 1))
        continue
      }
      const data = (await res.json()) as { elevation?: number[]; error?: boolean }
      if (data.error || !data.elevation) {
        lastError = new Error('Elevation lookup failed.')
        continue
      }
      return data.elevation
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      await sleep(400 * (attempt + 1))
    }
  }

  throw lastError ?? new Error('Elevation lookup failed.')
}

/** Best-effort elevations — returns zeros on total failure */
export async function fetchElevationsSoft(points: LatLng[]): Promise<number[]> {
  try {
    return await fetchElevations(points)
  } catch {
    return points.map(() => 0)
  }
}
