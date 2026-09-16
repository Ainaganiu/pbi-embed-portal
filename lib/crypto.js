// AES-256-GCM encryption for secrets (Power BI client secret, LLM API key)
// before they're written to Postgres. The key is derived by hashing
// SETTINGS_ENCRYPTION_KEY with SHA-256, so any string works as the env var
// (no base64/length requirements) — this matters because Render's
// `generateValue` for env vars produces an arbitrary random string, not
// necessarily valid base64.

const crypto = require("node:crypto");

function getKey() {
  const raw = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("SETTINGS_ENCRYPTION_KEY is not set");
  }
  return crypto.createHash("sha256").update(raw).digest();
}

function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

function decrypt(payload) {
  const key = getKey();
  const [ivB64, authTagB64, cipherB64] = payload.split(":");
  if (!ivB64 || !authTagB64 || !cipherB64) {
    throw new Error("Malformed encrypted payload");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(cipherB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

module.exports = { encrypt, decrypt };
