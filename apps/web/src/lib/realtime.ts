import { useEffect } from 'react';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import {
  WS_CLOSE_SETUP_REQUIRED,
  WS_CLOSE_UNAUTHENTICATED,
  type Channel,
  type CursorPage,
  type FirstRun,
  type HeaderStatus,
  type Pipeline,
  type RawItem,
  type RawQuery,
  type RealtimeEvent,
  type RefineryRun,
} from '@gen-harness/contracts';
import { qk2 } from './dataQueries';
import { currentPath, navigateTo } from './navigation';
import { qk } from './queries';
import { queryClient } from './queryClient';

// ── transport ─────────────────────────────────────────────────────────────

/** The subset of WebSocket the client uses (a fake one is injected in tests). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export type RealtimeStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'stopped';

export interface RealtimeOptions {
  url: () => string;
  onEvent: (e: RealtimeEvent) => void;
  /** Close 4401 — session missing/expired. The client stops. */
  onUnauthenticated?: () => void;
  /** Close 4428 — setup not finished. The client stops. */
  onSetupRequired?: () => void;
  onStatus?: (s: RealtimeStatus) => void;
  factory?: SocketFactory;
  /** Ping interval (ms). Default 25 s. */
  pingMs?: number;
  /** Reconnect when nothing (not even a pong) arrived for this long. Default 70 s. */
  staleMs?: number;
  random?: () => number;
}

const OPEN = 1;

/** Exponential backoff 1 s, 2 s, 4 s … capped at 30 s, ±20 % jitter. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.8 + 0.4 * random()));
}

export function wsUrl(loc: Pick<Location, 'protocol' | 'host'> = window.location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/api/v1/ws`;
}

/**
 * `/api/v1/ws` client: reconnects with backoff, pings, and hands every server
 * frame to `onEvent`. Close 4401 → login, 4428 → setup; neither reconnects.
 */
export class RealtimeClient {
  private socket: SocketLike | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeen = 0;
  private running = false;
  status: RealtimeStatus = 'idle';

  constructor(private readonly opts: RealtimeOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = null;
      s.onmessage = null;
      s.onerror = null;
      s.onopen = null;
      try {
        s.close(1000, 'client stop');
      } catch {
        /* already closed */
      }
    }
    this.setStatus('stopped');
  }

  send(frame: { type: string; [k: string]: unknown }): void {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(frame));
  }

  private setStatus(s: RealtimeStatus) {
    this.status = s;
    this.opts.onStatus?.(s);
  }

  private clearTimers() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.retryTimer = null;
    this.pingTimer = null;
  }

  private connect() {
    if (!this.running) return;
    this.setStatus(this.attempt ? 'reconnecting' : 'connecting');
    let socket: SocketLike;
    try {
      const factory = this.opts.factory ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
      socket = factory(this.opts.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.lastSeen = Date.now();
      this.setStatus('open');
      const pingMs = this.opts.pingMs ?? 25_000;
      const staleMs = this.opts.staleMs ?? 70_000;
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastSeen > staleMs) {
          // Half-open connection: drop it and reconnect.
          try {
            socket.close(4000, 'stale');
          } catch {
            /* ignore */
          }
          this.handleClose(4000);
          return;
        }
        this.send({ type: 'ping' });
      }, pingMs);
    };
    socket.onmessage = (ev) => {
      this.lastSeen = Date.now();
      const e = parseFrame(ev.data);
      if (e && e.type !== 'pong') this.opts.onEvent(e);
    };
    socket.onerror = () => {
      /* onclose follows */
    };
    socket.onclose = (ev) => this.handleClose(ev.code);
  }

  private handleClose(code: number) {
    if (!this.socket) return;
    const s = this.socket;
    s.onclose = null;
    s.onmessage = null;
    s.onopen = null;
    this.socket = null;
    this.clearTimers();
    if (!this.running) return;
    if (code === WS_CLOSE_UNAUTHENTICATED) {
      this.running = false;
      this.setStatus('stopped');
      this.opts.onUnauthenticated?.();
      return;
    }
    if (code === WS_CLOSE_SETUP_REQUIRED) {
      this.running = false;
      this.setStatus('stopped');
      this.opts.onSetupRequired?.();
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (!this.running) return;
    const delay = backoffDelay(this.attempt, this.opts.random);
    this.attempt += 1;
    this.setStatus('reconnecting');
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }
}

