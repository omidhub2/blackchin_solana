'use client';

import { motion } from 'framer-motion';
import { Boxes, Globe, LockKeyhole, Mail, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export default function LoginPage() {
  const router = useRouter();
  const { t, locale, setLocale } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.post('/auth/login', { email, password });
      router.replace('/');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 401 ? t('login.error') : t('error.network'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden px-4 py-10">
      <div className="pointer-events-none absolute inset-0 bg-grid-fade" />
      <button
        type="button"
        onClick={() => setLocale(locale === 'en' ? 'fa' : 'en')}
        className="btn-secondary absolute end-5 top-5 z-10 !px-3 !py-2 text-xs"
      >
        <Globe size={14} /> {locale === 'en' ? 'فارسی' : 'English'}
      </button>

      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: 'easeOut' }}
        className="relative z-10 w-full max-w-md"
      >
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-cyan-400 via-electric-500 to-violet-500 shadow-glow">
            <Boxes size={26} className="text-ink-950" />
          </span>
          <p className="mt-4 text-lg font-semibold tracking-[0.22em] text-white">{t('app.name')}</p>
          <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-slate-500">{t('app.tagline')}</p>
        </div>

        <div className="panel overflow-hidden">
          <div className="border-b border-white/[0.06] px-6 py-5">
            <h1 className="text-lg font-semibold text-white">{t('login.title')}</h1>
            <p className="mt-1 text-xs text-slate-500">{t('login.subtitle')}</p>
          </div>
          <form onSubmit={submit} className="space-y-4 px-6 py-6">
            <label className="block">
              <span className="field-label">{t('login.email')}</span>
              <span className="relative block">
                <Mail size={15} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  type="email"
                  required
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="input ps-9"
                  placeholder="ops@example.com"
                />
              </span>
            </label>
            <label className="block">
              <span className="field-label">{t('login.password')}</span>
              <span className="relative block">
                <LockKeyhole size={15} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="input ps-9"
                  placeholder="••••••••••••"
                />
              </span>
            </label>

            {error ? (
              <p className="rounded-xl border border-rose-500/20 bg-rose-500/[0.07] px-3 py-2 text-xs text-rose-200">{error}</p>
            ) : null}

            <button type="submit" disabled={loading} className="btn-primary w-full">
              {loading ? '…' : t('login.submit')}
            </button>
          </form>
          <div className="flex items-center gap-2 border-t border-white/[0.06] px-6 py-4 text-[11px] text-slate-500">
            <ShieldCheck size={14} className="text-emerald-400" />
            {t('login.footer')}
          </div>
        </div>
      </motion.div>
    </div>
  );
}