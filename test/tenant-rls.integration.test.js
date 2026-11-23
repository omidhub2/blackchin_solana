import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

import {
  assertTenantRuntimeRole,
  createTenantContextSigner,
  createTenantScopedDatabase,
  provisionTenantContextSecret
} from '../src/infrastructure/security/tenant-context.js';

const enabled = Boolean(
  process.env.DATABASE_URL &&
  process.env.TENANT_DATABASE_URL &&
  process.env.TENANT_CONTEXT_HMAC_KEY
);

test('PostgreSQL RLS isolates tenant rows, blocks cross-tenant writes and invalidates revoked credentials', {
  skip: !enabled && 'requires DATABASE_URL, TENANT_DATABASE_URL and TENANT_CONTEXT_HMAC_KEY'
}, async () => {
  const adminPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const tenantPool = new pg.Pool({ connectionString: process.env.TENANT_DATABASE_URL, max: 2 });
  const keyHex = process.env.TENANT_CONTEXT_HMAC_KEY;
  const signer = createTenantContextSigner(keyHex);
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const tenantCodes = [`rls_a_${suffix.slice(0, 20)}`, `rls_b_${suffix.slice(0, 20)}`];
  const publicKeys = [`test_wallet_a_${suffix}`, `test_wallet_b_${suffix}`];
  const tenantIds = [];
  const credentialIds = [];

  try {
    await provisionTenantContextSecret(adminPool, keyHex);
    await assertTenantRuntimeRole(tenantPool);

    for (const tenantCode of tenantCodes) {
      const tenant = await adminPool.query(
        `INSERT INTO tenants (tenant_code, display_name, status)
         VALUES ($1, $2, 'active') RETURNING id`,
        [tenantCode, tenantCode]
      );
      tenantIds.push(String(tenant.rows[0].id));

      const prefix = `bc_live_${crypto.randomBytes(6).toString('base64url')}`;
      const credential = await adminPool.query(
        `INSERT INTO tenant_api_credentials (tenant_id, key_prefix, secret_hash, scopes)
         VALUES ($1, $2, $3, ARRAY['wallets:read','wallets:write']::text[])
         RETURNING id`,
        [tenant.rows[0].id, prefix, crypto.randomBytes(32)]
      );
      credentialIds.push(String(credential.rows[0].id));
    }

    const walletIds = [];
    for (let index = 0; index < tenantIds.length; index += 1) {
      const wallet = await adminPool.query(
        `INSERT INTO wallets (
           tenant_id, public_key, private_key_encrypted, private_key_iv, private_key_auth_tag
         ) VALUES ($1, $2, 'ciphertext', 'iv', 'tag')
         RETURNING id`,
        [tenantIds[index], publicKeys[index]]
      );
      walletIds.push(String(wallet.rows[0].id));
    }

    const tenantA = createTenantScopedDatabase(tenantPool, signer.create({
      tenantId: tenantIds[0], credentialId: credentialIds[0]
    }));
    const tenantB = createTenantScopedDatabase(tenantPool, signer.create({
      tenantId: tenantIds[1], credentialId: credentialIds[1]
    }));

    const aRows = await tenantA.query('SELECT id, tenant_id FROM wallets ORDER BY id');
    const bRows = await tenantB.query('SELECT id, tenant_id FROM wallets ORDER BY id');

    assert.deepEqual(aRows.rows.map((row) => String(row.id)), [walletIds[0]]);
    assert.deepEqual(bRows.rows.map((row) => String(row.id)), [walletIds[1]]);
    assert.ok(aRows.rows.every((row) => String(row.tenant_id) === tenantIds[0]));
    assert.ok(bRows.rows.every((row) => String(row.tenant_id) === tenantIds[1]));

    const foreignRead = await tenantA.query(
      'SELECT id FROM wallets WHERE id = $1',
      [walletIds[1]]
    );
    assert.equal(foreignRead.rowCount, 0);

    const foreignUpdate = await tenantA.query(
      "UPDATE wallets SET private_key_encrypted = 'tampered' WHERE id = $1",
      [walletIds[1]]
    );
    assert.equal(foreignUpdate.rowCount, 0);

    await assert.rejects(
      () => tenantA.query(
        `INSERT INTO wallets (
           tenant_id, public_key, private_key_encrypted, private_key_iv, private_key_auth_tag
         ) VALUES ($1, $2, 'ciphertext', 'iv', 'tag')`,
        [tenantIds[1], `cross_tenant_${suffix}`]
      ),
      (error) => error.code === '42501'
    );

    const invalidContext = createTenantScopedDatabase(tenantPool, {
      ...signer.create({ tenantId: tenantIds[0], credentialId: credentialIds[0] }),
      signature: '0'.repeat(64)
    });
    const invalidRows = await invalidContext.query('SELECT id FROM wallets');
    assert.equal(invalidRows.rowCount, 0);

    const noContextClient = await tenantPool.connect();
    try {
      await noContextClient.query('BEGIN');
      await noContextClient.query('SET LOCAL ROLE blackchin_tenant_runtime');
      const noContextRows = await noContextClient.query('SELECT id FROM wallets');
      assert.equal(noContextRows.rowCount, 0);
      await noContextClient.query('COMMIT');
    } catch (error) {
      try { await noContextClient.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      noContextClient.release();
    }

    await adminPool.query(
      "UPDATE tenant_api_credentials SET status = 'revoked', revoked_at = NOW() WHERE id = $1",
      [credentialIds[0]]
    );
    const revokedContextRows = await tenantA.query('SELECT id FROM wallets');
    assert.equal(revokedContextRows.rowCount, 0);
  } finally {
    if (tenantIds.length) {
      await adminPool.query('DELETE FROM wallets WHERE tenant_id = ANY($1::bigint[])', [tenantIds]);
      await adminPool.query('DELETE FROM tenant_api_credentials WHERE tenant_id = ANY($1::bigint[])', [tenantIds]);
      await adminPool.query('DELETE FROM tenants WHERE id = ANY($1::bigint[])', [tenantIds]);
    }
    await tenantPool.end();
    await adminPool.end();
  }
});