export function parseFrame(data: unknown): RealtimeEvent | null {
  if (typeof data !== 'string') return null;
  try {
    const v = JSON.parse(data) as { type?: unknown; data?: unknown };
    if (!v || typeof v.type !== 'string') return null;
    return { type: v.type, data: v.data ?? {}, at: (v as { at?: string }).at } as RealtimeEvent;
  } catch {
    return null;
  }
}

// ── dispatch into the query cache ─────────────────────────────────────────

type RawPages = InfiniteData<CursorPage<RawItem>, string | null>;

/** Does a live row belong in a list filtered with `q`? */
export function rawMatches(item: RawItem, q: RawQuery | undefined): boolean {
  if (!q) return true;
  if (q.channel && item.channel.type !== q.channel) return false;
  if (q.group_id && item.group?.id !== q.group_id) return false;
  if (q.state && item.state !== q.state) return false;
  if (q.label && item.label !== q.label) return false;
  if (q.min_confidence && (item.confidence ?? 0) < q.min_confidence) return false;
  return true;
}

function patchRawRows(qc: QueryClient, fn: (row: RawItem) => RawItem): RawItem | undefined {
  let previous: RawItem | undefined;
  qc.setQueriesData<RawPages>({ queryKey: qk2.rawRoot }, (old) => {
    if (!old) return old;
    return {
      ...old,
      pages: old.pages.map((p) => ({
        ...p,
        items: p.items.map((row) => {
          const next = fn(row);
          if (next !== row && !previous) previous = row;
          return next;
        }),
      })),
    };
  });
  return previous;
}

