#!/usr/bin/env node
/**
 * Renders the homepage's header, hero links, content sections and footer into
 * index.html at build time, so the first HTML response holds the whole page.
 *
 * It runs the client's own render functions (src/hero.js, src/sections.js)
 * against jsdom, serving their fetches from the data files on disk, and splices
 * the resulting markup into the page. It also embeds the site config and the
 * runtime-dependent inputs each section was rendered with (src/hydrate.js),
 * which the client uses to hydrate instead of fetching and rendering.
 *
 * Usage: node tools/prerender.mjs <siteDir> [--out <file>]
 *   Reads <siteDir>/index.html (the hand-edited page, not yet prerendered) and
 *   the data files under <siteDir>; writes to <file>, default <siteDir>/index.html.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

import { renderHeader, renderHero, renderFooter } from "../src/hero.js";
import { renderSections } from "../src/sections.js";
import { parseCSV } from "../src/data.js";
import { getCareerRows } from "../src/stats-table.js";
import { describeRuntimeInputs, countFormat, PRERENDER_STATE_ID } from "../src/hydrate.js";

// A production origin: cards render their canonical thumbnails, not the
// localhost-only previews.
const ORIGIN = "https://hedgertronic.com/";

/**
 * jsdom 23 has no `loading` or `referrerPolicy` IDL attributes on <img>, so the
 * card code's `img.loading = "lazy"` would never reach the markup. Reflect them
 * to their content attributes as browsers do.
 */
function reflectMissingImageAttributes(window) {
  const proto = window.HTMLImageElement.prototype;
  for (const [prop, attr] of [["loading", "loading"], ["referrerPolicy", "referrerpolicy"]]) {
    if (prop in proto) continue;
    Object.defineProperty(proto, prop, {
      configurable: true,
      get() {
        return this.getAttribute(attr) ?? "";
      },
      set(value) {
        this.setAttribute(attr, value);
      },
    });
  }
}

function installGlobals(values) {
  const saved = Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  return () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
}

function resolveInSite(siteDir, sitePath) {
  const root = path.resolve(siteDir);
  const file = path.resolve(root, "." + path.posix.normalize("/" + sitePath));
  if (file !== root && !file.startsWith(root + path.sep)) {
    throw new Error(`Path escapes the site directory: ${sitePath}`);
  }
  return file;
}

/** A fetch that serves site paths from siteDir and records every failure. */
function createFileFetch(siteDir, failures) {
  return async (url) => {
    const { pathname } = new URL(url, ORIGIN);
    try {
      const body = await readFile(resolveInSite(siteDir, decodeURIComponent(pathname)), "utf8");
      return {
        ok: true,
        status: 200,
        text: async () => body,
        json: async () => {
          try {
            return JSON.parse(body);
          } catch (error) {
            failures.push(`${pathname}: ${error.message}`);
            throw error;
          }
        },
      };
    } catch (error) {
      if (!failures.some((f) => f.startsWith(pathname))) failures.push(`${pathname}: ${error.message}`);
      throw error;
    }
  };
}

async function readSiteJSON(siteDir, sitePath) {
  return JSON.parse(await readFile(resolveInSite(siteDir, sitePath), "utf8"));
}

/** Per-section inputs the client checks before hydrating (see src/hydrate.js). */
async function describeSections(siteDir, config) {
  const sections = {};
  for (const section of config.sections) {
    const files = [
      section.trainingFile,
      section.dataFile,
      ...(section.subsections || []).map((subsection) => subsection.dataFile),
    ].filter(Boolean);
    const itemLists = await Promise.all(files.map((file) => readSiteJSON(siteDir, file)));
    const inputs = describeRuntimeInputs(itemLists);
    if (section.type === "stats") {
      const csv = await readFile(resolveInSite(siteDir, section.statsFile), "utf8");
      inputs.careerRows = getCareerRows(parseCSV(csv));
    }
    sections[section.id] = inputs;
  }
  return sections;
}

