import { useMemo, useState, type FormEvent } from 'react'
import { AddressAutocomplete } from './components/AddressAutocomplete'
import { RunMap } from './components/RunMap'
import { geocodeAddress, type GeocodeResult } from './lib/geocode'
import { buildGpx, downloadGpx } from './lib/gpx'
import type { LatLng } from './lib/geo'
import {
  addManualWaypoint,
  beginManualRoute,
  cancelManualRoute,
  dragRouteHandle,
  finishManualAtStart,
  planRunRoute,
  undoManualWaypoint,
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
  const [drawing, setDrawing] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const canExport = Boolean(route?.coordinates.length)
  const mapMode = drawing ? 'draw' : route ? 'view' : 'pick-start'

  const canStart = Boolean(start || form.location.trim())

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
    cancelManualRoute()
    setDrawing(false)
    setStart(result.location)
    setResolvedLabel(result.label)
    setForm((f) => ({ ...f, location: result.label }))
    setPickedFromSuggestions(true)
    setRoute(null)
  }

  function onPickStart(point: LatLng) {
    cancelManualRoute()
    setDrawing(false)
    const label = `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`
    setStart(point)
    setResolvedLabel(label)
    setForm((f) => ({ ...f, location: label }))
    setPickedFromSuggestions(true)
    setRoute(null)
  }

  async function ensureStart(): Promise<LatLng> {
    let origin = start
    const typed = form.location.trim()
    if (!typed && !origin) {
      throw new Error('Enter a starting location or click the map.')
    }
    if (!origin || !pickedFromSuggestions) {
      if (!typed) throw new Error('Enter a starting location or click the map.')
      const result = await geocodeAddress(typed)
      applyLocation(result)
      origin = result.location
    }
    return origin
  }

  async function onStartDrawing() {
    setError(null)
    setBusy(true)
    try {
      setStatus('Preparing draw mode…')
      const origin = await ensureStart()
      const hint = Number(form.distanceMiles)
      await beginManualRoute(
        origin,
        Number.isFinite(hint) && hint > 0 ? hint : 5,
        setStatus,
      )
      setRoute(null)
      setDrawing(true)
      setStatus('Click the map to add waypoints. Streets will connect them.')
    } catch (err) {
      setStatus(null)
      setError(err instanceof Error ? err.message : 'Could not start drawing.')
      setDrawing(false)
    } finally {
      setBusy(false)
    }
  }

  async function onDrawClick(point: LatLng) {
    if (!drawing || busy) return
    setError(null)
    setBusy(true)
    try {
      const result = await addManualWaypoint(point)
      setRoute(result)
      setStatus('Click to add another point, or return to start.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add that point.')
    } finally {
      setBusy(false)
    }
  }

  async function onUndoWaypoint() {
    setError(null)
    setBusy(true)
    try {
      const result = await undoManualWaypoint()
      setRoute(result)
      setStatus(
        result
          ? 'Click to add another point, or return to start.'
          : 'Click the map to add waypoints.',
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not undo.')
    } finally {
      setBusy(false)
    }
  }

  async function onFinishAtStart() {
    setError(null)
    setBusy(true)
    setStatus('Routing back to start…')
    try {
      const result = await finishManualAtStart()
      setRoute(result)
      setDrawing(false)
      setStatus(null)
    } catch (err) {
      setStatus(null)
      setError(err instanceof Error ? err.message : 'Could not finish route.')
    } finally {
      setBusy(false)
    }
  }

  function onCancelDrawing() {
    cancelManualRoute()
    setDrawing(false)
    setRoute(null)
    setStatus(null)
    setError(null)
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
    cancelManualRoute()
    setDrawing(false)

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
      const origin = await ensureStart()

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
                disabled={drawing}
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
                disabled={drawing}
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
              disabled={drawing}
              onChange={(e) =>
                setForm({ ...form, maxElevationFeet: e.target.value })
              }
            />
            <em className="field-hint">
              Caps total up + down for auto routes. Or draw your own after
              picking a start — same stats either way.
            </em>
          </label>

          {!drawing ? (
            <div className="btn-row">
              <button className="btn primary" type="submit" disabled={busy || !canStart}>
                {busy ? 'Routing…' : 'Auto route'}
              </button>
              <button
                className="btn ghost"
                type="button"
                disabled={busy || !canStart}
                onClick={onStartDrawing}
              >
                Draw my own
              </button>
            </div>
          ) : (
            <div className="draw-controls">
              <p className="field-hint">
                Click the map to drop waypoints. Each segment follows streets.
              </p>
              <div className="btn-row">
                <button
                  className="btn ghost"
                  type="button"
                  disabled={busy || !route}
                  onClick={onUndoWaypoint}
                >
                  Undo point
                </button>
                <button
                  className="btn primary"
                  type="button"
                  disabled={busy || !route}
                  onClick={onFinishAtStart}
                >
                  Return to start
                </button>
              </div>
              <button
                className="btn ghost"
                type="button"
                disabled={busy}
                onClick={onCancelDrawing}
              >
                Cancel drawing
              </button>
            </div>
          )}
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
          Prefers fewer lights and sharp turns (over 60°). Built on
          OpenStreetMap.
        </footer>
      </aside>

      <main className="map-stage">
        <RunMap
          start={start}
          route={route?.coordinates ?? null}
          controlPoints={route?.controlPoints ?? null}
          waypoints={route?.waypoints ?? null}
          mode={mapMode}
          onPickStart={onPickStart}
          onDrawClick={onDrawClick}
          onDragHandle={onDragHandle}
        />
      </main>
    </div>
  )
}
