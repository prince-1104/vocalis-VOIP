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
  cancellationReason?: string;
  [key: string]: unknown;
}

const CANCELLATION_REASON_KEYS = [
  "cancellationReason",
  "cancellation_reason",
  "cancelReason",
  "cancel_reason",
  "cancelledBecause",
  "cancelled_because",
  "cancelledReason",
  "cancelled_reason",
  "denialReason",
  "denial_reason",
  "deniedReason",
  "denied_reason",
  "rejectionReason",
  "rejection_reason",
  "cancelNote",
  "cancel_note",
  "cancellationNote",
  "cancellation_note",
  "reason",
] as const;

function extractCancellationReason(obj: Record<string, unknown>): string | undefined {
  for (const key of CANCELLATION_REASON_KEYS) {
    const val = obj[key];
    if (val != null && String(val).trim()) return String(val).trim();
  }
  return undefined;
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

/** Extract a numeric order ID from free-form user input (e.g. "tell me about orderid 25215"). */
export function extractOrderIdFromInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Never treat a phone number as an order ID
  if (extractPhoneFromMessage(trimmed)) return null;

  // Explicit order-id patterns
  const explicitOrder = trimmed.match(/(?:order\s*(?:id|#)?|orderid|order\s*no\.?|#)\s*(\d{4,})/i);
  if (explicitOrder) {
    const id = normalizeOrderId(explicitOrder[1]);
    if (id.length < 10) return id;
  }

  // Bare short numeric input (typical order ID: 4–9 digits)
  if (/^#?\d{4,9}$/.test(trimmed)) return normalizeOrderId(trimmed);

  // Embedded 4–9 digit number (not a 10-digit phone)
  const shortNum = trimmed.match(/\b(\d{4,9})\b/);
  if (shortNum) return normalizeOrderId(shortNum[1]);

  return null;
}

/** Detect a phone number in natural language (e.g. "detail for this no 8328258683"). */
export function extractPhoneFromMessage(message: string, currentPhone?: string): string | null {
  const trimmed = message.trim();
  if (!trimmed) return null;

  const currentNorm = currentPhone ? normalizePhoneNumber(currentPhone) : null;

  const phoneIntent =
    /\b(phone|mobile|number|contact|whatsapp|call)\b/i.test(trimmed) ||
    /\b(?:this|another|different|other|new)\s+(?:no|number|phone|mobile)\b/i.test(trimmed) ||
    /detail(?:s)?\s+for\s+(?:this\s+)?(?:no|number|phone)/i.test(trimmed) ||
    /(?:no|number|phone|mobile)\s*[.:]?\s*\d/i.test(trimmed);

  const candidates: string[] = [];
  const patterns = [
    /(?:\+?91[\s-]?)?([6-9]\d{9})\b/g,
    /\b(\d{10})\b/g,
    /(?:phone|mobile|number|no\.?|contact)\s*[.:]?\s*([+\d][\d\s\-]{8,14}\d)/gi,
  ];

  for (const re of patterns) {
    let m: RegExpExecArray | null;
    const regex = new RegExp(re.source, re.flags);
    while ((m = regex.exec(trimmed)) !== null) {
      const normalized = normalizePhoneNumber(m[1] ?? m[0]);
      if (normalized.length === 10) candidates.push(normalized);
    }
  }

  if (candidates.length === 0) return null;

  for (const phone of candidates) {
    if (phoneIntent) return phone;
    if (currentNorm && phone !== currentNorm) return phone;
  }

  // Bare 10-digit message with no other text
  const bareDigits = trimmed.replace(/\D/g, "");
  if (/^[\d\s+\-().]+$/.test(trimmed) && bareDigits.length === 10) {
    return normalizePhoneNumber(bareDigits);
  }

  return null;
}

export function maskPhoneForDisplay(phone: string): string {
  const n = normalizePhoneNumber(phone);
  if (n.length !== 10) return phone;
  return `${n.slice(0, 2)}****${n.slice(6)}`;
}

export function extractOrderIdFromMessage(message: string): string | null {
  return extractOrderIdFromInput(message);
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
  const orderId = obj.orderId ?? obj.order_id ?? obj.id ?? obj.orderNo ?? obj.order_no;
  if (orderId == null) return null;

  const cancellationReason = extractCancellationReason(obj);

  const order: CrmOrder = {
    orderId: String(orderId),
    status: obj.status != null ? String(obj.status) : undefined,
    cancellationReason,
    products: (obj.products ?? obj.product ?? obj.items ?? obj.productName) != null
      ? String(obj.products ?? obj.product ?? obj.items ?? obj.productName)
      : undefined,
    total: (obj.total ?? obj.amount ?? obj.orderTotal) != null
      ? String(obj.total ?? obj.amount ?? obj.orderTotal)
      : undefined,
    paymentStatus: (obj.paymentStatus ?? obj.payment_status) != null
      ? String(obj.paymentStatus ?? obj.payment_status)
      : undefined,
    rxStatus: (obj.rxStatus ?? obj.rx_status ?? obj.prescriptionStatus) != null
      ? String(obj.rxStatus ?? obj.rx_status ?? obj.prescriptionStatus)
      : undefined,
    rxValidUntil: (obj.rxValidUntil ?? obj.rx_valid_until) != null
      ? String(obj.rxValidUntil ?? obj.rx_valid_until)
      : undefined,
    doctor: (obj.doctor ?? obj.assignedDoctor ?? obj.assigned_doctor ?? obj.prescribingDoctor) != null
      ? String(obj.doctor ?? obj.assignedDoctor ?? obj.assigned_doctor ?? obj.prescribingDoctor)
      : undefined,
    trackingId: (obj.trackingId ?? obj.tracking_id ?? obj.trackingNumber) != null
      ? String(obj.trackingId ?? obj.tracking_id ?? obj.trackingNumber)
      : undefined,
    placedAt: (obj.placedAt ?? obj.placed_at ?? obj.orderDate ?? obj.createdAt) != null
      ? String(obj.placedAt ?? obj.placed_at ?? obj.orderDate ?? obj.createdAt)
      : undefined,
  };

  // Preserve any extra CRM fields so the AI can answer about them
  for (const [key, val] of Object.entries(obj)) {
    if (key in order || CANCELLATION_REASON_KEYS.includes(key as typeof CANCELLATION_REASON_KEYS[number]) || val == null) continue;
    if (typeof val === "object") {
      order[key] = JSON.stringify(val);
    } else {
      order[key] = val;
    }
  }

  return order;
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
  customerDoctor?: string;
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
  const found = typeof foundVal === "boolean"
    ? foundVal
    : !!(context?.customerFound ?? context?.customerName) || parseOrdersFromResponse(responseBody).length > 0;

  const extracted = extractCustomerFromResponse(responseBody, config.responseMapping);
  const customerName = extracted.customerName ?? context?.customerName;
  const email = extracted.email ?? context?.email;

  return { responseBody, context, found, customerName, email, customerDoctor: extracted.doctor };
}

function extractCustomerFromResponse(
  responseBody: unknown,
  mapping?: { customerName?: string; email?: string } | null,
): { customerName?: string; email?: string; doctor?: string } {
  if (!responseBody || typeof responseBody !== "object") return {};

  const namePaths = [
    mapping?.customerName,
    "customer.name",
    "customer.fullName",
    "customer.full_name",
    "data.customer.name",
    "name",
  ].filter((p): p is string => !!p && p.trim().length > 0);

  const emailPaths = [
    mapping?.email,
    "customer.email",
    "data.customer.email",
    "email",
  ].filter((p): p is string => !!p && p.trim().length > 0);

  const doctorPaths = [
    "customer.doctor",
    "customer.assignedDoctor",
    "doctor",
  ];

  let customerName: string | undefined;
  for (const path of namePaths) {
    const val = resolveJsonPath(responseBody, path);
    if (val != null && String(val).trim()) {
      customerName = String(val).trim();
      break;
    }
  }

  let email: string | undefined;
  for (const path of emailPaths) {
    const val = resolveJsonPath(responseBody, path);
    if (val != null && String(val).trim()) {
      email = String(val).trim();
      break;
    }
  }

  let doctor: string | undefined;
  for (const path of doctorPaths) {
    const val = resolveJsonPath(responseBody, path);
    if (val != null && String(val).trim()) {
      doctor = String(val).trim();
      break;
    }
  }

  return { customerName, email, doctor };
}

export async function fetchCrmCustomerWithOrders(
  userId: number,
  phone: string,
): Promise<{
  found: boolean;
  customerName?: string;
  email?: string;
  customerDoctor?: string;
  orders: CrmOrder[];
  context: ExternalCrmContext;
}> {
  const normalizedPhone = normalizePhoneNumber(phone);
  const { responseBody, context, found, customerName, email, customerDoctor } = await callExternalCrmRaw(userId, normalizedPhone);

  let orders = parseOrdersFromResponse(responseBody);
  if (orders.length === 0 && context?.rawData) {
    orders = parseOrdersFromResponse(context.rawData);
    // Also try recentOrders nested in raw truncated preview
    if (orders.length === 0 && typeof context.rawData === "object") {
      const raw = context.rawData as Record<string, unknown>;
      if (Array.isArray(raw.recentOrders)) {
        for (const item of raw.recentOrders) {
          const o = coerceOrder(item);
          if (o) orders.push(o);
        }
      }
    }
  }

  const emptyContext: ExternalCrmContext = context ?? { fetchedAt: new Date().toISOString(), customerFound: false };
  const hasOrders = orders.length > 0;

  return {
    found: (found || hasOrders) && hasOrders,
    customerName,
    email,
    customerDoctor,
    orders,
    context: {
      ...emptyContext,
      customerName: customerName ?? emptyContext.customerName,
      email: email ?? emptyContext.email,
      customerFound: found || hasOrders,
      rawData: {
        ...(typeof emptyContext.rawData === "object" ? emptyContext.rawData as object : {}),
        ...(customerDoctor ? { accountDoctor: customerDoctor } : {}),
      },
    },
  };
}

export function formatOrderForPrompt(order: CrmOrder): string {
  const lines: string[] = [];
  const labelMap: Record<string, string> = {
    orderId: "Order ID",
    status: "Status",
    cancellationReason: "Cancellation / Denial Reason",
    products: "Products / Items",
    total: "Order Total",
    paymentStatus: "Payment Status",
    rxStatus: "Prescription Status",
    rxValidUntil: "Prescription Valid Until",
    doctor: "Assigned Doctor",
    trackingId: "Tracking ID",
    placedAt: "Placed Date",
  };
  for (const [key, label] of Object.entries(labelMap)) {
    const val = order[key];
    if (val != null && String(val).trim() !== "") {
      lines.push(`  - ${label}: ${val}`);
    }
  }
  // Any extra CRM fields
  for (const [key, val] of Object.entries(order)) {
    if (labelMap[key] || val == null || String(val).trim() === "") continue;
    lines.push(`  - ${key}: ${typeof val === "object" ? JSON.stringify(val) : val}`);
  }
  return lines.join("\n");
}

export function buildOrderScopedContext(
  baseContext: ExternalCrmContext,
  activeOrder: CrmOrder,
  allOrders: CrmOrder[],
): ExternalCrmContext {
  const formattedOrder = formatOrderForPrompt(activeOrder);

  return {
    ...baseContext,
    recentOrders: formattedOrder,
    rawData: {
      activeOrder,
      // Do NOT expose other order IDs to the AI — prevents leaking order lists in chat
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
  const name = customerName || crmContext.customerName;
  system += `CUSTOMER CONTEXT (verified via CRM — phone number and order ID authenticated):\n`;
  if (name) system += `• Customer Name: ${name}\n`;
  if (crmContext.email) system += `• Email: ${crmContext.email}\n`;
  if (crmContext.rawData && typeof crmContext.rawData === "object") {
    const raw = crmContext.rawData as Record<string, unknown>;
    if (raw.accountDoctor) system += `• Account Doctor: ${raw.accountDoctor}\n`;
  }
  if (crmContext.recentOrders) {
    system += `• Verified Order #${activeOrderId} — USE THIS DATA to answer questions:\n${crmContext.recentOrders}\n`;
  }
  system += `\nCRM DATA RULES (MANDATORY):\n`;
  system += `• You HAVE the verified order details above. Answer questions about products/items, doctor, status, tracking, payment, prescription, and cancellation/denial reasons USING THIS DATA.\n`;
  system += `• NEVER say you "can't provide" or "don't have access to" information that is listed above.\n`;
  system += `• If the order Status is denied, cancelled, or rejected and "Cancellation / Denial Reason" is listed above, you MUST explain that reason when the customer asks why (e.g. underage, prescription issue, payment failed).\n`;
  system += `• NEVER say the denial/cancellation reason is unspecified when "Cancellation / Denial Reason" appears in the verified order data above.\n`;
  system += `• If a specific field is missing from the data above, say that detail is not available in our system for this order.\n`;
  system += `• You are helping with order #${activeOrderId} only. If the customer asks about a DIFFERENT order, ask them to provide that order ID first.\n`;
  system += `• NEVER reveal other customers' data. NEVER invent order information.\n\n`;
  return system;
}

// Re-export for cache invalidation consistency
export { invalidateExternalCrmConfigCache };
