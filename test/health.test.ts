import { describe, it, expect, afterEach } from 'vitest';
import { buildApp, setReady } from '../src/app.js';
import { initJwks } from '../src/domain/verify.js';

describe('health endpoints', () => {
  afterEach(() => setReady(false));

  it('liveness is up before anything is initialised', async () => {
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    await app.close();
  });

  it('readiness is 503 until ready', async () => {
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
    await app.close();
  });

  it('readiness is 200 once JWKS is configured', async () => {
    const app = await buildApp();
    initJwks('http://127.0.0.1:1/.well-known/jwks.json');
    setReady(true);
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    await app.close();
  });

  it('exposes gateway metrics', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain('gateway_auth_failures_total');
    expect(res.body).toContain('gateway_proxy_duration_seconds');
    await app.close();
  });
});
