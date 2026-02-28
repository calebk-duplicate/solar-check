interface MetricCardProps {
  label: string
  value: string
  unit?: string
  icon?: React.ReactNode
}

export function MetricCard({ label, value, unit, icon }: MetricCardProps) {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 hover:border-gray-600 transition-colors">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wide">
          {label}
        </h3>
        {icon && <div className="text-gray-500">{icon}</div>}
      </div>
      <div className="flex items-baseline gap-2">
        <p className="text-3xl font-bold text-white tabular-nums">{value}</p>
        {unit && <span className="text-lg text-gray-400">{unit}</span>}
      </div>
    </div>
  )
}