function replaceOnce(html, pattern, replacement, label) {
  const matches = html.match(new RegExp(pattern.source, "g")) || [];
  if (matches.length !== 1) {
    throw new Error(`index.html must contain exactly one ${label}; found ${matches.length}. Is it already prerendered?`);
  }
  // A string replacement is inserted verbatim (no `$` patterns); a function receives the match groups.
  return html.replace(pattern, typeof replacement === "function" ? replacement : () => replacement);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function literal(text) {
  return new RegExp(escapeRegExp(text));
}

/** Embeds JSON in a script element without letting its text close the element. */
function scriptJSON(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * Renders the homepage for siteDir and returns the full HTML.
 *
 * @param {string} siteDir - Directory laid out like the deployed site
 * @param {object} [options]
 * @param {string} [options.template] - Page HTML; defaults to <siteDir>/index.html
 * @returns {Promise<string>}
 */
export async function prerenderHomepage(siteDir, { template } = {}) {
  const html = template ?? (await readFile(path.join(siteDir, "index.html"), "utf8"));
  if (html.includes(`id="${PRERENDER_STATE_ID}"`)) {
    throw new Error("index.html is already prerendered; prerender the hand-edited page.");
  }
  const config = await readSiteJSON(siteDir, "data/site.json");

  // jsdom parses the page without running its scripts.
  const dom = new JSDOM(html, { url: ORIGIN });
  const { window } = dom;
  const { document } = window;
  reflectMissingImageAttributes(window);

  const failures = [];
  const restoreGlobals = installGlobals({
    window,
    document,
    location: window.location,
    localStorage: window.localStorage,
    fetch: createFileFetch(siteDir, failures),
  });

  try {
    // Same sequence as initSite in src/main.js.
    renderHeader(config);
    renderHero(config);
    await renderSections(config);
    renderFooter(config);
    // Let the carousels' deferred scroll-indicator reads run against jsdom.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    restoreGlobals();
  }

  if (failures.length > 0) {
    window.close();
    throw new Error(`Prerender could not load site data:\n  ${failures.join("\n  ")}`);
  }

  const heroContainer = document.querySelector("#about > .container");
  const main = document.querySelector("main");
  const parts = {
    header: document.querySelector("header").innerHTML,
    socialLinks: heroContainer.querySelector(".social-links").innerHTML,
    heroNav: heroContainer.querySelector(".hero-nav").innerHTML,
    heroContainerClass: heroContainer.className,
    sections: [...main.querySelectorAll(":scope > section.content-section")].map((el) => el.outerHTML),
    footer: document.querySelector("footer").innerHTML,
  };
  window.close();

  if (parts.sections.length !== config.sections.length) {
    throw new Error(`Rendered ${parts.sections.length} sections; site.json lists ${config.sections.length}.`);
  }

  const state = {
    config: await readSiteJSON(siteDir, "data/site.json"),
    countFormat: countFormat(),
    sections: await describeSections(siteDir, config),
  };

  let out = html;
  out = replaceOnce(out, literal("<header></header>"), `<header>${parts.header}</header>`, "empty <header>");
  out = replaceOnce(
    out,
    literal('<div class="social-links"></div>'),
    `<div class="social-links">${parts.socialLinks}</div>`,
    "empty .social-links",
  );
  out = replaceOnce(
    out,
    literal('<nav class="hero-nav"></nav>'),
    `<nav class="hero-nav">${parts.heroNav}</nav>`,
    "empty .hero-nav",
  );
  out = replaceOnce(
    out,
    /(<section id="about" class="hero">\s*<div class=")container(">)/,
    (_, open, close) => `${open}${parts.heroContainerClass}${close}`,
    "hero container",
  );
  // Sections follow the hero with no whitespace between them, as main.appendChild leaves them.
  out = replaceOnce(out, literal("</main>"), `${parts.sections.join("")}</main>`, "</main>");
  out = replaceOnce(out, literal("<footer></footer>"), `<footer>${parts.footer}</footer>`, "empty <footer>");
  out = replaceOnce(
    out,
    literal('<script defer src="/script.js"></script>'),
    `<script type="application/json" id="${PRERENDER_STATE_ID}">${scriptJSON(state)}</script>\n` +
      '    <script defer src="/script.js"></script>',
    "script.js tag",
  );
  return out;
}

async function main(argv) {
  const args = argv.slice(2);
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? args.splice(outIndex, 2)[1] : null;
  const [siteDir] = args;
  if (!siteDir || (outIndex >= 0 && !out) || args.length !== 1) {
    console.error("Usage: node tools/prerender.mjs <siteDir> [--out <file>]");
    process.exit(2);
  }
  const outFile = out || path.join(siteDir, "index.html");
  const html = await prerenderHomepage(siteDir);
  await writeFile(outFile, html);
  console.log(`Prerendered ${outFile} (${Buffer.byteLength(html)} bytes)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv).catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
