import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prerenderHomepage } from "../../tools/prerender.mjs";
import {
  countFormat,
  describeRuntimeInputs,
  hydrateHero,
  hydrateSections,
  isSectionStale,
  readPrerenderState,
} from "../../src/hydrate.js";
import { renderSection } from "../../src/sections.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readJSON = (file) => JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));
const site = readJSON("data/site.json");

/** fetch() served from the repo's data files, like the deployed site. */
function diskFetch(url) {
  const file = path.join(ROOT, new URL(url, "https://hedgertronic.com/").pathname);
  const body = readFileSync(file, "utf8");
  return Promise.resolve({ ok: true, text: async () => body, json: async () => JSON.parse(body) });
}

let prerendered;

beforeAll(async () => {
  prerendered = await prerenderHomepage(ROOT);
});

function loadPrerenderedBody() {
  const parsed = new DOMParser().parseFromString(prerendered, "text/html");
  document.body.innerHTML = parsed.body.innerHTML;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("hydrating the prerendered homepage on a production host", () => {
  let fetchMock;
  let state;

  async function hydrate() {
    vi.stubGlobal("location", { hostname: "hedgertronic.com" });
    fetchMock = vi.fn(() => Promise.reject(new Error("unexpected fetch")));
    vi.stubGlobal("fetch", fetchMock);
    loadPrerenderedBody();
    const sectionsBefore = [...document.querySelectorAll("main > section.content-section")];
    state = readPrerenderState();
    hydrateHero(state.config);
    await hydrateSections(state);
    return sectionsBefore;
  }

  it("needs no data fetches and keeps every prerendered section", async () => {
    const before = await hydrate();
    expect(before).toHaveLength(site.sections.length);
    expect(fetchMock).not.toHaveBeenCalled();
    const after = [...document.querySelectorAll("main > section.content-section")];
    expect(after).toEqual(before);
    expect(after.map((s) => s.id)).toEqual(site.sections.map((s) => s.id));
  });

  it("finishes the hero as renderHero does", async () => {
    await hydrate();
    expect(document.querySelector(".hero-intro script")).toBeNull();
    expect(document.querySelector("#about > .container").classList.contains("rendered")).toBe(true);
    expect(document.querySelector(".hero-name").textContent).toBe(site.profile.name);
  });

  it("wires the stats category selector", async () => {
    await hydrate();
    const college = document.querySelector('.stats-category-btn[data-category="College"]');
    college.click();
    expect(college.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector('.stats-category-btn[data-category="Minors"]').getAttribute("aria-pressed")).toBe("false");
    for (const row of document.querySelectorAll(".stats-table tbody tr, .stats-table tfoot tr")) {
      expect(row.style.display !== "none").toBe(row.dataset.category === "College");
    }
    expect(document.querySelector('.stat-value[data-stat="ERA"]').textContent).toBe(
      state.sections.field.careerRows.College.ERA,
    );
    expect(document.querySelector('th[data-column="team"]').textContent).toBe("Team");
    expect(document.querySelector("#field .subsection-header .view-all-link").textContent).toBe("View BBRef");
  });

  it("tracks carousel overflow on scroll", async () => {
    await hydrate();
    const grid = document.querySelector("#writing .content-grid-wrapper > .content-grid");
    Object.defineProperty(grid, "scrollWidth", { value: 800, configurable: true });
    Object.defineProperty(grid, "clientWidth", { value: 300, configurable: true });
    Object.defineProperty(grid, "scrollLeft", { value: 250, configurable: true });
    grid.dispatchEvent(new Event("scroll"));
    expect(grid.parentElement.className).toBe("content-grid-wrapper has-overflow-right has-overflow-left");
  });

  it("falls back when a thumbnail or training poster fails to load", async () => {
    await hydrate();
    const thumb = document.querySelector("img.thumbnail");
    thumb.dispatchEvent(new Event("error"));
    expect(thumb.style.display).toBe("none");
    expect(thumb.parentElement.classList.contains("thumbnail-error")).toBe(true);

    const poster = document.querySelector(".training-bg-wrapper > img");
    const card = poster.closest(".training-card");
    poster.dispatchEvent(new Event("error"));
    expect(card.querySelector(".training-bg-wrapper")).toBeNull();
    expect(card.classList.contains("no-poster")).toBe(true);
  });
});

describe("stale sections", () => {
  it("re-renders a section whose thumbnails differ on a preview host, fetching only its data", async () => {
    vi.stubGlobal("location", { hostname: "localhost" });
    const fetchMock = vi.fn(diskFetch);
    vi.stubGlobal("fetch", fetchMock);
    loadPrerenderedBody();
    const field = document.getElementById("field");
    const state = readPrerenderState();
    await hydrateSections(state);

    const lab = site.sections.find((s) => s.id === "lab");
    expect(fetchMock.mock.calls.map(([url]) => url).sort()).toEqual(
      lab.subsections.map((s) => "/" + s.dataFile).sort(),
    );
    expect(document.querySelector("#lab").innerHTML).toContain("localhost:5173");
    expect(document.getElementById("field")).toBe(field);
  });

  it("re-renders sections whose counts would print differently in this locale", () => {
    const inputs = describeRuntimeInputs([readJSON("data/writing-shortform.json")]);
    vi.stubGlobal("location", { hostname: "hedgertronic.com" });
    expect(isSectionStale(inputs, countFormat())).toBe(false);
    expect(isSectionStale(inputs, "1.234.567")).toBe(countFormat() !== "1.234.567");
  });

  // Guards the prerender's record of date-dependent inputs: a section must be
  // flagged stale exactly when rendering it at a later time changes its markup.
  it("flags a section stale exactly when its New badges would change", async () => {
    vi.stubGlobal("location", { hostname: "hedgertronic.com" });
    vi.stubGlobal("fetch", diskFetch);
    vi.useFakeTimers({ toFake: ["Date"] });

    const render = async (section, index) => (await renderSection(section, index, site)).outerHTML;
    const day = 24 * 60 * 60 * 1000;
    const atNoon = (date, offsetDays) => {
      const [y, m, d] = date.split("-").map(Number);
      return new Date(y, m - 1, d, 12).getTime() + offsetDays * day;
    };
    const sectionFiles = (section) =>
      [section.trainingFile, section.dataFile, ...(section.subsections || []).map((s) => s.dataFile)].filter(Boolean);
    const sectionDates = (section) =>
      [...new Set(sectionFiles(section).flatMap((f) => [readJSON(f)].flat().map((item) => item.date)).filter(Boolean))].sort();

    // Prerender at a time when the newest dated item still carries its badge,
    // and check the state it recorded.
    const buildTime = atNoon(site.sections.flatMap(sectionDates).sort().at(-1), 2);
    vi.setSystemTime(buildTime);
    const html = await prerenderHomepage(ROOT);
    const state = JSON.parse(
      new DOMParser().parseFromString(html, "text/html").getElementById("prerender-state").textContent,
    );
    let checked = 0;
    let stale = 0;

    for (const [index, section] of site.sections.entries()) {
      const dates = sectionDates(section);
      if (dates.length === 0) continue;
      vi.setSystemTime(buildTime);
      const built = await render(section, index);
      const inputs = state.sections[section.id];

      for (const date of dates) {
        for (const offset of [-1, 0, 30, 31]) {
          vi.setSystemTime(atNoon(date, offset));
          const changed = (await render(section, index)) !== built;
          expect(isSectionStale(inputs, state.countFormat), `${section.id} at ${date}${offset >= 0 ? "+" : ""}${offset}d`).toBe(changed);
          checked += 1;
          if (changed) stale += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(stale).toBeGreaterThan(0);
  });
});
