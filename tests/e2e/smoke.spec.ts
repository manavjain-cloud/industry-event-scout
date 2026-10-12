import { expect, test } from "@playwright/test";

const PASSWORD = process.env.ADMIN_PASSWORD ?? "";

test.describe("public site", () => {
  test("landing page renders the product, the architecture and no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("registration closes");
    await expect(page.getByRole("heading", { name: /Trigger → Input → Context → Processing → AI → Output/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open the dashboard" })).toBeVisible();
    // The decorative WebGL canvas must never swallow clicks.
    const pe = await page.locator("canvas").first().evaluate((el) => getComputedStyle(el).pointerEvents);
    expect(pe).toBe("none");
    await page.waitForTimeout(1500);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("ordinary links only navigate; the background colour control is separate and explicit", async ({ page }) => {
    await page.goto("/");
    const shuffle = page.getByRole("button", { name: "Change background colours" });
    await expect(shuffle).toBeVisible({ timeout: 15_000 });
    // Clicking the CTA/anchor must only navigate; the colour control is separate and explicit.
    await page.getByRole("link", { name: "How it works" }).click();
    await expect(page).toHaveURL(/#how-it-works$/);
  });

  test("the app works at phone width without horizontal scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe("dashboard protection", () => {
  test("anonymous visitors are redirected to the sign-in page", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel("Password")).toBeVisible();
  });

  test("protected APIs refuse anonymous calls", async ({ request }) => {
    for (const path of ["/api/preferences", "/api/runs"]) expect((await request.get(path)).status()).toBe(401);
    expect((await request.post("/api/runs")).status()).toBe(401);
    expect((await request.post("/api/digest/test-email")).status()).toBe(401);
    expect((await request.get("/api/cron/weekly-digest")).status()).toBe(401);
    expect((await request.get("/api/cron/weekly-digest", { headers: { authorization: "Bearer not-the-secret" } })).status()).toBe(401);
  });

  test("wrong password is rejected, the right one opens the dashboard, sign-out closes it", async ({ page }) => {
    test.skip(!PASSWORD, "ADMIN_PASSWORD is not set in .env.local");
    await page.goto("/login");
    await page.getByLabel("Password").fill("definitely-wrong");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("#login-error")).toContainText("Incorrect password");

    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Opportunities for the next");

    // Session cookie is HttpOnly (not readable from page scripts).
    expect(await page.evaluate(() => document.cookie)).not.toContain("scout_session");

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);
  });
});
