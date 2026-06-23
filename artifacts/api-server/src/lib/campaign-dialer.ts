import { db, agentConfigsTable, callLogsTable, contactsTable, campaignsTable, campaignContactsTable } from "@workspace/db";
import { eq, and, ne, lt, or, lte, sql, isNull, desc } from "drizzle-orm";
import { logger } from "./logger";
import { buildCallCrmMetadataForCampaign } from "./campaign-transfer";
import { placeOutboundCall } from "./telephony/place-outbound-call";

function getCampaignBaseUrl(): string {
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) {
    return `https://${domains.split(",")[0].trim()}`;
  }
  return process.env.PUBLIC_BASE_URL || "https://dialog.noeticminds.com";
}

/** Contacts stuck in "calling" with no active call log block parallel slots — release them. */
async function releaseStaleCallingContacts(campaignId: number): Promise<void> {
  const campaign = await db.query.campaignsTable.findFirst({
    where: eq(campaignsTable.id, campaignId),
  });
  if (!campaign) return;

  const callingContacts = await db
    .select({
      linkId: campaignContactsTable.id,
      contactId: campaignContactsTable.contactId,
      attempts: campaignContactsTable.attempts,
    })
    .from(campaignContactsTable)
    .where(
      and(
        eq(campaignContactsTable.campaignId, campaignId),
        eq(campaignContactsTable.status, "calling"),
      ),
    );

  for (const cc of callingContacts) {
    const activeCall = await db.query.callLogsTable.findFirst({
      where: and(
        eq(callLogsTable.campaignId, campaignId),
        eq(callLogsTable.contactId, cc.contactId),
        isNull(callLogsTable.endedAt),
      ),
    });

    if (activeCall) continue;

    const lastCall = await db.query.callLogsTable.findFirst({
      where: and(
        eq(callLogsTable.campaignId, campaignId),
        eq(callLogsTable.contactId, cc.contactId),
      ),
      orderBy: desc(callLogsTable.startedAt),
    });

    if (lastCall?.outcome === "answered") {
      await db.update(campaignContactsTable)
        .set({ status: "answered" })
        .where(eq(campaignContactsTable.id, cc.linkId));
    } else if (cc.attempts >= 1 + campaign.maxRetries) {
      await db.update(campaignContactsTable)
        .set({ status: "failed" })
        .where(eq(campaignContactsTable.id, cc.linkId));
    } else {
      const nextTime = new Date(Date.now() + campaign.retryIntervalMinutes * 60 * 1000);
      await db.update(campaignContactsTable)
        .set({ status: "retrying", nextAttemptAt: nextTime })
        .where(eq(campaignContactsTable.id, cc.linkId));
    }
  }
}

export interface DialNextResult {
  done: boolean;
  dialFailed?: boolean;
  error?: string;
  message?: string;
  callSid?: string;
  callLogId?: number;
  contact?: {
    id: number;
    phone: string;
    firstName: string | null;
    lastName: string | null;
  };
  remaining?: number;
}

/** Twilio errors that won't succeed on retry without user action (verify number, fix format, etc.) */
function isPermanentDialError(err: unknown): boolean {
  const code = (err as { code?: number })?.code;
  return code === 21219 || code === 21211 || code === 21214 || code === 21608 || code === 13224;
}

async function resolveFailedContactStatus(
  campaign: { maxRetries: number; retryIntervalMinutes: number },
  linkId: number,
  previousAttempts: number,
  err: unknown,
): Promise<void> {
  const newAttempts = previousAttempts + 1;
  const permanent = isPermanentDialError(err);

  if (permanent || newAttempts >= 1 + campaign.maxRetries) {
    await db.update(campaignContactsTable)
      .set({ status: "failed" })
      .where(eq(campaignContactsTable.id, linkId));
    return;
  }

  const nextTime = new Date(Date.now() + campaign.retryIntervalMinutes * 60 * 1000);
  await db.update(campaignContactsTable)
    .set({ status: "retrying", nextAttemptAt: nextTime })
    .where(eq(campaignContactsTable.id, linkId));
}

