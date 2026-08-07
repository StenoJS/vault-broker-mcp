// login.js — does the actual page interaction. Isolated in its own module
// so the only two places that ever hold a plaintext password in memory are
// (a) the bw CLI child process, and (b) this function's local variables.
// Never log `password`. Never put it in a returned object.

import { chromium } from "playwright";

const USERNAME_SELECTORS = [
  'input[autocomplete="username"]',
  'input[name="username"]',
  'input[type="email"]',
  'input[name*="user" i]',
  'input[id*="user" i]',
];

const PASSWORD_SELECTORS = [
  'input[autocomplete="current-password"]',
  'input[type="password"]',
];

const SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("Log in")',
  'button:has-text("Sign in")',
  'button:has-text("Inloggen")',
];

async function firstMatch(page, selectors, timeout = 8000) {
  for (const sel of selectors) {
    const locator = page.locator(sel).first();
    try {
      await locator.waitFor({ state: "visible", timeout: timeout / selectors.length });
      return locator;
    } catch {
      // try next selector
    }
  }
  return null;
}

/**
 * @param {{url: string, username: string, password: string}} args
 * @returns {Promise<{success: boolean, finalUrl?: string, reason?: string}>}
 */
export async function performLogin({ url, username, password }) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: false });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });

    const userField = await firstMatch(page, USERNAME_SELECTORS);
    if (!userField) return { success: false, reason: "username field not found" };
    await userField.fill(username);

    const passField = await firstMatch(page, PASSWORD_SELECTORS);
    if (!passField) return { success: false, reason: "password field not found" };
    await passField.fill(password);

    const submitBtn = await firstMatch(page, SUBMIT_SELECTORS, 4000);
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await passField.press("Enter");
    }

    // Wait for either navigation or the password field to disappear —
    // rough success heuristic, good enough for a first pass.
    await Promise.race([
      page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {}),
      passField.waitFor({ state: "detached", timeout: 15000 }).catch(() => {}),
    ]);

    const stillOnPasswordField = await page.locator('input[type="password"]').count();
    const success = stillOnPasswordField === 0;

    return { success, finalUrl: page.url() };
  } finally {
    await browser.close();
  }
}
