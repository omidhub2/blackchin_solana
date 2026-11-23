export type DashboardUser = {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'operator' | 'viewer';
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
};

export type SessionResponse = {
  user: DashboardUser;
  expiresAt: string;
  csrfToken: string | null;
};

export type ServiceStatus = {
  status: string;
  [key: string]: unknown;
};

export type OverviewStats = {
  tenants: number;
  activeTenants: number;
  hdWallets: number;
  childWallets: number;
  hotWallets: number;
  frozenHotWallets: number;
  registeredAddresses: number;
  monitoredAddresses: number;
  deposits: { total: number; confirmed: number; pending: number; failed: number; underReview: number };
  withdrawals: { total: number; confirmed: number; pending: number; failed: number };
  transactions: { total: number; confirmed: number; pending: number; failed: number; underReview: number };
  webhooks: { pending: number; delivered: number; failed: number; endpoints: number };
  activeCredentials: number;
  dashboardUsers: number;
  eventsInRange: number;
};

export type SeriesPoint = { bucket: string; count: number };

export type OverviewResponse = {
  range: string;
  since: string;
  generatedAt: string;
  stats: OverviewStats;
  series: {
    bucket: 'hour' | 'day';
    wallets: SeriesPoint[];
    addresses: SeriesPoint[];
    deposits: SeriesPoint[];
    withdrawals: SeriesPoint[];
  };
  services: {
    rpc: { status: string; network?: string; slot?: number; latencyMs?: number; reason?: string };
    scanner: { status: string; lastRunAt: string | null; cursors: Array<{ status: string; cursors: number; lastRunAt: string | null; lastError: string | null }> };
    signer: { status: string; kms: boolean; note: string };
    webhooks: { status: string; delivered?: number; retried?: number; discarded?: number; lastRunAt?: string | null };
  };
  recentEvents: OperationalEvent[];
  lastEventId: number;
};

export type OperationalEvent = {
  id: string;
  eventId: string;
  tenantId: string | null;
  eventType: string;
  network: string | null;
  walletPublicKey: string | null;
  hdWalletId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type HdWallet = {
  id: string;
  tenantId: string | null;
  label: string | null;
  ownerId: string | null;
  network: string;
  status: string;
  nextAccountIndex: number;
  childCount: number;
  phraseProvisioned: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ChildWallet = {
  id: string;
  tenantId: string | null;
  hdWalletId: string;
  parentLabel: string | null;
  publicKey: string;
  accountIndex: number;
  derivationPath: string;
  walletType: string;
  network: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type HotWallet = {
  id: string;
  tenantId: string;
  hdWalletId: string;
  walletAccountId: string;
  publicKey: string;
  network: string;
  label: string | null;
  status: string;
  signingEnabled: boolean;
  maxSingleLamports: string;
  freezeReason: string | null;
  createdBy: string | null;
  frozenAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AddressRecord = {
  id: string;
  tenantId: string | null;
  publicKey: string;
  walletType: string;
  network: string | null;
  status: string;
  hdWalletId: string | null;
  accountIndex: number | null;
  derivationPath: string | null;
  createdAt: string;
};

export type TransactionRecord = {
  id: string;
  tenantId: string | null;
  signature: string;
  direction: 'deposit' | 'withdrawal';
  walletPublicKey: string;
  hdWalletId: string | null;
  counterparty: string | null;
  amountLamports: string;
  feeLamports: string | null;
  network: string;
  commitment: string | null;
  status: string;
  slot: number | null;
  blockTime: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WithdrawalRecord = {
  idempotencyKey: string;
  tenantId: string | null;
  status: string;
  network: string;
  fromPublicKey: string;
  toPublicKey: string;
  amountLamports: string | null;
  signature: string | null;
  approvalReference: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WebhookEvent = {
  id: string;
  eventId: string;
  eventType: string;
  tenantId: string | null;
  walletPublicKey: string | null;
  hdWalletId: string | null;
  network: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lastHttpStatus: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WebhookEndpoint = {
  id: string;
  tenantId: string;
  endpointUrl: string;
  eventTypes: string[];
  status: string;
  rotatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CredentialRecord = {
  id: string;
  tenantId: string;
  tenantCode: string;
  tenantName: string;
  keyPrefix: string;
  scopes: string[];
  status: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type TenantRecord = {
  id: string;
  tenantCode: string;
  displayName: string;
  status: string;
  hdWallets: number;
  childWallets: number;
  createdAt: string;
};

export type PolicyRecord = {
  tenantId: string;
  tenantCode: string;
  tenantName: string;
  enabled: boolean;
  emergencyFrozen: boolean;
  freezeReason: string | null;
  maxSingleLamports: string;
  maxDailyLamports: string;
  maxWeeklyLamports: string;
  maxDailyCount: number;
  maxWeeklyCount: number;
  policyVersion: number;
  updatedAt: string;
};

export type TenantWithdrawalPolicy = {
  tenantId: string;
  enabled: boolean;
  emergencyFrozen: boolean;
  freezeReason: string | null;
  maxSingleLamports: string;
  maxDailyLamports: string;
  maxWeeklyLamports: string;
  maxDailyCount: number;
  maxWeeklyCount: number;
  policyVersion: string;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WithdrawalDestination = {
  id: string;
  tenantId: string;
  network: string;
  asset: 'SOL';
  destinationPublicKey: string;
  status: 'pending' | 'active' | 'revoked';
  label: string | null;
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type WithdrawalApproval = {
  tenantId: string;
  credentialId: string;
  approvalReference: string;
  walletPublicKey: string;
  destinationPublicKey: string;
  network: string;
  asset: 'SOL';
  amountLamports: string;
  status: 'approved' | 'consumed' | 'revoked' | 'expired';
  issuer: string;
  issuerEventId: string;
  expiresAt: string;
  approvedAt: string;
  consumedAt: string | null;
};

export type NetworkResponse = {
  network: string;
  commitment: string;
  rpc: { status: string; slot?: number; latencyMs?: number; reason?: string };
  scanner: { cursors: Array<{ status: string; cursors: number; lastRunAt: string | null; lastError: string | null }>; lastRunAt: string | null };
  supportedAssets: string[];
  unsupported: string[];
};

export type ListResponse<T> = { items: T[] };