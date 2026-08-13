import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { AddressAutocomplete } from './components/AddressAutocomplete'
import { DiscoverPanel } from './components/DiscoverPanel'
import { RunMap } from './components/RunMap'
import { geocodeAddress, type GeocodeResult } from './lib/geocode'
import { buildGpx, downloadGpx } from './lib/gpx'
import type { DiscoverHit } from './lib/discover'
import type { LatLng } from './lib/geo'
import {
  addManualWaypoint,
  beginManualRoute,
  cancelManualRoute,
  clearPlannedRoutes,
  dragRouteHandle,
  finishManualAtStart,
  planRunRoute,
  selectPlannedRoute,
  undoManualWaypoint,
  type RouteResult,
} from './lib/router'

type TabId = 'nearby' | 'discover'

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
  const [tab, setTab] = useState<TabId>('nearby')
  const [form, setForm] = useState<FormState>(defaults)
  const [start, setStart] = useState<LatLng | null>(null)
  const [resolvedLabel, setResolvedLabel] = useState<string | null>(null)
  const [pickedFromSuggestions, setPickedFromSuggestions] = useState(false)
  const [route, setRoute] = useState<RouteResult | null>(null)
  const [routeOptions, setRouteOptions] = useState<RouteResult[]>([])
  const [selectedOption, setSelectedOption] = useState(0)
  const [drawing, setDrawing] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [mapFocus, setMapFocus] = useState(false)
  const [discoverHits, setDiscoverHits] = useState<DiscoverHit[]>([])
  const [discoverSelectedId, setDiscoverSelectedId] = useState<string | null>(
    null,
  )
  const [discoverHome, setDiscoverHome] = useState<LatLng | null>(null)

  const selectedDiscover = useMemo(
    () => discoverHits.find((h) => h.id === discoverSelectedId) ?? null,
    [discoverHits, discoverSelectedId],
  )

  const canExport = Boolean(route?.coordinates.length)
  const mapMode =
    tab === 'discover'
      ? selectedDiscover
        ? 'view'
        : 'pick-start'
      : drawing
        ? 'draw'
        : route
          ? 'view'
          : 'pick-start'

  const canStart = Boolean(start || form.location.trim())

  useEffect(() => {
    if (drawing) setMapFocus(true)
  }, [drawing])

  const summary = useMemo(() => {
    if (tab !== 'nearby' || !route) return null
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
  }, [route, tab])

  function switchTab(next: TabId) {
    if (next === tab) return
    setTab(next)
    setError(null)
    setStatus(null)
    setMapFocus(false)
    if (next === 'nearby') {
      setDiscoverSelectedId(null)
    } else {
      setDrawing(false)
      cancelManualRoute()
    }
  }

  function clearRoutes() {
    setRoute(null)
    setRouteOptions([])
    setSelectedOption(0)
    clearPlannedRoutes()
  }

  function applyLocation(result: GeocodeResult) {
    cancelManualRoute()
    setDrawing(false)
    setStart(result.location)
    setResolvedLabel(result.label)
    setForm((f) => ({ ...f, location: result.label }))
    setPickedFromSuggestions(true)
    clearRoutes()
  }

  function onPickStart(point: LatLng) {
    if (tab === 'discover') {
      const label = `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`
      setDiscoverHome(point)
      setStart(point)
      setResolvedLabel(label)
      return
    }
    cancelManualRoute()
    setDrawing(false)
    const label = `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`
    setStart(point)
    setResolvedLabel(label)
    setForm((f) => ({ ...f, location: label }))
    setPickedFromSuggestions(true)
    clearRoutes()
  }

  function onSelectDiscoverHit(hit: DiscoverHit) {
    setDiscoverSelectedId(hit.id)
    setRoute(hit.route)
    setRouteOptions([])
    setSelectedOption(0)
    setStart(hit.parking)
    setResolvedLabel(hit.name)
  }

  async function ensureStart(): Promise<LatLng> {
    let origin = start
    const typed = form.location.trim()
    if (!typed && !origin) {
      throw new Error('Enter a starting location or tap the map.')
    }
    if (!origin || !pickedFromSuggestions) {
      if (!typed) throw new Error('Enter a starting location or tap the map.')
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
      setRouteOptions([])
      setSelectedOption(0)
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
      setRouteOptions([])
      setSelectedOption(0)
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
      setRouteOptions([])
      setSelectedOption(0)
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
      setRouteOptions([])
      setSelectedOption(0)
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
    clearRoutes()
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
      setRouteOptions([])
      setSelectedOption(0)
      setStatus(null)
    } catch (err) {
      setStatus(null)
      setError(err instanceof Error ? err.message : 'Could not update route.')
    } finally {
      setBusy(false)
    }
  }

  function onSelectOption(index: number) {
    if (index === selectedOption || busy) return
    try {
      const result = selectPlannedRoute(index)
      setSelectedOption(index)
      setRoute(result)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch routes.')
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    clearRoutes()
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
      setError('Max climb must be 0 or greater.')
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

      const planned = await planRunRoute({
        start: origin,
        distanceMiles,
        varianceMiles,
        maxClimbFeet: maxElevationFeet,
        onStatus: setStatus,
      })

      setRouteOptions(planned.routes)
      setSelectedOption(planned.selectedIndex)
      setRoute(planned.routes[planned.selectedIndex] ?? null)
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
    <div className={`app-shell${mapFocus ? ' map-focus' : ''}`}>
      <aside className={`panel${mapFocus ? ' is-compact' : ''}`}>
        <header className="brand">
          <div className="brand-row">
            <p className="brand-mark">MapRun</p>
            <button
              className="btn ghost panel-toggle"
              type="button"
              onClick={() => setMapFocus((v) => !v)}
              aria-expanded={!mapFocus}
              aria-controls="route-controls"
            >
              {mapFocus ? 'Show controls' : 'Focus map'}
            </button>
          </div>
          <div className="tab-row" role="tablist" aria-label="MapRun modes">
            <button
              type="button"
              role="tab"
              className={`tab${tab === 'nearby' ? ' is-active' : ''}`}
              aria-selected={tab === 'nearby'}
              disabled={busy}
              onClick={() => switchTab('nearby')}
            >
              From here
            </button>
            <button
              type="button"
              role="tab"
              className={`tab${tab === 'discover' ? ' is-active' : ''}`}
              aria-selected={tab === 'discover'}
              disabled={busy}
              onClick={() => switchTab('discover')}
            >
              Find runs
            </button>
          </div>
          {tab === 'nearby' && (
            <p className="brand-sub">Quiet routes. Exact miles. Exportable.</p>
          )}
        </header>

        <div id="route-controls" className="panel-body">
        {tab === 'discover' ? (
          <DiscoverPanel
            busy={busy}
            status={status}
            error={error}
            onBusy={setBusy}
            onStatus={setStatus}
            onError={setError}
            hits={discoverHits}
            onHits={setDiscoverHits}
            selectedId={discoverSelectedId}
            onSelectHit={onSelectDiscoverHit}
            home={discoverHome}
            homeLabel={tab === 'discover' ? resolvedLabel : null}
            onHome={(point, label) => {
              setDiscoverHome(point)
              setStart(point)
              setResolvedLabel(label)
            }}
          />
        ) : (
          <>
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
                inputMode="decimal"
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
                inputMode="decimal"
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
            <span>Max climb (ft)</span>
            <input
              type="number"
              inputMode="numeric"
              min="0"
              step="10"
              value={form.maxElevationFeet}
              disabled={drawing}
              onChange={(e) =>
                setForm({ ...form, maxElevationFeet: e.target.value })
              }
            />
            <em className="field-hint">
              Cumulative elevation gain only (descents ignored). Auto routes
              prioritize lower climb first, then lights, turns, and crossings.
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
                Tap the map to drop waypoints. Each segment follows streets.
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

        {routeOptions.length > 1 && (
          <section className="route-options" aria-label="Route options">
            <h2>Choose a route</h2>
            <div className="route-option-list">
              {routeOptions.map((opt, index) => {
                const active = index === selectedOption
                return (
                  <button
                    key={`${opt.label}-${opt.distanceMiles}-${index}`}
                    type="button"
                    className={`route-option${active ? ' is-active' : ''}`}
                    disabled={busy}
                    aria-pressed={active}
                    onClick={() => onSelectOption(index)}
                  >
                    <strong>
                      Option {index + 1}
                      {opt.optionLabel ? ` · ${opt.optionLabel}` : ''}
                    </strong>
                    <span>
                      {opt.distanceMiles.toFixed(2)} mi ·{' '}
                      {Math.round(opt.elevationGainFeet)} ft climb
                    </span>
                    <span>
                      {opt.label} · {opt.signals} lights · {opt.turns} turns
                    </span>
                  </button>
                )
              })}
            </div>
          </section>
        )}

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
          Prefers lower climb first, then fewer lights, turns, and crossings.
          Built on OpenStreetMap.
        </footer>
          </>
        )}
        </div>
      </aside>

      <main className="map-stage">
        {mapFocus && (
          <div className="map-chrome">
            <button
              className="btn primary map-chrome-btn"
              type="button"
              onClick={() => setMapFocus(false)}
            >
              Controls
            </button>
            {drawing && tab === 'nearby' && (
              <div className="map-chrome-actions">
                <button
                  className="btn ghost map-chrome-btn"
                  type="button"
                  disabled={busy || !route}
                  onClick={onUndoWaypoint}
                >
                  Undo
                </button>
                <button
                  className="btn ghost map-chrome-btn"
                  type="button"
                  disabled={busy || !route}
                  onClick={onFinishAtStart}
                >
                  Finish
                </button>
              </div>
            )}
          </div>
        )}
        <RunMap
          start={
            tab === 'discover'
              ? (selectedDiscover?.parking ?? discoverHome ?? start)
              : start
          }
          route={
            tab === 'discover'
              ? (selectedDiscover?.route.coordinates ?? null)
              : (route?.coordinates ?? null)
          }
          alternateRoutes={
            tab === 'nearby' && routeOptions.length > 1
              ? routeOptions
                  .filter((_, i) => i !== selectedOption)
                  .map((r) => r.coordinates)
              : null
          }
          controlPoints={
            tab === 'nearby' ? (route?.controlPoints ?? null) : null
          }
          waypoints={tab === 'nearby' ? (route?.waypoints ?? null) : null}
          parking={
            tab === 'discover' ? (selectedDiscover?.parking ?? null) : null
          }
          mode={mapMode}
          onPickStart={onPickStart}
          onDrawClick={tab === 'nearby' ? onDrawClick : undefined}
          onDragHandle={tab === 'nearby' ? onDragHandle : undefined}
        />
      </main>
    </div>
  )
}
