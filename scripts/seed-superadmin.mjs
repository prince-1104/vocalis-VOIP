/**
 * Seed a superadmin user for local testing.
 *
 * Usage:
 *   node scripts/seed-superadmin.mjs
 *
 * Creates:
 *   - User (isSuperadmin=true)
 *   - Tenant owned by that user
 *   - TenantUser with admin role + hashed password
 *   - AgentConfig (default AI agent setup)
 *
 * Login credentials:
 *   email:    admin@dialog.local
 *   password: admin123
 */

import pg from "pg";
import bcrypt from "bcryptjs";

const DATABASE_URL = process.env.DATABASE_URL
  || "postgresql://postgres:kulbuXgiMZiIAHAmhGYQpBmOEvuIGfsz@acela.proxy.rlwy.net:41996/railway";

const pool = new pg.Pool({ connectionString: DATABASE_URL });

const EMAIL = "admin@dialog.local";
const PASSWORD = "admin123";
const NAME = "Test Superadmin";
const BUSINESS = "Dialog Dev";
const TENANT_SLUG = "dialog-dev";

async function seed() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Check if user already exists
    const existing = await client.query(
      `SELECT id FROM users WHERE email = $1`,
      [EMAIL],
    );

    if (existing.rows.length > 0) {
      const uid = existing.rows[0].id;
      // Make sure they're superadmin
      await client.query(`UPDATE users SET is_superadmin = true WHERE id = $1`, [uid]);
      console.log(`✓ User already exists (id=${uid}), ensured is_superadmin=true`);

      // Update password in case it changed
      const hash = await bcrypt.hash(PASSWORD, 10);
      await client.query(
        `UPDATE tenant_users SET password_hash = $1 WHERE user_id = $2`,
        [hash, uid],
      );
      console.log(`✓ Password updated`);

      await client.query("COMMIT");
      console.log(`\n🔑 Login: email=${EMAIL}  password=${PASSWORD}`);
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

    // 4. Create tenant_user with password
    const hash = await bcrypt.hash(PASSWORD, 10);
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
