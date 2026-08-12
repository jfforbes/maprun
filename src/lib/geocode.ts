import type { LatLng } from './geo'

export type GeocodeResult = {
  label: string
  location: LatLng
}

/** San Diego metro bias for Nominatim viewbox (west,south,east,north) */
const SAN_DIEGO_VIEWBOX = '-117.60,32.50,-116.70,33.20'

function parseCoordinates(query: string): GeocodeResult | null {
  const coordMatch = query
    .trim()
    .match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/)
  if (!coordMatch) return null

  const lat = Number(coordMatch[1])
  const lng = Number(coordMatch[2])
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  ) {
    return null
  }

  return {
    label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
    location: { lat, lng },
  }
}

type NominatimHit = {
  lat: string
  lon: string
  display_name: string
  place_id: number
}

async function nominatimSearch(
  query: string,
  limit: number,
): Promise<GeocodeResult[]> {
  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('addressdetails', '0')
  url.searchParams.set('limit', String(limit))
  url.searchParams.set('countrycodes', 'us')
  url.searchParams.set('viewbox', SAN_DIEGO_VIEWBOX)
  url.searchParams.set('bounded', '0')

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error('Geocoding failed. Try again in a moment.')

  const data = (await res.json()) as NominatimHit[]
  const seen = new Set<string>()
  const results: GeocodeResult[] = []

  for (const hit of data) {
    const label = hit.display_name
    if (seen.has(label)) continue
    seen.add(label)
    results.push({
      label,
      location: { lat: Number(hit.lat), lng: Number(hit.lon) },
    })
  }

  return results
}

export async function searchAddresses(query: string): Promise<GeocodeResult[]> {
  const trimmed = query.trim()
  if (trimmed.length < 3) return []

  const coords = parseCoordinates(trimmed)
  if (coords) return [coords]

  return nominatimSearch(trimmed, 6)
}

export async function geocodeAddress(query: string): Promise<GeocodeResult> {
  const trimmed = query.trim()
  const coords = parseCoordinates(trimmed)
  if (coords) return coords

  const results = await nominatimSearch(trimmed, 1)
  if (!results.length) throw new Error('Could not find that location.')
  return results[0]
}
