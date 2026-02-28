import type { LiveResponse, HistoryResponse, DailyResponse } from '../types'
import { getMockLive, getMockHistory, getMockDaily } from './mock'

export const USE_MOCK = false

type LiveApiEnvelope = {
  data: LiveResponse | null
  message?: string
}

type HistoryApiEnvelope = {
  data: HistoryResponse['data']
}

type DailyApiEnvelope = {
  data: DailyResponse[]
}

export async function getLive(): Promise<LiveResponse> {
  if (USE_MOCK) {
    return getMockLive()
  }

  const response = await fetch('/api/live')
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  const payload = (await response.json()) as LiveResponse | LiveApiEnvelope
  if ('data' in payload) {
    if (!payload.data) {
      throw new Error(payload.message || 'No live data yet')
    }
    return payload.data
  }

  return payload
}

export async function getHistory(
  fromIso: string,
  toIso: string
): Promise<HistoryResponse> {
  if (USE_MOCK) {
    return getMockHistory()
  }

  const url = `/api/history?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  const payload = (await response.json()) as HistoryResponse | HistoryApiEnvelope
  if ('data' in payload) {
    return { data: payload.data }
  }

  return payload
}

export async function getDaily(
  fromIso: string,
  toIso: string
): Promise<DailyResponse | null> {
  if (USE_MOCK) {
    return getMockDaily()
  }

  const url = `/api/daily?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  const payload = (await response.json()) as DailyResponse | DailyResponse[] | DailyApiEnvelope
  if (Array.isArray(payload)) {
    return payload[0] || null
  }

  if ('data' in payload) {
    return payload.data[0] || null
  }

  return payload
}
