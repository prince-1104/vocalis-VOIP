/**
 * Seed a superadmin user for local testing.
 *
 * Usage:  (from project root)
 *   npx dotenv-cli -e .env -- npx tsx scripts/seed-superadmin.ts
 *
 * Login credentials:
 *   email:    admin@dialog.local
 *   password: admin123
 */

import { pool } from "../lib/db/src/index.js";
import { createHash, randomBytes, scryptSync } from "crypto";

const EMAIL = "admin@dialog.local";
const PASSWORD = "admin123";
const NAME = "Test Superadmin";
const BUSINESS = "Dialog Dev";
const TENANT_SLUG = "dialog-dev";

// bcrypt-compatible hash using $2b$ format
// We use the simple approach: generate a bcrypt hash via the pool itself
async function hashPassword(password: string): Promise<string> {
  // Use pgcrypto extension or fallback to a simple known-format hash
  // Try pgcrypto first (common on Railway/Neon/Supabase)
  try {
    const result = await pool.query(
      `SELECT crypt($1, gen_salt('bf', 10)) as hash`,
      [password],
    );
    return result.rows[0].hash;
  } catch {
    // pgcrypto not available — use scrypt-based hash with $scrypt$ prefix
    // The app uses bcryptjs which we can't import here, so we'll install it inline
    // Actually, let's just do a raw SQL approach
    throw new Error("pgcrypto extension not available. Install it with: CREATE EXTENSION IF NOT EXISTS pgcrypto;");
  }
}

async function seed() {
  const client = await pool.connect();

  try {
    // Ensure pgcrypto is available
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");

    await client.query("BEGIN");

    // 1. Check if user already exists
    const existing = await client.query(
      `SELECT id FROM users WHERE email = $1`,
      [EMAIL],
    );

    if (existing.rows.length > 0) {
      const uid = existing.rows[0].id;
      await client.query(`UPDATE users SET is_superadmin = true WHERE id = $1`, [uid]);
      console.log(`✓ User already exists (id=${uid}), ensured is_superadmin=true`);

      const hashRes = await client.query(`SELECT crypt($1, gen_salt('bf', 10)) as hash`, [PASSWORD]);
      await client.query(
        `UPDATE tenant_users SET password_hash = $1 WHERE user_id = $2`,
        [hashRes.rows[0].hash, uid],
      );
      console.log(`✓ Password updated`);

      await client.query("COMMIT");
      console.log(`\n🔑 Login: email=${EMAIL}  password=${PASSWORD}`);
      await pool.end();
      return;
    }

    // 2. Create user
    const userRes = await client.query(
      `INSERT INTO users (email, name, business_name, plan, is_superadmin)
       VALUES ($1, $2, $3, 'pro', true)
       RETURNING id`,
      [EMAIL, NAME, BUSINESS],
    );
    const userId = userRes.rows[0].id;
    console.log(`✓ Created user id=${userId}`);

    // 3. Create tenant
    const tenantRes = await client.query(
      `INSERT INTO tenants (name, slug, owner_id, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (slug) DO UPDATE SET owner_id = $3
       RETURNING id`,
      [BUSINESS, TENANT_SLUG, userId],
    );
    const tenantId = tenantRes.rows[0].id;
    console.log(`✓ Created tenant id=${tenantId} slug=${TENANT_SLUG}`);

    // 4. Create tenant_user with password (bcrypt via pgcrypto)
    const hashRes = await client.query(`SELECT crypt($1, gen_salt('bf', 10)) as hash`, [PASSWORD]);
    const hash = hashRes.rows[0].hash;

    const tuRes = await client.query(
      `INSERT INTO tenant_users (tenant_id, user_id, role, email, name, password_hash, is_active)
       VALUES ($1, $2, 'admin', $3, $4, $5, true)
       RETURNING id`,
      [tenantId, userId, EMAIL, NAME, hash],
    );
    console.log(`✓ Created tenant_user id=${tuRes.rows[0].id}`);

    // 5. Create default agent config
    await client.query(
      `INSERT INTO agent_configs (user_id, agent_name, voice, personality, greeting, ai_model)
       VALUES ($1, 'SalesBot', 'nova', 'professional',
               'Hi, this is SalesBot. How can I help you today?', 'gpt-4o-mini')
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    console.log(`✓ Created agent config`);

    await client.query("COMMIT");

    console.log(`\n${"═".repeat(50)}`);
    console.log(`🎉 Superadmin created successfully!`);
    console.log(`${"═".repeat(50)}`);
    console.log(`   Email:    ${EMAIL}`);
    console.log(`   Password: ${PASSWORD}`);
    console.log(`   Tenant:   ${TENANT_SLUG}`);
    console.log(`   User ID:  ${userId}`);
    console.log(`${"═".repeat(50)}`);
    console.log(`\nLogin via POST /api/auth/login with:`);
    console.log(`  { "email": "${EMAIL}", "password": "${PASSWORD}" }`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Seed failed:", err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(() => process.exit(1));
