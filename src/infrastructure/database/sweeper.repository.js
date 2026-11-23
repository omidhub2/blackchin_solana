/** PostgreSQL repository for the Phase 6 SOL sweeper. */
export async function findSweepPolicy(db, tenantId, network) {
  const result = await db.query(
    `SELECT * FROM sweep_policies
      WHERE tenant_id IS NOT DISTINCT FROM $1 AND network = $2
      LIMIT 1`,
    [tenantId === null ? null : String(tenantId), network]
  );
  return result.rows[0] ?? null;
}

export async function findSweepSource(db, tenantId, publicKey, network) {
  const result = await db.query(
    `SELECT a.id, a.tenant_id, a.hd_wallet_id, a.public_key, a.network,
            a.status AS account_status, h.status AS parent_status
       FROM wallet_accounts a
       INNER JOIN hd_wallets h
         ON h.id = a.hd_wallet_id
        AND h.tenant_id IS NOT DISTINCT FROM a.tenant_id
      WHERE a.public_key = $1
        AND a.tenant_id IS NOT DISTINCT FROM $2
        AND a.network = $3
      LIMIT 1`,
    [publicKey, tenantId === null ? null : String(tenantId), network]
  );
  return result.rows[0] ?? null;
}

export async function insertSweepJob(db, input) {
  const result = await db.query(
    `INSERT INTO sweep_jobs (
       tenant_id, policy_id, policy_version, network, source_public_key,
       hd_wallet_id, destination_public_key, asset_type, source_balance_raw,
       amount_raw, estimated_fee_lamports, rent_exempt_lamports,
       funding_amount_lamports, observed_slot, idempotency_key, status, metadata
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,'sol',$8,$9,$10,$11,0,$12,$13,$14,$15::jsonb
     )
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [
      input.tenantId, input.policyId, input.policyVersion, input.network,
      input.sourcePublicKey, input.hdWalletId, input.destinationPublicKey,
      input.sourceBalanceLamports, input.amountLamports, input.feeLamports,
      input.retainLamports, input.observedSlot, input.idempotencyKey,
      input.status, JSON.stringify(input.metadata ?? {})
    ]
  );
  if (result.rowCount === 1) return { created: true, job: result.rows[0] };
  const existing = await db.query('SELECT * FROM sweep_jobs WHERE idempotency_key = $1 LIMIT 1', [input.idempotencyKey]);
  if (!existing.rows[0]) throw new Error('Sweep idempotency conflict could not be resolved');
  return { created: false, job: existing.rows[0] };
}

export async function findSweepJob(db, id, tenantId = undefined) {
  const result = tenantId === undefined
    ? await db.query('SELECT * FROM sweep_jobs WHERE id = $1 LIMIT 1', [id])
    : await db.query(
      `SELECT * FROM sweep_jobs
        WHERE id = $1 AND tenant_id IS NOT DISTINCT FROM $2
        LIMIT 1`,
      [id, tenantId === null ? null : String(tenantId)]
    );
  return result.rows[0] ?? null;
}

export async function recordSweepEvent(db, { jobId, tenantId = null, network, outcome, signature = null, details = {} }) {
  await db.query(
    `INSERT INTO sweep_events (job_id, tenant_id, network, outcome, signature, details)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [jobId, tenantId, network, outcome, signature, JSON.stringify(details)]
  );
}

export async function updateSweepJob(db, id, { status, signature = undefined, errorCode = null, errorMessage = null, metadata = null }) {
  const result = await db.query(
    `UPDATE sweep_jobs
        SET status = $2,
            transaction_signature = COALESCE($3, transaction_signature),
            error_code = $4,
            error_message = $5,
            metadata = CASE WHEN $6::jsonb IS NULL THEN metadata ELSE metadata || $6::jsonb END,
            attempts = attempts + CASE WHEN $2 IN ('submitted','failed','under_review') THEN 1 ELSE 0 END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, status, signature ?? null, errorCode, errorMessage, metadata ? JSON.stringify(metadata) : null]
  );
  return result.rows[0] ?? null;
}

export async function listSweepJobs(db, { tenantId = undefined, limit = 50, offset = 0 } = {}) {
  const result = tenantId === undefined
    ? await db.query(
      `SELECT * FROM sweep_jobs
        ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    )
    : await db.query(
      `SELECT * FROM sweep_jobs
        WHERE tenant_id IS NOT DISTINCT FROM $1
        ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [tenantId === null ? null : String(tenantId), limit, offset]
    );
  return result.rows;
}

export async function listSweepCandidates(db, network, { limit = 500 } = {}) {
  const result = await db.query(
    `SELECT a.id AS account_id, a.tenant_id, a.hd_wallet_id, a.public_key,
            a.network, p.id AS policy_id, p.execution_enabled
       FROM wallet_accounts a
       INNER JOIN hd_wallets h
         ON h.id = a.hd_wallet_id
        AND h.tenant_id IS NOT DISTINCT FROM a.tenant_id
        AND h.status = 'active'
       INNER JOIN sweep_policies p
         ON p.tenant_id IS NOT DISTINCT FROM a.tenant_id
        AND p.network = a.network
        AND p.enabled = TRUE
      WHERE a.network = $1
        AND a.status = 'active'
      ORDER BY a.id ASC
      LIMIT $2`,
    [network, limit]
  );
  return result.rows;
}

export async function acquireSweeperLock(client, network) {
  const result = await client.query(
    'SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS acquired',
    [`blackchin:sweeper:${network}`]
  );
  if (result.rows[0]?.acquired !== true) return null;
  return {
    async release() {
      await client.query(
        'SELECT pg_advisory_unlock(hashtext($1)::bigint)',
        [`blackchin:sweeper:${network}`]
      ).catch(() => {});
    }
  };
}

