import twilio from "twilio";
import { db, agentConfigsTable, callLogsTable, contactsTable, campaignsTable, campaignContactsTable, tenantsTable, sipTrunkConfigsTable } from "@workspace/db";
import { eq, and, ne, lt, or, lte, sql } from "drizzle-orm";
import { decrypt } from "./encryption";

function getTwilioClient(accountSid: string, authToken: string) {
  return twilio(accountSid, authToken);
}

export interface DialNextResult {
  done: boolean;
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
    } else {
      return { done: true, message: `No contacts available to dial right now. ${remainingCount} contacts scheduled for future retries.` };
    }
  }

  const nextContact = {
    id: nextLink.contactId,
    phone: nextLink.phone,
    firstName: nextLink.firstName,
    lastName: nextLink.lastName,
  };

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

  await db.update(campaignsTable)
    .set({ calledCount: campaign.calledCount + 1, updatedAt: new Date() })
    .where(eq(campaignsTable.id, campaign.id));

  const agentConfig = await db.query.agentConfigsTable.findFirst({ where: eq(agentConfigsTable.userId, userId) });

  if (!agentConfig?.twilioAccountSid || !agentConfig?.twilioAuthToken) {
    throw new Error("Twilio not fully configured. Check AI Agent settings.");
  }

  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.ownerId, userId),
  });

  if (!tenant) {
    throw new Error("Tenant not found for user.");
  }

  let toPhone = nextContact.phone;
  let fromPhone: string;
  let sipAuthUsername: string | undefined;
  let sipAuthPassword: string | undefined;

  if (tenant.telephonyType === "SIP_TRUNK") {
    const sipConfig = await db.query.sipTrunkConfigsTable.findFirst({
      where: eq(sipTrunkConfigsTable.tenantId, tenant.id),
    });

    if (!sipConfig || !sipConfig.isEnabled) {
      throw new Error("SIP Trunk configuration is disabled or not found.");
    }

    toPhone = `sip:${nextContact.phone}@${sipConfig.sipDomain}`;
    fromPhone = sipConfig.phoneNumber;
    sipAuthUsername = sipConfig.sipUsername;
    try {
      sipAuthPassword = decrypt(sipConfig.sipPassword);
    } catch (err) {
      throw new Error("Failed to decrypt SIP password.");
    }
  } else {
    if (!agentConfig.phoneNumber) {
      throw new Error("Twilio phone number not configured. Check AI Agent settings.");
    }
    fromPhone = agentConfig.phoneNumber;
  }

  const client = getTwilioClient(agentConfig.twilioAccountSid, agentConfig.twilioAuthToken);

  const [callLog] = await db.insert(callLogsTable).values({
    userId,
    contactId: nextContact.id,
    campaignId: campaign.id,
    direction: "outbound",
    phone: nextContact.phone,
    outcome: "no_answer",
    aiModel: agentConfig.aiModel || "gpt-4o-mini",
    startedAt: new Date(),
  }).returning();

  const call = await client.calls.create({
    to: toPhone,
    from: fromPhone,
    url: `${baseUrl}/api/twilio/outbound-voice?callLogId=${callLog.id}&userId=${userId}`,
    statusCallback: `${baseUrl}/api/twilio/status?callLogId=${callLog.id}`,
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["completed", "no-answer", "busy", "failed"],
    machineDetection: "Enable",
    asyncAmd: "true",
    ...(sipAuthUsername && sipAuthPassword ? { sipAuthUsername, sipAuthPassword } : {}),
  });

  // Store the actual Call SID in the call logs
  await db.update(callLogsTable)
    .set({ callSid: call.sid })
    .where(eq(callLogsTable.id, callLog.id));

  return {
    done: false,
    callSid: call.sid,
    callLogId: callLog.id,
    contact: {
      id: nextContact.id,
      phone: nextContact.phone,
      firstName: nextContact.firstName,
      lastName: nextContact.lastName,
    },
    remaining: pendingLinks.length - 1,
  };
}
