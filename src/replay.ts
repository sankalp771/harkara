import type { Pool } from 'pg';

/**
 * §6.2/§6.3 — replay: a human/API decision, never automatic. Creates a
 * FRESH delivery for the same message (same webhook-id; the receiver's
 * §2.2 dedup collapses re-processing) with new attempts and a fresh
 * seal at attempt time. Dead rows themselves are never touched — parked
 * until explicitly pruned (§6.1).
 */

export interface ReplayFilter {
  /** Replay exactly this dead delivery. */
  deliveryId?: string;
  /** Replay all dead deliveries of one endpoint. */
  endpointId?: string;
  /** Time-range on when the delivery DIED (combinable with endpointId). */
  diedAfter?: Date;
  diedBefore?: Date;
  /** Scope guard for multi-tenant hosts. */
  tenantId?: string;
}

export interface ReplayResult {
  /** Fresh deliveries created. Corpses blocked by an existing live
   * delivery for the same (message, endpoint) are not counted. */
  replayed: number;
}

export async function replay(pool: Pool, filter: ReplayFilter): Promise<ReplayResult> {
  if (
    filter.deliveryId === undefined &&
    filter.endpointId === undefined &&
    filter.diedAfter === undefined &&
    filter.diedBefore === undefined
  ) {
    throw new Error(
      'harkara.replay: at least one filter (deliveryId, endpointId, diedAfter, diedBefore) is required',
    );
  }

  if (filter.deliveryId !== undefined) {
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM deliveries WHERE id = $1`,
      [filter.deliveryId],
    );
    const row = rows[0];
    if (!row) throw new Error(`harkara.replay: no delivery ${filter.deliveryId}`);
    if (row.status !== 'dead') {
      throw new Error(
        `harkara.replay: delivery ${filter.deliveryId} is '${row.status}' — only dead deliveries can be replayed (§6.2)`,
      );
    }
  }

  // ON CONFLICT rides Phase 1's partial unique index: at most one LIVE
  // delivery per (message, endpoint) — an existing live row blocks the
  // duplicate silently, and dead rows never block a fresh insert.
  // The fresh row copies the ordering key but takes a NEW seq — §7.2:
  // a replay re-enters at the BACK of its key's queue, out of order
  // with the past, in order with everything still queued.
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO deliveries (message_id, endpoint_id, ordering_key)
     SELECT DISTINCT d.message_id, d.endpoint_id, m.ordering_key
     FROM deliveries d
     JOIN messages m ON m.id = d.message_id
     WHERE d.status = 'dead'
       AND ($1::uuid IS NULL OR d.id = $1)
       AND ($2::uuid IS NULL OR d.endpoint_id = $2)
       AND ($3::timestamptz IS NULL OR d.dead_at >= $3)
       AND ($4::timestamptz IS NULL OR d.dead_at <= $4)
       AND ($5::text IS NULL OR m.tenant_id = $5)
     ON CONFLICT (message_id, endpoint_id) WHERE status <> 'dead' DO NOTHING
     RETURNING id`,
    [
      filter.deliveryId ?? null,
      filter.endpointId ?? null,
      filter.diedAfter ?? null,
      filter.diedBefore ?? null,
      filter.tenantId ?? null,
    ],
  );
  return { replayed: rows.length };
}
