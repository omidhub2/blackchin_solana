import test from 'node:test';
import assert from 'node:assert/strict';
import { getOperationalBacklog } from '../src/infrastructure/database/observability.repository.js';

test('maps aggregate backlog and oldest-age signals without exposing source rows', async () => {
  let capturedSql = '';
  const db = {
    async query(sql) {
      capturedSql = sql;
      return {
        rows: [{
          webhook_pending: 12,
          signed_withdrawals_pending: 2,
          ledger_under_review: 1,
          deposit_reconciliation_under_review: 3,
          withdrawal_reconciliation_under_review: 4,
          oldest_webhook_age_seconds: 360,
          oldest_signed_withdrawal_age_seconds: 900
        }]
      };
    }
  };
  const result = await getOperationalBacklog(db);
  assert.deepEqual(result, {
    webhookPending: 12,
    signedWithdrawalsPending: 2,
    ledgerUnderReview: 1,
    depositReconciliationUnderReview: 3,
    withdrawalReconciliationUnderReview: 4,
    oldestWebhookAgeSeconds: 360,
    oldestSignedWithdrawalAgeSeconds: 900
  });
  assert.match(capturedSql, /status = 'processing'/);
  assert.match(capturedSql, /transaction_signature IS NOT NULL/);
  assert.match(capturedSql, /outcome = 'under_review'/);
  assert.equal(capturedSql.includes('wallet_public_key'), false);
});
