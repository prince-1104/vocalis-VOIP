import { logger } from "../logger";

export type ExotelRegion = "singapore" | "mumbai";

export interface ExotelCredentials {
  accountSid: string;
  apiKey: string;
  apiToken: string;
  exophone: string;
  region: ExotelRegion;
  appFlowUrl: string;
}

export function getExotelApiHost(region: ExotelRegion): string {
  return region === "mumbai" ? "api.in.exotel.com" : "api.exotel.com";
}

function authHeader(apiKey: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${apiKey}:${apiToken}`).toString("base64")}`;
}

export interface ExotelConnectParams {
  credentials: ExotelCredentials;
  customerPhone: string;
  statusCallbackUrl: string;
  customField?: string;
  timeLimitSec?: number;
  timeOutSec?: number;
}

export interface ExotelConnectResult {
  callSid: string;
  status: string;
  raw: unknown;
}

/** Place outbound call — customer is dialed first, then routed to the configured ExoML flow (AI voicebot). */
export async function exotelConnectToFlow(params: ExotelConnectParams): Promise<ExotelConnectResult> {
  const { credentials, customerPhone, statusCallbackUrl, customField, timeLimitSec, timeOutSec } = params;
  const host = getExotelApiHost(credentials.region);
  const url = `https://${host}/v1/Accounts/${credentials.accountSid}/Calls/connect.json`;

  const body = new URLSearchParams();
  body.set("From", customerPhone);
  body.set("CallerId", credentials.exophone);
  body.set("Url", credentials.appFlowUrl);
  body.set("CallType", "trans");
  body.set("StatusCallback", statusCallbackUrl);
  body.set("StatusCallbackEvents[0]", "terminal");
  body.set("StatusCallbackEvents[1]", "answered");
  body.set("StatusCallbackContentType", "application/json");
  if (customField) body.set("CustomField", customField.slice(0, 128));
  if (timeLimitSec) body.set("TimeLimit", String(timeLimitSec));
  if (timeOutSec) body.set("TimeOut", String(timeOutSec));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader(credentials.apiKey, credentials.apiToken),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const data = await res.json().catch(() => ({})) as any;

  if (!res.ok) {
    const msg = data?.RestException?.Message || data?.message || `Exotel API error ${res.status}`;
    logger.warn(
      { provider: "exotel", status: res.status, providerCode: data?.RestException?.Code ?? data?.code },
      "Exotel connect failed",
    );
    throw Object.assign(new Error(msg), { status: res.status });
  }

  const callSid = data?.Call?.Sid;
  if (!callSid) {
    throw new Error("Exotel did not return a Call Sid");
  }

  return {
    callSid,
    status: data?.Call?.Status || "queued",
    raw: data,
  };
}

/** Hang up an active Exotel call */
export async function exotelHangupCall(
  credentials: ExotelCredentials,
  callSid: string,
): Promise<void> {
  const host = getExotelApiHost(credentials.region);
  const url = `https://${host}/v1/Accounts/${credentials.accountSid}/Calls/${callSid}.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader(credentials.apiKey, credentials.apiToken),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ Status: "completed" }).toString(),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as any;
    throw new Error(data?.RestException?.Message || `Exotel hangup failed (${res.status})`);
  }
}

/** Map Exotel terminal status to Dialog outcome */
export function mapExotelStatusToOutcome(status: string): string {
  const s = (status || "").toLowerCase();
  if (s === "completed" || s === "answered") return "answered";
  if (s === "busy") return "busy";
  if (s === "no-answer" || s === "no_answer") return "no_answer";
  if (s === "failed" || s === "canceled") return "no_answer";
  return "no_answer";
}
