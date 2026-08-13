import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { AddressAutocomplete } from './AddressAutocomplete'
import { StatusProgress } from './StatusProgress'
import { discoverRuns, type DiscoverHit } from '../lib/discover'
import { geocodeAddress, type GeocodeResult } from '../lib/geocode'
import { buildGpx, downloadGpx } from '../lib/gpx'
import type { LatLng } from '../lib/geo'
import {
  clearPlannedRoutes,
  restoreRoutingState,
} from '../lib/router'

type FormState = {
  home: string
  searchRadiusMiles: string
  distanceMiles: string
  varianceMiles: string
  maxElevationFeet: string
  allowLights: boolean
}

const defaults: FormState = {
  home: '',
  searchRadiusMiles: '15',
  distanceMiles: '5',
  varianceMiles: '0.5',
  maxElevationFeet: '200',
  allowLights: false,
}

type Props = {
  busy: boolean
  status: string | null
  progress?: number | null
  error: string | null
  onBusy: (busy: boolean) => void
  onStatus: (status: string | null) => void
  onProgress: (progress: number | null) => void
  onError: (error: string | null) => void
  onSelectHit: (hit: DiscoverHit) => void
  selectedId: string | null
  hits: DiscoverHit[]
  onHits: (hits: DiscoverHit[]) => void
  home: LatLng | null
  homeLabel?: string | null
  onHome: (home: LatLng | null, label: string) => void
}

