import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import replyFrom from '@fastify/reply-from';
import { registry, httpRequests, proxyLatency, authFailures, rateLimited } from './metrics.js';
import { verifyToken, requireRole, jwksReady, UnauthorizedError, ForbiddenError } from './domain/verify.js';
import { matchRoute } from './domain/routes-table.js';

export const SERVICE_NAME = 'logitrack-api-gateway';

let ready = false;
export const setReady = (v: boolean): void => { ready = v; };

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie'],
        censor: '[redacted]',
      },
    },
    // Required for rate limiting to see the real client IP rather than the
    // ingress controller's.
    trustProxy: true,
    genReqId: () => randomUUID(),
  });

  await app.register(rateLimit, {
    max: Number(process.env['RATE_LIMIT_MAX'] ?? 100),
    timeWindow: process.env['RATE_LIMIT_WINDOW'] ?? '1 minute',
    // In-memory: each replica limits independently, so the effective limit is
    // max x replicas. Redis-backed is the fix when that matters.
    onExceeded: () => rateLimited.inc(),
  });

  await app.register(replyFrom, { undici: { connections: 128, pipelining: 1 } });

  app.addHook('onResponse', (req, reply, done) => {
    httpRequests.inc({
      method: req.method,
      route: req.routeOptions.url ?? 'unknown',
      status: String(reply.statusCode),
    });
    done();
  });

  // Never checks dependencies: failing liveness kills the container.
  app.get('/healthz', () => ({ status: 'ok', service: SERVICE_NAME }));

  app.get('/readyz', async (_req, reply) => {
    if (!ready || !jwksReady()) {
      return reply.code(503).send({ status: 'not-ready', service: SERVICE_NAME });
    }
    // Backends are deliberately not probed. The gateway can serve some routes
    // while one backend is down, and failing readiness would take the whole
    // platform offline for a single unhealthy service.
    return { status: 'ready', service: SERVICE_NAME };
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });

  app.all('/api/*', async (req, reply) => {
    const rule = matchRoute(req.url.split('?')[0] ?? '');
    if (!rule) return reply.code(404).send({ error: 'NotFound' });

    const headers: Record<string, string> = { 'x-trace-id': String(req.id) };

    if (rule.roles !== 'public') {
      let identity;
      try {
        identity = await verifyToken(req.headers.authorization);
        if (rule.roles.length > 0) requireRole(identity, rule.roles);
      } catch (err) {
        const status = err instanceof ForbiddenError ? 403 : 401;
        authFailures.inc({ reason: status === 403 ? 'forbidden' : 'unauthenticated' });
        return reply.code(status).send({ error: status === 403 ? 'Forbidden' : 'Unauthorized' });
      }
      headers['x-user-id'] = identity.userId;
      headers['x-user-email'] = identity.email;
      headers['x-user-role'] = identity.role;
    }

    const started = process.hrtime.bigint();
    void reply.from(`${rule.target}${req.url}`, {
      rewriteRequestHeaders: (_orig, existing) => {
        // Strip Authorization: backends must trust the gateway's verdict, not
        // re-verify, and forwarding the token widens where it can leak.
        const { authorization: _a, ...rest } = existing as Record<string, string>;
        return { ...rest, ...headers };
      },
      onResponse: (_request, proxyReply, upstream) => {
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        proxyLatency.observe(
          { upstream: rule.prefix, status: String(upstream.statusCode) },
          seconds,
        );
        void proxyReply.send(upstream);
      },
    });
    // Return the reply, not the result of from(): returning a value from an
    // async handler makes Fastify try to send a second response and the
    // request hangs.
    return reply;
  });

  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number };
    if (e instanceof UnauthorizedError || e instanceof ForbiddenError) {
      return reply.code(e.statusCode ?? 401).send({ error: e.name });
    }
    if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: e.name, message: e.message });
    }
    req.log.error({ err }, 'gateway error');
    // A backend being down is a 502, not a 500: the gateway itself is fine.
    return reply.code(502).send({ error: 'BadGateway' });
  });

  return app;
}
