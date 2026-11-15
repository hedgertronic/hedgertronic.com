import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prerenderHomepage } from "../../tools/prerender.mjs";

// The dev server serves the hand-edited index.html; these tests serve the page
// tools/prerender.mjs builds from it, as the deploy does.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const site = JSON.parse(readFileSync(path.join(ROOT, "data/site.json"), "utf8"));
// A non-local host, so cards keep their canonical thumbnails as in production.
const PROD_LIKE = "http://prerender.test";

let html;

test.beforeAll(async () => {
  html = await prerenderHomepage(ROOT);
});

/**
 * Serves the prerendered homepage at `origin` and its scripts, styles and data
 * from the dev server. Returns the list of data-file requests the page makes.
 */
async function servePrerendered(page, baseURL, origin) {
  const dataRequests = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/data/") || pathname.endsWith(".csv")) dataRequests.push(pathname);
  });
  const target = new URL(origin);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.host !== target.host) {
      // Third-party images and fonts are not under test.
      return url.hostname === "localhost" || url.hostname === "127.0.0.1" ? route.continue() : route.abort();
    }
    if (url.pathname === "/") {
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
    }
    // Images and fonts are not under test; skipping them keeps load off the
    // single-threaded dev server.
    if (["image", "font", "media"].includes(route.request().resourceType())) return route.abort();
    const response = await route.fetch({ url: new URL(url.pathname + url.search, baseURL).href });
    return route.fulfill({ response });
  });
  return dataRequests;
}

test.describe("Prerendered homepage without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("shows the hero and every section's content", async ({ page, baseURL }) => {
    const dataRequests = await servePrerendered(page, baseURL, PROD_LIKE);
    await page.goto(PROD_LIKE + "/");

    await expect(page.locator(".hero-name")).toBeVisible();
    await expect(page.locator(".hero-intro .social-links a")).toHaveCount(site.socials.length);
    await expect(page.locator(".hero-nav .hero-nav-item")).toHaveCount(site.sections.length);

    const sections = page.locator("main > section.content-section");
    await expect(sections).toHaveCount(site.sections.length);
    for (const section of site.sections) {
      const container = page.locator(`#${section.id} > .container`);
      await container.scrollIntoViewIfNeeded();
      await expect(container).toBeVisible();
      // Playwright counts opacity 0 as visible; the scroll reveal would leave it there.
      await expect(container).toHaveCSS("opacity", "1");
      await expect(container.locator("h2")).toHaveText(section.title);
    }
    await expect(page.locator('#field .stats-table tbody tr[data-category="Minors"]').first()).toBeVisible();
    await expect(page.locator("#writing .tweet-card").first()).toBeVisible();
    await expect(page.locator("#lab .project-card").first()).toBeVisible();
    await expect(page.locator("#offtheClock .personal-card").first()).toBeVisible();
    expect(dataRequests).toEqual([]);
  });
});

test.describe("Prerendered homepage with JavaScript", () => {
  test("hydrates without data fetches and keeps interactions working", async ({ page, baseURL }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const dataRequests = await servePrerendered(page, baseURL, PROD_LIKE);
    await page.goto(PROD_LIKE + "/");
    await page.waitForFunction(() => document.querySelector(".theme-switcher .theme-menu"));

    // The hero's inline headshot script is removed, as on the client-render path.
    await expect(page.locator(".hero-intro script")).toHaveCount(0);
    await expect(page.locator("main > section.content-section")).toHaveCount(site.sections.length);

    // Stats category selector.
    const college = page.getByRole("button", { name: /^College/ });
    await college.click();
    await expect(college).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('.stats-table tbody tr[data-category="College"]').first()).toBeVisible();
    await expect(page.locator('.stats-table tbody tr[data-category="Minors"]').first()).toBeHidden();
    await expect(page.locator("#field .subsection").first().locator(".view-all-link")).toHaveText("View BBRef");

    // Hero nav scrolls to its section, which reveals and shows the header.
    await page.locator('.hero-nav-item[data-section="writing"]').click();
    await expect(page.locator("#writing")).toHaveClass(/revealed/);
    await expect(page.locator("header")).toHaveClass(/visible/);

    // Theme picker switches the theme and the headshots.
    await page.locator(".theme-menu-trigger").click();
    await page.getByRole("option", { name: "Mets", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "mets");
    await expect(page.locator(".logo-headshot")).toHaveAttribute("src", site.profile.headshots.mets);
    await expect(page.locator(".hero-headshot")).toHaveAttribute("src", site.profile.headshots.mets);

    expect(dataRequests).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("applies a saved theme's headshot before and after hydration", async ({ page, baseURL }) => {
    await page.addInitScript(() => localStorage.setItem("theme", "phillies"));
    await servePrerendered(page, baseURL, PROD_LIKE);
    await page.goto(PROD_LIKE + "/");
    await page.waitForFunction(() => document.querySelector(".theme-switcher .theme-menu"));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "phillies");
    await expect(page.locator(".hero-headshot")).toHaveAttribute("src", site.profile.headshots.phillies);
    await expect(page.locator(".logo-headshot")).toHaveAttribute("src", site.profile.headshots.phillies);
    await expect(page.locator(".theme-menu-trigger")).toContainText("Phillies");
  });

  test("re-renders only sections that differ on a local host", async ({ page, baseURL }) => {
    const dataRequests = await servePrerendered(page, baseURL, baseURL);
    await page.goto("/");
    await page.waitForFunction(() => document.querySelector(".theme-switcher .theme-menu"));
    // Lab cards swap in localhost-only preview thumbnails, so only Lab refetches its data.
    const lab = site.sections.find((s) => s.id === "lab");
    expect([...dataRequests].sort()).toEqual(lab.subsections.map((s) => "/" + s.dataFile).sort());
    await expect(page.locator("main > section.content-section")).toHaveCount(site.sections.length);
    await expect(page.locator("#lab .content-card, #lab .project-card").first()).toBeVisible();
  });
});
