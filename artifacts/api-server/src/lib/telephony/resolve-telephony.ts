import {
  db,
  tenantsTable,
  agentConfigsTable,
  sipTrunkConfigsTable,
  exotelConfigsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { readCredential, twilioAuthTokenFor } from "../tenant-credentials";
import type { ExotelCredentials } from "./exotel-client";

export type TelephonyProvider = "TWILIO" | "SIP_TRUNK" | "EXOTEL" | "VOBIZ_SIP";

export interface TwilioTelephonyContext {
  provider: "TWILIO" | "SIP_TRUNK";
  twilioAccountSid: string;
  twilioAuthToken: string;
  fromPhone: string;
  toPhone: string;
  sipAuthUsername?: string;
  sipAuthPassword?: string;
}

export interface ExotelTelephonyContext {
  provider: "EXOTEL";
  credentials: ExotelCredentials;
  customerPhone: string;
}

export type TelephonyContext = TwilioTelephonyContext | ExotelTelephonyContext;

export class TelephonyNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelephonyNotConfiguredError";
  }
}

export class TelephonyUnavailableError extends TelephonyNotConfiguredError {
  readonly code = "livekit_required";
  constructor() {
    super("Vobiz SIP call execution requires the LiveKit integration, which is not available.");
    this.name = "TelephonyUnavailableError";
  }
}

/** Resolve active telephony provider and dial parameters for a tenant owner. */
export async function resolveTelephonyForUser(
  userId: number,
  destinationPhone: string,
): Promise<TelephonyContext> {
  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.ownerId, userId),
  });

  if (!tenant) {
    throw new TelephonyNotConfiguredError("Tenant not found for user.");
  }

  // Vobiz is not the Twilio-mediated SIP_TRUNK path. Fail before credentials,
  // budget reservations, call logs or provider work, even if set out of band.
  if (tenant.telephonyType === "VOBIZ_SIP") throw new TelephonyUnavailableError();

  const agentConfig = await db.query.agentConfigsTable.findFirst({
    where: eq(agentConfigsTable.userId, userId),
  });

  if (tenant.telephonyType === "EXOTEL") {
    const exotel = await db.query.exotelConfigsTable.findFirst({
      where: eq(exotelConfigsTable.tenantId, tenant.id),
    });

    if (!exotel || !exotel.isEnabled) {
      throw new TelephonyNotConfiguredError(
        "Exotel is not configured for this tenant. Ask your superadmin to set up Exotel under Tenant → Telephony.",
      );
    }

    const apiKey = readCredential("exotelApiKey", tenant.id, exotel.apiKey);
    const apiToken = readCredential("exotelApiToken", tenant.id, exotel.apiToken);
    if (!apiKey || !apiToken) {
      throw new TelephonyNotConfiguredError("Failed to decrypt Exotel credentials.");
    }

    return {
      provider: "EXOTEL",
      customerPhone: destinationPhone,
      credentials: {
        accountSid: exotel.accountSid,
        apiKey,
        apiToken,
        exophone: exotel.exophone,
        region: exotel.region === "mumbai" ? "mumbai" : "singapore",
        appFlowUrl: exotel.appFlowUrl,
      },
    };
  }

  if (!agentConfig?.twilioAccountSid || !agentConfig?.twilioAuthToken) {
    throw new TelephonyNotConfiguredError(
      "Twilio credentials not configured. Set them in Superadmin → Tenant → Telephony or AI Agent settings.",
    );
  }
  const twilioAuthToken = twilioAuthTokenFor(agentConfig);
  if (!twilioAuthToken) {
    throw new TelephonyNotConfiguredError("Failed to decrypt Twilio credentials.");
  }

  if (tenant.telephonyType === "SIP_TRUNK") {
    const sipConfig = await db.query.sipTrunkConfigsTable.findFirst({
      where: eq(sipTrunkConfigsTable.tenantId, tenant.id),
    });

    if (!sipConfig || !sipConfig.isEnabled) {
      throw new TelephonyNotConfiguredError("SIP Trunk configuration is disabled or not found.");
    }

    const sipAuthPassword = readCredential("sipPassword", tenant.id, sipConfig.sipPassword);
    if (!sipAuthPassword) {
      throw new TelephonyNotConfiguredError("Failed to decrypt SIP password.");
    }

    return {
      provider: "SIP_TRUNK",
      twilioAccountSid: agentConfig.twilioAccountSid,
      twilioAuthToken,
      fromPhone: sipConfig.phoneNumber,
      toPhone: `sip:${destinationPhone}@${sipConfig.sipDomain}`,
      sipAuthUsername: sipConfig.sipUsername,
      sipAuthPassword,
    };
  }

  if (!agentConfig.phoneNumber) {
    throw new TelephonyNotConfiguredError("Twilio phone number not configured.");
  }

  return {
    provider: "TWILIO",
    twilioAccountSid: agentConfig.twilioAccountSid,
    twilioAuthToken,
    fromPhone: agentConfig.phoneNumber,
    toPhone: destinationPhone,
  };
}
