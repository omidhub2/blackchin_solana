/**
 * Tenant-isolated native SOL withdrawals for HD child wallets.
 * Tenant ownership is enforced on wallet lookup, signing, idempotency and ledger writes.
 */
import { badRequest, conflict, notFound, serviceUnavailable } from '../errors.js';
import {
  findAccountByPublicKeyForTenant,
  findHdWalletByIdForTenant
} from '../../infrastructure/database/tenant-wallet.repository.js';
import { withTenantSigningKey } from '../../infrastructure/security/wallet-signer.js';
import {
  findTransactionBySignatureForTenant,
  insertBlockchainTransaction
} from '../../infrastructure/database/blockchain-transaction.repository.js';
import { emitEventSafe } from '../../infrastructure/database/webhook-outbox.repository.js';
import { recordOperationalEventSafe } from '../../infrastructure/database/operational-event.repository.js';
import { hashTenantWithdrawalRequest } from './tenant-withdrawal-policy.service.js';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

function assertTenantId(value) {
  if ((typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') ||
      !/^[1-9][0-9]*$/.test(String(value))) {
    throw new TypeError('tenantId must be a positive integer');
  }
  return String(value);
}

function parseAmountLamports(amountSol) {
  if (typeof amountSol !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(amountSol)) {
    throw badRequest('amountSol must be a positive decimal string with at most 9 decimal places', 'INVALID_AMOUNT');
  }
  const [whole, fraction = ''] = amountSol.split('.');
  const value = BigInt(whole) * 1_000_000_000n + BigInt((fraction + '000000000').slice(0, 9));
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw badRequest('amountSol is outside the supported transfer range', 'INVALID_AMOUNT');
  }
  return value.toString();
}

