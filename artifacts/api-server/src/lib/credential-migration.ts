import {
  agentConfigsTable,
  crmApiKeysTable,
  exotelConfigsTable,
  externalCrmConfigsTable,
  sipTrunkConfigsTable,
  vobizSipConfigsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { CredentialError, type CredentialCodec, type CredentialField } from "./credential-crypto";

/**
 * Explicit re-encryption of stored credentials into v1 under the active key.
 * Used both for the one-time legacy migration and for key rotation.
 *
 * Every write is a compare-and-set on the exact value that was read and
 * verified, so a credential updated concurrently (by an admin, or by another
 * migration run) is never overwritten. Values that cannot be decrypted are
 * reported by reason and left untouched. Reports contain counts only.
 */

interface Target {
  table: any;
  owner: "userId" | "tenantId";
  columns: Array<[property: string, field: CredentialField]>;
}

export const CREDENTIAL_TARGETS: Target[] = [
  {
    table: agentConfigsTable,
    owner: "userId",
    columns: [
      ["twilioAuthToken", "twilioAuthToken"],
      ["telephonyApiKey", "telephonyApiKey"],
      ["telephonyApiSecret", "telephonyApiSecret"],
    ],
  },
  { table: externalCrmConfigsTable, owner: "userId", columns: [["authValue", "crmAuthValue"]] },
  { table: crmApiKeysTable, owner: "userId", columns: [["webhookSecret", "crmWebhookSecret"]] },
  { table: sipTrunkConfigsTable, owner: "tenantId", columns: [["sipPassword", "sipPassword"]] },
  { table: vobizSipConfigsTable, owner: "tenantId", columns: [["sipUsername", "vobizSipUsername"], ["sipPassword", "vobizSipPassword"]] },
  {
    table: exotelConfigsTable,
    owner: "tenantId",
    columns: [
      ["apiKey", "exotelApiKey"],
      ["apiToken", "exotelApiToken"],
    ],
  },
];

export interface ColumnReport {
  field: CredentialField;
  rows: number;
  empty: number;
  /** Already v1 under the active key. */
  current: number;
  /** Formats found that need re-encryption (legacy_plaintext, legacy_cbc, v1:<oldKeyId>). */
  pendingByFormat: Record<string, number>;
  /** Written in this run (apply mode only). */
  reencrypted: number;
  /** Value changed between read and write; left for the next run. */
  skippedConcurrent: number;
  /** Could not be decrypted; left untouched. Keyed by CredentialError reason. */
  failed: Record<string, number>;
}

export interface MigrationReport {
  apply: boolean;
  activeKeyId: string;
  columns: ColumnReport[];
  /** True when every non-empty value is v1 under the active key. */
  complete: boolean;
}

const bump = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

export async function migrateCredentials(
  database: any,
  codec: CredentialCodec,
  options: { apply: boolean },
): Promise<MigrationReport> {
  const columns: ColumnReport[] = [];
  for (const target of CREDENTIAL_TARGETS) {
    const rows: any[] = await database.select().from(target.table);
    for (const [property, field] of target.columns) {
      const report: ColumnReport = {
        field,
        rows: rows.length,
        empty: 0,
        current: 0,
        pendingByFormat: {},
        reencrypted: 0,
        skippedConcurrent: 0,
        failed: {},
      };
      for (const row of rows) {
        const stored: string | null = row[property];
        const info = codec.inspect(field, stored);
        if (info.format === "empty") {
          report.empty++;
          continue;
        }
        if (!codec.needsReencryption(field, stored)) {
          report.current++;
          continue;
        }
        const ownerId = row[target.owner];
        let plaintext: string;
        let sealed: string;
        try {
          plaintext = codec.open(field, ownerId, stored)!;
          sealed = codec.seal(field, ownerId, plaintext);
          // Verify the new value round-trips before anything is written.
          if (codec.open(field, ownerId, sealed) !== plaintext) throw new CredentialError("authentication");
        } catch (err) {
          bump(report.failed, err instanceof CredentialError ? err.reason : "error");
          continue;
        }
        bump(report.pendingByFormat, info.format === "v1" ? `v1:${info.keyId}` : info.format);
        if (!options.apply) continue;
        const updated: any[] = await database
          .update(target.table)
          .set({ [property]: sealed })
          .where(and(eq(target.table.id, row.id), eq(target.table[property], stored)))
          .returning({ id: target.table.id });
        if (updated.length === 1) report.reencrypted++;
        else report.skippedConcurrent++;
      }
      columns.push(report);
    }
  }
  const complete = columns.every(
    (c) =>
      Object.keys(c.failed).length === 0 &&
      c.skippedConcurrent === 0 &&
      c.current + c.empty + (options.apply ? c.reencrypted : 0) === c.rows,
  );
  return { apply: options.apply, activeKeyId: codec.activeKeyId, columns, complete };
}
