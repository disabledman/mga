import { z } from 'zod';

export const analyticsEventSchema = z.object({
  event_id: z.string().uuid(),
  tenant_id: z.string().min(1).max(32),
  site_id: z.string().min(1).max(32),
  event_name: z.string().min(1).max(64),
  timestamp: z.string().datetime(),
  client_ts: z.string().datetime(),
  session_id: z.string().min(8).max(64),
  visitor_id: z.string().min(8).max(64),
  page_url: z.string().max(2048).optional(),
  page_path: z.string().max(2048).optional(),
  referrer: z.string().max(2048).optional(),
  user_agent: z.string().max(512).optional(),
  device_type: z.string().max(16).optional(),
  browser: z.string().max(64).optional(),
  os: z.string().max(64).optional(),
  country: z.string().length(2).optional(),
  client_ip: z.string().max(45).optional(),
  track_id: z.string().max(128).optional(),
  consent_granted: z.boolean().optional(),
  properties: z.record(z.unknown()).optional(),
});

export const collectPayloadSchema = z.object({
  site_id: z.string().min(1).max(32),
  write_key: z.string().min(8).max(64),
  events: z.array(analyticsEventSchema).min(1).max(50),
});

export const mssqlBatchRequestSchema = z.object({
  batch_id: z.string().uuid(),
  source: z.string().min(1).max(64),
  events: z.array(
    z.object({
      event_id: z.string().uuid(),
      tenant_id: z.string(),
      site_id: z.string(),
      event_name: z.string(),
      event_time_utc: z.string(),
      session_id: z.string(),
      visitor_id: z.string(),
      page_url: z.string().optional(),
      page_path: z.string().optional(),
      referrer: z.string().optional(),
      user_agent: z.string().optional(),
      device_type: z.string().optional(),
      browser: z.string().optional(),
      os: z.string().optional(),
      country_code: z.string().optional(),
      client_ip: z.string().max(45).optional(),
      track_id: z.string().optional(),
      properties_json: z.string().optional(),
      consent_granted: z.boolean().optional(),
    })
  ).min(1).max(500),
});
