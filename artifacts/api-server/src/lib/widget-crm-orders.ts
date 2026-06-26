import { db, externalCrmConfigsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  type ExternalCrmContext,
  invalidateExternalCrmConfigCache,
} from "./external-crm-lookup";

export interface CrmOrder {
  orderId: string;
  status?: string;
  products?: string;
  total?: string;
  paymentStatus?: string;
  rxStatus?: string;
  rxValidUntil?: string;
  doctor?: string;
  trackingId?: string | null;
  placedAt?: string;
  [key: string]: unknown;
}

export function normalizePhoneNumber(phone: string): string {
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("91") && digits.length === 12) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length === 11) digits = digits.slice(1);
  return digits;
}

export function normalizeOrderId(orderId: string): string {
  return String(orderId).trim().replace(/^#/, "").replace(/\s+/g, "");
}

export function extractOrderIdFromMessage(message: string): string | null {
  const trimmed = message.trim();
  // Explicit patterns: "order 25173", "#25173", "order id 25173"
  const explicit = trimmed.match(/(?:order\s*(?:id|#)?|#)\s*(\d{4,})/i);
  if (explicit) return normalizeOrderId(explicit[1]);

  // Bare numeric ID (4+ digits) when message is short
  if (/^\d{4,}$/.test(trimmed)) return normalizeOrderId(trimmed);

  return null;
}

function resolveJsonPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function coerceOrder(raw: unknown): CrmOrder | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const orderId = obj.orderId ?? obj.order_id ?? obj.id;
  if (orderId == null) return null;
  return {
    orderId: String(orderId),
    status: obj.status != null ? String(obj.status) : undefined,
    products: obj.products != null ? String(obj.products) : undefined,
    total: obj.total != null ? String(obj.total) : undefined,
    paymentStatus: obj.paymentStatus != null ? String(obj.paymentStatus) : undefined,
    rxStatus: obj.rxStatus != null ? String(obj.rxStatus) : undefined,
    rxValidUntil: obj.rxValidUntil != null ? String(obj.rxValidUntil) : undefined,
    doctor: obj.doctor != null ? String(obj.doctor) : undefined,
    trackingId: obj.trackingId != null ? (obj.trackingId as string | null) : undefined,
    placedAt: obj.placedAt != null ? String(obj.placedAt) : undefined,
  };
}

function parseOrdersFromResponse(responseBody: unknown): CrmOrder[] {
  if (!responseBody || typeof responseBody !== "object") return [];
  const body = responseBody as Record<string, unknown>;

  const candidates: unknown[] = [];
  if (Array.isArray(body.recentOrders)) candidates.push(...body.recentOrders);
  if (Array.isArray(body.orders)) candidates.push(...body.orders);
  if (body.customer && typeof body.customer === "object") {
    const cust = body.customer as Record<string, unknown>;
    if (Array.isArray(cust.recentOrders)) candidates.push(...cust.recentOrders);
    if (Array.isArray(cust.orders)) candidates.push(...cust.orders);
  }

  const orders: CrmOrder[] = [];
  for (const item of candidates) {
    const order = coerceOrder(item);
    if (order) orders.push(order);
  }
  return orders;
}

async function callExternalCrmRaw(userId: number, phone: string): Promise<{
  responseBody: unknown;
  context: ExternalCrmContext | null;
  found: boolean;
  customerName?: string;
  email?: string;
}> {
  const config = await db.query.externalCrmConfigsTable.findFirst({
    where: eq(externalCrmConfigsTable.userId, userId),
  });
  if (!config || !config.isEnabled) {
    return { responseBody: null, context: null, found: false };
  }

  // Re-use fetch via dynamic import of internal lookup — call CRM directly here
  const { fetchExternalCrmData } = await import("./external-crm-lookup");
  const context = await fetchExternalCrmData(userId, phone);

  // For order parsing we need raw body — duplicate minimal fetch
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  let responseBody: unknown = null;
  try {
    let url = config.lookupUrl;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (config.authValue) {
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
    }

    if (config.phoneParamLocation === "path") {
      url = url.replace(/\{phone\}/g, encodeURIComponent(phone));
    } else if (config.httpMethod === "GET" || config.phoneParamLocation === "query") {
      const separator = url.includes("?") ? "&" : "?";
      url = `${url}${separator}${encodeURIComponent(config.phoneParamName)}=${encodeURIComponent(phone)}`;
    }

    const response = await fetch(url, {
      method: config.httpMethod,
      headers,
      body: config.httpMethod !== "GET" && config.phoneParamLocation === "body"
        ? JSON.stringify({ [config.phoneParamName]: phone })
        : undefined,
      signal: controller.signal,
    });

    if (response.ok) {
      responseBody = await response.json();
    }
  } catch {
    // fall through — use mapped context only
  } finally {
    clearTimeout(timeout);
  }

  const foundVal = responseBody && typeof responseBody === "object"
    ? (responseBody as Record<string, unknown>).found
    : undefined;
  const found = typeof foundVal === "boolean" ? foundVal : !!(context?.customerFound ?? context?.customerName);

  const mapping = config.responseMapping;
  let customerName = context?.customerName;
  let email = context?.email;
  if (responseBody && mapping) {
    const namePath = mapping.customerName ?? "customer.name";
    const emailPath = mapping.email ?? "customer.email";
    const nameVal = resolveJsonPath(responseBody, namePath);
    const emailVal = resolveJsonPath(responseBody, emailPath);
    if (nameVal) customerName = String(nameVal);
    if (emailVal) email = String(emailVal);
  } else if (responseBody) {
    const cust = resolveJsonPath(responseBody, "customer");
    if (cust && typeof cust === "object") {
      const c = cust as Record<string, unknown>;
      if (c.name) customerName = String(c.name);
      if (c.email) email = String(c.email);
    }
  }

  return { responseBody, context, found, customerName, email };
}

export async function fetchCrmCustomerWithOrders(
  userId: number,
  phone: string,
): Promise<{
  found: boolean;
  customerName?: string;
  email?: string;
  orders: CrmOrder[];
  context: ExternalCrmContext;
}> {
  const normalizedPhone = normalizePhoneNumber(phone);
  const { responseBody, context, found, customerName, email } = await callExternalCrmRaw(userId, normalizedPhone);

  let orders = parseOrdersFromResponse(responseBody);
  if (orders.length === 0 && context?.rawData) {
    orders = parseOrdersFromResponse(context.rawData);
  }

  const emptyContext: ExternalCrmContext = context ?? { fetchedAt: new Date().toISOString(), customerFound: false };

  return {
    found: found && orders.length > 0,
    customerName,
    email,
    orders,
    context: {
      ...emptyContext,
      customerName: customerName ?? emptyContext.customerName,
      email: email ?? emptyContext.email,
      customerFound: found,
    },
  };
}

export function buildOrderScopedContext(
  baseContext: ExternalCrmContext,
  activeOrder: CrmOrder,
  allOrders: CrmOrder[],
): ExternalCrmContext {
  const otherIds = allOrders
    .map(o => normalizeOrderId(o.orderId))
    .filter(id => id !== normalizeOrderId(activeOrder.orderId));

  return {
    ...baseContext,
    recentOrders: JSON.stringify(activeOrder, null, 2),
    rawData: {
      activeOrder,
      otherOrderIds: otherIds,
      totalOrdersOnAccount: allOrders.length,
    },
    fetchedAt: new Date().toISOString(),
  };
}

export function appendCrmContextToWidgetPrompt(
  system: string,
  crmContext: ExternalCrmContext,
  activeOrderId: string,
  customerName?: string,
): string {
  system += `CUSTOMER CONTEXT (verified via CRM — phone number authenticated):\n`;
  if (customerName || crmContext.customerName) {
    system += `• Customer Name: ${customerName || crmContext.customerName}\n`;
  }
  if (crmContext.email) system += `• Email: ${crmContext.email}\n`;
  if (crmContext.recentOrders) {
    system += `• Active Order (#${activeOrderId}) details:\n${crmContext.recentOrders}\n`;
  }
  if (crmContext.rawData && typeof crmContext.rawData === "object") {
    const raw = crmContext.rawData as Record<string, unknown>;
    if (Array.isArray(raw.otherOrderIds) && raw.otherOrderIds.length > 0) {
      system += `• Other order IDs on this account (details NOT loaded): ${(raw.otherOrderIds as string[]).map(id => `#${id}`).join(", ")}\n`;
    }
  }
  system += `\nSECURITY RULES (MANDATORY):\n`;
  system += `• The customer has been verified by phone number. ONLY discuss orders belonging to this verified account.\n`;
  system += `• You are currently helping with order #${activeOrderId}. Answer questions about THIS order using the data above.\n`;
  system += `• If the customer asks about a different order, ask for the order ID first. Only discuss orders that exist on their account.\n`;
  system += `• NEVER reveal details of orders that don't belong to this verified phone number.\n`;
  system += `• NEVER invent order information — only use data explicitly provided above.\n`;
  system += `• Match order IDs EXACTLY. If an order ID is not in the account, say you cannot find it.\n\n`;
  return system;
}

// Re-export for cache invalidation consistency
export { invalidateExternalCrmConfigCache };
