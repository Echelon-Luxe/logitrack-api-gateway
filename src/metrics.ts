import { Registry, collectDefaultMetrics, Counter, Histogram } from 'prom-client';

export const registry = new Registry();
registry.setDefaultLabels({ service: 'logitrack-api-gateway' });
collectDefaultMetrics({ register: registry });

export const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const proxyLatency = new Histogram({
  name: 'gateway_proxy_duration_seconds',
  help: 'Time spent proxying to a backend',
  labelNames: ['upstream', 'status'] as const,
  // Buckets chosen around a p95 target of ~250ms; the defaults bunch
  // everything into one bucket at this scale and hide all detail.
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const authFailures = new Counter({
  name: 'gateway_auth_failures_total',
  help: 'Requests rejected before reaching a backend',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const rateLimited = new Counter({
  name: 'gateway_rate_limited_total',
  help: 'Requests rejected by the rate limiter',
  registers: [registry],
});
