/**
 * Dependency-free Prometheus metrics for the wallet API.
 *
 * Labels are restricted to HTTP method, registered route template and status
 * code. Request paths, wallet addresses, tenant IDs, signatures and query
 * parameters are never used as metric labels.
 */
const DEFAULT_BUCKETS = Object.freeze([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);

function escapeLabel(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}

function labelsToString(labels) {
  const entries = Object.entries(labels ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '';
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`;
}

export function createMetricsService({ buckets = DEFAULT_BUCKETS, now = () => Date.now() } = {}) {
  if (!Array.isArray(buckets) || buckets.length === 0 ||
      buckets.some((value, index) => !Number.isFinite(value) || value <= 0 || (index > 0 && value <= buckets[index - 1]))) {
    throw new TypeError('Histogram buckets must be strictly increasing positive numbers');
  }

  const requests = new Map();
  const durations = new Map();
  const counters = new Map();
  const gauges = new Map();

  function keyFor(labels = {}) {
    return JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
  }

  function recordHttpRequest({ method, route, statusCode, durationMs }) {
    if (route === '/metrics') return;
    const labels = {
      method: String(method || 'UNKNOWN').toUpperCase(),
      route: String(route || 'unmatched').slice(0, 120),
      status: String(statusCode || 0)
    };
    const key = keyFor(labels);
    requests.set(key, { labels, value: (requests.get(key)?.value ?? 0) + 1 });
    const duration = Math.max(0, Number(durationMs) || 0) / 1000;
    let histogram = durations.get(key);
    if (!histogram) {
      histogram = { labels, count: 0, sum: 0, buckets: new Map(buckets.map((bucket) => [bucket, 0])) };
      durations.set(key, histogram);
    }
    histogram.count += 1;
    histogram.sum += duration;
    for (const bucket of buckets) {
      if (duration <= bucket) histogram.buckets.set(bucket, histogram.buckets.get(bucket) + 1);
    }
  }

  function increment(name, amount = 1, labels = {}) {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name) || !Number.isFinite(amount) || amount < 0) {
      throw new TypeError('Invalid metric counter name or increment');
    }
    const key = `${name}:${keyFor(labels)}`;
    const current = counters.get(key);
    counters.set(key, { name, labels, value: (current?.value ?? 0) + amount });
  }

  function setGauge(name, value, labels = {}) {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name) || !Number.isFinite(value)) {
      throw new TypeError('Invalid metric gauge name or value');
    }
    const key = `${name}:${keyFor(labels)}`;
    gauges.set(key, { name, labels, value });
  }

  function render() {
    const lines = [
      '# HELP blackchin_http_requests_total Total HTTP requests handled by the wallet API.',
      '# TYPE blackchin_http_requests_total counter'
    ];
    for (const { labels, value } of requests.values()) {
      lines.push(`blackchin_http_requests_total${labelsToString(labels)} ${value}`);
    }

    lines.push(
      '# HELP blackchin_http_request_duration_seconds HTTP request duration in seconds.',
      '# TYPE blackchin_http_request_duration_seconds histogram'
    );
    for (const histogram of durations.values()) {
      for (const [bucket, count] of histogram.buckets) {
        lines.push(`blackchin_http_request_duration_seconds_bucket${labelsToString({ ...histogram.labels, le: bucket })} ${count}`);
      }
      lines.push(`blackchin_http_request_duration_seconds_bucket${labelsToString({ ...histogram.labels, le: '+Inf' })} ${histogram.count}`);
      lines.push(`blackchin_http_request_duration_seconds_sum${labelsToString(histogram.labels)} ${histogram.sum}`);
      lines.push(`blackchin_http_request_duration_seconds_count${labelsToString(histogram.labels)} ${histogram.count}`);
    }

    for (const metric of counters.values()) {
      lines.push(`# TYPE ${metric.name} counter`);
      lines.push(`${metric.name}${labelsToString(metric.labels)} ${metric.value}`);
    }
    for (const metric of gauges.values()) {
      lines.push(`# TYPE ${metric.name} gauge`);
      lines.push(`${metric.name}${labelsToString(metric.labels)} ${metric.value}`);
    }

    const memory = process.memoryUsage();
    lines.push(
      '# HELP process_uptime_seconds Process uptime in seconds.',
      '# TYPE process_uptime_seconds gauge',
      `process_uptime_seconds ${process.uptime()}`,
      '# HELP process_resident_memory_bytes Resident memory size in bytes.',
      '# TYPE process_resident_memory_bytes gauge',
      `process_resident_memory_bytes ${memory.rss}`,
      '# HELP process_heap_used_bytes Process heap used in bytes.',
      '# TYPE process_heap_used_bytes gauge',
      `process_heap_used_bytes ${memory.heapUsed}`,
      '# HELP blackchin_metrics_generated_timestamp_seconds Unix timestamp when metrics were rendered.',
      '# TYPE blackchin_metrics_generated_timestamp_seconds gauge',
      `blackchin_metrics_generated_timestamp_seconds ${Math.floor(now() / 1000)}`
    );
    return `${lines.join('\n')}\n`;
  }

  return Object.freeze({
    recordHttpRequest,
    increment,
    setGauge,
    render
  });
}
