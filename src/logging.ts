import { Writable } from 'node:stream';
import { type FastifyBaseLogger } from 'fastify';
import pino, { type LoggerOptions } from 'pino';

// Shipping to Seq is opt-in: without SEQ_URL the logger writes JSON to stdout
// exactly as before. In Kubernetes it stays unset, because Fluent Bit tails
// stdout there and forwards to the same Seq - setting it would double every
// line. It is for local development, where the services run on the host and
// nothing is tailing them.
const SEQ_URL = process.env['SEQ_URL'];

// Seq's own client is not used: it sets Content-Length by hand, which undici
// rejects outright once it is the global dispatcher (the gateway loads it
// through @fastify/reply-from). Posting CLEF is a handful of lines anyway.
const CLEF_PATH = '/api/events/raw?clef';

const FLUSH_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 5_000;
// Enough to keep a busy service off one request per line, small enough that a
// crash loses little.
const MAX_BATCH = 200;
// A Seq outage must not grow the heap without bound. Past this the oldest lines
// go; stdout still has every one of them.
const MAX_QUEUED = 5_000;

// pino's numeric levels to Seq's names. Kept identical to the translation
// Fluent Bit applies in the cluster (clef.lua in logitrack-infrastructure), so
// a line reads the same in Seq whichever route carried it there.
const SEQ_LEVELS: Record<string, string> = {
  '10': 'Verbose',
  '20': 'Debug',
  '30': 'Information',
  '40': 'Warning',
  '50': 'Error',
  '60': 'Fatal',
};

interface PinoLine {
  level?: number;
  time?: number;
  msg?: string;
  err?: { type?: string; message?: string; stack?: string };
  [key: string]: unknown;
}

interface Shipper {
  push: (event: string) => void;
  close: () => Promise<void>;
}

let shipper: Shipper | undefined;

function createShipper(serverUrl: string): Shipper {
  const endpoint = serverUrl.replace(/\/+$/, '') + CLEF_PATH;
  const apiKey = process.env['SEQ_API_KEY'];
  const queue: string[] = [];
  let sending = false;
  let failing = false;

  const send = async (): Promise<void> => {
    if (sending || queue.length === 0) return;
    sending = true;
    const batch = queue.splice(0, MAX_BATCH);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.serilog.clef',
          ...(apiKey === undefined || apiKey === '' ? {} : { 'X-Seq-ApiKey': apiKey }),
        },
        body: batch.join('\n'),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
      failing = false;
    } catch (err) {
      // Straight to stderr, and only on the first failure of an outage:
      // reporting this through pino would feed the stream that just failed, and
      // one line per batch would bury the terminal.
      if (!failing) {
        failing = true;
        process.stderr.write(`seq: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      queue.unshift(...batch);
      if (queue.length > MAX_QUEUED) queue.splice(0, queue.length - MAX_QUEUED);
    } finally {
      sending = false;
    }
  };

  // unref: a pending flush must never be the reason the process stays alive.
  const timer = setInterval(() => void send(), FLUSH_INTERVAL_MS);
  timer.unref();

  return {
    push(event) {
      queue.push(event);
      if (queue.length > MAX_QUEUED) queue.shift();
      if (queue.length >= MAX_BATCH) void send();
    },
    async close() {
      clearInterval(timer);
      // Bounded: a Seq that is down must not hold the shutdown open.
      for (let i = 0; i < 3 && queue.length > 0; i++) await send();
    },
  };
}

function seqStream(service: string, serverUrl: string): Writable {
  const client = createShipper(serverUrl);
  shipper = client;

  return new Writable({
    write(chunk, _encoding, done) {
      let line: PinoLine;
      try {
        line = JSON.parse(String(chunk)) as PinoLine;
      } catch {
        // Not ours to translate, and stdout already carried it.
        done();
        return;
      }

      const { level, time, msg, err, pid, ...properties } = line;

      client.push(JSON.stringify({
        '@t': new Date(time ?? Date.now()).toISOString(),
        '@l': SEQ_LEVELS[String(level)] ?? 'Information',
        // @m, not @mt: a rendered message, so {braces} in it stay literal
        // instead of being read as property placeholders.
        '@m': msg ?? '',
        ...(err?.stack === undefined ? {} : { '@x': err.stack }),
        ...properties,
        // An error is far more useful flattened than as a nested object.
        ...(err?.type === undefined ? {} : { errorType: err.type }),
        service,
      }));
      done();
    },
  });
}

/**
 * pino instance for the service: always stdout, plus Seq when SEQ_URL is set.
 *
 * Typed as Fastify sees it. Returning pino's own Logger would pin the
 * FastifyInstance generic to it, and every `FastifyInstance` written without
 * generics stops matching.
 */
export function buildLogger(service: string, options: LoggerOptions = {}): FastifyBaseLogger {
  const opts: LoggerOptions = { level: process.env['LOG_LEVEL'] ?? 'info', ...options };
  if (SEQ_URL === undefined || SEQ_URL === '') return pino(opts);

  // level 'trace' on both entries so multistream never filters: the logger's
  // own level already did that, and multistream would otherwise default each
  // stream to info and silently swallow debug lines.
  return pino(opts, pino.multistream([
    { stream: process.stdout, level: 'trace' },
    { stream: seqStream(service, SEQ_URL), level: 'trace' },
  ]));
}

/**
 * Flush what is still batched. Called on shutdown: without it the last couple
 * of seconds of logs - which include the shutdown itself - never leave.
 */
export async function closeLogger(): Promise<void> {
  const client = shipper;
  shipper = undefined;
  if (client) await client.close();
}
