/**
 * Legacy standalone wallet metadata repository.
 *
 * Prefer the injected query executor so services and tests do not depend on a
 * module-global PostgreSQL pool. The one-argument form remains for legacy
 * callers and loads the default pool lazily.
 */
export async function findWalletMetadataByPublicKey(dbOrPublicKey, maybePublicKey) {
  let db = dbOrPublicKey;
  let publicKey = maybePublicKey;

  if (maybePublicKey === undefined) {
    publicKey = dbOrPublicKey;
    ({ pool: db } = await import('../../../PostgreSQL/walletStorage.js'));
  }

  const result = await db.query(
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
