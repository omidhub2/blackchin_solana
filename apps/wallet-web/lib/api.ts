const BASE = '/api/v1/dashboard';

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code = 'API_ERROR') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function buildQuery(params?: Record<string, string | number | null | undefined>): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; params?: Record<string, string | number | null | undefined> } = {}
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  if (method !== 'GET') {
    const csrf = readCookie('bc_dashboard_csrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }

  const response = await fetch(`${BASE}${path}${buildQuery(options.params)}`, {
    method,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => null);

  if (!response.ok) {
    const message = typeof payload === 'object' && payload && 'message' in payload
      ? String((payload as { message: unknown }).message)
      : `Request failed with status ${response.status}`;
    const code = typeof payload === 'object' && payload && 'error' in payload
      ? String((payload as { error: unknown }).error)
      : 'API_ERROR';
    throw new ApiError(message, response.status, code);
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, params?: Record<string, string | number | null | undefined>) =>
    request<T>(path, { params }),
  post: <T>(path: string, body: unknown = {}) =>
    request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body })
};