import type { Pool } from 'pg';
import { send, type SendEvent, type SendOptions, type SendResult } from './send.js';

export interface HarkaraOptions {
  /** The host application's existing pg Pool — harkara brings no broker,
   * no Redis, no second datastore. */
  pool: Pool;
}

export interface Harkara {
  send(event: SendEvent, options?: SendOptions): Promise<SendResult>;
}

export function createHarkara(options: HarkaraOptions): Harkara {
  const { pool } = options;
  return {
    send: (event, sendOptions) => send(pool, event, sendOptions),
  };
}
