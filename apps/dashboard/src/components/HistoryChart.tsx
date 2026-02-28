import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import type { HistoryPoint } from '../types'
import { formatTime } from '../utils/format'

interface HistoryChartProps {
  data: HistoryPoint[]
}

export function HistoryChart({ data }: HistoryChartProps) {
  const chartData = data.map((point) => ({
    time: formatTime(point.ts_utc),
    PV: point.pv_w,
    Load: point.load_w,
    Import: point.grid_import_w,
    Export: point.grid_export_w,
  }))

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-6">
      <h3 className="text-lg font-semibold text-white mb-4">24-Hour History</h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
          <XAxis
            dataKey="time"
            stroke="#9CA3AF"
            tick={{ fill: '#9CA3AF', fontSize: 12 }}
          />
          <YAxis
            stroke="#9CA3AF"
            tick={{ fill: '#9CA3AF', fontSize: 12 }}
            label={{ value: 'Watts', angle: -90, position: 'insideLeft', fill: '#9CA3AF' }}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1F2937',
              border: '1px solid #374151',
              borderRadius: '0.5rem',
              color: '#F9FAFB',
            }}
            labelStyle={{ color: '#F9FAFB' }}
          />
          <Legend wrapperStyle={{ color: '#F9FAFB' }} />
          <Line
            type="monotone"
            dataKey="PV"
            stroke="#FBBF24"
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="Load"
            stroke="#60A5FA"
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="Import"
            stroke="#F59E0B"
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="Export"
            stroke="#10B981"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
