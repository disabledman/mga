export interface MgaInitOptions {
  siteId: string;
  writeKey: string;
  apiHost?: string;
  tenantId?: string;
  consentRequired?: boolean;
  allowIdentify?: boolean;
  sampleRate?: number;
  autoTrack?: {
    pageView?: boolean;
    clicks?: boolean;
    outboundLinks?: boolean;
  };
  clickSelector?: string;
  maskQueryParams?: string[];
  blockPaths?: string[];
}

type ConsentState = 'pending' | 'granted' | 'denied';
type Command = [string, ...unknown[]];

interface QueuedEvent {
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

const COOKIE_VISITOR = '_mga_vid';
const COOKIE_SESSION = '_mga_sid';
const SESSION_MS = 30 * 60 * 1000;
const QUEUE_MAX = 20;
const FLUSH_MS = 5000;

let config: MgaInitOptions | null = null;
let consent: ConsentState = 'pending';
let queue: QueuedEvent[] = [];
let pendingBuffer: QueuedEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let sessionExpiry = 0;
let lastClickKey = '';
let lastClickAt = 0;
let initialized = false;
let optedOut = false;
let droppedOverflow = 0;
let superProps: Record<string, unknown> = {};
let identifiedUserId: string | null = null;
let lastPageViewPath = '';
let lastPageViewAt = 0;
let spaNavTimer: ReturnType<typeof setTimeout> | null = null;

function uuid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function writeCookie(name: string, value: string, days: number): void {
  const maxAge = days * 86400;
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; SameSite=Lax`;
}

function hashId(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

function getVisitorId(): string {
  let vid = readCookie(COOKIE_VISITOR);
  if (!vid) {
    vid = hashId();
    writeCookie(COOKIE_VISITOR, vid, 365);
  }
  return vid;
}

function getSessionId(): string {
  const now = Date.now();
  let sid = readCookie(COOKIE_SESSION);
  if (!sid || now > sessionExpiry) {
    sid = hashId();
    sessionExpiry = now + SESSION_MS;
    writeCookie(COOKIE_SESSION, sid, 1);
  } else {
    sessionExpiry = now + SESSION_MS;
    writeCookie(COOKIE_SESSION, sid, 1);
  }
  return sid;
}

function maskUrl(url: string): string {
  if (!config?.maskQueryParams?.length) return url;
  try {
    const u = new URL(url);
    for (const p of config.maskQueryParams) {
      if (u.searchParams.has(p)) u.searchParams.set(p, '[masked]');
    }
    return u.toString();
  } catch {
    return url;
  }
}

function isBlockedPath(): boolean {
  if (!config?.blockPaths?.length) return false;
  const path = location.pathname;
  return config.blockPaths.some((p) => {
    if (p.endsWith('*')) return path.startsWith(p.slice(0, -1));
    return path === p;
  });
}

function canSend(): boolean {
  if (!config) return false;
  if (config.consentRequired) return consent === 'granted';
  return consent !== 'denied';
}

function parseUa(): { device_type: string; browser: string; os: string } {
  const ua = navigator.userAgent;
  let device_type = 'desktop';
  if (/Mobi|Android/i.test(ua)) device_type = 'mobile';
  else if (/Tablet|iPad/i.test(ua)) device_type = 'tablet';

  let browser = 'unknown';
  if (/Edg\//i.test(ua)) browser = 'edge';
  else if (/Chrome\//i.test(ua)) browser = 'chrome';
  else if (/Firefox\//i.test(ua)) browser = 'firefox';
  else if (/Safari\//i.test(ua)) browser = 'safari';

  let os = 'unknown';
  if (/Windows/i.test(ua)) os = 'windows';
  else if (/Mac OS/i.test(ua)) os = 'macos';
  else if (/Android/i.test(ua)) os = 'android';
  else if (/iPhone|iPad/i.test(ua)) os = 'ios';
  else if (/Linux/i.test(ua)) os = 'linux';

  return { device_type, browser, os };
}

function shouldSample(): boolean {
  const rate = config?.sampleRate ?? 1;
  if (rate >= 1) return true;
  return Math.random() < rate;
}

function buildEvent(eventName: string, props?: Record<string, unknown>): QueuedEvent | null {
  if (!config || optedOut || isBlockedPath()) return null;
  if (!shouldSample()) return null;

  const ua = parseUa();
  const now = new Date().toISOString();
  const mergedProps = { ...superProps, ...props };
  if (identifiedUserId && config.allowIdentify) {
    mergedProps.identified_user_hash = identifiedUserId;
  }

  return {
    event_id: uuid(),
    tenant_id: config.tenantId ?? 't_default',
    site_id: config.siteId,
    event_name: eventName,
    timestamp: now,
    client_ts: now,
    session_id: getSessionId(),
    visitor_id: consent === 'granted' ? getVisitorId() : 'anonymous',
    page_url: maskUrl(location.href),
    page_path: location.pathname,
    referrer: document.referrer || undefined,
    user_agent: navigator.userAgent.slice(0, 512),
    ...ua,
    consent_granted: consent === 'granted',
    properties: Object.keys(mergedProps).length ? mergedProps : undefined,
  };
}

function shouldFlushImmediately(eventName: string): boolean {
  return eventName === 'click' || eventName === 'outbound_click' || eventName.startsWith('custom:');
}

function scheduleFlush(immediate = false): void {
  if (immediate) {
    void flush();
    return;
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => void flush(), FLUSH_MS);
  }
}

function enqueue(ev: QueuedEvent, holdUntilConsent = false): void {
  if (holdUntilConsent || (config?.consentRequired && consent === 'pending')) {
    pendingBuffer.push(ev);
    if (pendingBuffer.length > QUEUE_MAX * 2) {
      pendingBuffer.shift();
      droppedOverflow += 1;
    }
    return;
  }

  if (!canSend()) return;

  if (queue.length >= QUEUE_MAX) {
    droppedOverflow += 1;
    void flush();
  }
  queue.push(ev);
  if (queue.length >= QUEUE_MAX) {
    void flush();
    return;
  }
  scheduleFlush(shouldFlushImmediately(ev.event_name));
}

function flushPending(): void {
  if (consent !== 'granted') return;
  for (const ev of pendingBuffer) {
    ev.consent_granted = true;
    ev.visitor_id = getVisitorId();
    queue.push(ev);
  }
  pendingBuffer = [];
  void flush();
}

function buildPayload(): { site_id: string; write_key: string; events: QueuedEvent[] } | null {
  if (!config || queue.length === 0 || !canSend()) return null;
  return {
    site_id: config.siteId,
    write_key: config.writeKey,
    events: queue.splice(0, queue.length),
  };
}

async function flush(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const payload = buildPayload();
  if (!payload || !config) return;

  const url = `${config.apiHost ?? ''}/v1/collect`;
  const body = JSON.stringify(payload);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
      mode: 'cors',
      credentials: 'omit',
    });
    if (res.ok || res.status === 204) return;
    console.warn('[mga] collect rejected:', res.status, await res.text().catch(() => ''));
  } catch (err) {
    console.warn('[mga] collect failed:', err);
  }

  if (navigator.sendBeacon) {
    navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
  }
}

function trackPage(extra?: Record<string, unknown>): void {
  const path = location.pathname + location.search;
  const now = Date.now();
  if (path === lastPageViewPath && now - lastPageViewAt < 1500) return;
  lastPageViewPath = path;
  lastPageViewAt = now;

  const hold = Boolean(config?.consentRequired && consent === 'pending');
  const ev = buildEvent('page_view', extra);
  if (ev) enqueue(ev, hold);
}

function resolveLinkPagePath(link: HTMLAnchorElement): string {
  try {
    const dest = new URL(link.href, location.href);
    if (dest.origin === location.origin) {
      return dest.pathname + dest.search;
    }
    return dest.href;
  } catch {
    return location.pathname + location.search;
  }
}

function isSameOriginLink(link: HTMLAnchorElement): boolean {
  try {
    return new URL(link.href, location.href).origin === location.origin;
  } catch {
    return true;
  }
}

function trackLinkPageView(link: HTMLAnchorElement, trackId?: string): void {
  // Same-origin: PV is counted once on destination page load (trackPage).
  // Sending page_view here too would double-count after navigation.
  if (isSameOriginLink(link)) return;

  const hold = Boolean(config?.consentRequired && consent === 'pending');
  const ev = buildEvent('page_view', {
    link_click: true,
    link_url: link.href,
    ...(trackId ? { track_id: trackId } : {}),
  });
  if (!ev) return;
  ev.page_path = resolveLinkPagePath(link);
  enqueue(ev, hold);
}

function trackClick(el: Element): void {
  if (el.closest('.no-track')) return;
  const target = el as HTMLElement;
  if (target.closest('input[type="password"], [autocomplete="current-password"]')) return;

  const link = el.closest('a') as HTMLAnchorElement | null;
  const trackId = el.getAttribute('data-track') ?? undefined;
  const effectiveTrackId =
    trackId ?? (link?.href ? `link:${resolveLinkPagePath(link)}` : undefined);
  const key = trackId ?? (link?.href ? link.href : el.tagName + (el.id || ''));
  const now = Date.now();
  if (key === lastClickKey && now - lastClickAt < 1000) return;
  lastClickKey = key;
  lastClickAt = now;

  const props: Record<string, unknown> = {
    element_tag: el.tagName.toLowerCase(),
    element_id: el.id || undefined,
  };
  if (effectiveTrackId) props.track_id = effectiveTrackId;

  if (link?.href) props.link_url = link.href;

  const hold = Boolean(config?.consentRequired && consent === 'pending');

  if (link?.href) trackLinkPageView(link, effectiveTrackId);

  if (config?.autoTrack?.outboundLinks && link?.href) {
    try {
      const dest = new URL(link.href, location.href);
      if (dest.origin !== location.origin) {
        const outProps: Record<string, unknown> = { link_url: link.href };
        if (effectiveTrackId) outProps.track_id = effectiveTrackId;
        const out = buildEvent('outbound_click', outProps);
        if (out) {
          if (effectiveTrackId) out.track_id = effectiveTrackId;
          enqueue(out, hold);
        }
        return;
      }
    } catch {
      /* ignore */
    }
  }

  const ev = buildEvent('click', props);
  if (!ev) return;
  if (effectiveTrackId) ev.track_id = effectiveTrackId;
  enqueue(ev, hold);
}

function onDocumentClick(e: MouseEvent): void {
  if (!config?.autoTrack?.clicks) return;
  const selector = config.clickSelector ?? '[data-track], a, button, [role="button"]';
  const target = e.target as Element | null;
  if (!target) return;
  const trackEl = target.closest('[data-track]');
  const el = trackEl ?? target.closest(selector);
  if (el) trackClick(el);
}

function hookSpa(): void {
  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);

  const onNav = (): void => {
    if (spaNavTimer) clearTimeout(spaNavTimer);
    spaNavTimer = setTimeout(() => {
      spaNavTimer = null;
      trackPage({ spa: true });
    }, 300);
  };

  history.pushState = (...args) => {
    origPush(...args);
    onNav();
  };
  history.replaceState = (...args) => {
    origReplace(...args);
    onNav();
  };
  window.addEventListener('popstate', onNav);
}

function processCommand(args: Command): void {
  const [cmd, a, b] = args;
  switch (cmd) {
    case 'init': {
      config = a as MgaInitOptions;
      consent = config.consentRequired ? 'pending' : 'granted';
      if (!initialized) {
        initialized = true;
        if (config.autoTrack?.clicks !== false) {
          document.addEventListener('click', onDocumentClick, true);
        }
        hookSpa();
        if (config.autoTrack?.pageView !== false) {
          trackPage();
        }
      }
      break;
    }
    case 'consent': {
      const state = a as string;
      if (state === 'grant' || state === 'granted') {
        consent = 'granted';
        flushPending();
      } else if (state === 'deny' || state === 'denied') {
        consent = 'denied';
        queue = [];
        pendingBuffer = [];
      } else consent = state as ConsentState;
      break;
    }
    case 'track': {
      const name = a as string;
      const props = (b as Record<string, unknown>) ?? {};
      const hold = Boolean(config?.consentRequired && consent === 'pending');
      const ev = buildEvent(name.startsWith('custom:') ? name : `custom:${name}`, props);
      if (ev) {
        if (typeof props.track_id === 'string') ev.track_id = props.track_id;
        enqueue(ev, hold);
      }
      break;
    }
    case 'page': {
      trackPage(a as Record<string, unknown> | undefined);
      break;
    }
    case 'set': {
      Object.assign(superProps, (a as Record<string, unknown>) ?? {});
      break;
    }
    case 'identify': {
      if (!config?.allowIdentify || consent !== 'granted') break;
      identifiedUserId = String(a).slice(0, 64);
      break;
    }
    case 'opt_out': {
      optedOut = true;
      queue = [];
      pendingBuffer = [];
      break;
    }
    case 'flush': {
      void flush();
      break;
    }
    default:
      break;
  }
}

function drainPreloadQueue(existing: unknown): void {
  if (!existing) return;

  const batches: unknown[][] = [];
  if (Array.isArray(existing)) {
    batches.push(existing);
  } else if (
    (typeof existing === 'object' || typeof existing === 'function') &&
    Array.isArray((existing as { q?: unknown }).q)
  ) {
    batches.push((existing as { q: unknown[] }).q);
  }

  for (const batch of batches) {
    for (const item of batch) {
      if (Array.isArray(item) && typeof item[0] === 'string') {
        processCommand(item as Command);
      }
    }
  }
}

function bootstrap(): void {
  const w = window as Window & {
    analytics?: { push: (args: Command) => void; q?: Command[] };
    MgaAnalytics?: { push: (args: Command) => void };
  };

  drainPreloadQueue(w.analytics);

  const api = (command: string, ...rest: unknown[]) => {
    processCommand([command, ...rest]);
  };
  const fn = api as typeof api & { push: (args: Command) => void; q: Command[] };
  fn.push = (args: Command) => processCommand(args);
  fn.q = [];

  w.analytics = fn;
  w.MgaAnalytics = fn;

  window.addEventListener('pagehide', () => void flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush();
  });
}

bootstrap();

export { processCommand as mgaProcessCommand };
