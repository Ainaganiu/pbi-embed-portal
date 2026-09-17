const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      portal_name TEXT NOT NULL DEFAULT 'Reports Portal',
      logo_data_uri TEXT,
      accent_color TEXT NOT NULL DEFAULT '#3b5bfd',
      pbi_tenant_id TEXT,
      pbi_client_id TEXT,
      pbi_client_secret_encrypted TEXT,
      llm_provider TEXT NOT NULL DEFAULT 'anthropic',
      llm_api_key_encrypted TEXT,
      llm_model TEXT,
      llm_api_base TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      report_id TEXT NOT NULL,
      dataset_id TEXT,
      schema_description TEXT,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Added after the table shipped, so it needs its own ALTER for existing
  // deployments rather than living in the CREATE above.
  await pool.query(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS problem_statement TEXT;`);

  // Split out of schema_description so an admin can paste focused metadata
  // for measures and columns separately, rather than one undifferentiated
  // blob -- and so the prompt can label each section for the model.
  await pool.query(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS measures_description TEXT;`);
  await pool.query(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS columns_description TEXT;`);
}

module.exports = { pool, migrate };