function mapWithdrawalRecord(row) {
  return {
    idempotencyKey: row.idempotency_key, status: row.status, network: row.network,
    fromPublicKey: row.wallet_public_key, toPublicKey: row.to_public_key,
    amountLamports: row.amount_lamports === null ? null : String(row.amount_lamports),
    signature: row.transaction_signature, approvalReference: row.approval_reference,
    response: row.response_json ?? null, createdAt: row.created_at, updatedAt: row.updated_at
  };
}
export function createTenantWithdrawalService({
  db, rpc, network, commitment, cipher,
  tenantWithdrawalPolicy = null,
  hotWallets = null,
  log = () => {}
}) {
  if (!db || typeof db.query !== 'function' || typeof db.connect !== 'function') {
    throw new TypeError('A PostgreSQL database pool is required');
  }
  if (!rpc || typeof rpc.estimateTransfer !== 'function' || typeof rpc.sendSolWithSigner !== 'function') {
    throw new TypeError('Solana transfer RPC methods are required');
  }

  async function requireWallet(tenantId, publicKey) {
    const account = await findAccountByPublicKeyForTenant(db, tenantId, publicKey);
    if (!account) {
      throw notFound('HD child wallet was not found for this tenant', 'WALLET_ACCOUNT_NOT_FOUND');
    }
    const parent = await findHdWalletByIdForTenant(db, tenantId, account.hdWalletId);
    if (!parent) {
      throw notFound('HD parent wallet was not found for this tenant', 'HD_WALLET_NOT_FOUND');
    }
    if (account.network !== network || parent.network !== network) {
      throw conflict('Wallet network does not match the configured Solana network', 'NETWORK_MISMATCH');
    }
    if (account.status !== 'active' || parent.status !== 'active') {
      throw conflict('Both the child wallet and its parent HD wallet must be active', 'WALLET_NOT_ACTIVE');
    }
    return {
      publicKey: account.publicKey,
      walletType: 'hd_child',
      hdWalletId: account.hdWalletId,
      accountIndex: account.accountIndex,
      network: account.network
    };
  }

  async function reserve({ tenantId, credentialId, approvalReference, idempotencyKey, requestHash, walletPublicKey, toPublicKey, amountLamports }) {
    const inserted = await db.query(
      `INSERT INTO api_idempotency_keys
         (tenant_id, tenant_credential_id, approval_reference, idempotency_key,
          request_hash, status, wallet_public_key, operation, network, to_public_key, amount_lamports)
       VALUES ($1, $2, $3, $4, $5, 'processing', $6, 'withdrawal', $7, $8, $9)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [tenantId, credentialId, approvalReference, idempotencyKey, requestHash, walletPublicKey, network, toPublicKey, amountLamports]
    );
    if (inserted.rowCount === 1) return { reserved: true, id: inserted.rows[0].id };

    const existingResult = await db.query(
      `SELECT id, request_hash, status, response_json, wallet_public_key,
              approval_reference, operation, network, to_public_key, amount_lamports
         FROM api_idempotency_keys
        WHERE tenant_id = $1 AND idempotency_key = $2
        LIMIT 1`,
      [tenantId, idempotencyKey]
    );
    const existing = existingResult.rows[0];
    if (!existing) throw conflict('Tenant idempotency reservation could not be read', 'IDEMPOTENCY_ERROR');

    if (existing.request_hash !== requestHash || existing.approval_reference !== approvalReference || existing.operation !== 'withdrawal' ||
        existing.wallet_public_key !== walletPublicKey || existing.network !== network ||
        existing.to_public_key !== toPublicKey || String(existing.amount_lamports) !== amountLamports) {
      throw conflict('Idempotency-Key was already used for a different tenant withdrawal', 'IDEMPOTENCY_KEY_REUSED');
    }
    if (existing.status === 'completed') return { reserved: false, replay: existing.response_json };
    throw conflict(
      existing.status === 'processing'
        ? 'This tenant withdrawal is still processing and must be reconciled before retry'
        : 'This tenant idempotency key belongs to a failed request and cannot be reused',
      'IDEMPOTENCY_IN_PROGRESS'
    );
  }

  async function failReservation(tenantId, idempotencyKey) {
    await db.query(
      `UPDATE api_idempotency_keys
          SET status = 'failed', updated_at = NOW()
        WHERE tenant_id = $1 AND idempotency_key = $2
          AND status = 'processing' AND transaction_signature IS NULL`,
      [tenantId, idempotencyKey]
    );
  }

  return Object.freeze({
    async list({ tenantId, limit = 20, offset = 0 } = {}) {
      tenantId = assertTenantId(tenantId);
      const result = await db.query(
        `SELECT idempotency_key, status, network, wallet_public_key, to_public_key,
                amount_lamports, transaction_signature, approval_reference, response_json,
                created_at, updated_at
           FROM api_idempotency_keys
          WHERE tenant_id = $1 AND operation = 'withdrawal'
          ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
        [tenantId, limit, offset]
      );
      return { items: result.rows.map(mapWithdrawalRecord), limit, offset };
    },

    async get({ tenantId, idempotencyKey } = {}) {
      tenantId = assertTenantId(tenantId);
      if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        throw badRequest('Invalid withdrawal idempotency key', 'INVALID_IDEMPOTENCY_KEY');
      }
      const result = await db.query(
        `SELECT idempotency_key, status, network, wallet_public_key, to_public_key,
                amount_lamports, transaction_signature, approval_reference, response_json,
                created_at, updated_at
           FROM api_idempotency_keys
          WHERE tenant_id = $1 AND operation = 'withdrawal' AND idempotency_key = $2
          LIMIT 1`,
        [tenantId, idempotencyKey]
      );
      if (!result.rows[0]) throw notFound('Tenant withdrawal was not found', 'WITHDRAWAL_NOT_FOUND');
      return mapWithdrawalRecord(result.rows[0]);
    },
    async estimate({ tenantId, fromPublicKey, toPublicKey, amountSol }) {
      tenantId = assertTenantId(tenantId);
      await requireWallet(tenantId, fromPublicKey);
      parseAmountLamports(amountSol);
      const estimate = await rpc.estimateTransfer({ fromPublicKey, toPublicKey, amountSol });
      return { ...estimate, network, walletType: 'hd_child' };
    },

    async submit(input) {
      const tenantId = assertTenantId(input?.tenantId);
      const credentialId = assertTenantId(input?.credentialId);
      const { idempotencyKey, fromPublicKey, toPublicKey, amountSol, approvalReference } = input ?? {};
      if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        throw badRequest('A valid Idempotency-Key header is required', 'INVALID_IDEMPOTENCY_KEY');
      }
      if (typeof approvalReference !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(approvalReference)) {
        throw badRequest('A valid partner approval reference is required', 'APPROVAL_REFERENCE_REQUIRED');
      }
      if (!tenantWithdrawalPolicy || typeof tenantWithdrawalPolicy.authorize !== 'function') {
        throw serviceUnavailable('Tenant withdrawal policy is not configured; submissions are disabled', 'WITHDRAWAL_POLICY_UNAVAILABLE');
      }

      const wallet = await requireWallet(tenantId, fromPublicKey);
      const amountLamports = parseAmountLamports(amountSol);

      // A designated hot wallet must be active, signing-enabled and within its
      // single-transfer ceiling before any policy check, reservation or signing.
      if (hotWallets && typeof hotWallets.assertCanSpend === 'function') {
        await hotWallets.assertCanSpend({ tenantId, publicKey: fromPublicKey, amountLamports });
      }

      const requestHash = hashTenantWithdrawalRequest({ fromPublicKey, toPublicKey, amountLamports, network, approvalReference });
      const reservation = await reserve({
        tenantId, credentialId, approvalReference, idempotencyKey, requestHash,
        walletPublicKey: fromPublicKey, toPublicKey, amountLamports
      });
      if (!reservation.reserved) return { ...reservation.replay, replayed: true };

      // Reserve idempotency before consuming the one-time approval. A completed
      // retry can then replay its original response without reusing an approval.
      let authorization;
      try {
        authorization = await tenantWithdrawalPolicy.authorize({
          tenantId, credentialId, approvalReference, wallet,
          fromPublicKey, toPublicKey, amountLamports, network, idempotencyKey,
          requestHash
        });
      } catch (error) {
        await failReservation(tenantId, idempotencyKey).catch(() => {});
        throw error;
      }
      if (authorization !== true && authorization?.allowed !== true) {
        await failReservation(tenantId, idempotencyKey);
        throw conflict('Tenant withdrawal was denied by the configured policy', 'WITHDRAWAL_NOT_AUTHORIZED');
      }

      await emitEventSafe(db, {
        eventType: 'withdrawal.accepted',
        tenantId,
        network,
        walletPublicKey: fromPublicKey,
        hdWalletId: wallet.hdWalletId,
        payload: {
          idempotencyKey,
          fromPublicKey,
          toPublicKey,
          amountLamports,
          network,
          approvalReference
        }
      }, log);
      await recordOperationalEventSafe(db, {
        eventType: 'withdrawal.accepted',
        tenantId,
        network,
        walletPublicKey: fromPublicKey,
        hdWalletId: wallet.hdWalletId,
        payload: { idempotencyKey, amountLamports, toPublicKey }
      }, log);

      let signaturePersisted = false;
      let sent;
      try {
        sent = await withTenantSigningKey(db, tenantId, fromPublicKey, async ({ keypair }) =>
          rpc.sendSolWithSigner({
            fromPublicKey, toPublicKey, amountSol,
            getKeypair: () => keypair,
            commitment,
            onSigned: async ({ signature }) => {
              const persisted = await db.query(
                `UPDATE api_idempotency_keys
                    SET transaction_signature = $3, updated_at = NOW()
                  WHERE tenant_id = $1 AND idempotency_key = $2
                    AND status = 'processing' AND transaction_signature IS NULL
                    AND network = $4`,
                [tenantId, idempotencyKey, signature, network]
              );
              if (persisted.rowCount !== 1) {
                throw new Error('Unable to persist tenant withdrawal signature before broadcast');
              }
              signaturePersisted = true;
            }
          }), { cipher, deploymentNetwork: network }
        );
      } catch (error) {
        if (!signaturePersisted) {
          await failReservation(tenantId, idempotencyKey);
        } else {
          error.code = 'WITHDRAWAL_RECONCILIATION_REQUIRED';
          error.message = 'Tenant withdrawal signature was persisted; do not retry with a new idempotency key. Reconciliation is required.';
          await recordOperationalEventSafe(db, {
            eventType: 'withdrawal.reconciliation_required',
            tenantId,
            network,
            walletPublicKey: fromPublicKey,
            hdWalletId: wallet.hdWalletId,
            payload: { idempotencyKey, amountLamports }
          }, log);
        }
        throw error;
      }

      const response = {
        sent: true, signature: sent.signature, network: sent.network,
        from: sent.from, to: sent.to, amountLamports: sent.amountLamports,
        amountSol: sent.amountSol, feeLamports: sent.feeLamports,
        feeSol: sent.feeSol, slot: sent.slot,
        confirmationStatus: sent.confirmationStatus,
        walletType: wallet.walletType, hdWalletId: wallet.hdWalletId
      };

      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const existing = await findTransactionBySignatureForTenant(
          client, tenantId, sent.signature, fromPublicKey, 'withdrawal'
        );
        if (existing && (
          existing.amountLamports !== sent.amountLamports ||
          existing.counterparty !== toPublicKey ||
          ['failed', 'rejected'].includes(existing.status)
        )) {
          throw new Error('Existing tenant withdrawal ledger row conflicts with the confirmed transaction');
        }
        if (!existing) {
          const inserted = await insertBlockchainTransaction(client, {
            signature: sent.signature, direction: 'withdrawal',
            walletPublicKey: fromPublicKey, hdWalletId: wallet.hdWalletId,
            counterparty: toPublicKey, amountLamports: sent.amountLamports,
            feeLamports: sent.feeLamports, network,
            commitment: sent.confirmationStatus ?? commitment,
            status: 'confirmed', slot: sent.slot ?? null,
            idempotencyKey, tenantId,
            metadata: { walletType: wallet.walletType, accountIndex: wallet.accountIndex }
          });
          if (!inserted.created) throw new Error('Withdrawal signature already exists outside this tenant ledger scope');
        }
        const completed = await client.query(
          `UPDATE api_idempotency_keys
              SET status = 'completed', response_json = $3::jsonb,
                  transaction_signature = $4, updated_at = NOW()
            WHERE tenant_id = $1 AND idempotency_key = $2
              AND status = 'processing' AND transaction_signature = $4`,
          [tenantId, idempotencyKey, JSON.stringify(response), sent.signature]
        );
        if (completed.rowCount !== 1) throw new Error('Tenant withdrawal idempotency state changed before completion');
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        // The chain may already have accepted the transaction. Keep the signed
        // reservation processing so reconciliation, never a retry, resolves it.
        error.code = 'WITHDRAWAL_RECONCILIATION_REQUIRED';
        throw error;
      } finally {
        client.release();
      }

      await emitEventSafe(db, {
        eventType: 'withdrawal.broadcast',
        tenantId,
        network,
        walletPublicKey: fromPublicKey,
        hdWalletId: wallet.hdWalletId,
        payload: {
          idempotencyKey,
          signature: response.signature,
          fromPublicKey,
          toPublicKey,
          amountLamports: response.amountLamports,
          network,
          slot: response.slot,
          confirmationStatus: response.confirmationStatus
        }
      }, log);
      await recordOperationalEventSafe(db, {
        eventType: 'withdrawal.broadcast',
        tenantId,
        network,
        walletPublicKey: fromPublicKey,
        hdWalletId: wallet.hdWalletId,
        payload: {
          idempotencyKey,
          signature: response.signature,
          amountLamports: response.amountLamports,
          toPublicKey
        }
      }, log);

      return response;
    }
  });
}
