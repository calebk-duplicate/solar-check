import type { LiveResponse, HistoryResponse, DailyResponse } from '../types'

export const MOCK_LIVE_EXPORTING: LiveResponse = {
  ts_utc: '2026-03-01T01:30:00Z',
  pv_w: 4200,
  load_w: 3100,
  grid_import_w: 0,
  grid_export_w: 1100,
  grid_net_w: -1100,
  self_consumed_w: 3100,
  explanation: 'Exporting surplus solar production.',
}

export const MOCK_LIVE_IMPORTING: LiveResponse = {
  ts_utc: '2026-03-01T19:45:00Z',
  pv_w: 200,
  load_w: 1800,
  grid_import_w: 1600,
  grid_export_w: 0,
  grid_net_w: 1600,
  self_consumed_w: 200,
  explanation: 'Importing because household load exceeds solar generation.',
}

export const MOCK_HISTORY: HistoryResponse = {
  data: [
    { ts_utc: '2026-02-29T00:00:00Z', pv_w: 0, load_w: 500, grid_import_w: 500, grid_export_w: 0 },
    { ts_utc: '2026-02-29T06:00:00Z', pv_w: 100, load_w: 600, grid_import_w: 500, grid_export_w: 0 },
    { ts_utc: '2026-02-29T09:00:00Z', pv_w: 2500, load_w: 1200, grid_import_w: 0, grid_export_w: 1300 },
    { ts_utc: '2026-02-29T12:00:00Z', pv_w: 4800, load_w: 2000, grid_import_w: 0, grid_export_w: 2800 },
    { ts_utc: '2026-02-29T15:00:00Z', pv_w: 3500, load_w: 1800, grid_import_w: 0, grid_export_w: 1700 },
    { ts_utc: '2026-02-29T18:30:00Z', pv_w: 300, load_w: 2400, grid_import_w: 2100, grid_export_w: 0 },
    { ts_utc: '2026-02-29T22:00:00Z', pv_w: 0, load_w: 700, grid_import_w: 700, grid_export_w: 0 },
  ],
}

export const MOCK_DAILY: DailyResponse = {
  day: '2026-02-29',
  pv_kwh: 28.4,
  load_kwh: 21.2,
  import_kwh: 6.1,
  export_kwh: 13.3,
  self_kwh: 15.1,
  import_cost: 1.95,
  export_credit: 1.6,
  net_cost: 0.35,
}

export function getMockLive(): Promise<LiveResponse> {
  const hour = new Date().getHours()
  const isDaytime = hour >= 6 && hour <= 18
  const data = isDaytime ? MOCK_LIVE_EXPORTING : MOCK_LIVE_IMPORTING
  
  return Promise.resolve({
    ...data,
    ts_utc: new Date().toISOString(),
  })
}

export function getMockHistory(): Promise<HistoryResponse> {
  return Promise.resolve(MOCK_HISTORY)
}

export function getMockDaily(): Promise<DailyResponse> {
  const today = new Date().toISOString().split('T')[0]
  return Promise.resolve({
    ...MOCK_DAILY,
    day: today,
  })
}
