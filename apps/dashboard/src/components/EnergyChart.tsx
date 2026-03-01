import { useState, useEffect } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceArea,
} from 'recharts'
import { fetchEnergy5m, getRates } from '../api/client'
import type { RatePeriod } from '../types'

// ── helpers ──────────────────────────────────────────────────────────────────

function localHHMM(tsMs: number, timezone: string): string {
  return new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(tsMs))
}

function isWeekendTs(tsMs: number, timezone: string): boolean {
  const day = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    weekday: 'short',
  }).format(new Date(tsMs))
  return day === 'Sat' || day === 'Sun'
}

/**
 * Returns true if tsMs falls within any of the supplied zero-rate periods.
 * Period times are HH:mm strings; "24:00" is treated as end-of-day.
 * String comparison is safe here because times are always zero-padded HH:MM.
 */
function isZeroRate(tsMs: number, zeroPeriods: RatePeriod[], timezone: string): boolean {
  const hhmm = localHHMM(tsMs, timezone)
  const dayType = isWeekendTs(tsMs, timezone) ? 'weekend' : 'weekday'

  for (const p of zeroPeriods) {
    const applies = !p.days || p.days === 'all' || p.days === dayType
    if (!applies) continue
    // "24:00" > any "HH:MM", so the upper-bound check works with plain string compare
    if (hhmm >= p.start && hhmm < p.end) return true
  }
  return false
}

interface ShadedBand { x1: number; x2: number }

/**
 * Walks chartData points and merges contiguous zero-rate points into bands
 * suitable for <ReferenceArea x1={…} x2={…} />.
 */
function buildShadedBands(
  chartData: ChartPoint[],
  zeroPeriods: RatePeriod[],
  timezone: string,
): ShadedBand[] {
  if (zeroPeriods.length === 0 || chartData.length === 0) return []

  const bands: ShadedBand[] = []
  let bandStart: number | null = null

  for (const point of chartData) {
    if (isZeroRate(point.ts, zeroPeriods, timezone)) {
      if (bandStart === null) bandStart = point.ts
    } else if (bandStart !== null) {
      bands.push({ x1: bandStart, x2: point.ts })
      bandStart = null
    }
  }
  if (bandStart !== null) {
    bands.push({ x1: bandStart, x2: chartData[chartData.length - 1].ts })
  }

  return bands
}

// ── chart data type ───────────────────────────────────────────────────────────

interface ChartPoint {
  ts: number      // epoch ms — used as the XAxis dataKey and for ReferenceArea bounds
  Import: number
  Export: number
}

// ── component ─────────────────────────────────────────────────────────────────

interface EnergyChartProps {
  fromIso: string
  toIso: string
}

export function EnergyChart({ fromIso, toIso }: EnergyChartProps) {
  const [chartData, setChartData] = useState<ChartPoint[]>([])
  const [shadedBands, setShadedBands] = useState<ShadedBand[]>([])
  const [ticks, setTicks] = useState<number[]>([])
  const [timezone, setTimezone] = useState('UTC')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)

    Promise.all([fetchEnergy5m(fromIso, toIso), getRates()])
      .then(([energy, rates]) => {
        const tz = rates.timezone
        const zeroPeriods = rates.import_periods.filter((p) => p.cents_per_kwh === 0)

        const points: ChartPoint[] = energy.data.map((pt) => ({
          ts: new Date(pt.ts_utc).getTime(),
          Import: +(pt.import_wh / 1000).toFixed(4),
          Export: +(pt.export_wh / 1000).toFixed(4),
        }))

        // One tick per hour — where local time is HH:00
        const hourlyTicks = points
          .filter((p) => localHHMM(p.ts, tz).endsWith(':00'))
          .map((p) => p.ts)

        setTimezone(tz)
        setChartData(points)
        setTicks(hourlyTicks)
        setShadedBands(buildShadedBands(points, zeroPeriods, tz))
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [fromIso, toIso])

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-6">
      <h3 className="text-lg font-semibold text-white mb-4">Energy (5-min buckets)</h3>
      {loading && <p className="text-gray-400 text-sm">Loading…</p>}
      {error && <p className="text-red-400 text-sm">{error}</p>}
      {!loading && !error && (
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />

            {/* Shaded bands for zero-import-rate windows */}
            {shadedBands.map((band, i) => (
              <ReferenceArea
                key={i}
                x1={band.x1}
                x2={band.x2}
                fill="#FBBF24"
                fillOpacity={0.08}
                ifOverflow="visible"
              />
            ))}

            <XAxis
              dataKey="ts"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              ticks={ticks}
              tickFormatter={(ts: number) => localHHMM(ts, timezone)}
              stroke="#9CA3AF"
              tick={{ fill: '#9CA3AF', fontSize: 12 }}
            />
            <YAxis
              stroke="#9CA3AF"
              tick={{ fill: '#9CA3AF', fontSize: 12 }}
              label={{ value: 'kWh', angle: -90, position: 'insideLeft', fill: '#9CA3AF' }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#1F2937',
                border: '1px solid #374151',
                borderRadius: '0.5rem',
                color: '#F9FAFB',
              }}
              labelStyle={{ color: '#F9FAFB' }}
              labelFormatter={(ts: number) => localHHMM(ts, timezone)}
              formatter={(value: number) => [`${value.toFixed(4)} kWh`]}
            />
            <Legend wrapperStyle={{ color: '#F9FAFB' }} />
            <Area
              type="monotone"
              dataKey="Import"
              stroke="#EF4444"
              fill="#EF4444"
              fillOpacity={0.3}
              strokeWidth={1.5}
              dot={false}
            />
            <Area
              type="monotone"
              dataKey="Export"
              stroke="#22C55E"
              fill="#22C55E"
              fillOpacity={0.3}
              strokeWidth={1.5}
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