/** Apply one server frame to the cached queries. Pure w.r.t. the given client. */
export function applyEvent(qc: QueryClient, e: RealtimeEvent): void {
  switch (e.type) {
    case 'raw.new': {
      const item = e.data;
      for (const q of qc.getQueryCache().findAll({ queryKey: qk2.rawRoot })) {
        const filters = q.queryKey[2] as RawQuery | undefined;
        if (!rawMatches(item, filters)) continue;
        qc.setQueryData<RawPages>(q.queryKey, (old) => {
          if (!old || !old.pages.length) return old;
          if (old.pages.some((p) => p.items.some((r) => r.id === item.id))) return old;
          const [first, ...rest] = old.pages;
          return {
            ...old,
            pages: [{ ...first, items: [item, ...first.items], total: first.total + 1 }, ...rest.map((p) => ({ ...p, total: p.total + 1 }))],
          };
        });
      }
      qc.setQueryData<Pipeline>(qk2.pipeline, (p) =>
        p ? { ...p, raw_total: p.raw_total + 1, raw_pending: p.raw_pending + (item.state === 'pending' ? 1 : 0) } : p,
      );
      return;
    }
    case 'raw.state': {
      const d = e.data;
      const prev = patchRawRows(qc, (row) =>
        row.id === d.id ? { ...row, state: d.state, label: d.label ?? row.label, confidence: d.confidence ?? row.confidence } : row,
      );
      if (prev && prev.state === 'pending' && d.state !== 'pending') {
        qc.setQueryData<Pipeline>(qk2.pipeline, (p) => (p ? { ...p, raw_pending: Math.max(0, p.raw_pending - 1) } : p));
      }
      return;
    }
    case 'refinery.progress': {
      qc.setQueryData(qk2.progress(e.data.run_id), e.data);
      qc.setQueryData(qk2.latestProgress, e.data);
      if (e.data.status === 'done' || e.data.status === 'failed') {
        for (const key of [qk2.runs, qk2.pipeline, qk2.schedule, qk2.cleanRoot, qk2.firstRun, ['raw', 'by-group']]) {
          void qc.invalidateQueries({ queryKey: key });
        }
      }
      return;
    }
    case 'refinery.run': {
      const run = e.data;
      qc.setQueryData<RefineryRun[]>(qk2.runs, (old) => {
        if (!old) return old;
        const rest = old.filter((r) => r.id !== run.id);
        return [run, ...rest].sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, Math.max(5, old.length));
      });
      qc.setQueryData<FirstRun>(qk2.firstRun, (f) => (f ? { ...f, run } : f));
      return;
    }
    case 'channel.qr': {
      const d = e.data;
      qc.setQueryData<Channel[]>(qk2.channels, (old) =>
        old?.map((c) =>
          c.type === d.type
            ? { ...c, state: 'pending_qr', qr: { session_id: d.session_id, image: d.image, expires_at: d.expires_at, scanned: false } }
            : c,
        ),
      );
      return;
    }
    case 'channel.status': {
      const d = e.data;
      qc.setQueryData<Channel[]>(qk2.channels, (old) =>
        old?.map((c) =>
          c.type === d.type
            ? {
                ...c,
                state: d.state,
                account_label: d.account_label ?? c.account_label,
                qr: d.state === 'pending_qr' && c.qr ? { ...c.qr, scanned: d.scanned } : d.state === 'pending_qr' ? c.qr : null,
              }
            : c,
        ),
      );
      if (d.state === 'active' || d.state === 'logged_out' || d.state === 'expired') {
        void qc.invalidateQueries({ queryKey: qk2.channels });
        void qc.invalidateQueries({ queryKey: qk2.channelGroups(d.type) });
        void qc.invalidateQueries({ queryKey: qk2.credentials });
        void qc.invalidateQueries({ queryKey: qk2.pipeline });
        void qc.invalidateQueries({ queryKey: qk.header });
      }
      return;
    }
    case 'cli.login': {
      qc.setQueryData(qk2.cliLogin(e.data.login_id), e.data);
      if (e.data.status === 'done') {
        void qc.invalidateQueries({ queryKey: qk2.cliProfiles });
        void qc.invalidateQueries({ queryKey: qk2.providers });
        void qc.invalidateQueries({ queryKey: qk2.credentials });
      }
      return;
    }
    case 'header': {
      qc.setQueryData<HeaderStatus>(qk.header, e.data);
      return;
    }
    default:
      return;
  }
}

// ── app wiring ────────────────────────────────────────────────────────────

let client: RealtimeClient | null = null;
let users = 0;

const PUBLIC_PREFIXES = ['/login', '/setup'];

function sharedClient(): RealtimeClient {
  if (!client) {
    client = new RealtimeClient({
      url: () => wsUrl(),
      onEvent: (e) => applyEvent(queryClient, e),
      onUnauthenticated: () => {
        if (PUBLIC_PREFIXES.some((p) => window.location.pathname.startsWith(p))) return;
        queryClient.clear();
        navigateTo(`/login?next=${encodeURIComponent(currentPath())}`, { replace: true });
      },
      onSetupRequired: () => {
        if (window.location.pathname.startsWith('/setup')) return;
        navigateTo('/setup', { replace: true });
      },
    });
  }
  return client;
}

/** Keep the shared socket open while at least one mounted component wants it. */
export function useRealtime(enabled = true): void {
  useEffect(() => {
    if (!enabled || typeof WebSocket === 'undefined') return;
    const c = sharedClient();
    users += 1;
    c.start();
    return () => {
      users -= 1;
      if (users <= 0) {
        users = 0;
        c.stop();
      }
    };
  }, [enabled]);
}
