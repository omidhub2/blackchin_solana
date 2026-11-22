/**
 * Lifecycle & network authorization policies for signing.
 *
 * Two layers:
 *
 *  1. `authorizeWalletForSigning()` — cheap, cached-free pre-check that runs
 *     before the idempotency reservation and before any RPC work.
 *  2. `loadSigningKeypairLocked()` — the authoritative check. It reads the
 *     child and parent rows inside a SHORT transaction with `FOR SHARE`
 *     row locks, derives the keypair, and commits immediately. The locks are
 *     released *before* the network broadcast, so a slow RPC call never holds
 *     database locks, while any concurrent lifecycle change either happens
 *     before this check (and is seen) or waits until it is done.
 *
 * A parent HD root's status governs its children: any non-active parent state
 * denies signing regardless of the child's own status.
 */
import { AppError, conflict, notFound } from '../../core/errors.js';

export const ACTIVE = 'active';

function lifecycleError(message, code = 'WALLET_NOT_ACTIVE') {
  return new AppError(message, 409, code);
}

/** Parent states that deny signing, with a stable error code per state. */
export function assertParentAllowsSigning(parent) {
  if (!parent) {
    throw notFound('Parent HD wallet was not found', 'HD_WALLET_NOT_FOUND');
  }

  switch (parent.status) {
    case ACTIVE:
      return parent;
    case 'disabled':
      throw lifecycleError(
        'The parent HD wallet is disabled; its child wallets cannot sign',
        'HD_WALLET_DISABLED'
      );
    case 'archived':
      throw lifecycleError(
        'The parent HD wallet is archived; its child wallets cannot sign',
        'HD_WALLET_ARCHIVED'
      );
    case 'provisioning':
      throw lifecycleError(
        'The parent HD wallet is not fully provisioned',
        'HD_WALLET_NOT_ACTIVE'
      );
    default:
      throw lifecycleError(
        'The parent HD wallet is in an unknown state; signing denied',
        'HD_WALLET_NOT_ACTIVE'
      );
  }
}

export function assertChildAllowsSigning(child) {
  if (!child) {
    throw notFound('Wallet account was not found', 'WALLET_ACCOUNT_NOT_FOUND');
  }

  if (child.status !== ACTIVE) {
    throw lifecycleError(
      `Wallet is ${child.status} and cannot sign transactions`,
      'WALLET_NOT_ACTIVE'
    );
  }

  return child;
}

export function assertNetworkMatches(walletNetwork, deploymentNetwork) {
  if (!walletNetwork) return;

  if (walletNetwork !== deploymentNetwork) {
    throw conflict(
      `Wallet belongs to network ${walletNetwork} but this service operates on ${deploymentNetwork}`,
      'NETWORK_MISMATCH'
    );
  }
}

/**
 * Shared row-lock helper.
 *
 * Both rows are locked `FOR SHARE`: signing must not block on, but must not
 * miss, a concurrent `UPDATE hd_wallets SET status=...`. Committing immediately
 * after derivation releases the locks before any network I/O.
 */
export async function lockRowsForSigning(client, { accountId, hdWalletId, tenantId = null }) {
  const accountResult = await client.query(
    `
      SELECT id, tenant_id, hd_wallet_id, public_key, account_index, derivation_path,
             wallet_type, network, status
      FROM wallet_accounts
      WHERE id = $1
        AND ($2::bigint IS NULL OR tenant_id = $2)
      FOR SHARE
    `,
    [accountId, tenantId === null ? null : String(tenantId)]
  );

  const parentResult = await client.query(
    `
      SELECT id, tenant_id, network, status, derivation_scheme,
             mnemonic_encrypted, mnemonic_iv, mnemonic_auth_tag, encryption_key_version
      FROM hd_wallets
      WHERE id = $1
        AND ($2::bigint IS NULL OR tenant_id = $2)
      FOR SHARE
    `,
    [hdWalletId, tenantId === null ? null : String(tenantId)]
  );

  return {
    accountRow: accountResult.rows[0] ?? null,
    parentRow: parentResult.rows[0] ?? null
  };
}
