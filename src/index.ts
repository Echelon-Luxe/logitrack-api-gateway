import { buildApp, setReady, SERVICE_NAME } from './app.js';

const PORT = Number(process.env['PORT'] ?? 8080);
const app = buildApp();

async function main(): Promise<void> {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  // Phase 3 replaces this with real dependency checks (Postgres, Kafka, Redis).
  setReady(true);
  app.log.info({ service: SERVICE_NAME, port: PORT }, 'service started');
}

/**
 * Graceful termination. Kubernetes sends SIGTERM, waits terminationGracePeriodSeconds,
 * then SIGKILLs. Without this handler in-flight requests are severed mid-response and
 * every rolling update produces 502s that look like an application bug.
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'shutting down');
    // Fail readiness first so the endpoint controller pulls this pod out of
    // rotation BEFORE we stop accepting connections.
    setReady(false);
    void app.close().then(() => process.exit(0));
  });
}

main().catch((err: unknown) => {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
});