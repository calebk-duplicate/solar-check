import { useState, useEffect } from 'react'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { fetchEnergy5m } from '../api/client'
import type { Energy5mPoint } from '../types'

const TIMEZONE = 'Pacific/Auckland'

function formatLocalTime(tsUtc: string): string {
  try {
    return new Intl.DateTimeFormat('en', {
      timeZone: TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(tsUtc))
  } catch {
    return tsUtc
  }
}

interface EnergyChartProps {
  fromIso: string
  toIso: string
}

export function EnergyChart({ fromIso, toIso }: EnergyChartProps) {
  const [data, setData] = useState<Energy5mPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetchEnergy5m(fromIso, toIso)
      .then((res) => setData(res.data))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [fromIso, toIso])

  const chartData = data.map((point) => ({
    time: formatLocalTime(point.ts_utc),
    Import: +(point.import_wh / 1000).toFixed(4),
    Export: +(point.export_wh / 1000).toFixed(4),
  }))

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-6">
      <h3 className="text-lg font-semibold text-white mb-4">Energy (5-min buckets)</h3>
      {loading && <p className="text-gray-400 text-sm">Loading…</p>}
      {error && <p className="text-red-400 text-sm">{error}</p>}
      {!loading && !error && (
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis
              dataKey="time"
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
