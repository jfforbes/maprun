import type { LatLng } from './geo'

export function buildGpx(
  coordinates: LatLng[],
  elevationsM: number[],
  name = 'MapRun route',
): string {
  const when = new Date().toISOString()
  const trkpts = coordinates
    .map((c, i) => {
      const ele = elevationsM[i]
      const eleTag =
        ele !== undefined && Number.isFinite(ele)
          ? `\n        <ele>${ele.toFixed(1)}</ele>`
          : ''
      return `      <trkpt lat="${c.lat.toFixed(6)}" lon="${c.lng.toFixed(6)}">${eleTag}
      </trkpt>`
    })
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="MapRun"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapeXml(name)}</name>
    <time>${when}</time>
  </metadata>
  <trk>
    <name>${escapeXml(name)}</name>
    <type>running</type>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function downloadGpx(gpx: string, filename = 'maprun-route.gpx') {
  const blob = new Blob([gpx], { type: 'application/gpx+xml' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
