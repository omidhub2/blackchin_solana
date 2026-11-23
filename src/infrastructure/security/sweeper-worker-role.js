/**
 * Fail-closed validation of the dedicated Phase 6 sweeper runtime login.
 * This role can read encrypted HD mnemonic columns to sign controlled sweeps,
 * but cannot read legacy private-key ciphertext, credentials, dashboard
 * sessions, or webhook payloads.
 */
export async function assertSweeperRuntimeRole(db) {
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('A PostgreSQL sweeper connection is required');
  }
  const result = await db.query(
    `SELECT session_user, current_user, role.rolsuper, role.rolbypassrls,
            pg_has_role(session_user, 'blackchin_sweeper_runtime', 'MEMBER') AS sweeper_member,
            has_column_privilege(session_user, 'public.wallet_accounts', 'public_key', 'SELECT') AS can_read_child_addresses,
            has_column_privilege(session_user, 'public.hd_wallets', 'mnemonic_encrypted', 'SELECT') AS can_read_encrypted_mnemonic,
            has_column_privilege(session_user, 'public.hd_wallets', 'mnemonic_iv', 'SELECT') AS can_read_mnemonic_iv,
            has_column_privilege(session_user, 'public.hd_wallets', 'mnemonic_auth_tag', 'SELECT') AS can_read_mnemonic_auth_tag,
            has_column_privilege(session_user, 'public.wallets', 'private_key_encrypted', 'SELECT') AS can_read_legacy_private_key,
            has_table_privilege(session_user, 'public.tenant_api_credentials', 'SELECT') AS can_read_credentials,
            has_table_privilege(session_user, 'public.dashboard_sessions', 'SELECT') AS can_read_dashboard_sessions,
            has_column_privilege(session_user, 'public.webhook_outbox', 'payload', 'SELECT') AS can_read_webhook_payload,
            has_table_privilege(session_user, 'public.sweep_policies', 'SELECT') AS can_read_sweep_policies,
            has_table_privilege(session_user, 'public.sweep_jobs', 'SELECT') AS can_read_sweep_jobs,
            has_table_privilege(session_user, 'public.sweep_jobs', 'INSERT') AS can_insert_sweep_jobs,
            has_table_privilege(session_user, 'public.sweep_jobs', 'UPDATE') AS can_update_sweep_jobs,
            has_table_privilege(session_user, 'public.sweep_events', 'INSERT') AS can_append_sweep_events,
            has_table_privilege(session_user, 'public.blockchain_transactions', 'SELECT') AS can_read_ledger,
            has_table_privilege(session_user, 'public.blockchain_transactions', 'INSERT') AS can_insert_ledger
       FROM pg_roles AS role
      WHERE role.rolname = session_user`
  );
  const role = result.rows[0];
  const valid = role &&
    role.session_user === role.current_user &&
    role.rolsuper === false &&
    role.rolbypassrls === true &&
    role.sweeper_member === true &&
    role.can_read_child_addresses === true &&
    role.can_read_encrypted_mnemonic === true &&
    role.can_read_mnemonic_iv === true &&
    role.can_read_mnemonic_auth_tag === true &&
    role.can_read_legacy_private_key === false &&
    role.can_read_credentials === false &&
    role.can_read_dashboard_sessions === false &&
    role.can_read_webhook_payload === false &&
    role.can_read_sweep_policies === true &&
    role.can_read_sweep_jobs === true &&
    role.can_insert_sweep_jobs === true &&
    role.can_update_sweep_jobs === true &&
    role.can_append_sweep_events === true &&
    role.can_read_ledger === true &&
    role.can_insert_ledger === true;

  if (!valid) {
    const error = new Error(
      'SWEEPER_DATABASE_URL must use a non-superuser BYPASSRLS login with blackchin_sweeper_runtime membership and the exact restricted HD-signing grants'
    );
    error.code = 'INVALID_SWEEPER_RUNTIME_ROLE';
    throw error;
  }
  return {
    sessionUser: role.session_user,
    role: 'blackchin_sweeper_runtime',
    bypassRls: true,
    encryptedHdMnemonicAccess: true,
    legacyPrivateKeyAccess: false
  };
}
