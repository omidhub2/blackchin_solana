'use client';

import { useEffect, useRef, useState } from 'react';

import type { OperationalEvent, OverviewResponse } from './types';

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

type Handlers = {
  onSnapshot?: (snapshot: OverviewResponse) => void;
  onEvent?: (event: OperationalEvent) => void;
};

const LAST_ID_KEY = 'bc_last_event_id';

export function useDashboardStream(handlers: Handlers) {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let stopped = false;
    let retry = 0;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const seen = new Set<string>();

    const connect = () => {
      if (stopped) return;
      setStatus(retry === 0 ? 'connecting' : 'reconnecting');

      const lastId = window.localStorage.getItem(LAST_ID_KEY);
      const url = lastId
        ? `/api/v1/dashboard/stream?lastEventId=${encodeURIComponent(lastId)}`
        : '/api/v1/dashboard/stream';

      source = new EventSource(url, { withCredentials: true });

      source.addEventListener('snapshot', (message) => {
        try {
          const snapshot = JSON.parse((message as MessageEvent).data) as OverviewResponse;
          retry = 0;
          setStatus('live');
          if (snapshot.lastEventId) {
            window.localStorage.setItem(LAST_ID_KEY, String(snapshot.lastEventId));
          }
          handlersRef.current.onSnapshot?.(snapshot);
        } catch {
          // Ignore malformed frames; the next snapshot or poll will recover.
        }
      });

      source.addEventListener('operational', (message) => {
        try {
          const event = JSON.parse((message as MessageEvent).data) as OperationalEvent;
          if (seen.has(event.eventId)) return;
          seen.add(event.eventId);
          if (seen.size > 500) {
            const first = seen.values().next().value;
            if (first) seen.delete(first);
          }
          window.localStorage.setItem(LAST_ID_KEY, String(event.id));
          setLastEventAt(event.createdAt);
          handlersRef.current.onEvent?.(event);
        } catch {
          // Ignore malformed frames.
        }
      });

      source.addEventListener('stream_error', () => {
        setStatus('reconnecting');
      });

      source.onopen = () => {
        retry = 0;
        setStatus('live');
      };

      source.onerror = () => {
        if (stopped) return;
        source?.close();
        source = null;
        setStatus('reconnecting');
        retry += 1;
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(retry, 5));
        timer = setTimeout(connect, delay);
      };
    };

    connect();

    const offline = () => setStatus('offline');
    const online = () => setStatus('reconnecting');
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      source?.close();
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
    };
  }, []);

  return { status, lastEventAt };
}