import { db, webhookDeliveriesTable, crmApiKeysTable, callLogsTable } from "@workspace/db";
import { eq, and, lte } from "drizzle-orm";
import { signWebhookPayload } from "./crm-auth";
import { logger } from "./logger";
import { metrics } from "./operational-metrics";
import { crmHttp } from "./crm-http";
import { OutboundRequestError } from "./safe-outbound-http";
import { readCredential } from "./tenant-credentials";
import type { CRMCallEvent } from "./crm-event-bus";
import { crmEventBus } from "./crm-event-bus";

// ── Webhook Dispatcher ─────────────────────────────────────────────────
// Listens to the CRM event bus and delivers webhook events to all API keys
// that have a webhookUrl configured. Delivery is async with retry (3 attempts,
// exponential backoff: 10s, 60s, 300s).

const RETRY_DELAYS_MS = [10_000, 60_000, 300_000]; // 10s, 1min, 5min
const RESPONSE_BODY_MAX = 500;
const RESPONSE_READ_MAX_BYTES = 64 * 1024;

interface WebhookTarget {
  apiKeyId: number;
  ownerId: number;
  webhookUrl: string;
  /** Stored (encrypted) representation. */
  webhookSecret: string;
}

async function deliverWebhook(
  target: WebhookTarget, event: CRMCallEvent, deliveryId?: number,
): Promise<{ success: boolean; status?: number; body?: string }> {
  return metrics.measure("webhook_delivery", () => deliverWebhookImpl(target, event, deliveryId), "internal", result => result.success ? "success" : "error");
}

async function deliverWebhookImpl(
  target: WebhookTarget,
  event: CRMCallEvent,
  deliveryId?: number,
): Promise<{ success: boolean; status?: number; body?: string }> {
  const payload = JSON.stringify({
    event: event.type,
    callId: event.callId,
    callSid: event.callSid,
    data: event.data,
    metadata: event.metadata,
    timestamp: event.timestamp,
  });

  const secret = readCredential("crmWebhookSecret", target.ownerId, target.webhookSecret);
  if (!secret) return { success: false, status: 0, body: "Delivery failed: signing secret unavailable" };
  const signature = signWebhookPayload(payload, secret);

  try {
    const response = await crmHttp.request(target.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Dialog-Signature": signature,
        "X-Dialog-Event": event.type,
        "X-Dialog-Delivery-Id": deliveryId?.toString() || "0",
      },
      body: payload,
      timeoutMs: 10_000,
      maxResponseBytes: RESPONSE_READ_MAX_BYTES,
    });

    return {
      success: response.ok,
      status: response.status,
      body: response.text().slice(0, RESPONSE_BODY_MAX),
    };
  } catch (err: unknown) {
    if (err instanceof OutboundRequestError && err.blocked) {
      logger.warn({ apiKeyId: target.apiKeyId, reason: err.reason }, "Webhook destination rejected");
    }
    // Stored responseBody is readable by the tenant; transport error text
    // (resolved addresses, ports) is replaced by a fixed reason.
    return {
      success: false,
      status: 0,
      body: err instanceof OutboundRequestError ? `Delivery ${err.blocked ? "blocked" : "failed"}: ${err.reason}` : "Network error",
    };
  }
}

async function createDelivery(
  apiKeyId: number,
  event: CRMCallEvent,
): Promise<number> {
  const [row] = await db.insert(webhookDeliveriesTable).values({
    apiKeyId,
    callId: event.callId,
    event: event.type,
    payload: {
      event: event.type,
      callId: event.callId,
      callSid: event.callSid,
      data: event.data,
      metadata: event.metadata,
      timestamp: event.timestamp,
    },
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
  }).returning();

  return row.id;
}

async function processDelivery(
  target: WebhookTarget,
  event: CRMCallEvent,
): Promise<void> {
  const deliveryId = await createDelivery(target.apiKeyId, event);

  const result = await deliverWebhook(target, event, deliveryId);

  if (result.success) {
    await db.update(webhookDeliveriesTable)
      .set({
        status: "delivered",
        attempts: 1,
        lastAttemptAt: new Date(),
        responseStatus: result.status,
        responseBody: result.body,
      })
      .where(eq(webhookDeliveriesTable.id, deliveryId));

    logger.debug({ deliveryId, event: event.type, callId: event.callId }, "Webhook delivered");
  } else {
    // Schedule retry
    const nextRetryAt = new Date(Date.now() + RETRY_DELAYS_MS[0]);
    await db.update(webhookDeliveriesTable)
      .set({
        status: "pending",
        attempts: 1,
        lastAttemptAt: new Date(),
        responseStatus: result.status,
        responseBody: result.body,
        nextRetryAt,
      })
      .where(eq(webhookDeliveriesTable.id, deliveryId));

    logger.warn(
      { deliveryId, event: event.type, callId: event.callId, status: result.status },
      "Webhook delivery failed, scheduled retry",
    );
  }
}

