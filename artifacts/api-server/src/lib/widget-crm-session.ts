import crypto from "crypto";
import {
  type ExternalCrmContext,
} from "./external-crm-lookup";
import {
  buildOrderScopedContext,
  extractOrderIdFromInput,
  extractOrderIdFromMessage,
  extractPhoneFromMessage,
  fetchCrmCustomerWithOrders,
  maskPhoneForDisplay,
  normalizeOrderId,
  normalizePhoneNumber,
  type CrmOrder,
} from "./widget-crm-orders";

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const PENDING_TTL_MS = 15 * 60 * 1000; // 15 min — waiting for order ID after phone verify

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

export interface WidgetCrmPendingSession {
  userId: number;
  phone: string;
  customerName?: string;
  orderIds: string[];
  orders: CrmOrder[];
  createdAt: number;
  expiresAt: number;
}

export type CrmChatResolution = {
  session: WidgetCrmSession | null;
  switchedOrder: boolean;
  switchedPhone: boolean;
  switchMessage?: string;
  pendingToken?: string;
  clearSession?: boolean;
};

function getSigningSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is required for widget CRM sessions");
  return secret;
}

function signPayload(payload: string): string {
  return crypto.createHmac("sha256", getSigningSecret()).update(payload).digest("base64url");
}

export function createWidgetCrmPendingToken(
  session: Omit<WidgetCrmPendingSession, "createdAt" | "expiresAt">,
): string {
  const createdAt = Date.now();
  const expiresAt = createdAt + PENDING_TTL_MS;
  const body = { ...session, createdAt, expiresAt, kind: "pending" as const };
  const encoded = Buffer.from(JSON.stringify(body)).toString("base64url");
  const sig = signPayload(encoded);
  return `${encoded}.${sig}`;
}

export function verifyWidgetCrmPendingToken(token: string): WidgetCrmPendingSession | null {
  try {
    const [encoded, sig] = token.split(".");
    if (!encoded || !sig) return null;
    const expected = signPayload(encoded);
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (parsed.kind !== "pending") return null;
    if (!parsed.expiresAt || Date.now() > parsed.expiresAt) return null;
    if (!parsed.userId || !parsed.phone) return null;
    return parsed as WidgetCrmPendingSession;
  } catch {
    return null;
  }
}

export async function handlePendingPhoneChat(
  userId: number,
  pending: WidgetCrmPendingSession,
  message: string,
): Promise<{
  completed: boolean;
  message: string;
  sessionToken?: string;
  pendingToken?: string;
}> {
  const newPhone = extractPhoneFromMessage(message, pending.phone);
  if (newPhone && newPhone !== normalizePhoneNumber(pending.phone)) {
    const verification = await verifyWidgetCrmPhone(userId, newPhone);
    if (!verification.success) {
      return { completed: false, message: verification.message, pendingToken: createWidgetCrmPendingToken(pending) };
    }
    const customer = await fetchCrmCustomerWithOrders(userId, newPhone);
    const refreshed: WidgetCrmPendingSession = {
      userId,
      phone: normalizePhoneNumber(newPhone),
      customerName: customer.customerName,
      orderIds: customer.orders.map(o => normalizeOrderId(o.orderId)),
      orders: customer.orders,
      createdAt: Date.now(),
      expiresAt: Date.now() + PENDING_TTL_MS,
    };
    return {
      completed: false,
      message: `I've verified phone number ${maskPhoneForDisplay(newPhone)}. Please enter the order ID for this number.`,
      pendingToken: createWidgetCrmPendingToken(refreshed),
    };
  }

  const orderId = extractOrderIdFromInput(message);
  if (!orderId) {
    return {
      completed: false,
      message: `Please enter the order ID for phone number ${maskPhoneForDisplay(pending.phone)}.`,
      pendingToken: createWidgetCrmPendingToken(pending),
    };
  }

  const result = await verifyWidgetCrmOrder(userId, pending.phone, orderId);
  if (!result.success) {
    return {
      completed: false,
      message: result.message,
      pendingToken: createWidgetCrmPendingToken(pending),
    };
  }

  return {
    completed: true,
    message: result.greeting ?? result.message,
    sessionToken: result.sessionToken,
  };
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

  if (!normalizedOrderId || !/^\d{4,9}$/.test(normalizedOrderId)) {
    return { success: false, message: "Please enter a valid order ID (e.g. 25215). Phone numbers cannot be used as order IDs." };
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
): Promise<CrmChatResolution> {
  const newPhone = extractPhoneFromMessage(userMessage, session.phone);
  if (newPhone && newPhone !== normalizePhoneNumber(session.phone)) {
    const verification = await verifyWidgetCrmPhone(userId, newPhone);
    if (!verification.success) {
      return { session, switchedOrder: false, switchedPhone: true, switchMessage: verification.message };
    }
    const customer = await fetchCrmCustomerWithOrders(userId, newPhone);
    const pendingToken = createWidgetCrmPendingToken({
      userId,
      phone: newPhone,
      customerName: customer.customerName,
      orderIds: customer.orders.map(o => normalizeOrderId(o.orderId)),
      orders: customer.orders,
    });
    return {
      session: null,
      switchedOrder: false,
      switchedPhone: true,
      clearSession: true,
      pendingToken,
      switchMessage: `I've verified phone number ${maskPhoneForDisplay(newPhone)}. Please enter the order ID for this number.`,
    };
  }

  const extractedId = extractOrderIdFromMessage(userMessage);
  if (!extractedId || extractedId === session.activeOrderId) {
    return { session, switchedOrder: false, switchedPhone: false };
  }

  if (!session.orderIds.includes(extractedId)) {
    return {
      session,
      switchedOrder: false,
      switchedPhone: false,
      switchMessage: `I couldn't find order #${extractedId} on the account linked to ${maskPhoneForDisplay(session.phone)}. Please provide a valid order ID for this phone number, or share a different registered phone number.`,
    };
  }

  const refreshed = refreshSessionOrderScope(session, extractedId);
  if (!refreshed) {
    return { session, switchedOrder: false, switchedPhone: false };
  }

  return {
    session: refreshed,
    switchedOrder: true,
    switchedPhone: false,
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
