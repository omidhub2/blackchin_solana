import crypto from 'node:crypto';
import { pool } from '../../../PostgreSQL/walletStorage.js';
import { solanaAdapter } from '../../blockchain/solana/solana.adapter.js';

function hashRequest({ fromPublicKey, toPublicKey, amountSol }) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      fromPublicKey,
      toPublicKey,
      amountSol
    }))
    .digest('hex');
}

export async function estimateTransfer(input) {
  return solanaAdapter.estimateSolTransfer(input);
}

/**
 * Persist an idempotency reservation before broadcasting.
 * A reservation left in "processing" after a process crash is deliberately
 * not replayed automatically: an operator must reconcile its signature.
 */
export async function submitTransfer({
  idempotencyKey,
  fromPublicKey,
  toPublicKey,
  amountSol,
  approved
}) {
  if (typeof idempotencyKey !== 'string' ||
      !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
    const error = new Error('A valid Idempotency-Key header is required');
    error.statusCode = 400;
    throw error;
  }

  if (approved !== true) {
    const error = new Error('Explicit transfer approval is required');
    error.statusCode = 400;
    throw error;
  }

  const requestHash = hashRequest({ fromPublicKey, toPublicKey, amountSol });
  const reservation = await pool.query(
    `
      INSERT INTO api_idempotency_keys
        (idempotency_key, request_hash, status)
      VALUES ($1, $2, 'processing')
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING idempotency_key
    `,
    [idempotencyKey, requestHash]
  );

  if (reservation.rowCount === 0) {
    const existingResult = await pool.query(
      `
        SELECT request_hash, status, response_json
        FROM api_idempotency_keys
        WHERE idempotency_key = $1
        LIMIT 1
      `,
      [idempotencyKey]
    );

    const existing = existingResult.rows[0];

    if (!existing || existing.request_hash !== requestHash) {
      const error = new Error('Idempotency-Key was already used for a different request');
      error.statusCode = 409;
      throw error;
    }

    if (existing.status === 'completed') {
      return { ...existing.response_json, replayed: true };
    }

    const error = new Error(
      existing.status === 'processing'
        ? 'A request with this Idempotency-Key is already processing; do not retry with a new key until reconciled'
        : 'This Idempotency-Key belongs to a failed request and cannot be reused'
    );
    error.statusCode = 409;
    throw error;
  }

  try {
    const result = await solanaAdapter.sendSol({
      fromPublicKey,
      toPublicKey,
      amountSol,
      // HTTP caller has already authenticated and explicitly approved the
      // exact request body; the idempotency reservation prevents replay.
      confirm: async () => true
    });

    await pool.query(
      `
        UPDATE api_idempotency_keys
        SET status = 'completed', response_json = $2::jsonb, updated_at = NOW()
        WHERE idempotency_key = $1
      `,
      [idempotencyKey, JSON.stringify(result)]
    );

    return result;
  } catch (error) {
    await pool.query(
      `
        UPDATE api_idempotency_keys
        SET status = 'failed', updated_at = NOW()
        WHERE idempotency_key = $1 AND status = 'processing'
      `,
      [idempotencyKey]
    );

    throw error;
  }
}
