type Props = {
  status: string | null
  progress?: number | null
}

export function StatusProgress({ status, progress }: Props) {
  if (!status && progress == null) return null
  const pct =
    progress == null
      ? null
      : Math.round(Math.min(100, Math.max(0, progress * 100)))

  return (
    <div className="status-progress">
      {status && <p className="status">{status}</p>}
      {pct != null && (
        <div
          className="progress-track"
          role="progressbar"
          aria-label="Routing progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}
