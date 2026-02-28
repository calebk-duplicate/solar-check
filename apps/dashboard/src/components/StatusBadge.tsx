import type { SystemStatus } from '../types'

interface StatusBadgeProps {
  status: SystemStatus
}

const statusStyles = {
  exporting: 'bg-green-600 text-white',
  importing: 'bg-amber-500 text-gray-900',
  neutral: 'bg-gray-600 text-white',
}

const statusLabels = {
  exporting: 'Exporting',
  importing: 'Importing',
  neutral: 'Neutral',
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span
      className={`px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider transition-colors duration-300 ${statusStyles[status]}`}
    >
      {statusLabels[status]}
    </span>
  )
}
