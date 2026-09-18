import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { generateKeyPair, exportJWK, SignJWT, type CryptoKey } from 'jose';

// A real user-service stand-in: publishes a JWKS and signs real RS256 tokens.
let authServer: FastifyInstance;
let backend: FastifyInstance;
let privateKey: CryptoKey;
let authPort = 0;
let backendPort = 0;
let received: Record<string, string> = {};
let receivedUrl = '';

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);

  authServer = Fastify();
  authServer.get('/.well-known/jwks.json', async () => ({
    keys: [{ ...jwk, kid: 'test-kid', alg: 'RS256', use: 'sig' }],
  }));
  await authServer.listen({ port: 0, host: '127.0.0.1' });
  authPort = (authServer.server.address() as { port: number }).port;

  backend = Fastify();
  backend.all('/*', async (req) => {
    received = req.headers as Record<string, string>;
    // reply.from does not surface the upstream body through inject, so the path
    // has to be captured here rather than asserted on the response.
    receivedUrl = req.url;
    return { ok: true, path: req.url };
  });
  await backend.listen({ port: 0, host: '127.0.0.1' });
  backendPort = (backend.server.address() as { port: number }).port;

  process.env['SHIPMENT_SERVICE_URL'] = `http://127.0.0.1:${backendPort}`;
  process.env['USER_SERVICE_URL'] = `http://127.0.0.1:${backendPort}`;
});

afterAll(async () => {
  await authServer.close();
  await backend.close();
});

const token = (over: Record<string, unknown> = {}, opts: { aud?: string; iss?: string; exp?: string } = {}) =>
  new SignJWT({ email: 'a@b.c', role: 'CUSTOMER', ...over })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
    .setSubject('user-1')
    .setIssuer(opts.iss ?? 'logitrack-user-service')
    .setAudience(opts.aud ?? 'logitrack')
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '15m')
    .sign(privateKey);

const makeGateway = async () => {
  const { buildApp, setReady } = await import('../src/app.js');
  const { initJwks } = await import('../src/domain/verify.js');
  const app = await buildApp();
  initJwks(`http://127.0.0.1:${authPort}/.well-known/jwks.json`);
  setReady(true);
  return app;
};

describe('gateway auth and proxying', () => {
  it('proxies an authenticated request and forwards identity', async () => {
    const app = await makeGateway();
    const res = await app.inject({
      method: 'GET',
      url: '/api/shipments',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(received['x-user-id']).toBe('user-1');
    expect(received['x-user-role']).toBe('CUSTOMER');
    await app.close();
  });

  // A proxied response has to carry the upstream's body. Asserting only the
  // status hid a gateway that returned reply-from's internal
  // {statusCode, headers, stream} object for every single request.
  it('returns the upstream body, not the proxy envelope', async () => {
    const app = await makeGateway();
    const res = await app.inject({
      method: 'GET',
      url: '/api/shipments',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.json()).toEqual({ ok: true, path: '/shipments' });
    await app.close();
  });

  // The gateway's /api namespace is not the backends'. They register bare paths,
  // so leaving the prefix on made every proxied request 404 upstream - invisible
  // here until a test asserted the path the backend actually received.
  it('strips the /api prefix before proxying', async () => {
    const app = await makeGateway();
    const res = await app.inject({
      method: 'GET',
      url: '/api/shipments',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(receivedUrl).toBe('/shipments');
    await app.close();
  });

  it('keeps the query string when stripping the prefix', async () => {
    const app = await makeGateway();
    await app.inject({
      method: 'GET',
      url: '/api/shipments?status=IN_TRANSIT&limit=10',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(receivedUrl).toBe('/shipments?status=IN_TRANSIT&limit=10');
    await app.close();
  });

  // The route that sent us looking: register is public, so it reaches the
  // backend and the 404 was the backend's, not the gateway's.
  it('proxies a public auth route to its bare path', async () => {
    const app = await makeGateway();
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'a@b.c' } });
    expect(res.statusCode).toBe(200);
    expect(receivedUrl).toBe('/auth/register');
    await app.close();
  });

  // Backends trust the gateway's verdict; forwarding the token widens where it
  // can leak and invites a backend to re-verify inconsistently.
  it('strips the Authorization header before proxying', async () => {
    const app = await makeGateway();
    await app.inject({
      method: 'GET',
      url: '/api/shipments',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(received['authorization']).toBeUndefined();
    await app.close();
  });

  it('rejects a missing token with 401', async () => {
    const app = await makeGateway();
    const res = await app.inject({ method: 'GET', url: '/api/shipments' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a garbage token with 401', async () => {
    const app = await makeGateway();
    const res = await app.inject({
      method: 'GET', url: '/api/shipments',
      headers: { authorization: 'Bearer not.a.token' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  // A validly signed token for a different audience must not be accepted.
  it('rejects a token minted for another audience', async () => {
    const app = await makeGateway();
    const res = await app.inject({
      method: 'GET', url: '/api/shipments',
      headers: { authorization: `Bearer ${await token({}, { aud: 'another-app' })}` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a token from another issuer', async () => {
    const app = await makeGateway();
    const res = await app.inject({
      method: 'GET', url: '/api/shipments',
      headers: { authorization: `Bearer ${await token({}, { iss: 'evil' })}` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects an expired token', async () => {
    const app = await makeGateway();
    const res = await app.inject({
      method: 'GET', url: '/api/shipments',
      headers: { authorization: `Bearer ${await token({}, { exp: '-1s' })}` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('403s a CUSTOMER reaching an ADMIN-only route', async () => {
    const app = await makeGateway();
    const res = await app.inject({
      method: 'GET', url: '/api/users',
      headers: { authorization: `Bearer ${await token({ role: 'CUSTOMER' })}` },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('allows an ADMIN through the same route', async () => {
    const app = await makeGateway();
    const res = await app.inject({
      method: 'GET', url: '/api/users',
      headers: { authorization: `Bearer ${await token({ role: 'ADMIN' })}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('lets auth through without a token', async () => {
    const app = await makeGateway();
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { a: 1 } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('404s an unmapped api path rather than proxying it', async () => {
    const app = await makeGateway();
    const res = await app.inject({
      method: 'GET', url: '/api/nope',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('rejects a token missing the role claim', async () => {
    const app = await makeGateway();
    const t = await new SignJWT({ email: 'a@b.c' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setSubject('user-1').setIssuer('logitrack-user-service').setAudience('logitrack')
      .setIssuedAt().setExpirationTime('15m').sign(privateKey);
    const res = await app.inject({
      method: 'GET', url: '/api/shipments', headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
