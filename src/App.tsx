import { useMemo, useState, type FormEvent } from 'react'
import { AddressAutocomplete } from './components/AddressAutocomplete'
import { RunMap } from './components/RunMap'
import { geocodeAddress, type GeocodeResult } from './lib/geocode'
import { buildGpx, downloadGpx } from './lib/gpx'
import type { LatLng } from './lib/geo'
import {
  dragRouteHandle,
  planRunRoute,
  type RouteResult,
} from './lib/router'

type FormState = {
  location: string
  distanceMiles: string
  varianceMiles: string
  maxElevationFeet: string
}

const defaults: FormState = {
  location: '',
  distanceMiles: '5',
  varianceMiles: '0.5',
  maxElevationFeet: '200',
}

export default function App() {
  const [form, setForm] = useState<FormState>(defaults)
  const [start, setStart] = useState<LatLng | null>(null)
  const [resolvedLabel, setResolvedLabel] = useState<string | null>(null)
  const [pickedFromSuggestions, setPickedFromSuggestions] = useState(false)
  const [route, setRoute] = useState<RouteResult | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const canExport = Boolean(route?.coordinates.length)

  const summary = useMemo(() => {
    if (!route) return null
    return [
      { label: 'Type', value: route.label },
      { label: 'Distance', value: `${route.distanceMiles.toFixed(2)} mi` },
      { label: 'Elev change', value: `${Math.round(route.elevationChangeFeet)} ft` },
      { label: 'Elev gain', value: `${Math.round(route.elevationGainFeet)} ft` },
      { label: 'Elev loss', value: `${Math.round(route.elevationLossFeet)} ft` },
      { label: 'Elev range', value: `${Math.round(route.elevationRangeFeet)} ft` },
      { label: 'Signals', value: String(route.signals) },
      { label: 'Crossings', value: String(route.crossings) },
      { label: 'Turns', value: String(route.turns) },
    ]
  }, [route])

  function applyLocation(result: GeocodeResult) {
    setStart(result.location)
    setResolvedLabel(result.label)
    setForm((f) => ({ ...f, location: result.label }))
    setPickedFromSuggestions(true)
    setRoute(null)
  }

  function onPickStart(point: LatLng) {
    const label = `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`
    setStart(point)
    setResolvedLabel(label)
    setForm((f) => ({ ...f, location: label }))
    setPickedFromSuggestions(true)
    setRoute(null)
  }

  async function onDragHandle(handleIndex: number, point: LatLng) {
    setError(null)
    setBusy(true)
    setStatus('Updating route…')
    try {
      const result = await dragRouteHandle(handleIndex, point)
      setRoute(result)
      setStatus(null)
    } catch (err) {
      setStatus(null)
      setError(err instanceof Error ? err.message : 'Could not update route.')
    } finally {
      setBusy(false)
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setRoute(null)

    const distanceMiles = Number(form.distanceMiles)
    const varianceMiles = Number(form.varianceMiles)
    const maxElevationFeet = Number(form.maxElevationFeet)

    if (!Number.isFinite(distanceMiles) || distanceMiles <= 0) {
      setError('Enter a distance greater than 0.')
      return
    }
    if (!Number.isFinite(varianceMiles) || varianceMiles < 0) {
      setError('Variance must be 0 or greater.')
      return
    }
    if (!Number.isFinite(maxElevationFeet) || maxElevationFeet < 0) {
      setError('Max elevation change must be 0 or greater.')
      return
    }
    if (distanceMiles > 20) {
      setError('Keep distance at 20 miles or less for now.')
      return
    }

    setBusy(true)
    try {
      setStatus('Resolving start…')
      let origin = start
      const typed = form.location.trim()
      if (!typed) {
        throw new Error('Enter a starting location or click the map.')
      }

      if (!origin || !pickedFromSuggestions) {
        const result = await geocodeAddress(typed)
        applyLocation(result)
        origin = result.location
      }

      const result = await planRunRoute({
        start: origin,
        distanceMiles,
        varianceMiles,
        maxElevationChangeFeet: maxElevationFeet,
        onStatus: setStatus,
      })

      setRoute(result)
      setStatus(null)
    } catch (err) {
      setStatus(null)
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  function onExport() {
    if (!route) return
    const gpx = buildGpx(
      route.coordinates,
      route.elevationsM,
      `MapRun ${route.label} ${route.distanceMiles.toFixed(1)} mi`,
    )
    downloadGpx(gpx)
  }

  return (
    <div className="app-shell">
      <aside className="panel">
        <header className="brand">
          <p className="brand-mark">MapRun</p>
          <p className="brand-sub">Quiet routes. Exact miles. Exportable.</p>
        </header>

        <form className="route-form" onSubmit={onSubmit}>
          <label className="field">
            <span>Starting location</span>
            <AddressAutocomplete
              value={form.location}
              disabled={busy}
              onChange={(location) => {
                setForm({ ...form, location })
                setPickedFromSuggestions(false)
              }}
              onSelect={applyLocation}
            />
            {resolvedLabel && pickedFromSuggestions && (
              <em className="field-hint">Selected: {resolvedLabel}</em>
            )}
          </label>

          <div className="field-row">
            <label className="field">
              <span>Distance (mi)</span>
              <input
                type="number"
                min="0.5"
                step="0.1"
                value={form.distanceMiles}
                onChange={(e) =>
                  setForm({ ...form, distanceMiles: e.target.value })
                }
              />
            </label>
            <label className="field">
              <span>Variance (mi)</span>
              <input
                type="number"
                min="0"
                step="0.1"
                value={form.varianceMiles}
                onChange={(e) =>
                  setForm({ ...form, varianceMiles: e.target.value })
                }
              />
            </label>
          </div>

          <label className="field">
            <span>Max elevation change (ft)</span>
            <input
              type="number"
              min="0"
              step="10"
              value={form.maxElevationFeet}
              onChange={(e) =>
                setForm({ ...form, maxElevationFeet: e.target.value })
              }
            />
            <em className="field-hint">
              Caps total up + down (gain and loss combined). Prefers a loop;
              out-and-back is a backup. Drag green handles on the map to reshape.
            </em>
          </label>

          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'Routing…' : 'Route run'}
          </button>
        </form>

        {status && <p className="status">{status}</p>}
        {error && <p className="error">{error}</p>}

        {summary && (
          <section className="stats" aria-live="polite">
            <h2>Route</h2>
            <ul>
              {summary.map((item) => (
                <li key={item.label}>
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </li>
              ))}
            </ul>
            <button
              className="btn secondary"
              type="button"
              onClick={onExport}
              disabled={!canExport}
            >
              Export GPX
            </button>
          </section>
        )}

        <footer className="panel-foot">
          Prefers paths with fewer lights, crossings, and turns. Built on
          OpenStreetMap.
        </footer>
      </aside>

      <main className="map-stage">
        <RunMap
          start={start}
          route={route?.coordinates ?? null}
          controlPoints={route?.controlPoints ?? null}
          allowPickStart={!route}
          onPickStart={onPickStart}
          onDragHandle={onDragHandle}
        />
      </main>
    </div>
  )
}
