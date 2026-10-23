// Separate entry point: no campaigns, invoice jobs or provider credentials are loaded.
import { readFile } from "node:fs/promises";
import { applyMigrations } from "@workspace/db/migrations";
import { pool } from "@workspace/db";
import bcrypt from "bcryptjs";
import { localVoiceEnabled } from "./lib/livekit/sessions";

if (!localVoiceEnabled(process.env)) throw new Error("Isolated local voice configuration required");
const command = process.argv[2];
if (command === "init") {
  const migrationClient = await pool.connect();
  try { await applyMigrations(migrationClient, "/app/lib/db/drizzle"); } finally { migrationClient.release(); }
  const credentials = JSON.parse(await readFile("/run/dialog-local/login.json", "utf8"));
  const c = await pool.connect();
  try {
    await c.query("begin");
    for (const [index, user] of credentials.entries()) {
      const slug = `local-voice-${index + 1}`;
      const found = await c.query("select id from tenants where slug=$1", [slug]);
      if (found.rows.length) continue;
      const owner = await c.query("insert into users(email,name) values ($1,'Local fixture') returning id", [user.email]);
      const tenant = await c.query("insert into tenants(name,slug,owner_id) values ('Local voice fixture',$1,$2) returning id", [slug, owner.rows[0].id]);
      await c.query("insert into tenant_users(tenant_id,user_id,role,email,password_hash) values ($1,$2,'admin',$3,$4)", [tenant.rows[0].id, owner.rows[0].id, user.email, await bcrypt.hash(user.password, 12)]);
      await c.query("insert into agent_configs(user_id,greeting) values ($1,'Hello. This is a local mocked greeting.')", [owner.rows[0].id]);
    }
    await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); await pool.end(); }
} else {
  const { inspectSchema } = await import("@workspace/db/migrations");
  const report = await inspectSchema(pool);
  if (report.status !== "ready") throw new Error("Fixture migrations required");
  const { default: app, livekitRoutes } = await import("./app");
  const server = app.listen(3003, "0.0.0.0");
  const timer = setInterval(() => { void livekitRoutes.reconcile().catch(() => undefined); }, 5000);
  process.once("SIGTERM", () => { clearInterval(timer); server.close(() => { void pool.end(); }); });
}
