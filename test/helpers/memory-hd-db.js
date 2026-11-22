/**
 * Small in-memory "database" for HD tables.
 *
 * Mirrors the constraints that matter for correctness:
 *  - hd_wallets.next_account_index is the allocation counter,
 *  - wallet_accounts has UNIQUE(public_key) and UNIQUE(hd_wallet_id, account_index).
 */
export class MemoryHdDatabase {
  constructor() {
    this.hdWallets = new Map();
    this.accounts = [];
    this.nextHdWalletId = 1;
    this.nextAccountId = 1;
    this.transactions = [];
  }

  addHdWallet({ network = 'devnet', status = 'active', mnemonicEncrypted = 'x' } = {}) {
    const id = String(this.nextHdWalletId);

    const row = {
      id,
      owner_id: null,
      label: null,
      network,
      derivation_scheme: 'bip39+slip10-ed25519/v1',
      derivation_path_template: "m/44'/501'/{accountIndex}'/0'",
      mnemonic_encrypted: mnemonicEncrypted,
      mnemonic_iv: '0'.repeat(24),
      mnemonic_auth_tag: '0'.repeat(32),
      encryption_key_version: 1,
      next_account_index: 0,
      status,
      phrase_provisioned_at: null,
      created_at: new Date(),
      updated_at: new Date()
    };

    this.hdWallets.set(id, row);
    this.nextHdWalletId += 1;

    return row;
  }

  addAccount({ hdWalletId, publicKey, accountIndex, status = 'active', network = 'devnet' }) {
    const duplicate = this.accounts.find((item) => item.public_key === publicKey);

    if (duplicate) {
      const error = new Error('duplicate key value violates unique constraint');
      error.code = '23505';
      error.constraint = 'uq_wallet_accounts_public_key';
      throw error;
    }

    const sameIndex = this.accounts.find(
      (item) => String(item.hd_wallet_id) === String(hdWalletId) && item.account_index === accountIndex
    );

    if (sameIndex) {
      const error = new Error('duplicate key value violates unique constraint');
      error.code = '23505';
      error.constraint = 'uq_wallet_accounts_index';
      throw error;
    }

    const row = {
      id: String(this.nextAccountId),
      hd_wallet_id: String(hdWalletId),
      public_key: publicKey,
      account_index: accountIndex,
      derivation_path: `m/44'/501'/${accountIndex}'/0'`,
      wallet_type: 'hd_child',
      network,
      status,
      created_at: new Date(),
      updated_at: new Date()
    };

    this.nextAccountId += 1;
    this.accounts.push(row);

    return row;
  }

  accountByPublicKey(publicKey) {
    return this.accounts.find((item) => item.public_key === publicKey) ?? null;
  }

  accountsOf(hdWalletId) {
    return this.accounts.filter((item) => String(item.hd_wallet_id) === String(hdWalletId));
  }
}
