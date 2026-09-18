import { buildApp, setReady, SERVICE_NAME } from './app.js';
import { closeLogger } from './logging.js';
import { initJwks } from './domain/verify.js';

const PORT = Number(process.env['PORT'] ?? 8080);

async function main(): Promise<void> {
  const app = await buildApp();
  initJwks();

  await app.listen({ port: PORT, host: '0.0.0.0' });
  setReady(true);
  app.log.info({ service: SERVICE_NAME, port: PORT }, 'service started');

  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      app.log.info({ signal }, 'shutting down');
      // Fail readiness before closing so the pod leaves Service endpoints
      // first. This matters most here: the gateway takes all external traffic.
      setReady(false);
      void (async () => {
        await app.close();
        // Last: flush what Seq is still batching before the process goes.
        await closeLogger();
        process.exit(0);
      })();
    });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`failed to start: ${String(err)}\n`);
  process.exit(1);
});
