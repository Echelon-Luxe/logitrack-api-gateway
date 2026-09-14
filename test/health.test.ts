import { describe, it, expect, afterEach } from 'vitest';
import { buildApp, setReady } from '../src/app.js';

describe('health endpoints', () => {
  afterEach(() => setReady(false));

  it('liveness is up even before dependencies are ready', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('readiness returns 503 until the service marks itself ready', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('readiness returns 200 once ready', async () => {
    const app = buildApp();
    setReady(true);
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('exposes prometheus metrics', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('process_cpu_user_seconds_total');
    await app.close();
  });
});