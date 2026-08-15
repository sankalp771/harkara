import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

/**
 * Real HTTP receiver for delivery tests — CLAUDE.md's "real Postgres, not
 * mocks" rule extended to HTTP (maintainer directive): concurrency and
 * delivery claims are only proven against a real socket. Reused by Phases
 * 4–7 (signing, retries, breaker, SSRF all script this).
 */

export interface ReceivedRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** ms timestamp when the request arrived */
  arrivedAt: number;
  /** ms timestamp when the response finished (undefined while hanging) */
  respondedAt?: number;
  /** true when the CLIENT destroyed the socket before the response
   * finished — how Phase 7 observes the streamed byte cap from outside. */
  aborted?: boolean;
}

export type Behavior =
  | { status: number; body?: string; delayMs?: number; headers?: Record<string, string> }
  // §9.2 tests: send headers, then write chunkBytes every intervalMs
  // forever — only the client's caps can end this response.
  | { status: number; drip: { chunkBytes: number; intervalMs: number } }
  | 'hang'; // accept the request, never respond

export interface Receiver {
  /** Base URL, e.g. http://127.0.0.1:54321 — append a path per endpoint. */
  url: string;
  /** Every request seen, in arrival order. */
  requests: ReceivedRequest[];
  /** Set the behavior function (called per request). */
  behave(fn: (req: ReceivedRequest) => Behavior): void;
  /** Highest number of simultaneously in-flight requests for a path. */
  concurrentPeak(path: string): number;
  /** Resolve once at least n requests have arrived. */
  waitForRequests(n: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export async function startReceiver(): Promise<Receiver> {
  const requests: ReceivedRequest[] = [];
  const sockets = new Set<Socket>();
  const inFlight = new Map<string, number>();
  const peaks = new Map<string, number>();
  const waiters: { n: number; resolve: () => void }[] = [];

  let behavior: (req: ReceivedRequest) => Behavior = () => ({ status: 200 });

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = req.url ?? '/';
      const record: ReceivedRequest = {
        path,
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString('utf8'),
        arrivedAt: Date.now(),
      };
      requests.push(record);

      const active = (inFlight.get(path) ?? 0) + 1;
      inFlight.set(path, active);
      peaks.set(path, Math.max(peaks.get(path) ?? 0, active));

      for (const w of [...waiters]) {
        if (requests.length >= w.n) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve();
        }
      }

      const done = () => {
        inFlight.set(path, (inFlight.get(path) ?? 1) - 1);
        record.respondedAt = Date.now();
      };

      const directive = behavior(record);
      if (directive === 'hang') {
        // Never respond; socket stays open until close() destroys it.
        // In-flight count intentionally stays raised.
        return;
      }
      if ('drip' in directive) {
        res.writeHead(directive.status);
        const timer = setInterval(() => {
          res.write(Buffer.alloc(directive.drip.chunkBytes, 0x78));
        }, directive.drip.intervalMs);
        res.on('close', () => {
          clearInterval(timer);
          record.aborted = !res.writableFinished;
          done();
        });
        return;
      }
      res.on('close', () => {
        if (!res.writableFinished) record.aborted = true;
      });
      const respond = () => {
        res.statusCode = directive.status;
        for (const [name, value] of Object.entries(directive.headers ?? {})) {
          res.setHeader(name, value);
        }
        res.end(directive.body ?? '');
        done();
      };
      if (directive.delayMs && directive.delayMs > 0) {
        setTimeout(respond, directive.delayMs);
      } else {
        respond();
      }
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('receiver: could not determine listen port');
  }

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    behave(fn) {
      behavior = fn;
    },
    concurrentPeak(path) {
      return peaks.get(path) ?? 0;
    },
    waitForRequests(n, timeoutMs = 30_000) {
      if (requests.length >= n) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `receiver: timed out waiting for ${String(n)} requests (saw ${String(requests.length)})`,
            ),
          );
        }, timeoutMs);
        waiters.push({
          n,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
