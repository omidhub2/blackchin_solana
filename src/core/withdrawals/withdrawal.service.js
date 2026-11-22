/**
 * Native SOL withdrawal flow for standalone and HD child wallets.
 *
 * Order of operations:
 *   1. validate + normalize the request,
 *   2. reserve the idempotency key (INSERT ... ON CONFLICT DO NOTHING),
 *   3. resolve the wallet and its lifecycle/permission rules,
 *   4. estimate fee and verify the balance,
 *   5. derive/decrypt the key only for the signing callback window,
 *   6. broadcast, confirm, record the immutable ledger row,
 *   7. mark the idempotency key completed in the same database transaction.
 *
 * A reservation left in `processing` is never replayed automatically.
 */
import crypto from 'node:crypto';

import { badRequest, conflict, notFound } from '../errors.js';
import { resolveWallet, withSigningKey } from '../../infrastructure/security/wallet-signer.js';
import {
  findTransactionBySignature,
  insertBlockchainTransaction
} from '../../infrastructure/database/blockchain-transaction.repository.js';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

function hashRequest({ fromPublicKey, toPublicKey, amountSol }) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ fromPublicKey, toPublicKey, amountSol }))
    .digest('hex');
}

export function createWithdrawalService({ db, rpc, network, commitment, cipher }) {
  async function reserve({ idempotencyKey, requestHash, walletPublicKey }) {
    const reservation = await db.query(
      `
        INSERT INTO api_idempotency_keys
          (idempotency_key, request_hash, status, wallet_public_key, operation)
        VALUES ($1, $2, 'processing', $3, 'withdrawal')
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING idempotency_key
      `,
      [idempotencyKey, requestHash, walletPublicKey]
    );

    if (reservation.rowCount !== 0) {
      return { reserved: true };
    }

    const existingResult = await db.query(
      `
        SELECT request_hash, status, response_json, wallet_public_key, operation
        FROM api_idempotency_keys
        WHERE idempotency_key = $1
        LIMIT 1
      `,
      [idempotencyKey]
    );

    const existing = existingResult.rows[0];

    if (!existing) {
      throw conflict('Idempotency reservation could not be read', 'IDEMPOTENCY_ERROR');
    }

    if (
      existing.request_hash !== requestHash ||
      existing.operation !== 'withdrawal' ||
      existing.wallet_public_key !== walletPublicKey
    ) {
      throw conflict(
        'Idempotency-Key was already used for a different request',
        'IDEMPOTENCY_KEY_REUSED'
      );
    }

    if (existing.status === 'completed') {
      return { reserved: false, replay: existing.response_json };
    }

    throw conflict(
      existing.status === 'processing'
        ? 'A request with this Idempotency-Key is already processing; do not retry with a new key until it is reconciled'
        : 'This Idempotency-Key belongs to a failed request and cannot be reused',
      'IDEMPOTENCY_IN_PROGRESS'
    );
  }

  async function failReservation(idempotencyKey) {
    await db.query(
      `
        UPDATE api_idempotency_keys
        SET status = 'failed', updated_at = NOW()
        WHERE idempotency_key = $1 AND status = 'processing'
      `,
      [idempotencyKey]
    );
  }

  return Object.freeze({
    /**
     * Fee/balance preview. Never signs or broadcasts.
     */
    async estimate({ fromPublicKey, toPublicKey, amountSol }) {
      const wallet = await resolveWallet(db, fromPublicKey);

      if (!wallet) {
        throw notFound('Sender wallet was not found in the wallet database', 'WALLET_NOT_FOUND');
      }

      if (wallet.status !== 'active') {
        throw conflict('Wallet is not active and cannot send funds', 'WALLET_NOT_ACTIVE');
      }

      if (wallet.network && wallet.network !== network) {
        throw conflict(
          `Wallet belongs to network ${wallet.network} but this service operates on ${network}`,
          'NETWORK_MISMATCH'
        );
      }

      const estimate = await rpc.estimateTransfer({
        fromPublicKey,
        toPublicKey,
        amountSol
      });

      return { ...estimate, walletType: wallet.walletType, hdWalletId: wallet.hdWalletId };
    },

    /**
     * Submit an approved withdrawal.
     *
     * @param {{ idempotencyKey: string, fromPublicKey: string, toPublicKey: string,
     *           amountSol: string, approved: boolean }} input
     */
    async submit(input) {
      const { idempotencyKey, fromPublicKey, toPublicKey, amountSol, approved } = input;

      if (!IDEMPOTENCY_KEY_PATTERN.test(String(idempotencyKey))) {
        throw badRequest('A valid Idempotency-Key header is required', 'INVALID_IDEMPOTENCY_KEY');
      }

      if (approved !== true) {
        throw badRequest('Explicit transfer approval is required', 'APPROVAL_REQUIRED');
      }

      const wallet = await resolveWallet(db, fromPublicKey);

      if (!wallet) {
        throw notFound('Sender wallet was not found in the wallet database', 'WALLET_NOT_FOUND');
      }

      if (wallet.status !== 'active') {
        throw conflict('Wallet is not active and cannot send funds', 'WALLET_NOT_ACTIVE');
      }

      if (wallet.network && wallet.network !== network) {
        throw conflict(
          `Wallet belongs to network ${wallet.network} but this service operates on ${network}`,
          'NETWORK_MISMATCH'
        );
      }

      const requestHash = hashRequest({ fromPublicKey, toPublicKey, amountSol });
      const reservation = await reserve({
        idempotencyKey,
        requestHash,
        walletPublicKey: fromPublicKey
      });

      if (!reservation.reserved) {
        return { ...reservation.replay, replayed: true };
      }

      let sent;

      try {
        sent = await withSigningKey(db, fromPublicKey, async ({ keypair }) =>
          rpc.sendSolWithSigner({
            fromPublicKey,
            toPublicKey,
            amountSol,
            getKeypair: () => keypair,
            commitment
          }), { cipher }
        );
      } catch (error) {
        await failReservation(idempotencyKey);
        throw error;
      }

      const existing = await findTransactionBySignature(db, sent.signature, fromPublicKey, 'withdrawal');

      if (!existing) {
        await insertBlockchainTransaction(db, {
          signature: sent.signature,
          direction: 'withdrawal',
          walletPublicKey: fromPublicKey,
          hdWalletId: wallet.hdWalletId,
          counterparty: toPublicKey,
          amountLamports: sent.amountLamports,
          feeLamports: sent.feeLamports,
          network,
          commitment: sent.confirmationStatus ?? commitment,
          status: 'confirmed',
          slot: sent.slot ?? null,
          idempotencyKey,
          metadata: { walletType: wallet.walletType, accountIndex: wallet.accountIndex }
        });
      }

      const response = {
        sent: true,
        signature: sent.signature,
        network: sent.network,
        from: sent.from,
        to: sent.to,
        amountLamports: sent.amountLamports,
        amountSol: sent.amountSol,
        feeLamports: sent.feeLamports,
        feeSol: sent.feeSol,
        slot: sent.slot,
        confirmationStatus: sent.confirmationStatus,
        walletType: wallet.walletType,
        hdWalletId: wallet.hdWalletId
      };

      try {
        await db.query(
          `
            UPDATE api_idempotency_keys
            SET status = 'completed',
                response_json = $2::jsonb,
                transaction_signature = $3,
                updated_at = NOW()
            WHERE idempotency_key = $1
          `,
          [idempotencyKey, JSON.stringify(response), sent.signature]
        );
      } catch (error) {
        // The transaction is already on-chain: leaving the key in
        // `processing` forces manual reconciliation instead of a retry that
        // could double-spend. The real result is still returned.
        console.error('[WITHDRAWAL COMPLETION FAILURE]', {
          idempotencyKey,
          signature: sent.signature,
          message: error.message
        });
      }

      return response;
    }
  });
}
