import type { Pool } from 'pg';
import { replay, type ReplayFilter, type ReplayResult } from './replay.js';
import { send, type SendEvent, type SendOptions, type SendResult } from './send.js';
import { startWorker, type HarkaraWorker, type WorkerOptions } from './worker.js';

export interface HarkaraOptions {
  /** The host application's existing pg Pool — harkara brings no broker,
   * no Redis, no second datastore. */
  pool: Pool;
}

export interface Harkara {
  send(event: SendEvent, options?: SendOptions): Promise<SendResult>;
  startWorker(options?: WorkerOptions): HarkaraWorker;
  /** §6.2/§6.3 — replay dead deliveries. Human/API decision, never automatic. */
  replay(filter: ReplayFilter): Promise<ReplayResult>;
}

export function createHarkara(options: HarkaraOptions): Harkara {
  const { pool } = options;
  return {
    send: (event, sendOptions) => send(pool, event, sendOptions),
    startWorker: (workerOptions) => startWorker(pool, workerOptions),
    replay: (filter) => replay(pool, filter),
  };
}
