import crypto from "crypto";
import {
  type ExternalCrmContext,
} from "./external-crm-lookup";
import {
  buildOrderScopedContext,
  extractOrderIdFromInput,
  extractOrderIdFromMessage,
  fetchCrmCustomerWithOrders,
  normalizeOrderId,
  normalizePhoneNumber,
  type CrmOrder,
} from "./widget-crm-orders";

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface WidgetCrmSession {
  userId: number;
  phone: string;
  customerName?: string;
  activeOrderId: string;
  orderIds: string[];
  orders: CrmOrder[];
  crmContext: ExternalCrmContext;
  createdAt: number;
  expiresAt: number;
}

function getSigningSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is required for widget CRM sessions");
  return secret;
}

function signPayload(payload: string): string {
  return crypto.createHmac("sha256", getSigningSecret()).update(payload).digest("base64url");
}

export function createWidgetCrmSessionToken(session: Omit<WidgetCrmSession, "createdAt" | "expiresAt">): string {
  const createdAt = Date.now();
  const expiresAt = createdAt + SESSION_TTL_MS;
  const body = {
    userId: session.userId,
    phone: session.phone,
    customerName: session.customerName ?? "",
    activeOrderId: session.activeOrderId,
    orderIds: session.orderIds,
    orders: session.orders,
    crmContext: session.crmContext,
    createdAt,
    expiresAt,
  };
  const encoded = Buffer.from(JSON.stringify(body)).toString("base64url");
  const sig = signPayload(encoded);
  return `${encoded}.${sig}`;
}

export function verifyWidgetCrmSessionToken(token: string): WidgetCrmSession | null {
  try {
    const [encoded, sig] = token.split(".");
    if (!encoded || !sig) return null;
    const expected = signPayload(encoded);
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as WidgetCrmSession;
    if (!parsed.expiresAt || Date.now() > parsed.expiresAt) return null;
    if (!parsed.userId || !parsed.phone || !parsed.activeOrderId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function refreshSessionOrderScope(
  session: WidgetCrmSession,
  orderId: string,
): WidgetCrmSession | null {
  const normalized = normalizeOrderId(orderId);
  if (!session.orderIds.includes(normalized)) return null;
  const order = session.orders.find(o => normalizeOrderId(o.orderId) === normalized);
  if (!order) return null;
  return {
    ...session,
    activeOrderId: normalized,
    crmContext: buildOrderScopedContext(session.crmContext, order, session.orders),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
}

export async function verifyWidgetCrmPhone(
  userId: number,
  phone: string,
): Promise<{
  success: boolean;
  customerName?: string;
  orderIds: string[];
  message: string;
}> {
  const normalizedPhone = normalizePhoneNumber(phone);
  if (normalizedPhone.length < 10) {
    return { success: false, orderIds: [], message: "Please enter a valid phone number." };
  }

  const customer = await fetchCrmCustomerWithOrders(userId, normalizedPhone);
  if (!customer.found || customer.orders.length === 0) {
    return {
      success: false,
      orderIds: [],
      message: "We couldn't find any orders linked to this phone number. Please check the number and try again.",
    };
  }

  const orderIds = customer.orders.map(o => normalizeOrderId(o.orderId));

  // Do NOT reveal order count or order IDs before order verification
  return {
    success: true,
    customerName: customer.customerName,
    orderIds,
    message: "Your phone number is verified. Please enter your order ID to continue.",
  };
}

export async function verifyWidgetCrmOrder(
  userId: number,
  phone: string,
  orderId: string,
): Promise<{
  success: boolean;
  sessionToken?: string;
  greeting?: string;
  customerName?: string;
  orderId?: string;
  message: string;
}> {
  const normalizedPhone = normalizePhoneNumber(phone);
  const parsedOrderId = extractOrderIdFromInput(orderId);
  const normalizedOrderId = parsedOrderId ?? normalizeOrderId(orderId);

  if (!normalizedOrderId || !/^\d{4,}$/.test(normalizedOrderId)) {
    return { success: false, message: "Please enter a valid order ID (e.g. 25215)." };
  }

  const customer = await fetchCrmCustomerWithOrders(userId, normalizedPhone);
  if (!customer.found) {
    return { success: false, message: "Phone number not found. Please start again with your registered phone number." };
  }

  const order = customer.orders.find(o => normalizeOrderId(o.orderId) === normalizedOrderId);
  if (!order) {
    return {
      success: false,
      message: `Order #${normalizedOrderId} was not found on your account. Please check the order ID and try again.`,
    };
  }

  const scopedContext = buildOrderScopedContext(customer.context, order, customer.orders);
  const orderIds = customer.orders.map(o => normalizeOrderId(o.orderId));
  const displayName = customer.customerName?.trim() || "there";

  const sessionToken = createWidgetCrmSessionToken({
    userId,
    phone: normalizedPhone,
    customerName: customer.customerName,
    activeOrderId: normalizedOrderId,
    orderIds,
    orders: customer.orders,
    crmContext: scopedContext,
  });

  const greeting = `Hello ${displayName}, how can I help you with your order #${normalizedOrderId}?`;

  return {
    success: true,
    sessionToken,
    greeting,
    customerName: customer.customerName,
    orderId: normalizedOrderId,
    message: greeting,
  };
}

export async function resolveWidgetCrmSessionForChat(
  userId: number,
  session: WidgetCrmSession,
  userMessage: string,
): Promise<{ session: WidgetCrmSession; switchedOrder: boolean; switchMessage?: string }> {
  const extractedId = extractOrderIdFromMessage(userMessage);
  if (!extractedId || extractedId === session.activeOrderId) {
    return { session, switchedOrder: false };
  }

  if (!session.orderIds.includes(extractedId)) {
    return {
      session,
      switchedOrder: false,
      switchMessage: `I couldn't find order #${extractedId} on your account. Please provide an order ID linked to your registered phone number.`,
    };
  }

  const refreshed = refreshSessionOrderScope(session, extractedId);
  if (!refreshed) {
    return { session, switchedOrder: false };
  }

  return {
    session: refreshed,
    switchedOrder: true,
    switchMessage: `Sure! I've pulled up order #${extractedId}. What would you like to know about it?`,
  };
}

export async function isWidgetCrmActive(userId: number, widgetExternalCrmEnabled: boolean): Promise<boolean> {
  if (!widgetExternalCrmEnabled) return false;
  const { db, externalCrmConfigsTable } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  const config = await db.query.externalCrmConfigsTable.findFirst({
    where: eq(externalCrmConfigsTable.userId, userId),
  });
  return !!(config?.isEnabled && config.lookupUrl);
}
