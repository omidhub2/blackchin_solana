'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Bell,
  Boxes,
  ChevronDown,
  Cpu,
  Flame,
  GitBranch,
  Globe,
  KeyRound,
  Layers,
  LayoutDashboard,
  LogOut,
  MapPin,
  Menu,
  Network,
  Radio,
  Settings,
  ShieldCheck,
  Wallet,
  X
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { LiveIndicator } from '@/components/live-indicator';
import { RealtimeProvider, useRealtime } from '@/components/realtime-provider';
import { Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { shortAddress } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { SessionResponse } from '@/lib/types';

const navigation = [
  {
    group: 'Operations',
    items: [
      { href: '/', key: 'nav.overview', icon: LayoutDashboard },
      { href: '/wallets', key: 'nav.wallets', icon: Wallet },
      { href: '/hd-wallets', key: 'nav.hdWallets', icon: Layers },
      { href: '/child-wallets', key: 'nav.childWallets', icon: GitBranch },
      { href: '/hot-wallets', key: 'nav.hotWallets', icon: Flame },
      { href: '/addresses', key: 'nav.addresses', icon: MapPin }
    ]
  },
  {
    group: 'Chain',
    items: [
      { href: '/deposits', key: 'nav.deposits', icon: ArrowDownToLine },
      { href: '/withdrawals', key: 'nav.withdrawals', icon: ArrowUpFromLine },
      { href: '/transactions', key: 'nav.transactions', icon: Activity },
      { href: '/activity', key: 'nav.activity', icon: Radio }
    ]
  },
  {
    group: 'Platform',
    items: [
      { href: '/webhooks', key: 'nav.webhooks', icon: Boxes },
      { href: '/api-credentials', key: 'nav.credentials', icon: KeyRound },
      { href: '/network', key: 'nav.network', icon: Network },
      { href: '/security', key: 'nav.security', icon: ShieldCheck },
      { href: '/settings', key: 'nav.settings', icon: Settings }
    ]
  }
];

function Brand() {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-3 px-2">
      <span className="relative grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-cyan-400 via-electric-500 to-violet-500 shadow-glow">
        <Boxes size={20} className="text-ink-950" />
      </span>
      <div className="leading-tight">
        <p className="text-sm font-semibold tracking-[0.18em] text-white">{t('app.name')}</p>
        <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">{t('app.tagline')}</p>
      </div>
    </div>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { t } = useI18n();

  return (
    <div className="flex h-full flex-col">
      <div className="py-5"><Brand /></div>
      <nav className="flex-1 space-y-6 overflow-y-auto pb-6">
        {navigation.map((group) => (
          <div key={group.group}>
            <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-600">{group.group}</p>
            <div className="space-y-1">
              {group.items.map((item) => {
                const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onNavigate}
                    className={clsx(
                      'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition',
                      active
                        ? 'border border-cyan-400/20 bg-gradient-to-r from-cyan-400/10 to-transparent text-cyan-100'
                        : 'border border-transparent text-slate-400 hover:bg-white/[0.04] hover:text-slate-100'
                    )}
                  >
                    <Icon size={16} className={active ? 'text-cyan-300' : 'text-slate-500 group-hover:text-slate-300'} />
                    <span>{t(item.key)}</span>
                    {active ? <span className="ms-auto h-1.5 w-1.5 rounded-full bg-cyan-300" /> : null}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="panel-muted m-2 p-3 text-xs text-slate-500">
        <div className="flex items-center gap-2 text-slate-300">
          <Cpu size={14} className="text-cyan-300" />
          Solana native SOL
        </div>
        <p className="mt-1.5 leading-relaxed">SPL tokens, EVM and TRON are outside this release.</p>
      </div>
    </div>
  );
}

function Topbar({ onOpenMenu, user, onLogout }: {
  onOpenMenu: () => void;
  user: SessionResponse['user'];
  onLogout: () => void;
}) {
  const { t, locale, setLocale } = useI18n();
  const { status } = useRealtime();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-30 border-b border-white/[0.05] bg-ink-950/70 backdrop-blur-xl">
      <div className="flex h-16 items-center justify-between gap-3 px-4 md:px-6">
        <div className="flex items-center gap-3">
          <button type="button" onClick={onOpenMenu} className="btn-ghost !p-2 lg:hidden" aria-label="Menu">
            <Menu size={18} />
          </button>
          <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-slate-400 sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {t('network.cluster')}: <span className="text-slate-200">devnet</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <LiveIndicator status={status} />
          <button
            type="button"
            onClick={() => setLocale(locale === 'en' ? 'fa' : 'en')}
            className="btn-secondary !px-3 !py-1.5 text-[11px]"
            title={t('common.language')}
          >
            <Globe size={13} />
            {locale === 'en' ? 'FA' : 'EN'}
          </button>
          <button type="button" className="btn-ghost !p-2" aria-label="Notifications">
            <Bell size={17} />
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((value) => !value)}
              className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-sm text-slate-300 hover:border-cyan-400/30"
            >
              <span className="grid h-6 w-6 place-items-center rounded-lg bg-gradient-to-br from-cyan-400/30 to-violet-500/30 text-[10px] font-semibold text-cyan-100">
                {user.displayName.slice(0, 1).toUpperCase()}
              </span>
              <span className="hidden sm:block">{user.displayName}</span>
              <ChevronDown size={13} />
            </button>
            {menuOpen ? (
              <div className="panel absolute end-0 mt-2 w-56 overflow-hidden p-1 text-xs">
                <div className="px-3 py-2">
                  <p className="text-slate-200">{user.displayName}</p>
                  <p className="truncate text-[11px] text-slate-500">{user.email}</p>
                  <span className="chip mt-2 border-cyan-400/20 bg-cyan-400/10 text-cyan-300">{t(`common.${user.role}`)}</span>
                </div>
                <button
                  type="button"
                  onClick={onLogout}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-rose-300 hover:bg-rose-500/10"
                >
                  <LogOut size={14} /> {t('common.logout')}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </header>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [mobileOpen, setMobileOpen] = useState(false);

  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<SessionResponse>('/auth/session'),
    retry: false,
    staleTime: 60_000
  });

  useEffect(() => {
    if (session.error instanceof ApiError && session.error.status === 401) {
      router.replace('/login');
    }
  }, [router, session.error]);

  const logout = useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSettled: () => {
      queryClient.clear();
      router.replace('/login');
    }
  });

  const content = useMemo(() => {
    if (session.isLoading) {
      return (
        <div className="grid min-h-screen place-items-center">
          <div className="flex items-center gap-3 text-sm text-slate-400"><Spinner /> Loading control plane…</div>
        </div>
      );
    }
    if (!session.data) {
      return (
        <div className="grid min-h-screen place-items-center px-4">
          <div className="panel max-w-md p-6 text-center">
            <p className="text-sm text-slate-300">Session unavailable</p>
            <p className="mt-1 text-xs text-slate-500">{session.error instanceof Error ? session.error.message : 'Please sign in again.'}</p>
            <button type="button" className="btn-primary mt-4" onClick={() => router.replace('/login')}>Go to sign-in</button>
          </div>
        </div>
      );
    }
    return null;
  }, [router, session.data, session.error, session.isLoading]);

  if (content) return content;

  const user = session.data!.user;

  return (
    <RealtimeProvider>
      <div className="min-h-screen">
        <aside className="fixed inset-y-0 start-0 z-40 hidden w-[264px] border-e border-white/[0.05] bg-ink-950/80 px-3 backdrop-blur-xl lg:block">
          <SidebarContent />
        </aside>

        {mobileOpen ? (
          <div className="fixed inset-0 z-50 lg:hidden">
            <button type="button" aria-label="Close menu" className="absolute inset-0 bg-ink-950/80 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
            <aside className="absolute inset-y-0 start-0 w-[280px] border-e border-white/[0.06] bg-ink-950 px-3">
              <div className="flex justify-end py-3">
                <button type="button" className="btn-ghost !p-2" onClick={() => setMobileOpen(false)} aria-label="Close">
                  <X size={18} />
                </button>
              </div>
              <SidebarContent onNavigate={() => setMobileOpen(false)} />
            </aside>
          </div>
        ) : null}

        <div className="lg:ps-[264px]">
          <Topbar onOpenMenu={() => setMobileOpen(true)} user={user} onLogout={() => logout.mutate()} />
          <main className="mx-auto w-full max-w-[1500px] px-4 py-6 md:px-6 md:py-8">
            <div className="animate-[fadeIn_0.3s_ease-out]">{children}</div>
          </main>
          <footer className="mx-auto flex w-full max-w-[1500px] flex-wrap items-center justify-between gap-2 px-4 pb-8 text-[11px] text-slate-600 md:px-6">
            <span>BLACKCHIN · Solana infrastructure operations</span>
            <span className="mono">{shortAddress(user.id, 4)} · {user.role}</span>
          </footer>
        </div>
      </div>
    </RealtimeProvider>
  );
}