/** Mark campaign completed when every contact is done and no calls are in progress. */
export async function tryMarkCampaignCompleted(campaignId: number): Promise<boolean> {
  const campaign = await db.query.campaignsTable.findFirst({
    where: eq(campaignsTable.id, campaignId),
  });
  if (!campaign || campaign.status !== "active") return false;

  await releaseStaleCallingContacts(campaignId);

  const activeCalls = await db
    .select({ count: sql<number>`count(*)` })
    .from(callLogsTable)
    .where(and(eq(callLogsTable.campaignId, campaignId), isNull(callLogsTable.endedAt)));
  if (Number(activeCalls[0]?.count || 0) > 0) return false;

  const links = await db
    .select()
    .from(campaignContactsTable)
    .where(eq(campaignContactsTable.campaignId, campaignId));

  if (links.length === 0) return false;

  const now = new Date();
  const allTerminal = links.every((link) => {
    if (link.status === "answered" || link.status === "failed") return true;
    if (link.attempts >= 1 + campaign.maxRetries) return true;
    return false;
  });

  const allDialedOnce =
    links.every((link) => link.attempts >= 1) &&
    links.every((link) => link.status !== "pending" && link.status !== "calling") &&
    (campaign.calledCount || 0) >= links.length;

  const retryWaiting = links.some(
    (link) =>
      link.status === "retrying" &&
      link.attempts < 1 + campaign.maxRetries &&
      link.nextAttemptAt &&
      link.nextAttemptAt > now,
  );

  const shouldComplete = allTerminal || (allDialedOnce && !retryWaiting);

  if (!shouldComplete) return false;

  await db
    .update(campaignsTable)
    .set({ status: "completed", updatedAt: new Date() })
    .where(eq(campaignsTable.id, campaignId));

  logger.info({ campaignId, allTerminal, allDialedOnce }, "Campaign marked as completed");
  return true;
}

export async function dialNextForCampaign(
  campaignId: number,
  userId: number,
  baseUrl: string
): Promise<DialNextResult> {
  const campaign = await db.query.campaignsTable.findFirst({
    where: and(eq(campaignsTable.id, campaignId), eq(campaignsTable.userId, userId)),
  });

  if (!campaign) {
    throw new Error("Campaign not found");
  }

  if (campaign.status !== "active") {
    throw new Error("Campaign is not active");
  }

  const now = new Date();
  const pendingLinks = await db
    .select({
      linkId: campaignContactsTable.id,
      contactId: campaignContactsTable.contactId,
      status: campaignContactsTable.status,
      attempts: campaignContactsTable.attempts,
      firstName: contactsTable.firstName,
      lastName: contactsTable.lastName,
      phone: contactsTable.phone,
    })
    .from(campaignContactsTable)
    .innerJoin(contactsTable, eq(campaignContactsTable.contactId, contactsTable.id))
    .where(
      and(
        eq(campaignContactsTable.campaignId, campaign.id),
        ne(campaignContactsTable.status, "answered"),
        lt(campaignContactsTable.attempts, 1 + campaign.maxRetries),
        or(
          eq(campaignContactsTable.status, "pending"),
          and(
            eq(campaignContactsTable.status, "retrying"),
            lte(campaignContactsTable.nextAttemptAt, now)
          )
        )
      )
    )
    .orderBy(campaignContactsTable.createdAt);

  const nextLink = pendingLinks[0];

  if (!nextLink) {
    const completed = await tryMarkCampaignCompleted(campaign.id);
    if (completed) {
      return { done: true, message: "All contacts have been called. Campaign marked as completed." };
    }

    const activeLinksCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(campaignContactsTable)
      .where(
        and(
          eq(campaignContactsTable.campaignId, campaign.id),
          ne(campaignContactsTable.status, "answered"),
          lt(campaignContactsTable.attempts, 1 + campaign.maxRetries)
        )
      );

    const remainingCount = Number(activeLinksCount[0]?.count || 0);

    if (remainingCount === 0) {
      await db.update(campaignsTable)
        .set({ status: "completed", updatedAt: new Date() })
        .where(eq(campaignsTable.id, campaign.id));
      return { done: true, message: "All contacts have been called and retries exhausted. Campaign marked as completed." };
    }

    return { done: true, message: `No contacts available to dial right now. ${remainingCount} contacts scheduled for future retries.` };
  }

  const nextContact = {
    id: nextLink.contactId,
    phone: nextLink.phone,
    firstName: nextLink.firstName,
    lastName: nextLink.lastName,
  };

  const agentConfig = await db.query.agentConfigsTable.findFirst({ where: eq(agentConfigsTable.userId, userId) });

  await db.update(contactsTable)
    .set({ status: "called", lastCalledAt: new Date(), updatedAt: new Date() })
    .where(eq(contactsTable.id, nextContact.id));

  await db.update(campaignContactsTable)
    .set({
      status: "calling",
      attempts: nextLink.attempts + 1,
      lastAttemptAt: new Date(),
    })
    .where(eq(campaignContactsTable.id, nextLink.linkId));

  const crmMetadata = await buildCallCrmMetadataForCampaign(campaign, userId);

  try {
    const placed = await placeOutboundCall({
      userId,
      contactId: nextContact.id,
      campaignId: campaign.id,
      phone: nextContact.phone,
      aiModel: agentConfig?.aiModel || "gpt-4o-mini",
      baseUrl,
      crmMetadata: crmMetadata ?? null,
    });

    await db.update(campaignsTable)
      .set({ calledCount: campaign.calledCount + 1, updatedAt: new Date() })
      .where(eq(campaignsTable.id, campaign.id));

    return {
      done: false,
      callSid: placed.providerCallId,
      callLogId: placed.callLogId,
      contact: nextContact,
      remaining: pendingLinks.length - 1,
    };
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    logger.warn(
      { err, campaignId: campaign.id, contactId: nextContact.id, phone: nextContact.phone, code: err?.code },
      "Campaign dial failed for contact",
    );

    const failedLog = await db.query.callLogsTable.findFirst({
      where: and(
        eq(callLogsTable.campaignId, campaign.id),
        eq(callLogsTable.contactId, nextContact.id),
      ),
      orderBy: desc(callLogsTable.startedAt),
    });

    if (failedLog) {
      await db.update(callLogsTable)
        .set({
          outcome: "no_answer",
          endedAt: new Date(),
          transcript: `Failed to dial: ${errMsg}`,
        })
        .where(eq(callLogsTable.id, failedLog.id));
    }

    await resolveFailedContactStatus(campaign, nextLink.linkId, nextLink.attempts, err);

    return {
      done: false,
      dialFailed: true,
      error: errMsg,
      callLogId: failedLog?.id,
      contact: nextContact,
      remaining: pendingLinks.length - 1,
    };
  }
}

