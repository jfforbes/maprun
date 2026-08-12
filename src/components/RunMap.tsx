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
  controlPoints?: LatLng[] | null
  allowPickStart?: boolean
  onPickStart?: (point: LatLng) => void
  onDragHandle?: (handleIndex: number, point: LatLng) => void
}

const ROUTE_SOURCE = 'run-route'
const ROUTE_LAYER = 'run-route-line'

export function RunMap({
  start,
  route,
  controlPoints,
  allowPickStart = true,
  onPickStart,
  onDragHandle,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<Map | null>(null)
  const markerRef = useRef<Marker | null>(null)
  const handleMarkersRef = useRef<Marker[]>([])
  const onPickRef = useRef(onPickStart)
  const onDragRef = useRef(onDragHandle)
  const allowPickRef = useRef(allowPickStart)
  onPickRef.current = onPickStart
  onDragRef.current = onDragHandle
  allowPickRef.current = allowPickStart

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
      if (!allowPickRef.current) return
      onPickRef.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng })
    })

    map.on('load', () => {
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
    })

    mapRef.current = map
    return () => {
      markerRef.current?.remove()
      for (const m of handleMarkersRef.current) m.remove()
      handleMarkersRef.current = []
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

      const bounds = new LngLatBounds()
      for (const p of route) bounds.extend([p.lng, p.lat])
      map.fitBounds(bounds, { padding: 64, duration: 800, maxZoom: 15 })
    }

    if (map.isStyleLoaded()) apply()
    else map.once('load', apply)
  }, [route])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    for (const m of handleMarkersRef.current) m.remove()
    handleMarkersRef.current = []

    if (!controlPoints?.length) return

    controlPoints.forEach((point, index) => {
      const el = document.createElement('div')
      el.className = 'route-handle'
      el.title = 'Drag to reshape the route'
      const marker = new Marker({ element: el, draggable: true })
        .setLngLat([point.lng, point.lat])
        .addTo(map)

      marker.on('dragend', () => {
        const lngLat = marker.getLngLat()
        onDragRef.current?.(index, { lat: lngLat.lat, lng: lngLat.lng })
      })

      handleMarkersRef.current.push(marker)
    })
  }, [controlPoints])

  return <div ref={containerRef} className="run-map" role="presentation" />
}

function emptyLine(): Feature {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: [] },
  }
}