export function DiscoverPanel({
  busy,
  status,
  progress,
  error,
  onBusy,
  onStatus,
  onProgress,
  onError,
  onSelectHit,
  selectedId,
  hits,
  onHits,
  home,
  homeLabel,
  onHome,
}: Props) {
  const [form, setForm] = useState<FormState>(defaults)
  const [picked, setPicked] = useState(false)

  useEffect(() => {
    if (!homeLabel) return
    setForm((f) => (f.home === homeLabel ? f : { ...f, home: homeLabel }))
    setPicked(true)
  }, [homeLabel])

  const canSearch = Boolean(home || form.home.trim())

  const selected = useMemo(
    () => hits.find((h) => h.id === selectedId) ?? null,
    [hits, selectedId],
  )

  function applyHome(result: GeocodeResult) {
    onHome(result.location, result.label)
    setForm((f) => ({ ...f, home: result.label }))
    setPicked(true)
  }

  async function ensureHome(): Promise<LatLng> {
    if (home && picked) return home
    const typed = form.home.trim()
    if (!typed) throw new Error('Enter a home base or starting area.')
    const result = await geocodeAddress(typed)
    applyHome(result)
    return result.location
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    onError(null)
    onHits([])
    clearPlannedRoutes()

    const searchRadiusMiles = Number(form.searchRadiusMiles)
    const distanceMiles = Number(form.distanceMiles)
    const varianceMiles = Number(form.varianceMiles)
    const maxElevationFeet = Number(form.maxElevationFeet)

    if (!Number.isFinite(searchRadiusMiles) || searchRadiusMiles < 1) {
      onError('Search radius must be at least 1 mile.')
      return
    }
    if (searchRadiusMiles > 40) {
      onError('Keep search radius at 40 miles or less.')
      return
    }
    if (!Number.isFinite(distanceMiles) || distanceMiles <= 0) {
      onError('Enter a run distance greater than 0.')
      return
    }
    if (!Number.isFinite(varianceMiles) || varianceMiles < 0) {
      onError('Variance must be 0 or greater.')
      return
    }
    if (!Number.isFinite(maxElevationFeet) || maxElevationFeet < 0) {
      onError('Max climb must be 0 or greater.')
      return
    }

    onBusy(true)
    try {
      onProgress(0.02)
      onStatus('Resolving home base…')
      const origin = await ensureHome()
      const found = await discoverRuns({
        home: origin,
        searchRadiusMiles,
        distanceMiles,
        varianceMiles,
        maxClimbFeet: maxElevationFeet,
        allowLights: form.allowLights,
        onStatus,
        onProgress,
      })
      onHits(found)
      if (found[0]) {
        restoreRoutingState(found[0].routingSnap)
        onSelectHit(found[0])
      }
      onStatus(null)
      onProgress(null)
    } catch (err) {
      onStatus(null)
      onProgress(null)
      onError(err instanceof Error ? err.message : 'Could not find runs.')
    } finally {
      onBusy(false)
    }
  }

  function onExport() {
    if (!selected) return
    const gpx = buildGpx(
      selected.route.coordinates,
      selected.route.elevationsM,
      `MapRun ${selected.name} ${selected.route.distanceMiles.toFixed(1)} mi`,
    )
    downloadGpx(gpx)
  }

  return (
    <>
      <p className="brand-sub discover-lead">
        Drive-to loops from lots or street parking. Ranked by climb, then
        lights, turns, and crossings.
      </p>

      <form className="route-form" onSubmit={onSubmit}>
        <label className="field">
          <span>Home base</span>
          <AddressAutocomplete
            value={form.home}
            disabled={busy}
            onChange={(homeValue) => {
              setForm({ ...form, home: homeValue })
              setPicked(false)
            }}
            onSelect={applyHome}
          />
          <em className="field-hint">
            Search centers on this point. Tap the map to set it too.
          </em>
        </label>

        <div className="field-grid">
          <label className="field">
            <span>Drive radius (mi)</span>
            <input
              type="number"
              inputMode="decimal"
              min="1"
              max="40"
              step="1"
              value={form.searchRadiusMiles}
              disabled={busy}
              onChange={(e) =>
                setForm({ ...form, searchRadiusMiles: e.target.value })
              }
            />
          </label>
          <label className="field">
            <span>Run distance (mi)</span>
            <input
              type="number"
              inputMode="decimal"
              min="0.5"
              step="0.1"
              value={form.distanceMiles}
              disabled={busy}
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
              disabled={busy}
              onChange={(e) =>
                setForm({ ...form, varianceMiles: e.target.value })
              }
            />
          </label>
          <label className="field">
            <span>Max climb (ft)</span>
            <input
              type="number"
              inputMode="numeric"
              min="0"
              step="10"
              value={form.maxElevationFeet}
              disabled={busy}
              onChange={(e) =>
                setForm({ ...form, maxElevationFeet: e.target.value })
              }
            />
          </label>
        </div>

        <fieldset className="field choice-field">
          <legend>Lights</legend>
          <div className="choice-row" role="radiogroup" aria-label="Lights">
            <button
              type="button"
              className={`choice${form.allowLights ? '' : ' is-on'}`}
              aria-pressed={!form.allowLights}
              disabled={busy}
              onClick={() => setForm({ ...form, allowLights: false })}
            >
              No
            </button>
            <button
              type="button"
              className={`choice${form.allowLights ? ' is-on' : ''}`}
              aria-pressed={form.allowLights}
              disabled={busy}
              onClick={() => setForm({ ...form, allowLights: true })}
            >
              Yes
            </button>
          </div>
          <em className="field-hint">
            {form.allowLights
              ? 'Traffic lights are allowed. Runs are still ranked by how many they hit.'
              : 'Routes avoid traffic lights when possible.'}
          </em>
        </fieldset>

        <button
          className="btn primary"
          type="submit"
          disabled={busy || !canSearch}
        >
          {busy ? 'Searching…' : 'Find runs'}
        </button>
      </form>

      <StatusProgress status={status} progress={busy ? progress : null} />
      {error && <p className="error">{error}</p>}

      {hits.length > 0 && (
        <section className="route-options" aria-label="Discovered runs">
          <h2>Best drive-to runs</h2>
          <div className="route-option-list">
            {hits.map((hit, index) => {
              const active = hit.id === selectedId
              return (
                <button
                  key={hit.id}
                  type="button"
                  className={`route-option${active ? ' is-active' : ''}`}
                  disabled={busy}
                  aria-pressed={active}
                  onClick={() => {
                    restoreRoutingState(hit.routingSnap)
                    onSelectHit(hit)
                  }}
                >
                  <strong>
                    {index + 1}. {hit.name}
                  </strong>
                  <span>
                    {hit.driveMiles.toFixed(1)} mi drive · {hit.parkingLabel}
                  </span>
                  <span>
                    {hit.route.distanceMiles.toFixed(2)} mi run ·{' '}
                    {Math.round(hit.route.elevationGainFeet)} ft climb ·{' '}
                    {hit.route.signals} lights · {hit.route.turns} turns
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      )}

      {selected && (
        <section className="stats" aria-live="polite">
          <h2>Selected run</h2>
          <ul>
            <li>
              <span>Start</span>
              <strong>{selected.name}</strong>
            </li>
            <li>
              <span>Parking</span>
              <strong>{selected.parkingLabel}</strong>
            </li>
            <li>
              <span>Drive</span>
              <strong>{selected.driveMiles.toFixed(1)} mi</strong>
            </li>
            <li>
              <span>Distance</span>
              <strong>{selected.route.distanceMiles.toFixed(2)} mi</strong>
            </li>
            <li>
              <span>Elev gain</span>
              <strong>{Math.round(selected.route.elevationGainFeet)} ft</strong>
            </li>
            <li>
              <span>Lights (OSM)</span>
              <strong>{selected.route.signals}</strong>
            </li>
          </ul>
          <button
            className="btn secondary"
            type="button"
            onClick={onExport}
            disabled={!selected.route.coordinates.length}
          >
            Export GPX
          </button>
        </section>
      )}
    </>
  )
}
