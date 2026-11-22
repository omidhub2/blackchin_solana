/**
 * SSRF-safe webhook destination policy.
 *
 * Rejects, before any connection is made (and again on every redirect hop):
 *  - non-HTTPS schemes and URLs with embedded credentials,
 *  - localhost, `.internal`, `.local` and metadata hostnames,
 *  - IPv4 private / loopback / link-local / CGNAT / benchmark / multicast,
 *  - IPv6 loopback, link-local, unique-local, IPv4-mapped private ranges,
 *  - hostnames that resolve to any of the above (DNS rebinding is mitigated by
 *    re-validating the resolved address immediately before the request and by
 *    never following redirects to a new host automatically).
 *
 * Production note: a determined attacker can still win a TOCTOU race between
 * resolution and connect. For hostile-network deployments, route webhook
 * traffic through an egress proxy that enforces the same policy at connect
 * time. Documented in docs/WEBHOOKS.md.
 */
import dns from 'node:dns/promises';
import net from 'node:net';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'instance-data.ec2.internal',
  'kubernetes.default',
  'kubernetes.default.svc'
]);

const BLOCKED_SUFFIXES = ['.internal', '.local', '.localhost', '.localdomain'];

const BLOCKED_NETWORKS = [
  ['0.0.0.0', 8],          // "this network"
  ['10.0.0.0', 8],         // private
  ['100.64.0.0', 10],      // CGNAT
  ['127.0.0.0', 8],        // loopback
  ['169.254.0.0', 16],     // link-local (cloud metadata)
  ['172.16.0.0', 12],      // private
  ['192.0.0.0', 24],       // IETF protocol assignments
  ['192.168.0.0', 16],     // private
  ['198.18.0.0', 15],      // benchmarking
  ['224.0.0.0', 4],        // multicast
  ['240.0.0.0', 4]         // reserved + broadcast
];

function ipv4ToInt(address) {
  const parts = address.split('.');

  if (parts.length !== 4) return null;

  let value = 0;

  for (const part of parts) {
    const octet = Number(part);

    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;

    value = (value << 8) | octet;
  }

  return value >>> 0;
}

export function isBlockedIpv4(address) {
  const value = ipv4ToInt(address);

  if (value === null) return true;

  for (const [network, bits] of BLOCKED_NETWORKS) {
    const base = ipv4ToInt(network);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;

    if (((value & mask) >>> 0) === ((base & mask) >>> 0)) {
      return true;
    }
  }

  return false;
}

/**
 * Expand an IPv6 address into 8 16-bit groups.
 * Returns null for malformed input.
 */
function parseIpv6(address) {
  let input = address;

  // Strip zone id (fe80::1%eth0)
  const zoneIndex = input.indexOf('%');
  if (zoneIndex !== -1) input = input.slice(0, zoneIndex);

  // IPv4-mapped tail (::ffff:127.0.0.1)
  let tail = [];

  if (input.includes('.')) {
    const lastColon = input.lastIndexOf(':');
    const v4 = ipv4ToInt(input.slice(lastColon + 1));

    if (v4 === null) return null;

    tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    input = `${input.slice(0, lastColon)}:0:0`;
  }

  const [head, rest] = input.split('::');

  if (input.split('::').length > 2) return null;

  const headGroups = head ? head.split(':').filter((part) => part !== '') : [];
  const restGroups = rest ? rest.split(':').filter((part) => part !== '') : [];
  const groups = [];

  for (const part of [...headGroups, ...restGroups]) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }

  const missing = 8 - tail.length - groups.length;

  if (input.includes('::')) {
    if (missing < 0) return null;

    const headCount = headGroups.length;

    return [
      ...groups.slice(0, headCount),
      ...Array(missing).fill(0),
      ...groups.slice(headCount),
      ...tail
    ];
  }

  if (missing !== 0) return null;

  return [...groups, ...tail];
}

export function isBlockedIpv6(address) {
  const groups = parseIpv6(address);

  if (!groups) return true;

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const isZeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

  // :: and ::1
  if (isZeroPrefix && g5 === 0 && g6 === 0 && g7 <= 1) return true;

  // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded IPv4
  if (isZeroPrefix && g5 === 0xffff) {
    const embedded = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
    return isBlockedIpv4(embedded);
  }

  // IPv4-compatible (::a.b.c.d) — deprecated but routable on some stacks
  if (isZeroPrefix && g5 === 0 && g6 === 0 && g7 > 1) return true;

  // Link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfe80) return true;

  // Unique local fc00::/7
  if ((g0 & 0xfe00) === 0xfc00) return true;

  // Multicast ff00::/8
  if ((g0 & 0xff00) === 0xff00) return true;

  return false;
}

export function isBlockedAddress(address) {
  const family = net.isIP(address);

  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);

  // Unknown address form is treated as blocked (fail closed).
  return true;
}

function hostnameIsBlocked(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');

  if (BLOCKED_HOSTNAMES.has(host)) return true;

  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;

  // Single-label hostnames ("intranet") are not publicly resolvable.
  if (!host.includes('.') && net.isIP(host) === 0) return true;

  return false;
}

/**
 * Shape validation that does not involve DNS.
 *
 * @returns {{ ok: true, url: URL } | { ok: false, reason: string }}
 */
export function validateWebhookUrlShape(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2048) {
    return { ok: false, reason: 'invalid_url' };
  }

  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_scheme' };
  }

  if (url.username || url.password) {
    return { ok: false, reason: 'embedded_credentials' };
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  if (!hostname) {
    return { ok: false, reason: 'missing_hostname' };
  }

  if (hostnameIsBlocked(hostname)) {
    return { ok: false, reason: 'blocked_hostname' };
  }

  if (net.isIP(hostname) !== 0 && isBlockedAddress(hostname)) {
    return { ok: false, reason: 'blocked_address' };
  }

  return { ok: true, url };
}

/**
 * Full validation: shape + DNS resolution of every address.
 *
 * @param {string} rawUrl
 * @param {{ lookup?: (hostname: string) => Promise<Array<{address: string}>> }} [options]
 */
export async function validateWebhookDestination(rawUrl, { lookup = defaultLookup } = {}) {
  const shape = validateWebhookUrlShape(rawUrl);

  if (!shape.ok) return shape;

  const hostname = shape.url.hostname.replace(/^\[|\]$/g, '');

  // A literal IP already validated above.
  if (net.isIP(hostname) !== 0) {
    return { ok: true, url: shape.url, addresses: [hostname] };
  }

  let records;

  try {
    records = await lookup(hostname);
  } catch {
    return { ok: false, reason: 'dns_failure' };
  }

  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, reason: 'dns_failure' };
  }

  for (const record of records) {
    if (isBlockedAddress(String(record.address))) {
      return { ok: false, reason: 'blocked_address' };
    }
  }

  return { ok: true, url: shape.url, addresses: records.map((record) => record.address) };
}

async function defaultLookup(hostname) {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

export const BLOCKED_REASONS = Object.freeze([
  'invalid_url',
  'unsupported_scheme',
  'embedded_credentials',
  'missing_hostname',
  'blocked_hostname',
  'blocked_address',
  'dns_failure'
]);
