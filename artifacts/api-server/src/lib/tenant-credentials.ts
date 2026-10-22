import { CredentialError, openCredential, type CredentialField } from "./credential-crypto";
import { logger } from "./logger";

/**
 * Decrypts a stored credential for an authorized runtime use. Any failure
 * (missing key, tampering, legacy reads disabled) is logged by reason code and
 * returns null, so callers treat the credential as unavailable.
 */
export function readCredential(
  field: CredentialField,
  ownerId: number,
  stored: string | null | undefined,
): string | null {
  try {
    return openCredential(field, ownerId, stored);
  } catch (err) {
    logger.error(
      {
        event: "credential_unavailable",
        field,
        ownerId,
        reason: err instanceof CredentialError ? err.reason : "error",
      },
      "Stored credential unavailable",
    );
    return null;
  }
}

/** Twilio auth token for an agent config row (owner = agent_configs.user_id). */
export function twilioAuthTokenFor(agent: { userId: number; twilioAuthToken: string | null }): string | null {
  return readCredential("twilioAuthToken", agent.userId, agent.twilioAuthToken);
}
