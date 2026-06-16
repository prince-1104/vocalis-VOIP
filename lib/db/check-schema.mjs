import pg from 'pg';

const dbUrl = "postgresql://postgres:kulbuXgiMZiIAHAmhGYQpBmOEvuIGfsz@acela.proxy.rlwy.net:41996/railway";

const pool = new pg.Pool({ connectionString: dbUrl });

async function check() {
  try {
    const configs = await pool.query('SELECT * FROM agent_configs');
    console.log('--- AGENT_CONFIGS ROWS ---');
    console.log(configs.rows);
    
    const users = await pool.query('SELECT id, name, email, is_superadmin FROM users');
    console.log('--- USERS ---');
    console.log(users.rows);

    const tenants = await pool.query('SELECT * FROM tenants');
    console.log('--- TENANTS ---');
    console.log(tenants.rows);

    const tenantUsers = await pool.query('SELECT * FROM tenant_users');
    console.log('--- TENANT_USERS ---');
    console.log(tenantUsers.rows);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

check();
