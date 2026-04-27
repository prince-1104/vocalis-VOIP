/**
 * Seed script: Creates a "demo" tenant and an admin user for local dev.
 *
 * Usage:  npx dotenv-cli -e .env -- node lib/db/seed-demo-user.mjs
 * (run from project root)
 */

import pg from "pg";
import { randomBytes, scryptSync } from "node:crypto";

const { Pool } = pg;

/**
 * Hash a password using bcrypt-compatible $2a$ format via a manual approach.
 * Since bcryptjs isn't available here, we'll use pg's built-in crypt function
 * OR just use a raw SQL approach.
 * 
 * Actually — let's simply use the pg crypt + gen_salt extension, 
 * OR we can create a bcrypt hash inline using a pre-computed value.
 * 
 * Simplest: compute the hash and hardcode it.
 * For "Admin1234" with bcrypt cost 10, we generate it inline.
 */

// Use Node.js crypto to generate a bcrypt-compatible hash
// We'll use scrypt as a fallback and then let the login's bcrypt.compare work
// ACTUALLY: the login route uses bcryptjs.compare, so we need a proper bcrypt hash.
// Let's just compute it with a simple inline approach.

// Pre-computed bcrypt hash of "Admin1234" with cost 10
// We'll generate this dynamically by importing bcryptjs from its actual location in node_modules
async function hashPassword(password) {
  // Find bcryptjs from the pnpm store via the api-server's dependency chain
  const bcryptPath = await findBcrypt();
  if (bcryptPath) {
    const bcrypt = await import(bcryptPath);
    return bcrypt.default.hashSync(password, 10);
  }
  
  // Fallback: compute a hash using Node.js crypto that bcryptjs can verify
  // This won't work with bcryptjs.compare, so let's try a different approach
  throw new Error("Could not find bcryptjs. Please install it.");
}

async function findBcrypt() {
  // Try to find bcryptjs in common pnpm store locations
  const possiblePaths = [
    "bcryptjs",
    "../../node_modules/.pnpm/bcryptjs@3.0.2/node_modules/bcryptjs",
    "../../node_modules/.pnpm/bcryptjs@2.4.3/node_modules/bcryptjs",
  ];
  
  for (const p of possiblePaths) {
    try {
      await import(p);
      return p;
    } catch {}
  }
  return null;
}

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const needsSsl =
  process.env.DATABASE_SSL === "true" ||
  dbUrl.includes("sslmode=require") ||
  dbUrl.includes("sslmode=verify");

const pool = new Pool({
  connectionString: dbUrl,
  ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

async function main() {
  // Generate bcrypt hash
  let passwordHash;
  try {
    passwordHash = await hashPassword("Admin1234");
  } catch {
    // If bcryptjs is not available, use pgcrypto extension
    console.log("  bcryptjs not found, will use pgcrypto in PostgreSQL...");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // If we couldn't hash with bcryptjs, try pgcrypto
    if (!passwordHash) {
      try {
        await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
        const hashRes = await client.query(
          `SELECT crypt($1, gen_salt('bf', 10)) as hash`,
          ["Admin1234"]
        );
        passwordHash = hashRes.rows[0].hash;
        console.log("  Using pgcrypto for password hashing");
      } catch (err) {
        console.error("  pgcrypto extension not available:", err.message);
        console.error("  Cannot hash password. Aborting.");
        process.exit(1);
      }
    }

    // 1. Insert into "users" table (the owner)
    let ownerRow = await client.query(
      `SELECT id FROM users WHERE email = $1 LIMIT 1`,
      ["admin@demo.com"]
    );

    let ownerId;
    if (ownerRow.rows.length > 0) {
      ownerId = ownerRow.rows[0].id;
      console.log(`  Owner user already exists, id = ${ownerId}`);
    } else {
      const insertRes = await client.query(
        `INSERT INTO users (email, name, is_superadmin)
         VALUES ($1, $2, true)
         RETURNING id`,
        ["admin@demo.com", "Demo Admin"]
      );
      ownerId = insertRes.rows[0].id;
      console.log(`✔ Created owner user, id = ${ownerId}`);
    }

    // 2. Upsert "demo" tenant
    const tenantRes = await client.query(
      `INSERT INTO tenants (name, slug, status, owner_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO UPDATE SET owner_id = EXCLUDED.owner_id, status = 'active'
       RETURNING id`,
      ["Demo Workspace", "demo", "active", ownerId]
    );
    const tenantId = tenantRes.rows[0].id;
    console.log(`✔ Tenant "demo" id = ${tenantId}`);

    // 3. Upsert tenant_user (admin)
    await client.query(
      `INSERT INTO tenant_users (tenant_id, user_id, role, email, name, password_hash, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (tenant_id, email)
       DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin', is_active = true, user_id = EXCLUDED.user_id`,
      [tenantId, ownerId, "admin", "admin@demo.com", "Demo Admin", passwordHash]
    );
    console.log(`✔ Tenant user "admin@demo.com" created/updated (role=admin)`);

    await client.query("COMMIT");
    console.log("\n🎉 Seed complete! You can now sign in with:");
    console.log("   Email:          admin@demo.com");
    console.log("   Password:       Admin1234");
    console.log("   Workspace Slug: demo");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Seed failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
