import { db, externalCrmConfigsTable } from "@workspace/db";
import type { ExternalCrmConfig, ExternalCrmResponseMapping } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

// ── Types ──────────────────────────────────────────────────────────────

export interface ExternalCrmContext {
  customerName?: string;
  email?: string;
  accountId?: string;
  recentOrders?: string;
  customerFound?: boolean;
  rawData?: Record<string, unknown>;
  fetchedAt: string;
}

export interface ExternalCrmCallFlowConfig {
  openingPitch?: string | null;
  endingPitch?: string | null;
  unknownCallerPitch?: string | null;
  endingNote?: string | null;
  maxAiInteractionSeconds: number;
  endingNoteLeadSeconds: number;
  callInstructions?: string | null;
  verifyIdentity: boolean;
}

// ── Config cache (per userId, short TTL) ───────────────────────────────

const CONFIG_CACHE_TTL = 60_000;
const configCache = new Map<number, { data: ExternalCrmConfig | null; fetchedAt: number }>();

async function getCachedConfig(userId: number): Promise<ExternalCrmConfig | null> {
  const cached = configCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < CONFIG_CACHE_TTL) return cached.data;

  const config = await db.query.externalCrmConfigsTable.findFirst({
    where: eq(externalCrmConfigsTable.userId, userId),
  });

  configCache.set(userId, { data: config ?? null, fetchedAt: Date.now() });
  return config ?? null;
}

export function invalidateExternalCrmConfigCache(userId: number): void {
  configCache.delete(userId);
}

// ── Data cache (per userId+phone, configurable TTL) ────────────────────

const dataCache = new Map<string, { data: ExternalCrmContext; expiresAt: number }>();

function dataCacheKey(userId: number, phone: string): string {
  return `${userId}:${phone}`;
}

function getCachedData(userId: number, phone: string): ExternalCrmContext | null {
  const key = dataCacheKey(userId, phone);
  const cached = dataCache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    dataCache.delete(key);
    return null;
  }
  return cached.data;
}

function setCachedData(userId: number, phone: string, data: ExternalCrmContext, ttlSeconds: number): void {
  const key = dataCacheKey(userId, phone);
  dataCache.set(key, { data, expiresAt: Date.now() + ttlSeconds * 1000 });
}

// Periodic cleanup to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of dataCache) {
    if (now > entry.expiresAt) dataCache.delete(key);
  }
}, 60_000);

// ── JSON path resolver ─────────────────────────────────────────────────

function resolveJsonPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function stringifyValue(val: unknown): string | undefined {
  if (val == null) return undefined;
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (Array.isArray(val)) {
    return val
      .map((item, i) => {
        if (typeof item === "object" && item !== null) return JSON.stringify(item);
        return String(item);
      })
      .join("; ");
  }
  return JSON.stringify(val);
}

// ── HTTP request builder ───────────────────────────────────────────────

function buildAuthHeaders(config: ExternalCrmConfig): Record<string, string> {
  const headers: Record<string, string> = { "Accept": "application/json" };

  if (!config.authValue) return headers;

  switch (config.authType) {
    case "bearer":
      headers["Authorization"] = `Bearer ${config.authValue}`;
      break;
    case "api_key":
      headers["X-API-Key"] = config.authValue;
      break;
    case "basic":
      headers["Authorization"] = `Basic ${Buffer.from(config.authValue).toString("base64")}`;
      break;
    case "header":
      headers[config.authHeaderName || "X-Auth-Token"] = config.authValue;
      break;
  }

  return headers;
}

