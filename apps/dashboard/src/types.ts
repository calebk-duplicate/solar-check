export interface LiveResponse {
  ts_utc: string
  pv_w: number
  load_w: number
  grid_import_w: number
  grid_export_w: number
  grid_net_w: number
  self_consumed_w: number
  explanation?: string
}

export interface HistoryPoint {
  ts_utc: string
  pv_w: number
  load_w: number
  grid_import_w: number
  grid_export_w: number
}

export interface HistoryResponse {
  data: HistoryPoint[]
}

export interface DailyResponse {
  day: string
  pv_kwh: number
  load_kwh: number
  import_kwh: number
  export_kwh: number
  self_kwh: number
  import_cost?: number
  export_credit?: number
  net_cost?: number
}

export type SystemStatus = 'exporting' | 'importing' | 'neutral'