export async function triggerDialingForCampaign(
  campaignId: number,
  userId: number,
  baseUrl: string
): Promise<void> {
  const campaign = await db.query.campaignsTable.findFirst({
    where: and(eq(campaignsTable.id, campaignId), eq(campaignsTable.userId, userId)),
  });

  if (!campaign || campaign.status !== "active" || !campaign.isAutomatic) {
    return;
  }

  await releaseStaleCallingContacts(campaignId);

  const maxAllowed = campaign.dialParallel ? campaign.maxConcurrentCalls : 1;
  let safety = 0;

  // Fill parallel slots; failed dials return dialFailed and we immediately try the next contact.
  while (safety++ < 50) {
    const activeCalls = await db.select({ id: callLogsTable.id }).from(callLogsTable).where(
      and(
        eq(callLogsTable.campaignId, campaignId),
        isNull(callLogsTable.endedAt),
      ),
    );

    if (activeCalls.length >= maxAllowed) {
      logger.debug({ campaignId, active: activeCalls.length, maxAllowed }, "Parallel dial slots full");
      break;
    }

    try {
      const result = await dialNextForCampaign(campaignId, userId, baseUrl);

      if (result.done) {
        break;
      }

      if (result.dialFailed) {
        continue;
      }

      // Sequential auto-dial: stop after placing one successful call
      if (!campaign.dialParallel) {
        break;
      }
    } catch (err) {
      logger.error({ err, campaignId }, "Campaign dial aborted — configuration error");
      break;
    }
  }

  await tryMarkCampaignCompleted(campaignId);
}

/** Periodically fill parallel slots and pick up retry-ready contacts for active campaigns. */
export function startCampaignDialScheduler(): void {
  const intervalMs = 15_000;

  setInterval(async () => {
    try {
      const activeCampaigns = await db.select().from(campaignsTable).where(
        and(
          eq(campaignsTable.status, "active"),
          eq(campaignsTable.isAutomatic, true),
        ),
      );

      if (activeCampaigns.length === 0) return;

      const baseUrl = getCampaignBaseUrl();

      for (const campaign of activeCampaigns) {
        await triggerDialingForCampaign(campaign.id, campaign.userId, baseUrl);
      }
    } catch (err) {
      logger.error({ err }, "[campaign-dial-scheduler] Error");
    }
  }, intervalMs);

  logger.info("Campaign dial scheduler started (15s interval)");
}
