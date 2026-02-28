import { LiveResponse, HistoryResponse, DailyResponse } from '../types'
import { getMockLive, getMockHistory, getMockDaily } from './mock'

export const USE_MOCK = true

const API_BASE = ''

export async function getLive(): Promise<LiveResponse> {
  if (USE_MOCK) {
    return getMockLive()
  }

  const response = await fetch(`${API_BASE}/api/live`)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }
  return response.json()
}

export async function getHistory(
  fromIso: string,
  toIso: string
): Promise<HistoryResponse> {
  if (USE_MOCK) {
    return getMockHistory()
  }

  const url = `${API_BASE}/api/history?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }
  return response.json()
}

export async function getDaily(
  fromIso: string,
  toIso: string
): Promise<DailyResponse | DailyResponse[]> {
  if (USE_MOCK) {
    return getMockDaily()
  }

  const url = `${API_BASE}/api/daily?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }
  const data = await response.json()
  return data
}
