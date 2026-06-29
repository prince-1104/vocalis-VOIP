import { db, externalCrmConfigsTable, widgetChatSessionsTable } from "@workspace/db";
import type { WidgetChatTranscriptEntry } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import type { WidgetCrmSession } from "./widget-crm-session";

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

function buildAuthHeaders(config: {
  authType: string;
  authValue: string | null;
  authHeaderName: string | null;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (!config.authValue) return headers;
  switch (config.authType) {
    case "bearer":
      headers.Authorization = `Bearer ${config.authValue}`;
      break;
    case "api_key":
      headers["X-API-Key"] = config.authValue;
      break;
    case "basic":
      headers.Authorization = `Basic ${Buffer.from(config.authValue).toString("base64")}`;
      break;
    case "header":
      headers[config.authHeaderName || "X-Auth-Token"] = config.authValue;
      break;
  }
  return headers;
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 5000);

  try {
    const response = await fetch(config.widgetChatWebhookUrl, {
      method: "POST",
      headers: buildAuthHeaders(config),
      body: JSON.stringify(payload),
      signal: controller.signal,
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
    logger.error({ err, userId, event: payload.event }, "Widget chat CRM webhook failed");
    return false;
  } finally {
    clearTimeout(timeout);
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
