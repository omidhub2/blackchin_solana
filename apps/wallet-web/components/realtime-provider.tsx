'use client';

import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useDashboardStream } from '@/lib/realtime';
import type { OperationalEvent, OverviewResponse } from '@/lib/types';
import type { StreamStatus } from '@/lib/realtime';

type RealtimeContextValue = {
  status: StreamStatus;
  lastEventAt: string | null;
  recentEvents: OperationalEvent[];
};

const RealtimeContext = createContext<RealtimeContextValue>({
  status: 'connecting',
  lastEventAt: null,
  recentEvents: []
});

const INVALIDATE_KEYS = [
  'overview', 'activity', 'webhooks', 'wallets', 'addresses', 'deposits',
  'withdrawals', 'transactions', 'hot-wallets', 'security', 'network', 'credentials'
];

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [recentEvents, setRecentEvents] = useState<OperationalEvent[]>([]);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleInvalidate = useCallback(() => {
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      for (const key of INVALIDATE_KEYS) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    }, 600);
  }, [queryClient]);

  const { status, lastEventAt } = useDashboardStream({
    onSnapshot: (snapshot: OverviewResponse) => {
      setRecentEvents(snapshot.recentEvents ?? []);
      queryClient.setQueryData(['overview', snapshot.range], snapshot);
      queryClient.setQueryData(['overview'], snapshot);
    },
    onEvent: (event: OperationalEvent) => {
      setRecentEvents((current) => [event, ...current.filter((item) => item.eventId !== event.eventId)].slice(0, 30));
      scheduleInvalidate();
    }
  });

  useEffect(() => () => {
    if (pending.current) clearTimeout(pending.current);
  }, []);

  const value = useMemo(() => ({ status, lastEventAt, recentEvents }), [status, lastEventAt, recentEvents]);
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime() {
  return useContext(RealtimeContext);
}