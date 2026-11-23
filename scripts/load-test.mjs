#!/usr/bin/env node
/**
 * Opt-in HTTP smoke/load test. Remote targets require LOAD_TEST_ALLOW_REMOTE=true.
 *
 * Example:
 *   npm run load:test -- --url http://127.0.0.1:3000/health/ready --duration 15 --concurrency 8
 */
import process from 'node:process';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const target = argument('--url', 'http://127.0.0.1:3000/health/ready');
const durationSeconds = Number(argument('--duration', '10'));
const concurrency = Number(argument('--concurrency', '5'));
const apiKey = process.env.API_ACCESS_KEY;

let url;
try {
  url = new URL(target);
} catch (cause) {
  throw new Error('--url must be a valid HTTP(S) URL', { cause });
}
if (!['http:', 'https:'].includes(url.protocol)) {
  throw new Error('Load-test target must use HTTP or HTTPS');
}
const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname.replace(/^\[|\]$/g, ''));
if (!local && process.env.LOAD_TEST_ALLOW_REMOTE !== 'true') {
  throw new Error('Remote load testing is disabled; set LOAD_TEST_ALLOW_REMOTE=true only for an approved test target');
}
if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 300) {
  throw new Error('--duration must be an integer from 1 to 300 seconds');
}
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 100) {
  throw new Error('--concurrency must be an integer from 1 to 100');
}

const samples = [];
const statusCounts = new Map();
let errors = 0;
let running = true;
const deadline = Date.now() + durationSeconds * 1000;
const headers = apiKey ? { 'x-api-key': apiKey } : {};

async function worker() {
  while (running && Date.now() < deadline) {
    const started = performance.now();
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5_000),
        redirect: 'error'
      });
      await response.arrayBuffer();
      samples.push(performance.now() - started);
      statusCounts.set(response.status, (statusCounts.get(response.status) ?? 0) + 1);
    } catch {
      errors += 1;
    }
  }
}

const workers = Array.from({ length: concurrency }, () => worker());
await Promise.all(workers);
running = false;

samples.sort((a, b) => a - b);
const percentile = (p) => samples.length
  ? Number(samples[Math.min(samples.length - 1, Math.ceil(samples.length * p) - 1)].toFixed(2))
  : null;
const total = samples.length + errors;
const report = {
  target: `${url.origin}${url.pathname}`,
  durationSeconds,
  concurrency,
  requests: total,
  successfulResponses: samples.length,
  transportErrors: errors,
  requestsPerSecond: Number((total / durationSeconds).toFixed(2)),
  latencyMs: {
    p50: percentile(0.50),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: samples.length ? Number(samples.at(-1).toFixed(2)) : null
  },
  statusCodes: Object.fromEntries([...statusCounts.entries()].sort(([a], [b]) => a - b))
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (errors > 0 || [...statusCounts.keys()].some((status) => status >= 500)) {
  process.exitCode = 1;
}
