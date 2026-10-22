import type { db } from "@workspace/db";

/** The pool-backed database or an open transaction on it. */
export type Connection = Omit<typeof db, "$client">;
