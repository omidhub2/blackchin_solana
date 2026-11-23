import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetricsService } from '../src/core/metrics.service.js';

test('records HTTP request counts and latency histograms using route templates only', () => {
  const metrics = createMetricsService({ now: () => 1_700_000_000_000 });
  metrics.recordHttpRequest({
    method: 'GET',
    route: '/api/v1/wallets/:publicKey',
    statusCode: 200,
    durationMs: 12
  });
  metrics.recordHttpRequest({
    method: 'GET',
    route: '/api/v1/wallets/:publicKey',
    statusCode: 500,
    durationMs: 140
  });

  const output = metrics.render();
  assert.match(output, /blackchin_http_requests_total\{method="GET",route="\/api\/v1\/wallets\/\:publicKey",status="200"\} 1/);
  assert.match(output, /blackchin_http_requests_total\{method="GET",route="\/api\/v1\/wallets\/\:publicKey",status="500"\} 1/);
  assert.match(output, /blackchin_http_request_duration_seconds_count/);
  assert.match(output, /blackchin_http_request_duration_seconds_bucket/);
  assert.equal(output.includes('publicKey=111111'), false);
});

test('does not count Prometheus scrape requests to avoid self-observation noise', () => {
  const metrics = createMetricsService();
  metrics.recordHttpRequest({
    method: 'GET', route: '/metrics', statusCode: 200, durationMs: 1
  });
  assert.equal(metrics.render().includes('blackchin_http_requests_total{'), false);
});

test('supports bounded custom counters and gauges', () => {
  const metrics = createMetricsService();
  metrics.increment('blackchin_worker_failures_total', 2, { worker: 'deposit_scanner' });
  metrics.setGauge('blackchin_worker_consecutive_failures', 3, { worker: 'deposit_scanner' });
  const output = metrics.render();
  assert.match(output, /blackchin_worker_failures_total\{worker="deposit_scanner"\} 2/);
  assert.match(output, /blackchin_worker_consecutive_failures\{worker="deposit_scanner"\} 3/);
});

test('rejects invalid histogram bucket definitions', () => {
  assert.throws(() => createMetricsService({ buckets: [0.1, 0.1] }), /strictly increasing/);
});
