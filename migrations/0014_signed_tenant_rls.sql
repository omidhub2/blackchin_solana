-- Signed tenant context and PostgreSQL row-level isolation.
--
-- The existing application/migration role remains the privileged control-plane
-- connection. Tenant requests must use a separate login that is a member of
-- blackchin_tenant_runtime and must SET LOCAL ROLE through tenant-context.js.
-- This migration does not reassign legacy NULL-tenant rows.

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;

CREATE TABLE IF NOT EXISTS private.tenant_context_secrets (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
    secret_key BYTEA NOT NULL CHECK (octet_length(secret_key) = 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
REVOKE ALL ON private.tenant_context_secrets FROM PUBLIC;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

DO $role$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'blackchin_tenant_runtime') THEN
        CREATE ROLE blackchin_tenant_runtime
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    END IF;
END;
$role$;

CREATE OR REPLACE FUNCTION private.current_tenant_id()
RETURNS BIGINT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, private
AS $function$
DECLARE
    context_text TEXT;
    signature_text TEXT;
    claims JSONB;
    secret BYTEA;
    expected_signature TEXT;
    signature_diff INTEGER := 0;
    character_index INTEGER;
    issued_at BIGINT;
    tenant_value BIGINT;
    credential_value BIGINT;
BEGIN
    context_text := current_setting('app.tenant_context', TRUE);
    signature_text := current_setting('app.tenant_context_signature', TRUE);

    IF context_text IS NULL OR signature_text IS NULL
       OR length(context_text) > 1024
       OR signature_text !~ '^[a-f0-9]{64}$' THEN
        RETURN NULL;
    END IF;

    SELECT secret_key INTO secret
      FROM private.tenant_context_secrets
     WHERE singleton = TRUE;

    IF secret IS NULL THEN
        RETURN NULL;
    END IF;

    expected_signature := encode(
        public.hmac(convert_to(context_text, 'UTF8'), secret, 'sha256'),
        'hex'
    );
    -- Compare every hex character rather than exiting on the first mismatch.
    FOR character_index IN 1..64 LOOP
        signature_diff := signature_diff |
            (ascii(substr(expected_signature, character_index, 1)) #
             ascii(substr(signature_text, character_index, 1)));
    END LOOP;
    IF signature_diff <> 0 THEN
        RETURN NULL;
    END IF;

    claims := context_text::jsonb;
    IF claims->>'version' IS DISTINCT FROM '1'
       OR COALESCE(claims->>'nonce', '') !~ '^[a-f0-9]{32}$'
       OR COALESCE(claims->>'tenantId', '') !~ '^[1-9][0-9]*$'
       OR COALESCE(claims->>'credentialId', '') !~ '^[1-9][0-9]*$'
       OR COALESCE(claims->>'issuedAt', '') !~ '^[0-9]+$' THEN
        RETURN NULL;
    END IF;

    issued_at := (claims->>'issuedAt')::BIGINT;
    IF issued_at > extract(epoch FROM statement_timestamp())::BIGINT + 30
       OR issued_at < extract(epoch FROM statement_timestamp())::BIGINT - 300 THEN
        RETURN NULL;
    END IF;

    tenant_value := (claims->>'tenantId')::BIGINT;
    credential_value := (claims->>'credentialId')::BIGINT;

    IF NOT EXISTS (
        SELECT 1
          FROM public.tenants t
          JOIN public.tenant_api_credentials c
            ON c.tenant_id = t.id
         WHERE t.id = tenant_value
           AND t.status = 'active'
           AND c.id = credential_value
           AND c.status = 'active'
           AND c.revoked_at IS NULL
           AND (c.expires_at IS NULL OR c.expires_at > statement_timestamp())
    ) THEN
        RETURN NULL;
    END IF;

    RETURN tenant_value;
EXCEPTION
    WHEN OTHERS THEN
        RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION private.current_tenant_id() FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO blackchin_tenant_runtime;
GRANT EXECUTE ON FUNCTION private.current_tenant_id() TO blackchin_tenant_runtime;

-- These are the tenant-owned operational tables. Global control-plane tables
-- (tenants, tenant_api_credentials, dashboard sessions and worker cursors)
-- intentionally remain inaccessible to this runtime role.
GRANT SELECT, INSERT, UPDATE, DELETE ON
    public.wallets,
    public.hd_wallets,
    public.wallet_accounts,
    public.blockchain_transactions,
    public.api_idempotency_keys,
    public.webhook_outbox,
    public.withdrawal_reconciliation_events,
    public.tenant_withdrawal_policies,
    public.tenant_withdrawal_destinations,
    public.tenant_withdrawal_approvals,
    public.tenant_withdrawal_policy_events,
    public.operational_events,
    public.tenant_webhook_endpoints,
    public.hot_wallets
TO blackchin_tenant_runtime;

DO $sequences$
DECLARE
    table_name TEXT;
    sequence_name TEXT;
    tenant_tables TEXT[] := ARRAY[
        'wallets', 'hd_wallets', 'wallet_accounts',
        'blockchain_transactions', 'api_idempotency_keys',
        'webhook_outbox', 'withdrawal_reconciliation_events',
        'tenant_withdrawal_destinations', 'tenant_withdrawal_approvals',
        'tenant_withdrawal_policy_events', 'operational_events',
        'tenant_webhook_endpoints', 'hot_wallets'
    ];
BEGIN
    FOREACH table_name IN ARRAY tenant_tables LOOP
        sequence_name := pg_get_serial_sequence('public.' || table_name, 'id');
        IF sequence_name IS NOT NULL THEN
            EXECUTE format(
                'GRANT USAGE, SELECT ON SEQUENCE %s TO blackchin_tenant_runtime',
                sequence_name
            );
        END IF;
    END LOOP;
END;
$sequences$;

DO $policies$
DECLARE
    table_name TEXT;
    tenant_tables TEXT[] := ARRAY[
        'wallets',
        'hd_wallets',
        'wallet_accounts',
        'blockchain_transactions',
        'api_idempotency_keys',
        'webhook_outbox',
        'withdrawal_reconciliation_events',
        'tenant_withdrawal_policies',
        'tenant_withdrawal_destinations',
        'tenant_withdrawal_approvals',
        'tenant_withdrawal_policy_events',
        'operational_events',
        'tenant_webhook_endpoints',
        'hot_wallets'
    ];
BEGIN
    FOREACH table_name IN ARRAY tenant_tables LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format(
            'DROP POLICY IF EXISTS tenant_isolation ON public.%I',
            table_name
        );
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON public.%I FOR ALL TO blackchin_tenant_runtime USING (tenant_id = private.current_tenant_id()) WITH CHECK (tenant_id = private.current_tenant_id())',
            table_name
        );
    END LOOP;
END;
$policies$;

COMMENT ON FUNCTION private.current_tenant_id() IS
    'Returns a tenant id only for a valid, unexpired HMAC-signed request context and active tenant credential.';

COMMENT ON ROLE blackchin_tenant_runtime IS
    'NOLOGIN restricted role for tenant API sessions; application logins must be non-superuser members and use SET LOCAL ROLE.';
