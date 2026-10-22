import { type WidgetCustomerSession } from "@workspace/db";
import { type ExternalCrmContext } from "./external-crm-lookup";
import {
  buildOrderScopedContext,
  extractOrderIdFromInput,
  extractOrderIdFromMessage,
  extractPhoneFromMessage,
  fetchCrmCustomerWithOrders,
  normalizeOrderId,
  type CrmOrder,
} from "./widget-crm-orders";

/**
 * Per-request view of a verified customer. Built server-side from the
 * verified session plus a fresh CRM lookup; never serialized to the client.
 */
export interface WidgetCrmSession {
  userId: number;
  sessionId: string;
  phone: string;
  customerName?: string;
  activeOrderId: string;
  orderIds: string[];
  orders: CrmOrder[];
  crmContext: ExternalCrmContext;
}

export const ORDER_NOT_FOUND_MESSAGE =
  "I couldn't find that order on your verified account. Please check the order ID and try again.";
export const PHONE_SWITCH_MESSAGE =
  "To get help with a different phone number, please end this chat and verify that number.";

export const ORDER_SCOPE_MESSAGE =
  "This chat is limited to the order you verified. To discuss a different order, please end this chat and verify again.";

/**
 * Exact order-ID candidates from customer input. IDs are compared as
 * normalized strings, so leading zeros remain significant.
 */
function orderCandidates(input: string): string[] {
  const candidates = new Set<string>();
  const direct = normalizeOrderId(input);
  if (/^[A-Za-z0-9_-]{1,64}$/.test(direct)) candidates.add(direct);
  const extracted = extractOrderIdFromInput(input);
  if (extracted) candidates.add(extracted);
  return [...candidates];
}

function scopeToOrder(
  verified: WidgetCustomerSession,
  customer: Pick<Awaited<ReturnType<typeof fetchCrmCustomerWithOrders>>, "found" | "customerName" | "orders" | "context">,
  orderId: string,
): WidgetCrmSession | null {
  if (verified.scope === "order" && orderId !== verified.activeOrderId) return null;
  const order = customer.orders.find(o => normalizeOrderId(o.orderId) === orderId);
  if (!customer.found || !order) return null;
  return {
    userId: verified.ownerId,
    sessionId: verified.id,
    phone: verified.phone,
    customerName: customer.customerName,
    activeOrderId: orderId,
    orderIds: customer.orders.map(o => normalizeOrderId(o.orderId)),
    orders: customer.orders,
    crmContext: buildOrderScopedContext(customer.context, order, customer.orders),
  };
}

/**
 * Re-fetches the verified customer's CRM record and returns the requested
 * order only if it belongs to that customer's verified phone number.
 */
export async function resolveVerifiedOrder(
  verified: WidgetCustomerSession,
  orderInput: string,
): Promise<WidgetCrmSession | null> {
  const candidates = orderCandidates(orderInput);
  if (candidates.length === 0) return null;
  const customer = await fetchCrmCustomerWithOrders(verified.ownerId, verified.phone);
  for (const orderId of candidates) {
    const scoped = scopeToOrder(verified, customer, orderId);
    if (scoped) return scoped;
  }
  return null;
}

/** Re-checks the session's stored order against a fresh CRM lookup. */
export async function loadSessionOrder(verified: WidgetCustomerSession): Promise<WidgetCrmSession | null> {
  if (!verified.activeOrderId) return null;
  const customer = await fetchCrmCustomerWithOrders(verified.ownerId, verified.phone);
  return scopeToOrder(verified, customer, verified.activeOrderId);
}

export function greetingFor(session: WidgetCrmSession): string {
  const displayName = session.customerName?.trim() || "there";
  return `Hello ${displayName}, how can I help you with your order #${session.activeOrderId}?`;
}

export type CrmChatResolution = {
  session: WidgetCrmSession;
  switchedOrder: boolean;
  switchMessage?: string;
};

/** Handles order or phone changes mentioned inside an already-verified chat. */
export function resolveWidgetCrmSessionForChat(
  verified: WidgetCustomerSession,
  session: WidgetCrmSession,
  userMessage: string,
): CrmChatResolution {
  const otherPhone = extractPhoneFromMessage(userMessage, verified.phone);
  if (otherPhone && otherPhone !== verified.phone) {
    return { session, switchedOrder: false, switchMessage: PHONE_SWITCH_MESSAGE };
  }

  const extractedId = extractOrderIdFromMessage(userMessage);
  if (!extractedId || extractedId === session.activeOrderId) {
    return { session, switchedOrder: false };
  }
  if (verified.scope === "order") {
    return { session, switchedOrder: false, switchMessage: ORDER_SCOPE_MESSAGE };
  }

  const switched = scopeToOrder(
    verified,
    { found: true, customerName: session.customerName, orders: session.orders, context: session.crmContext },
    extractedId,
  );
  if (!switched) {
    return { session, switchedOrder: false, switchMessage: ORDER_NOT_FOUND_MESSAGE };
  }
  return {
    session: switched,
    switchedOrder: true,
    switchMessage: `Sure! I've pulled up order #${extractedId}. What would you like to know about it?`,
  };
}
