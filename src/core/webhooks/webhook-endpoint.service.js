/**
 * Tenant webhook endpoint lifecycle.
 *
 * Secrets are generated server-side, returned exactly once, stored encrypted,
 * and used to sign deliveries with HMAC-SHA256. Endpoint URLs are validated
 * against the SSRF policy at creation time and re-validated on every delivery
 * attempt by the delivery worker.
 */
import crypto from 'node:crypto';

import { conflict, notFound } from '../errors.js';
import { validateWebhookUrlShape } from '../../infrastructure/security/ssrf-guard.js';
import { WEBHOOK_EVENT_TYPES } from '../../infrastructure/database/webhook-outbox.repository.js';
import {
  findActiveWebhookEndpointForEvent,
  findWebhookEndpointByIdForTenant,
  insertWebhookEndpoint,
  listWebhookEndpointsForTenant,
  updateWebhookEndpointSecret,
  updateWebhookEndpointStatus
} from '../../infrastructure/database/webhook-endpoint.repository.js';

const EVENT_TYPES = new Set(WEBHOOK_EVENT_TYPES);
const MIN_SECRET_LENGTH = 32;

function assertTenantId(value) {
  if ((typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') ||
      !/^[1-9][0-9]*$/.test(String(value))) {
    throw new TypeError('tenantId must be a positive integer');
  }
  return String(value);
}

function normalizeEventTypes(eventTypes) {
  if (eventTypes === undefined || eventTypes === null) return [];
  if (!Array.isArray(eventTypes)) {
    throw conflict('eventTypes must be an array', 'INVALID_EVENT_TYPES');
  }
  const normalized = [...new Set(eventTypes)];
  for (const type of normalized) {
    if (typeof type !== 'string' || !EVENT_TYPES.has(type)) {
      throw conflict(`Unsupported webhook event type: ${type}`, 'INVALID_EVENT_TYPES');
    }
  }
  return normalized;
}

function secretAad(tenantId, endpointUrl) {
  return `tenant_webhook_endpoints:${tenantId}:${endpointUrl}:secret:v1`;
}

function publicView(endpoint) {
  return {
    id: endpoint.id,
    tenantId: endpoint.tenantId,
    endpointUrl: endpoint.endpointUrl,
    eventTypes: endpoint.eventTypes,
    status: endpoint.status,
    rotatedAt: endpoint.rotatedAt,
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt
  };
}

export function createWebhookEndpointService({ db, cipher, log = () => {} }) {
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('A database query executor is required');
  }
  if (!cipher || typeof cipher.encrypt !== 'function' || typeof cipher.decrypt !== 'function') {
    throw new TypeError('A cipher is required for webhook secret storage');
  }

  function seal(tenantId, endpointUrl, secret) {
    return cipher.encrypt(secret, {
      aad: secretAad(tenantId, endpointUrl),
      keyVersion: cipher.currentVersion
    });
  }

  return Object.freeze({
    async create({ tenantId, endpointUrl, eventTypes } = {}) {
      tenantId = assertTenantId(tenantId);
      const shape = validateWebhookUrlShape(endpointUrl);
      if (!shape.ok) {
        throw conflict(`Webhook endpoint rejected: ${shape.reason}`, 'INVALID_WEBHOOK_ENDPOINT');
      }

      const normalizedTypes = normalizeEventTypes(eventTypes);
      const secret = crypto.randomBytes(32).toString('base64url');
      const sealed = seal(tenantId, endpointUrl, secret);

      const endpoint = await insertWebhookEndpoint(db, {
        tenantId,
        endpointUrl,
        eventTypes: normalizedTypes,
        secretEncrypted: sealed.ciphertext,
        secretIv: sealed.iv,
        secretAuthTag: sealed.authTag,
        encryptionKeyVersion: cipher.currentVersion
      });

      log('webhook_endpoint.created', { tenantId, endpointId: endpoint.id });
      return { endpoint: publicView(endpoint), secret };
    },

    async list(tenantId, { limit = 50, offset = 0 } = {}) {
      tenantId = assertTenantId(tenantId);
      const items = await listWebhookEndpointsForTenant(db, tenantId, { limit, offset });
      return items.map(publicView);
    },

    async rotateSecret({ tenantId, id } = {}) {
      tenantId = assertTenantId(tenantId);
      const endpoint = await findWebhookEndpointByIdForTenant(db, tenantId, id);
      if (!endpoint) throw notFound('Webhook endpoint was not found', 'WEBHOOK_ENDPOINT_NOT_FOUND');

      const secret = crypto.randomBytes(32).toString('base64url');
      const sealed = seal(tenantId, endpoint.endpointUrl, secret);
      const updated = await updateWebhookEndpointSecret(db, tenantId, id, {
        secretEncrypted: sealed.ciphertext,
        secretIv: sealed.iv,
        secretAuthTag: sealed.authTag,
        encryptionKeyVersion: cipher.currentVersion
      });

      log('webhook_endpoint.rotated', { tenantId, endpointId: endpoint.id });
      return { endpoint: publicView(updated), secret };
    },

    async setStatus({ tenantId, id, status } = {}) {
      tenantId = assertTenantId(tenantId);
      if (!['active', 'disabled'].includes(status)) {
        throw conflict('status must be active or disabled', 'INVALID_STATUS');
      }
      const updated = await updateWebhookEndpointStatus(db, tenantId, id, status);
      if (!updated) throw notFound('Webhook endpoint was not found', 'WEBHOOK_ENDPOINT_NOT_FOUND');
      return publicView(updated);
    },

    /**
     * Delivery-time resolution. Returns null when the tenant has not configured
     * an endpoint for this event type, allowing the worker to fall back to a
     * legacy platform endpoint or discard the event.
     */
    async resolveForDelivery({ tenantId, eventType } = {}) {
      if (tenantId === null || tenantId === undefined) return null;
      const endpoint = await findActiveWebhookEndpointForEvent(db, assertTenantId(tenantId), eventType);
      if (!endpoint) return null;

      const secret = cipher.decrypt(
        endpoint.secretEncrypted,
        endpoint.secretIv,
        endpoint.secretAuthTag,
        {
          aad: secretAad(endpoint.tenantId, endpoint.endpointUrl),
          keyVersion: endpoint.encryptionKeyVersion
        }
      );

      if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
        throw new Error('Stored webhook secret is invalid');
      }

      return { endpointUrl: endpoint.endpointUrl, secret, endpointId: endpoint.id };
    }
  });
}