const express = require("express");
const { adminCount, createAdmin, findAdmin, verifyPassword } = require("../lib/auth");

const router = express.Router();

router.get("/status", async (req, res) => {
  const count = await adminCount();
  res.json({
    setupRequired: count === 0,
    loggedIn: Boolean(req.session && req.session.isAdmin),
  });
});

router.post("/setup", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 8) {
    return res
      .status(400)
      .json({ error: "Username and a password of at least 8 characters are required" });
  }

  const count = await adminCount();
  if (count > 0) {
    return res.status(400).json({ error: "An admin account already exists" });
  }

  await createAdmin(username, password);
  req.session.isAdmin = true;
  req.session.username = username;
  res.json({ ok: true });
});

router.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  const admin = await findAdmin(username || "");
  if (!admin || !(await verifyPassword(password || "", admin.passwordHash))) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  req.session.isAdmin = true;
  req.session.username = admin.username;
  res.json({ ok: true });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

module.exports = router;
