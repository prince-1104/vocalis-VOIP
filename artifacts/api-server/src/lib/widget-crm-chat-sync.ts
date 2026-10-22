import { db, externalCrmConfigsTable, widgetChatSessionsTable } from "@workspace/db";
import type { WidgetChatTranscriptEntry } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import { crmHttp } from "./crm-http";
import { OutboundRequestError } from "./safe-outbound-http";
import { CredentialError } from "./credential-crypto";
import { buildAuthHeaders } from "./external-crm-lookup";
import type { WidgetCrmSession } from "./widget-crm-session";

const CHAT_WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1024;

export type WidgetChatCrmEvent =
  | "widget.chat.started"
  | "widget.chat.message"
  | "widget.chat.order_switched";

export interface WidgetChatCrmPayload {
  event: WidgetChatCrmEvent;
  timestamp: string;
  session: {
    id: string;
    phone: string;
    orderId: string;
    customerName?: string;
  };
  message?: WidgetChatTranscriptEntry;
  transcript: WidgetChatTranscriptEntry[];
}

async function getCrmSyncConfig(userId: number) {
  return db.query.externalCrmConfigsTable.findFirst({
    where: eq(externalCrmConfigsTable.userId, userId),
  });
}

async function upsertLocalSession(
  userId: number,
  session: Pick<WidgetCrmSession, "sessionId" | "phone" | "activeOrderId" | "customerName">,
  transcript: WidgetChatTranscriptEntry[],
): Promise<void> {
  const existing = await db.query.widgetChatSessionsTable.findFirst({
    where: eq(widgetChatSessionsTable.sessionId, session.sessionId),
  });

  if (existing) {
    await db.update(widgetChatSessionsTable)
      .set({
        phone: session.phone,
        orderId: session.activeOrderId,
        customerName: session.customerName ?? null,
        transcript,
        updatedAt: new Date(),
      })
      .where(eq(widgetChatSessionsTable.id, existing.id));
    return;
  }

  await db.insert(widgetChatSessionsTable).values({
    userId,
    sessionId: session.sessionId,
    phone: session.phone,
    orderId: session.activeOrderId,
    customerName: session.customerName ?? null,
    transcript,
  });
}

async function postToCrmWebhook(
  userId: number,
  payload: WidgetChatCrmPayload,
): Promise<boolean> {
  const config = await getCrmSyncConfig(userId);
  if (!config?.isEnabled || !config.widgetChatSyncEnabled || !config.widgetChatWebhookUrl) {
    return false;
  }

  try {
    const response = await crmHttp.request(config.widgetChatWebhookUrl, {
      method: "POST",
      headers: { ...buildAuthHeaders(config), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: config.timeoutMs ?? 5000,
      maxResponseBytes: CHAT_WEBHOOK_MAX_RESPONSE_BYTES,
    });

    if (!response.ok) {
      logger.warn(
        { userId, status: response.status, event: payload.event, sessionId: payload.session.id },
        "Widget chat CRM webhook returned non-OK",
      );
      return false;
    }

    await db.update(widgetChatSessionsTable)
      .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(widgetChatSessionsTable.sessionId, payload.session.id));

    return true;
  } catch (err) {
    if (err instanceof OutboundRequestError && err.blocked) {
      logger.warn({ userId, event: payload.event, reason: err.reason }, "Widget chat CRM webhook destination rejected");
    } else if (err instanceof CredentialError) {
      logger.error({ event: "credential_unavailable", field: "crmAuthValue", ownerId: userId, reason: err.reason }, "Stored credential unavailable");
    } else {
      logger.error({ err, userId, event: payload.event }, "Widget chat CRM webhook failed");
    }
    return false;
  }
}

export async function recordWidgetChatSessionStarted(
  userId: number,
  session: WidgetCrmSession,
): Promise<void> {
  const existing = await db.query.widgetChatSessionsTable.findFirst({
    where: eq(widgetChatSessionsTable.sessionId, session.sessionId),
  });
  if (existing) return;

  const timestamp = new Date().toISOString();
  const transcript: WidgetChatTranscriptEntry[] = [];

  await upsertLocalSession(userId, session, transcript);

  const payload: WidgetChatCrmPayload = {
    event: "widget.chat.started",
    timestamp,
    session: {
      id: session.sessionId,
      phone: session.phone,
      orderId: session.activeOrderId,
      customerName: session.customerName,
    },
    transcript,
  };

  await postToCrmWebhook(userId, payload);
}

export async function recordWidgetChatTurn(
  userId: number,
  session: WidgetCrmSession,
  userMessage: string,
  assistantReply: string,
  event: WidgetChatCrmEvent = "widget.chat.message",
): Promise<void> {
  const now = new Date().toISOString();
  const userEntry: WidgetChatTranscriptEntry = {
    role: "user",
    content: userMessage,
    timestamp: now,
  };
  const assistantEntry: WidgetChatTranscriptEntry = {
    role: "assistant",
    content: assistantReply,
    timestamp: now,
  };

  const existing = await db.query.widgetChatSessionsTable.findFirst({
    where: eq(widgetChatSessionsTable.sessionId, session.sessionId),
  });

  const transcript: WidgetChatTranscriptEntry[] = [
    ...(existing?.transcript ?? []),
    userEntry,
    assistantEntry,
  ];

  await upsertLocalSession(userId, session, transcript);

  const payload: WidgetChatCrmPayload = {
    event,
    timestamp: now,
    session: {
      id: session.sessionId,
      phone: session.phone,
      orderId: session.activeOrderId,
      customerName: session.customerName,
    },
    transcript,
  };

  await postToCrmWebhook(userId, payload);
}

/**
 * Most recent turns the server recorded for a verified session, scoped to the
 * owning tenant. Writes are fire-and-forget, so a reply still being recorded
 * may be missing from the next turn's context.
 */
export async function loadWidgetChatHistory(
  userId: number,
  sessionId: string,
  limit: number,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const existing = await db.query.widgetChatSessionsTable.findFirst({
    where: and(eq(widgetChatSessionsTable.sessionId, sessionId), eq(widgetChatSessionsTable.userId, userId)),
  });
  return (existing?.transcript ?? [])
    .filter((t) => (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content.trim())
    .slice(-limit)
    .map((t) => ({ role: t.role as "user" | "assistant", content: t.content }));
}

export function fireWidgetChatSessionStarted(
  userId: number,
  session: WidgetCrmSession,
): void {
  recordWidgetChatSessionStarted(userId, session).catch(err => {
    logger.error({ err, userId, sessionId: session.sessionId }, "Failed to record widget chat session start");
  });
}

export function fireWidgetChatTurn(
  userId: number,
  session: WidgetCrmSession,
  userMessage: string,
  assistantReply: string,
  event: WidgetChatCrmEvent = "widget.chat.message",
): void {
  recordWidgetChatTurn(userId, session, userMessage, assistantReply, event).catch(err => {
    logger.error({ err, userId, sessionId: session.sessionId }, "Failed to record widget chat turn");
  });
}
