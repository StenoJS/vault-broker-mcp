// Thin wrapper so the login test can be run as `node test-login.mjs`, with
// the actual username/password passed in via env vars set by
// test-login.sh — never as literal text anywhere Claude writes.
import { performLogin } from "./login.js";

const { LOGIN_URL: url, LOGIN_USERNAME: username, LOGIN_PASSWORD: password } = process.env;

if (!url || !username || !password) {
  console.error("Missing LOGIN_URL/LOGIN_USERNAME/LOGIN_PASSWORD env vars.");
  process.exit(1);
}

const result = await performLogin({ url, username, password });
console.log(JSON.stringify({ success: result.success, finalUrl: result.finalUrl, reason: result.reason }, null, 2));
process.exit(result.success ? 0 : 1);
