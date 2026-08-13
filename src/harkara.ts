import type { Pool } from 'pg';
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
}

export function createHarkara(options: HarkaraOptions): Harkara {
  const { pool } = options;
  return {
    send: (event, sendOptions) => send(pool, event, sendOptions),
    startWorker: (workerOptions) => startWorker(pool, workerOptions),
  };
}
