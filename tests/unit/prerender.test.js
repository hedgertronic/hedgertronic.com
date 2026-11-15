// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { prerenderHomepage } from "../../tools/prerender.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readJSON = (file) => JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));
const site = readJSON("data/site.json");

describe("prerenderHomepage", () => {
  let html;
  let doc;
  let fetchSpy;

  beforeAll(async () => {
    // The build reads data from disk; any network fetch is a bug.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch called"));
    html = await prerenderHomepage(ROOT);
    doc = new JSDOM(html).window.document;
  });

  afterAll(() => {
    fetchSpy.mockRestore();
  });

  it("renders without network fetches and without error placeholders", () => {
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(html).not.toContain("Content not available.");
    expect(html).not.toContain("No items to display yet.");
  });

  it("renders every section from site.json in order, alternating backgrounds", () => {
    const sections = [...doc.querySelectorAll("main > section.content-section")];
    expect(sections.map((s) => s.id)).toEqual(site.sections.map((s) => s.id));
    sections.forEach((s, i) => expect(s.classList.contains("alt-bg")).toBe(i % 2 === 0));
    sections.forEach((s, i) => expect(s.querySelector("h2").textContent).toBe(site.sections[i].title));
  });

  it("renders one card per data item in each content subsection", () => {
    for (const section of site.sections.filter((s) => s.type === "content")) {
      const subsections = doc.querySelectorAll(`#${section.id} .subsection`);
      expect(subsections).toHaveLength(section.subsections.length);
      section.subsections.forEach((sub, i) => {
        const items = readJSON(sub.dataFile);
        const grid = subsections[i].querySelector(".content-grid-wrapper > .content-grid");
        expect(subsections[i].querySelector("h3").textContent).toBe(sub.title);
        expect(grid.children).toHaveLength(items.length);
        const cardClass = { projects: "project-card", tweets: "tweet-card", content: "content-card" }[sub.displayType];
        expect(grid.querySelectorAll(`:scope > .${cardClass}`)).toHaveLength(items.length);
      });
    }
  });

  it("renders the stats table, highlights and training cards", () => {
    const field = site.sections.find((s) => s.type === "stats");
    const el = doc.getElementById(field.id);
    const csv = readFileSync(path.join(ROOT, field.statsFile), "utf8").trim().split("\n").slice(1);
    const seasonRows = csv.filter((line) => /^\d{4},\d+ teams?,/.test(line));
    expect(el.querySelectorAll(".stats-category-btn")).toHaveLength(3);
    expect(el.querySelector(".stats-category-btn.active").dataset.category).toBe("Minors");
    expect(el.querySelectorAll(".stats-overview .stat-card-large")).toHaveLength(field.statsHighlights.length);
    expect(el.querySelectorAll(".stats-table tbody tr")).toHaveLength(seasonRows.length);
    expect(el.querySelectorAll(".stats-table tfoot tr").length).toBeGreaterThan(0);
    const videos = readJSON(field.trainingFile).filter((item) => item.type === "video");
    expect(el.querySelectorAll(".training-card")).toHaveLength(videos.length);
  });

  it("renders the personal cards", () => {
    const personal = readJSON(site.sections.find((s) => s.type === "personal").dataFile);
    const expected = ["reading", "listening", "chess"].filter((key) => personal[key]).length;
    expect(doc.querySelectorAll("#offtheClock .personal-card")).toHaveLength(expected);
  });

  it("fills the header, hero links and nav, and footer", () => {
    expect(doc.querySelectorAll("header .nav-links a[data-section]")).toHaveLength(site.sections.length);
    expect(doc.querySelectorAll(".hero-intro .social-links a")).toHaveLength(site.socials.length);
    expect(doc.querySelectorAll(".hero-nav .hero-nav-item")).toHaveLength(site.sections.length);
    expect(doc.querySelector("#about > .container").className).toBe("container rendered");
    expect(doc.querySelector("footer .theme-menu-trigger")).not.toBeNull();
  });

  it("keeps the hand-edited head and the headshot pre-paint script", () => {
    const template = readFileSync(path.join(ROOT, "index.html"), "utf8");
    const head = (text) => text.slice(0, text.indexOf("</head>"));
    expect(head(html)).toBe(head(template));
    expect(doc.querySelector(".hero-intro script").textContent).toContain("window.__themeHeadshot");
  });

  it("keeps lazy loading and referrer policy on card images, with canonical thumbnails", () => {
    const thumbs = [...doc.querySelectorAll("img.thumbnail")];
    expect(thumbs.length).toBeGreaterThan(0);
    thumbs.forEach((img) => {
      expect(img.getAttribute("loading")).toBe("lazy");
      expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    });
    expect(html).not.toContain("localhost:5173");
  });

  it("embeds the site config and per-section runtime inputs", () => {
    const state = JSON.parse(doc.getElementById("prerender-state").textContent);
    expect(state.config).toEqual(site);
    expect(Object.keys(state.sections)).toEqual(site.sections.map((s) => s.id));
    expect(state.sections.field.careerRows.Minors.Season).toBe("Minors Career");
    expect(state.sections.lab.previewThumbnails).toBe(true);
    expect(state.sections.writing.localeCounts).toBe(true);
    expect(typeof state.countFormat).toBe("string");
    // The state script sits just before script.js and cannot be closed early by its own text.
    expect(doc.getElementById("prerender-state").nextElementSibling.getAttribute("src")).toBe("/script.js");
  });

  it("refuses to prerender a page twice", async () => {
    await expect(prerenderHomepage(ROOT, { template: html })).rejects.toThrow(/already prerendered/);
  });
});

describe("prerenderHomepage with broken data", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "prerender-test-"));
    await cp(path.join(ROOT, "index.html"), path.join(dir, "index.html"));
    await cp(path.join(ROOT, "data"), path.join(dir, "data"), { recursive: true });
    await cp(path.join(ROOT, "assets/documents"), path.join(dir, "assets/documents"), { recursive: true });
    await unlink(path.join(dir, "data/media-press.json"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("fails instead of baking an error placeholder into the page", async () => {
    await expect(prerenderHomepage(dir)).rejects.toThrow(/media-press\.json/);
  });
});
