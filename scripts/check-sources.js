// Guards against a bug that shipped twice: regex source written through a
// layer that interprets "\b" turns the word boundary into a literal backspace
// byte (0x08). The file still parses, so `node --check` passes, but the regex
// can never match — the router silently sent every question down one path.
//
// Run: node scripts/check-sources.js

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIRS = ["lib", "routes", "public", "scripts"];
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

let failures = 0;
let scanned = 0;

function check(file) {
  const text = fs.readFileSync(file, "utf8");
  scanned += 1;
  text.split("\n").forEach((line, i) => {
    if (CONTROL.test(line)) {
      const codes = [...line]
        .filter((c) => CONTROL.test(c))
        .map((c) => "0x" + c.charCodeAt(0).toString(16).padStart(2, "0"));
      console.error(
        `${path.relative(ROOT, file)}:${i + 1}  control characters ${[...new Set(codes)].join(", ")}`
      );
      failures += 1;
    }
  });
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(js|html|css)$/.test(entry.name)) check(full);
  }
}

check(path.join(ROOT, "server.js"));
for (const d of DIRS) {
  const full = path.join(ROOT, d);
  if (fs.existsSync(full)) walk(full);
}

if (failures) {
  console.error(`\n${failures} line(s) contain stray control characters.`);
  process.exit(1);
}
console.log(`No stray control characters (${scanned} files scanned).`);
