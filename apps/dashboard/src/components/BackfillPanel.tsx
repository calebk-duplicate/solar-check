import { useState, useEffect, useRef } from 'react'
import { startArchiveBackfill, getArchiveBackfillStatus } from '../api/client'
import type { BackfillStatus } from '../api/client'

function getCurrentMonthNZ(): string {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now)
  const year = parts.find(p => p.type === 'year')?.value ?? ''
  const month = parts.find(p => p.type === 'month')?.value ?? ''
  return `${year}-${month}`
}

export function BackfillPanel() {
  const [startMonth, setStartMonth] = useState(getCurrentMonthNZ)
  const [months, setMonths] = useState(2)
  const [status, setStatus] = useState<BackfillStatus | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  function stopPolling() {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  function startPolling() {
    stopPolling()
    pollRef.current = setInterval(async () => {
      try {
        const s = await getArchiveBackfillStatus()
        setStatus(s)
        if (!s.running) {
          stopPolling()
          setSubmitting(false)
        }
      } catch {
        // ignore transient poll errors
      }
    }, 2000)
  }

  useEffect(() => stopPolling, [])

  async function handleBackfill() {
    setSubmitting(true)
    setNotice(null)
    try {
      const s = await startArchiveBackfill({ start_month: startMonth, months })
      setStatus(s)
      startPolling()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('409')) {
        setNotice('Backfill already running')
        startPolling()
      } else {
        setNotice(msg)
        setSubmitting(false)
      }
    }
  }

  const isRunning = submitting || (status?.running ?? false)
  const progress = status?.progress

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 mb-8">
      <h3 className="text-lg font-semibold mb-4">Archive Backfill</h3>

      <div className="flex flex-wrap items-end gap-4 mb-1">
        <div>
          <label className="block text-sm text-gray-400 mb-1">Start Month</label>
          <input
            type="month"
            value={startMonth}
            onChange={e => setStartMonth(e.target.value)}
            disabled={isRunning}
            className="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:border-blue-500 focus:outline-none disabled:opacity-50"
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Months</label>
          <input
            type="number"
            min={1}
            max={24}
            value={months}
            onChange={e => setMonths(Math.min(24, Math.max(1, Number(e.target.value))))}
            disabled={isRunning}
            className="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:border-blue-500 focus:outline-none w-20 disabled:opacity-50"
          />
        </div>
        <button
          onClick={handleBackfill}
          disabled={isRunning}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Backfill
        </button>
      </div>

      <p className="text-xs text-gray-500 mb-4">Starts from the 1st of the selected month (NZ time).</p>

      {notice && (
        <div className="mb-4 p-3 bg-amber-900/40 border border-amber-700 rounded text-amber-300 text-sm">
          {notice}
        </div>
      )}

      {status && (
        <div className="space-y-2">
          {status.range && (
            <p className="text-xs text-gray-500">
              Range: {status.range.start_local} &rarr; {status.range.end_local}{' '}
              <span className="text-gray-600">({status.range.timezone})</span>
            </p>
          )}

          {status.running && (
            <>
              <div className="w-full bg-gray-700 rounded-full h-2">
                <div
                  className="bg-blue-500 h-2 rounded-full transition-all duration-500"
                  style={{
                    width:
                      progress && progress.total_days > 0
                        ? `${Math.round((progress.completed_days / progress.total_days) * 100)}%`
                        : '0%',
                  }}
                />
              </div>
              <p className="text-sm text-gray-300">
                {progress
                  ? `Completed ${progress.completed_days}/${progress.total_days} days, rows upserted ${progress.rows_upserted}`
                  : 'Starting…'}
              </p>
            </>
          )}

          {!status.running && status.completed_at_utc && !status.last_error && (
            <p className="text-sm text-green-400">
              Completed {new Date(status.completed_at_utc).toLocaleString()}
            </p>
          )}

          {status.last_error && (
            <div className="p-3 bg-red-900/40 border border-red-700 rounded text-red-300 text-sm">
              {status.last_error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
