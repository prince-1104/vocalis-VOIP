import twilio from "twilio";
import { exotelHangupCall } from "./exotel-client";
import { resolveTelephonyForUser } from "./resolve-telephony";
import { unregisterExotelStream } from "./exotel-stream-registry";
import { logger } from "../logger";

/**
 * Provider-aware call hang up. Routes to Exotel's REST hangup for Exotel tenants
 * and Twilio's call-completion update for Twilio / SIP-trunk tenants.
 *
 * Never throws — telephony errors are logged and swallowed so callers can always
 * finalize their own call-log state.
 */
export async function hangupCall(
  userId: number,
  callSid: string,
  destinationPhone?: string,
): Promise<void> {
  try {
    const telephony = await resolveTelephonyForUser(userId, destinationPhone || "");

    if (telephony.provider === "EXOTEL") {
      await exotelHangupCall(telephony.credentials, callSid);
      return;
    }

    const client = twilio(telephony.twilioAccountSid, telephony.twilioAuthToken);
    await client.calls(callSid).update({ status: "completed" });
  } catch (err) {
    logger.error({ err, callSid, userId }, "Provider-aware hangup failed");
  } finally {
    unregisterExotelStream(String(callSid));
  }
}
