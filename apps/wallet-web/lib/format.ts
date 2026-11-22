export function formatSol(lamports: string | null | undefined, maxDecimals = 6): string {
  if (lamports === null || lamports === undefined || lamports === '') return '—';
  try {
    const value = BigInt(lamports);
    const negative = value < 0n;
    const absolute = negative ? -value : value;
    const whole = absolute / 1_000_000_000n;
    const fraction = (absolute % 1_000_000_000n).toString().padStart(9, '0');
    const trimmed = fraction.slice(0, maxDecimals).replace(/0+$/, '');
    return `${negative ? '-' : ''}${whole.toString()}${trimmed ? `.${trimmed}` : ''}`;
  } catch {
    return '—';
  }
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US').format(value);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date);
}

export function formatRelative(value: string | null | undefined, locale = 'en'): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const diff = Date.now() - date.getTime();
  const seconds = Math.round(diff / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale === 'fa' ? 'fa' : 'en', { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return rtf.format(-seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(-hours, 'hour');
  const days = Math.round(hours / 24);
  return rtf.format(-days, 'day');
}

export function shortAddress(value: string | null | undefined, size = 6): string {
  if (!value) return '—';
  if (value.length <= size * 2 + 3) return value;
  return `${value.slice(0, size)}…${value.slice(-size)}`;
}

export function shortSignature(value: string | null | undefined): string {
  return shortAddress(value, 8);
}

export function explorerUrl(network: string | null | undefined, signature: string | null | undefined): string | null {
  if (!signature) return null;
  const cluster = network === 'mainnet-beta' ? '' : `?cluster=${network ?? 'devnet'}`;
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}${cluster}`;
}

export function statusTone(status: string | null | undefined): string {
  switch ((status ?? '').toLowerCase()) {
    case 'active':
    case 'confirmed':
    case 'credited':
    case 'completed':
    case 'delivered':
    case 'ok':
    case 'running':
    case 'live':
      return 'emerald';
    case 'pending':
    case 'processing':
    case 'confirming':
    case 'detected':
    case 'idle':
    case 'reconnecting':
    case 'application_encrypted':
      return 'amber';
    case 'failed':
    case 'rejected':
    case 'frozen':
    case 'disabled':
    case 'revoked':
    case 'discarded':
    case 'unavailable':
    case 'offline':
      return 'rose';
    case 'under_review':
    case 'suspended':
      return 'violet';
    default:
      return 'slate';
  }
}

export function humanize(value: string | null | undefined): string {
  if (!value) return '—';
  return value.replace(/[._-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}