async function callExternalCrm(config: ExternalCrmConfig, phone: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    let url = config.lookupUrl;
    const headers = buildAuthHeaders(config);
    let body: string | undefined;

    if (config.phoneParamLocation === "path") {
      url = url.replace(/\{phone\}/g, encodeURIComponent(phone));
    } else if (config.httpMethod === "GET" || config.phoneParamLocation === "query") {
      const separator = url.includes("?") ? "&" : "?";
      url = `${url}${separator}${encodeURIComponent(config.phoneParamName)}=${encodeURIComponent(phone)}`;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({ [config.phoneParamName]: phone });
    }

    const response = await fetch(url, {
      method: config.httpMethod,
      headers,
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn({ status: response.status, url }, "External CRM lookup returned non-OK status");
      return null;
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ── Response mapping ───────────────────────────────────────────────────

function mapResponse(
  responseBody: unknown,
  config: ExternalCrmConfig,
): ExternalCrmContext {
  const mapping = config.responseMapping as ExternalCrmResponseMapping | null;
  const ctx: ExternalCrmContext = { fetchedAt: new Date().toISOString() };

  const foundVal = resolveJsonPath(responseBody, "found");
  if (typeof foundVal === "boolean") {
    ctx.customerFound = foundVal;
  }

  if (config.useRawResponse || !mapping) {
    const raw = typeof responseBody === "object" && responseBody !== null
      ? responseBody as Record<string, unknown>
      : { data: responseBody };
    const serialized = JSON.stringify(raw, null, 2);
    if (serialized.length <= config.maxContextChars) {
      ctx.rawData = raw;
    } else {
      ctx.rawData = { _truncated: true, _preview: serialized.slice(0, config.maxContextChars) };
    }
    return ctx;
  }

  if (mapping.customerName) {
    ctx.customerName = stringifyValue(resolveJsonPath(responseBody, mapping.customerName));
    if (ctx.customerFound === undefined && ctx.customerName) ctx.customerFound = true;
  }
  if (mapping.email) {
    ctx.email = stringifyValue(resolveJsonPath(responseBody, mapping.email));
  }
  if (mapping.accountId) {
    ctx.accountId = stringifyValue(resolveJsonPath(responseBody, mapping.accountId));
  }
  if (mapping.recentOrders) {
    ctx.recentOrders = stringifyValue(resolveJsonPath(responseBody, mapping.recentOrders));
  }

  if (mapping.customFields && mapping.customFields.length > 0) {
    const extra: Record<string, unknown> = {};
    for (const field of mapping.customFields) {
      const val = resolveJsonPath(responseBody, field);
      if (val !== undefined) {
        const label = field.split(".").pop() || field;
        extra[label] = val;
      }
    }
    if (Object.keys(extra).length > 0) {
      ctx.rawData = extra;
    }
  }

  return ctx;
}

// ── Call flow helpers ──────────────────────────────────────────────────

export function extractCallFlowConfig(config: ExternalCrmConfig | null): ExternalCrmCallFlowConfig | null {
  if (!config || !config.isEnabled) return null;
  return {
    openingPitch: config.openingPitch,
    endingPitch: config.endingPitch,
    unknownCallerPitch: config.unknownCallerPitch,
    endingNote: config.endingNote,
    maxAiInteractionSeconds: config.maxAiInteractionSeconds ?? 0,
    endingNoteLeadSeconds: config.endingNoteLeadSeconds ?? 2,
    callInstructions: config.callInstructions,
    verifyIdentity: config.verifyIdentity ?? false,
  };
}

export async function getExternalCrmCallFlow(userId: number): Promise<ExternalCrmCallFlowConfig | null> {
  const config = await getCachedConfig(userId);
  return extractCallFlowConfig(config);
}

export function applyPitchTemplate(
  template: string,
  ctx: ExternalCrmContext | null | undefined,
): string {
  if (!template) return template;

  const vars: Record<string, string> = {
    customerName: ctx?.customerName || "there",
    email: ctx?.email || "",
    accountId: ctx?.accountId || "",
    recentOrders: ctx?.recentOrders || "",
  };

  if (ctx?.rawData) {
    for (const [key, val] of Object.entries(ctx.rawData)) {
      if (key.startsWith("_")) continue;
      vars[key] = typeof val === "object" ? JSON.stringify(val) : String(val);
    }
  }

  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

export function resolveCrmOpeningGreeting(
  callFlow: ExternalCrmCallFlowConfig | null,
  ctx: ExternalCrmContext | null | undefined,
  fallbackGreeting: string,
): string {
  if (!callFlow) return fallbackGreeting;

  const useUnknown = ctx?.customerFound === false && callFlow.unknownCallerPitch;
  const template = useUnknown ? callFlow.unknownCallerPitch : callFlow.openingPitch;
  if (template?.trim()) {
    return applyPitchTemplate(template, ctx);
  }

  return fallbackGreeting;
}

// ── Main entry point ───────────────────────────────────────────────────

export async function fetchExternalCrmData(
  userId: number,
  phone: string,
): Promise<ExternalCrmContext | null> {
  try {
    const config = await getCachedConfig(userId);
    if (!config || !config.isEnabled) return null;

    const cached = getCachedData(userId, phone);
    if (cached) {
      logger.debug({ userId, phone }, "External CRM data served from cache");
      return cached;
    }

    const responseBody = await callExternalCrm(config, phone);
    if (responseBody == null) return null;

    const ctx = mapResponse(responseBody, config);

    setCachedData(userId, phone, ctx, config.cacheTtlSeconds);
    logger.info({ userId, phone, hasName: !!ctx.customerName }, "External CRM data fetched successfully");

    return ctx;
  } catch (err: any) {
    if (err.name === "AbortError") {
      logger.warn({ userId, phone }, "External CRM lookup timed out");
    } else {
      logger.error({ err, userId, phone }, "External CRM lookup failed");
    }
    return null;
  }
}

export async function testExternalCrmLookup(
  userId: number,
  phone: string,
): Promise<{ success: boolean; context?: ExternalCrmContext; error?: string; rawResponse?: unknown }> {
  try {
    const config = await db.query.externalCrmConfigsTable.findFirst({
      where: eq(externalCrmConfigsTable.userId, userId),
    });

    if (!config) {
      return { success: false, error: "No external CRM configuration found" };
    }

    const responseBody = await callExternalCrm(config, phone);
    if (responseBody == null) {
      return { success: false, error: "CRM returned empty or non-OK response" };
    }

    const ctx = mapResponse(responseBody, config);

    return {
      success: true,
      context: ctx,
      rawResponse: responseBody,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.name === "AbortError" ? "Request timed out" : err.message,
    };
  }
}
