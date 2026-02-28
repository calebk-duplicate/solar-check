import { LiveResponse, SystemStatus } from '../types'
import { format } from 'date-fns'

export function determineStatus(data: LiveResponse): SystemStatus {
  if (data.grid_export_w > 0) return 'exporting'
  if (data.grid_import_w > 0) return 'importing'
  return 'neutral'
}

export function formatWatts(watts: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(watts))
}

export function formatKWh(kwh: number): string {
  return kwh.toFixed(1)
}

export function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`
}

export function formatTimestamp(isoString: string): string {
  try {
    return format(new Date(isoString), 'PPpp')
  } catch {
    return isoString
  }
}

export function formatTime(isoString: string): string {
  try {
    return format(new Date(isoString), 'HH:mm')
  } catch {
    return isoString
  }
}
