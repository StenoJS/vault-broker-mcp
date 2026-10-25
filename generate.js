// generate.js — server-side password generation. The generated value is only
// ever handed to `bw` (stdin) and never returned in a tool response.

import { randomInt } from "node:crypto";

// Ambiguous characters (0/O, 1/l/I) are left out on purpose. `$`, quotes,
// backslash and whitespace are never used, so the value survives shells,
// docker-compose interpolation and .env files unchanged.
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "!@#%^*-_=+";

export function generatePassword({ length = 24, symbols = false } = {}) {
  if (!Number.isInteger(length) || length < 16 || length > 128) {
    throw new Error("length must be an integer between 16 and 128");
  }
  const sets = [LOWER, UPPER, DIGITS, ...(symbols ? [SYMBOLS] : [])];
  const all = sets.join("");

  // One guaranteed character from every set, the rest from the union.
  const chars = sets.map((s) => s[randomInt(s.length)]);
  while (chars.length < length) chars.push(all[randomInt(all.length)]);

  // Fisher–Yates shuffle with a CSPRNG so the guaranteed ones don't sit first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
