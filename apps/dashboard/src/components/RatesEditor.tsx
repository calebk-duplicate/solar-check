import { useState, useEffect, useCallback } from 'react'
import type { RatesResponse, RatePeriod } from '../types'
import { putRates } from '../api/client'

interface PeriodRow {
  id: number
  days: 'all' | 'weekday' | 'weekend'
  start: string
  end: string
  cents_per_kwh: string
}

let nextId = 1
function makeRow(p?: RatePeriod): PeriodRow {
  return {
    id: nextId++,
    days: p?.days ?? 'all',
    start: p?.start ?? '00:00',
    end: p?.end ?? '24:00',
    cents_per_kwh: p != null ? String(p.cents_per_kwh) : '0',
  }
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const END_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/

function validateRows(rows: PeriodRow[], label: string): string[] {
  const errors: string[] = []
  if (rows.length === 0) {
    errors.push(`${label}: at least one period is required.`)
    return errors
  }
  rows.forEach((row, i) => {
    const n = i + 1
    if (!TIME_RE.test(row.start)) errors.push(`${label} row ${n}: start must be HH:mm.`)
    if (!END_TIME_RE.test(row.end)) errors.push(`${label} row ${n}: end must be HH:mm or 24:00.`)
    const c = parseFloat(row.cents_per_kwh)
    if (isNaN(c) || c < 0) errors.push(`${label} row ${n}: cents/kWh must be ≥ 0.`)
  })
  return errors
}

function rowsToPeriods(rows: PeriodRow[]): RatePeriod[] {
  return rows.map(r => ({
    days: r.days,
    start: r.start,
    end: r.end,
    cents_per_kwh: parseFloat(r.cents_per_kwh),
  }))
}

interface PeriodTableProps {
  label: string
  rows: PeriodRow[]
  onChange: (rows: PeriodRow[]) => void
}

function PeriodTable({ label, rows, onChange }: PeriodTableProps) {
  function updateRow(id: number, patch: Partial<PeriodRow>) {
    onChange(rows.map(r => (r.id === id ? { ...r, ...patch } : r)))
  }

  function addRow() {
    onChange([...rows, makeRow()])
  }

  function removeRow(id: number) {
    onChange(rows.filter(r => r.id !== id))
  }

  return (
    <div>
      <h4 className="text-sm font-semibold text-gray-300 mb-2">{label}</h4>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-500 border-b border-gray-700">
              <th className="text-left pb-2 pr-3 font-medium">Days</th>
              <th className="text-left pb-2 pr-3 font-medium">Start</th>
              <th className="text-left pb-2 pr-3 font-medium">End</th>
              <th className="text-left pb-2 pr-3 font-medium">Cents/kWh</th>
              <th className="pb-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.id} className="border-b border-gray-800">
                <td className="py-1.5 pr-3">
                  <select
                    value={row.days}
                    onChange={e => updateRow(row.id, { days: e.target.value as PeriodRow['days'] })}
                    className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white text-sm w-full focus:outline-none focus:border-blue-500"
                  >
                    <option value="all">All</option>
                    <option value="weekday">Weekday</option>
                    <option value="weekend">Weekend</option>
                  </select>
                </td>
                <td className="py-1.5 pr-3">
                  <input
                    type="text"
                    value={row.start}
                    onChange={e => updateRow(row.id, { start: e.target.value })}
                    placeholder="HH:mm"
                    className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white text-sm w-24 focus:outline-none focus:border-blue-500"
                  />
                </td>
                <td className="py-1.5 pr-3">
                  <input
                    type="text"
                    value={row.end}
                    onChange={e => updateRow(row.id, { end: e.target.value })}
                    placeholder="HH:mm"
                    className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white text-sm w-24 focus:outline-none focus:border-blue-500"
                  />
                </td>
                <td className="py-1.5 pr-3">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={row.cents_per_kwh}
                    onChange={e => updateRow(row.id, { cents_per_kwh: e.target.value })}
                    className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white text-sm w-24 focus:outline-none focus:border-blue-500"
                  />
                </td>
                <td className="py-1.5">
                  <button
                    type="button"
                    onClick={() => removeRow(row.id)}
                    className="text-gray-500 hover:text-red-400 transition-colors px-1"
                    title="Remove row"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        onClick={addRow}
        className="mt-2 text-sm text-blue-400 hover:text-blue-300 transition-colors"
      >
        + Add row
      </button>
    </div>
  )
}

interface Props {
  initialRates: RatesResponse
  onSaved: (rates: RatesResponse) => void
}

export function RatesEditor({ initialRates, onSaved }: Props) {
  const [fixedCents, setFixedCents] = useState(String(initialRates.daily_fixed_cents))
  const [timezone, setTimezone] = useState(initialRates.timezone)
  const [importRows, setImportRows] = useState<PeriodRow[]>(() =>
    initialRates.import_periods.map(makeRow)
  )
  const [exportRows, setExportRows] = useState<PeriodRow[]>(() =>
    initialRates.export_periods.map(makeRow)
  )
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [statusMsg, setStatusMsg] = useState('')

  // Sync if parent pushes a new initialRates (e.g. after external navigation)
  useEffect(() => {
    setFixedCents(String(initialRates.daily_fixed_cents))
    setTimezone(initialRates.timezone)
    setImportRows(initialRates.import_periods.map(makeRow))
    setExportRows(initialRates.export_periods.map(makeRow))
  }, [initialRates])

  const validationErrors = useCallback((): string[] => {
    const errs: string[] = []
    const fixed = parseFloat(fixedCents)
    if (isNaN(fixed) || fixed < 0) errs.push('Daily fixed must be ≥ 0.')
    if (!timezone.trim()) errs.push('Timezone is required.')
    errs.push(...validateRows(importRows, 'Import'))
    errs.push(...validateRows(exportRows, 'Export'))
    return errs
  }, [fixedCents, timezone, importRows, exportRows])

  const errors = validationErrors()
  const canSave = errors.length === 0 && status !== 'saving'

  async function handleSave() {
    const errs = validationErrors()
    if (errs.length > 0) return

    setStatus('saving')
    setStatusMsg('')
    try {
      const payload: RatesResponse = {
        daily_fixed_cents: parseFloat(fixedCents),
        timezone: timezone.trim(),
        import_periods: rowsToPeriods(importRows),
        export_periods: rowsToPeriods(exportRows),
      }
      const updated = await putRates(payload)
      setStatus('saved')
      setStatusMsg('Saved.')
      onSaved(updated)
      setTimeout(() => setStatus('idle'), 3000)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed'
      setStatus('error')
      setStatusMsg(msg)
    }
  }

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-6">
      <h3 className="text-lg font-semibold mb-6">Rates &amp; Schedule</h3>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Daily Fixed (cents/day)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={fixedCents}
            onChange={e => setFixedCents(e.target.value)}
            className="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white text-sm w-full focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Timezone</label>
          <input
            type="text"
            value={timezone}
            onChange={e => setTimezone(e.target.value)}
            placeholder="Pacific/Auckland"
            className="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white text-sm w-full focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>

      <div className="space-y-6 mb-6">
        <PeriodTable label="Import Periods" rows={importRows} onChange={setImportRows} />
        <PeriodTable label="Export Periods" rows={exportRows} onChange={setExportRows} />
      </div>

      {errors.length > 0 && (
        <div className="mb-4 p-3 bg-red-900/40 border border-red-700 rounded text-red-300 text-sm space-y-0.5">
          {errors.map((e, i) => (
            <p key={i}>{e}</p>
          ))}
        </div>
      )}

      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={handleSave}
          disabled={!canSave}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:text-gray-400 disabled:cursor-not-allowed text-white text-sm font-medium rounded transition-colors"
        >
          {status === 'saving' ? 'Saving…' : 'Save'}
        </button>

        {status === 'saved' && (
          <span className="text-sm text-green-400">{statusMsg}</span>
        )}
        {status === 'error' && (
          <span className="text-sm text-red-400">{statusMsg}</span>
        )}
      </div>
    </div>
  )
}
