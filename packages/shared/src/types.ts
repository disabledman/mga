export type ConsentState = 'pending' | 'granted' | 'denied';

export interface AnalyticsEvent {
  event_id: string;
  tenant_id: string;
  site_id: string;
  event_name: string;
  timestamp: string;
  client_ts: string;
  session_id: string;
  visitor_id: string;
  page_url?: string;
  page_path?: string;
  referrer?: string;
  user_agent?: string;
  device_type?: string;
  browser?: string;
  os?: string;
  country?: string;
  track_id?: string;
  consent_granted?: boolean;
  properties?: Record<string, unknown>;
}

export interface CollectPayload {
  site_id: string;
  write_key: string;
  events: AnalyticsEvent[];
}

export interface MssqlEventDto {
  event_id: string;
  tenant_id: string;
  site_id: string;
  event_name: string;
  event_time_utc: string;
  session_id: string;
  visitor_id: string;
  page_url?: string;
  page_path?: string;
  referrer?: string;
  user_agent?: string;
  device_type?: string;
  browser?: string;
  os?: string;
  country_code?: string;
  track_id?: string;
  properties_json?: string;
  consent_granted?: boolean;
}

export interface MssqlBatchRequest {
  batch_id: string;
  source: string;
  events: MssqlEventDto[];
}

export interface MssqlBatchResponse {
  accepted: number;
  duplicates: number;
}

export interface SiteConfig {
  site_id: string;
  tenant_id: string;
  name: string;
  write_key: string;
  allowed_hosts: string[];
  is_active: boolean;
}

export interface QueueRow {
  id: number;
  payload: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  attempts: number;
  last_error: string | null;
  created_at: string;
}
