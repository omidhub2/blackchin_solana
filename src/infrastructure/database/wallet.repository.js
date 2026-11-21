import { pool } from '../../../PostgreSQL/walletStorage.js';

export async function findWalletMetadataByPublicKey(publicKey) {
  const result = await pool.query(
    `
      SELECT id, public_key, created_at
      FROM wallets
      WHERE public_key = $1
      LIMIT 1
    `,
    [publicKey]
  );

  if (result.rowCount === 0) return null;

  const row = result.rows[0];
  return {
    id: String(row.id),
    publicKey: row.public_key,
    createdAt: row.created_at
  };
}
