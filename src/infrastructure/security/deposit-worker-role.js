/**
 * Validate the least-privilege cross-tenant deposit-worker database login.
 *
 * This login must be a non-superuser BYPASSRLS role because the background
 * scanner processes multiple tenants. It receives only explicit worker grants;
 * encrypted HD mnemonic columns and all withdrawal/signing tables stay denied.
 */
export async function assertDepositWorkerRuntimeRole(db) {
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('A PostgreSQL worker connection is required');
  }

  const result = await db.query(
    `SELECT session_user,
            current_user,
            role.rolsuper,
            role.rolbypassrls,
            pg_has_role(session_user, 'blackchin_deposit_worker_runtime', 'MEMBER') AS worker_member,
            has_column_privilege(session_user, 'public.wallets', 'public_key', 'SELECT') AS can_read_wallet_addresses,
            has_column_privilege(session_user, 'public.wallet_accounts', 'public_key', 'SELECT') AS can_read_child_addresses,
            has_column_privilege(session_user, 'public.hd_wallets', 'status', 'SELECT') AS can_read_hd_status,
            has_column_privilege(session_user, 'public.hd_wallets', 'mnemonic_encrypted', 'SELECT') AS can_read_encrypted_mnemonic,
            has_column_privilege(session_user, 'public.hd_wallets', 'mnemonic_iv', 'SELECT') AS can_read_mnemonic_iv,
            has_table_privilege(session_user, 'public.blockchain_transactions', 'SELECT') AS can_read_ledger,
            has_table_privilege(session_user, 'public.blockchain_transactions', 'INSERT') AS can_insert_ledger,
            has_table_privilege(session_user, 'public.blockchain_transactions', 'UPDATE') AS can_update_ledger,
            has_table_privilege(session_user, 'public.deposit_scanner_cursors', 'UPDATE') AS can_update_scanner_cursor,
            has_table_privilege(session_user, 'public.deposit_reconciliation_cursors', 'UPDATE') AS can_update_reconciliation_cursor,
            has_table_privilege(session_user, 'public.deposit_reconciliation_events', 'INSERT') AS can_append_reconciliation_events,
            has_table_privilege(session_user, 'public.webhook_outbox', 'INSERT') AS can_append_webhook_outbox,
            has_table_privilege(session_user, 'public.operational_events', 'INSERT') AS can_append_operational_events
       FROM pg_roles AS role
      WHERE role.rolname = session_user`
  );

  const role = result.rows[0];
  const valid = role &&
    role.session_user === role.current_user &&
    role.rolsuper === false &&
    role.rolbypassrls === true &&
    role.worker_member === true &&
    role.can_read_wallet_addresses === true &&
    role.can_read_child_addresses === true &&
    role.can_read_hd_status === true &&
    role.can_read_encrypted_mnemonic === false &&
    role.can_read_mnemonic_iv === false &&
    role.can_read_ledger === true &&
    role.can_insert_ledger === true &&
    role.can_update_ledger === true &&
    role.can_update_scanner_cursor === true &&
    role.can_update_reconciliation_cursor === true &&
    role.can_append_reconciliation_events === true &&
    role.can_append_webhook_outbox === true &&
    role.can_append_operational_events === true;

  if (!valid) {
    const error = new Error(
      'DEPOSIT_WORKER_DATABASE_URL must use a non-superuser BYPASSRLS login with the restricted deposit-worker role and without encrypted mnemonic access'
    );
    error.code = 'INVALID_DEPOSIT_WORKER_ROLE';
    throw error;
  }

  return {
    sessionUser: role.session_user,
    role: 'blackchin_deposit_worker_runtime',
    bypassRls: true,
    encryptedMnemonicAccess: false
  };
}
