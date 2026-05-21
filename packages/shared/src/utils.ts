import type { AnalyticsEvent, MssqlEventDto } from './types.js';

export function anonymizeIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  if (ip.includes('.')) {
    const parts = ip.split('.');
    if (parts.length === 4) {
      parts[3] = '0';
      return parts.join('.');
    }
  }
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return parts.slice(0, 4).join(':') + '::';
  }
  return ip;
}

export function parseAllowedHosts(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    /* fall through */
  }
  return raw.split(',').map((h) => h.trim()).filter(Boolean);
}

export function hostMatchesAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p.startsWith('*.')) {
      const suffix = p.slice(1);
      return h === p.slice(2) || h.endsWith(suffix);
    }
    return h === p;
  });
}

export function toMssqlDto(event: AnalyticsEvent): MssqlEventDto {
  const props = { ...event.properties };
  if (event.track_id) props.track_id = event.track_id;

  return {
    event_id: event.event_id,
    tenant_id: event.tenant_id,
    site_id: event.site_id,
    event_name: event.event_name,
    event_time_utc: event.timestamp,
    session_id: event.session_id,
    visitor_id: event.visitor_id,
    page_url: event.page_url,
    page_path: event.page_path,
    referrer: event.referrer,
    user_agent: event.user_agent,
    device_type: event.device_type,
    browser: event.browser,
    os: event.os,
    country_code: event.country,
    track_id: event.track_id,
    properties_json: Object.keys(props).length ? JSON.stringify(props) : undefined,
    consent_granted: event.consent_granted,
  };
}

export function extractTrackId(properties?: Record<string, unknown>): string | undefined {
  if (!properties) return undefined;
  const id = properties.track_id;
  return typeof id === 'string' ? id : undefined;
}
