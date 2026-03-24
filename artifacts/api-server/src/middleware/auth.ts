import { Request, Response, NextFunction } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { agentConfigsTable } from "@workspace/db";

const DEMO_USER_ID = "demo-user";

declare global {
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}

export async function resolveUser(req: Request, res: Response, next: NextFunction) {
  const replitUserId = (req.headers["x-replit-user-id"] as string) || DEMO_USER_ID;
  const replitUserName = (req.headers["x-replit-user-name"] as string) || "Demo User";

  try {
    let user = await db.query.usersTable.findFirst({
      where: eq(usersTable.replitUserId, replitUserId),
    });

    if (!user) {
      const [newUser] = await db.insert(usersTable).values({
        replitUserId,
        name: replitUserName,
        plan: "free",
      }).returning();
      user = newUser;

      await db.insert(agentConfigsTable).values({
        userId: newUser.id,
        agentName: "SalesBot",
        voice: "nova",
        personality: "professional",
        greeting: "Hi, this is SalesBot calling on behalf of [Business Name]. Is this a good time to speak?",
        voicemailMessage: "Hi, this is a message for [Name]. Please call us back at your earliest convenience. Thank you!",
      }).onConflictDoNothing();
    }

    req.userId = user.id;
    next();
  } catch (err) {
    next(err);
  }
}
