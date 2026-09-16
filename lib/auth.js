const bcrypt = require("bcryptjs");
const { pool } = require("./db");

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

async function adminCount() {
  const result = await pool.query("SELECT COUNT(*)::int AS count FROM admin_users");
  return result.rows[0].count;
}

async function createAdmin(username, password) {
  const passwordHash = await hashPassword(password);
  await pool.query("INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)", [
    username,
    passwordHash,
  ]);
}

async function findAdmin(username) {
  const result = await pool.query(
    `SELECT id, username, password_hash AS "passwordHash" FROM admin_users WHERE username = $1`,
    [username]
  );
  return result.rows[0] || null;
}

/**
 * If ADMIN_USERNAME + ADMIN_PASSWORD are set, makes them the admin account —
 * creating it if none exists, or overwriting the existing one's username/
 * password otherwise. Env is authoritative whenever both are present, so
 * setting/changing these vars and restarting is how you set or reset the
 * admin password without a change-password UI. No-op if either is unset.
 */
async function syncAdminFromEnv() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) return;

  const passwordHash = await hashPassword(password);
  const existing = await pool.query("SELECT id FROM admin_users ORDER BY id LIMIT 1");

  if (existing.rows.length === 0) {
    await pool.query("INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)", [
      username,
      passwordHash,
    ]);
  } else {
    await pool.query("UPDATE admin_users SET username = $2, password_hash = $3 WHERE id = $1", [
      existing.rows[0].id,
      username,
      passwordHash,
    ]);
  }
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ error: "Not authenticated" });
}

module.exports = {
  hashPassword,
  verifyPassword,
  adminCount,
  createAdmin,
  findAdmin,
  syncAdminFromEnv,
  requireAdmin,
};