// Subscribe to the event bus and dispatch webhooks to all matching API keys
export function startWebhookDispatcher(): void {
  crmEventBus.onCallEvent(async (event) => {
    try {
      // Resolve the tenant (userId) from the event or fall back to DB lookup
      let userId = event.userId;
      if (!userId && event.callId) {
        const callLog = await db.query.callLogsTable.findFirst({
          where: eq(callLogsTable.id, event.callId),
        }).catch(() => null);
        userId = callLog?.userId;
      }

      if (!userId) {
        logger.warn({ event: event.type, callId: event.callId }, "Webhook dispatch skipped: could not resolve userId");
        return;
      }

      // Find active API keys for THIS tenant that have webhook URLs configured
      const apiKeys = await db.select().from(crmApiKeysTable).where(
        and(
          eq(crmApiKeysTable.isActive, true),
          eq(crmApiKeysTable.userId, userId),
        ),
      );

      // Filter to keys that have webhookUrl + webhookSecret configured
      const targets = apiKeys
        .filter(k => k.webhookUrl && k.webhookSecret)
        .map(k => ({
          apiKeyId: k.id,
          ownerId: k.userId,
          webhookUrl: k.webhookUrl!,
          webhookSecret: k.webhookSecret!,
        }));

      if (targets.length === 0) return;

      logger.debug(
        { event: event.type, callId: event.callId, userId, targets: targets.length },
        "Dispatching webhook to CRM(s)",
      );

      // Dispatch to all of this tenant's webhook targets in parallel
      await Promise.allSettled(
        targets.map(t => processDelivery(t, event)),
      );
    } catch (err) {
      logger.error({ err, event: event.type, callId: event.callId }, "Webhook dispatch error");
    }
  });

  // Start retry processor — runs every 30 seconds
  setInterval(processRetries, 30_000);

  logger.info("Webhook dispatcher started");
}

// Retry failed deliveries
async function processRetries(): Promise<void> {
  const finish = metrics.operation("webhook_job");
  try {
    const pending = await db.select()
      .from(webhookDeliveriesTable)
      .where(
        and(
          eq(webhookDeliveriesTable.status, "pending"),
          lte(webhookDeliveriesTable.nextRetryAt, new Date()),
        ),
      )
      .limit(50);

    metrics.retryBatch(pending);

    for (const delivery of pending) {
      const apiKey = await db.query.crmApiKeysTable.findFirst({
        where: eq(crmApiKeysTable.id, delivery.apiKeyId),
      });

      if (!apiKey || !apiKey.webhookUrl || !apiKey.webhookSecret) {
        await db.update(webhookDeliveriesTable)
          .set({ status: "failed" })
          .where(eq(webhookDeliveriesTable.id, delivery.id));
        continue;
      }

      const event: CRMCallEvent = {
        type: (delivery.payload as any).event || delivery.event as CRMCallEvent["type"],
        callId: delivery.callId || 0,
        callSid: (delivery.payload as any).callSid,
        data: (delivery.payload as any).data || {},
        metadata: (delivery.payload as any).metadata,
        timestamp: (delivery.payload as any).timestamp || delivery.createdAt.toISOString(),
      };

      const result = await deliverWebhook(
        {
          apiKeyId: apiKey.id,
          ownerId: apiKey.userId,
          webhookUrl: apiKey.webhookUrl,
          webhookSecret: apiKey.webhookSecret,
        },
        event,
        delivery.id,
      );

      const newAttempts = delivery.attempts + 1;

      if (result.success) {
        await db.update(webhookDeliveriesTable)
          .set({
            status: "delivered",
            attempts: newAttempts,
            lastAttemptAt: new Date(),
            responseStatus: result.status,
            responseBody: result.body,
            nextRetryAt: null,
          })
          .where(eq(webhookDeliveriesTable.id, delivery.id));
      } else if (newAttempts >= delivery.maxAttempts) {
        await db.update(webhookDeliveriesTable)
          .set({
            status: "failed",
            attempts: newAttempts,
            lastAttemptAt: new Date(),
            responseStatus: result.status,
            responseBody: result.body,
            nextRetryAt: null,
          })
          .where(eq(webhookDeliveriesTable.id, delivery.id));

        logger.error(
          { deliveryId: delivery.id, event: delivery.event, attempts: newAttempts },
          "Webhook delivery permanently failed",
        );
      } else {
        const delay = RETRY_DELAYS_MS[Math.min(newAttempts - 1, RETRY_DELAYS_MS.length - 1)];
        await db.update(webhookDeliveriesTable)
          .set({
            attempts: newAttempts,
            lastAttemptAt: new Date(),
            responseStatus: result.status,
            responseBody: result.body,
            nextRetryAt: new Date(Date.now() + delay),
          })
          .where(eq(webhookDeliveriesTable.id, delivery.id));
      }
    }
  } catch (err) {
    finish("error");
    logger.error({ err }, "Webhook retry processor error");
  } finally {
    finish();
  }
}
