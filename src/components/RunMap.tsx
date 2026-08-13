import { useEffect, useRef } from 'react'
import {
  Map,
  Marker,
  NavigationControl,
  LngLatBounds,
  setWorkerUrl,
  type MapMouseEvent,
  type GeoJSONSource,
} from 'maplibre-gl'
import type { Feature } from 'geojson'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import type { LatLng } from '../lib/geo'

setWorkerUrl(workerUrl)

type Props = {
  start: LatLng | null
  route: LatLng[] | null
  /** Other auto-route options shown faintly behind the selected route. */
  alternateRoutes?: LatLng[][] | null
  controlPoints?: LatLng[] | null
  waypoints?: LatLng[] | null
  parking?: LatLng | null
  mode?: 'pick-start' | 'draw' | 'view'
  onPickStart?: (point: LatLng) => void
  onDrawClick?: (point: LatLng) => void
  onDragHandle?: (handleIndex: number, point: LatLng) => void
  onRouteClick?: (point: LatLng) => void
}

const ROUTE_SOURCE = 'run-route'
const ROUTE_LAYER = 'run-route-line'
const ROUTE_HIT = 'run-route-hit'
const ALT_SOURCE = 'run-route-alts'
const ALT_LAYER = 'run-route-alts-line'

export function RunMap({
  start,
  route,
  alternateRoutes,
  controlPoints,
  waypoints,
  parking,
  mode = 'pick-start',
  onPickStart,
  onDrawClick,
  onDragHandle,
  onRouteClick,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<Map | null>(null)
  const markerRef = useRef<Marker | null>(null)
  const parkingMarkerRef = useRef<Marker | null>(null)
  const handleMarkersRef = useRef<Marker[]>([])
  const waypointMarkersRef = useRef<Marker[]>([])
  const modeRef = useRef(mode)
  const onPickRef = useRef(onPickStart)
  const onDrawRef = useRef(onDrawClick)
  const onDragRef = useRef(onDragHandle)
  const onRouteClickRef = useRef(onRouteClick)
  modeRef.current = mode
  onPickRef.current = onPickStart
  onDrawRef.current = onDrawClick
  onDragRef.current = onDragHandle
  onRouteClickRef.current = onRouteClick

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const map = new Map({
      container: containerRef.current,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [-117.1611, 32.7157],
      zoom: 12,
    })

    map.addControl(new NavigationControl({ showCompass: false }), 'top-right')

    map.on('click', (e: MapMouseEvent) => {
      const point = { lat: e.lngLat.lat, lng: e.lngLat.lng }
      if (modeRef.current === 'pick-start') {
        onPickRef.current?.(point)
      } else if (modeRef.current === 'draw') {
        onDrawRef.current?.(point)
      } else if (modeRef.current === 'view' && onRouteClickRef.current) {
        const layers = [ROUTE_LAYER, ROUTE_HIT].filter((id) => map.getLayer(id))
        if (!layers.length) return
        const pad = 16
        const hits = map.queryRenderedFeatures(
          [
            [e.point.x - pad, e.point.y - pad],
            [e.point.x + pad, e.point.y + pad],
          ],
          { layers },
        )
        if (hits.length) onRouteClickRef.current(point)
      }
    })

    map.on('load', () => {
      map.addSource(ALT_SOURCE, {
        type: 'geojson',
        data: emptyMultiLine(),
      })
      map.addLayer({
        id: ALT_LAYER,
        type: 'line',
        source: ALT_SOURCE,
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': '#5f7a68',
          'line-width': 3.5,
          'line-opacity': 0.35,
          'line-dasharray': [1.2, 1.6],
        },
      })
      map.addSource(ROUTE_SOURCE, {
        type: 'geojson',
        data: emptyLine(),
      })
      map.addLayer({
        id: ROUTE_LAYER,
        type: 'line',
        source: ROUTE_SOURCE,
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': '#1f6f4a',
          'line-width': 5,
          'line-opacity': 0.92,
        },
      })
      map.addLayer({
        id: ROUTE_HIT,
        type: 'line',
        source: ROUTE_SOURCE,
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': '#1f6f4a',
          'line-width': 22,
          'line-opacity': 0.01,
        },
      })
      map.resize()
    })

    map.on('mouseenter', ROUTE_HIT, () => {
      if (modeRef.current === 'view' && onRouteClickRef.current) {
        map.getCanvas().style.cursor = 'pointer'
      }
    })
    map.on('mouseleave', ROUTE_HIT, () => {
      map.getCanvas().style.cursor = ''
    })

    const resizeMap = () => map.resize()
    window.addEventListener('resize', resizeMap)
    window.addEventListener('orientationchange', resizeMap)

    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            map.resize()
          })
        : null
    ro?.observe(containerRef.current)

    mapRef.current = map
    return () => {
      window.removeEventListener('resize', resizeMap)
      window.removeEventListener('orientationchange', resizeMap)
      ro?.disconnect()
      markerRef.current?.remove()
      parkingMarkerRef.current?.remove()
      for (const m of handleMarkersRef.current) m.remove()
      for (const m of waypointMarkersRef.current) m.remove()
      handleMarkersRef.current = []
      waypointMarkersRef.current = []
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !start) return

    if (!markerRef.current) {
      const el = document.createElement('div')
      el.className = 'start-marker'
      markerRef.current = new Marker({ element: el })
        .setLngLat([start.lng, start.lat])
        .addTo(map)
    } else {
      markerRef.current.setLngLat([start.lng, start.lat])
    }

    if (!route?.length) {
      map.easeTo({ center: [start.lng, start.lat], zoom: Math.max(map.getZoom(), 13) })
    }
  }, [start, route])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    if (!parking) {
      parkingMarkerRef.current?.remove()
      parkingMarkerRef.current = null
      return
    }

    if (!parkingMarkerRef.current) {
      const el = document.createElement('div')
      el.className = 'parking-marker'
      el.title = 'Parking'
      parkingMarkerRef.current = new Marker({ element: el })
        .setLngLat([parking.lng, parking.lat])
        .addTo(map)
    } else {
      parkingMarkerRef.current.setLngLat([parking.lng, parking.lat])
    }
  }, [parking])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const apply = () => {
      const source = map.getSource(ROUTE_SOURCE) as GeoJSONSource | undefined
      if (!source) return

      if (!route?.length) {
        source.setData(emptyLine())
        return
      }

      source.setData({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: route.map((p) => [p.lng, p.lat]),
        },
      })

      if (modeRef.current !== 'draw') {
        const bounds = new LngLatBounds()
        for (const p of route) bounds.extend([p.lng, p.lat])
        const pad = window.matchMedia('(max-width: 860px)').matches ? 36 : 64
        map.fitBounds(bounds, { padding: pad, duration: 800, maxZoom: 15 })
      }
    }

    if (map.isStyleLoaded()) apply()
    else map.once('load', apply)
  }, [route])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const apply = () => {
      const source = map.getSource(ALT_SOURCE) as GeoJSONSource | undefined
      if (!source) return

      const lines = (alternateRoutes ?? []).filter((r) => r.length > 1)
      if (!lines.length) {
        source.setData(emptyMultiLine())
        return
      }

      source.setData({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'MultiLineString',
          coordinates: lines.map((line) => line.map((p) => [p.lng, p.lat])),
        },
      })
    }

    if (map.isStyleLoaded()) apply()
    else map.once('load', apply)
  }, [alternateRoutes])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    for (const m of handleMarkersRef.current) m.remove()
    handleMarkersRef.current = []

    if (!controlPoints?.length || mode === 'draw') return

    controlPoints.forEach((point, index) => {
      const el = document.createElement('div')
      el.className = 'route-handle'
      el.title = 'Drag to reshape the route'
      el.addEventListener('click', (ev) => ev.stopPropagation())
      const marker = new Marker({ element: el, draggable: true })
        .setLngLat([point.lng, point.lat])
        .addTo(map)

      marker.on('dragend', () => {
        const lngLat = marker.getLngLat()
        onDragRef.current?.(index, { lat: lngLat.lat, lng: lngLat.lng })
      })

      handleMarkersRef.current.push(marker)
    })
  }, [controlPoints, mode])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    for (const m of waypointMarkersRef.current) m.remove()
    waypointMarkersRef.current = []

    if (!waypoints?.length) return

    waypoints.forEach((point, index) => {
      if (index === 0) return // start marker already shown
      const el = document.createElement('div')
      el.className = 'waypoint-marker'
      el.textContent = String(index)
      const marker = new Marker({ element: el })
        .setLngLat([point.lng, point.lat])
        .addTo(map)
      waypointMarkersRef.current.push(marker)
    })
  }, [waypoints])

  return <div ref={containerRef} className={`run-map mode-${mode}`} role="presentation" />
}

function emptyLine(): Feature {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: [] },
  }
}

function emptyMultiLine(): Feature {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'MultiLineString', coordinates: [] },
  }
}
