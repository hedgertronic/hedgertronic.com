/**
 * Homepage hydration: attaches behavior to the section markup that
 * tools/prerender.mjs renders into index.html at build time.
 *
 * The build renders with the same functions the client uses, at the build's
 * time, on a non-local host, in the build's locale. It records the inputs that
 * depend on those (see describeRuntimeInputs). A section whose inputs evaluate
 * differently here is re-rendered from its data files instead of hydrated, so
 * the DOM always matches what client-side rendering would produce.
 */

import { attachCarouselScrollDetection, isWithinDays, NEW_BADGE_DAYS } from "./ui.js";
import { bindThumbnailFallback, isPreviewHost } from "./cards.js";
import { bindPosterFallback, renderSection } from "./sections.js";
import { bindStatsCategorySelector } from "./stats-table.js";
import { getThemedHeadshot } from "./hero.js";

export const PRERENDER_STATE_ID = "prerender-state";

// Sample whose formatting shows whether this locale prints counts like the build did.
const COUNT_FORMAT_SAMPLE = 1234567;

export function countFormat() {
  return COUNT_FORMAT_SAMPLE.toLocaleString();
}

/** Returns the build's embedded state, or null when the page was not prerendered. */
export function readPrerenderState(doc = document) {
  const el = doc.getElementById(PRERENDER_STATE_ID);
  if (!el) return null;
  try {
    return JSON.parse(el.textContent);
  } catch (error) {
    console.error("Error reading prerender state:", error);
    return null;
  }
}

/**
 * Describes the runtime-dependent inputs of one section's cards.
 *
 * @param {Array<Array<object>>} itemLists - The section's card data arrays
 * @returns {{ newBadgeDates: Object<string, boolean>, previewThumbnails: boolean, localeCounts: boolean }}
 *   newBadgeDates maps each item date to whether it carried the "New" badge;
 *   previewThumbnails is true when a card swaps its image on a preview host;
 *   localeCounts is true when a card prints counts with toLocaleString.
 */
export function describeRuntimeInputs(itemLists) {
  const newBadgeDates = {};
  let previewThumbnails = false;
  let localeCounts = false;
  itemLists.forEach((items) => {
    if (!Array.isArray(items)) return;
    items.forEach((item) => {
      if (typeof item.date === "string" && item.date) {
        newBadgeDates[item.date] = isWithinDays(item.date, NEW_BADGE_DAYS);
      }
      if (item.thumbnailPreview) previewThumbnails = true;
      if (item.retweets !== undefined || item.likes !== undefined || item.bookmarks !== undefined) {
        localeCounts = true;
      }
    });
  });
  return { newBadgeDates, previewThumbnails, localeCounts };
}

/** True when rendering the section here would differ from the build's markup. */
export function isSectionStale(inputs, buildCountFormat) {
  if (!inputs) return false;
  if (inputs.previewThumbnails && isPreviewHost()) return true;
  if (inputs.localeCounts && countFormat() !== buildCountFormat) return true;
  return Object.entries(inputs.newBadgeDates || {}).some(
    ([date, wasNew]) => isWithinDays(date, NEW_BADGE_DAYS) !== wasNew,
  );
}

/** Applies to the static hero what renderHero applies to it on the client path. */
export function hydrateHero(config) {
  const heroSection = document.getElementById("about");
  if (!heroSection) return;
  const heroIntro = heroSection.querySelector(".hero-intro");
  if (heroIntro) {
    // The inline script has already set the themed headshot src.
    const inlineScript = heroIntro.querySelector("script");
    if (inlineScript) inlineScript.remove();
  }
  const heroImg = document.getElementById("hero-headshot-img");
  if (heroImg) {
    heroImg.src = getThemedHeadshot(config);
    heroImg.alt = config.profile.name;
  }
  const heroName = heroSection.querySelector(".hero-name");
  if (heroName) heroName.textContent = config.profile.name;
  const heroDescription = heroSection.querySelector(".hero-description");
  if (heroDescription) heroDescription.textContent = config.profile.bio;
  heroSection.querySelector(".container")?.classList.add("rendered");
}

// An image that already failed before this script ran never fires onerror again.
function runFallbackIfBroken(img) {
  if (img.getAttribute("src") && img.complete && img.naturalWidth === 0) img.onerror();
}

/** Attaches the behavior that section rendering attaches, to prerendered markup. */
export function hydrateSection(sectionEl, section, inputs) {
  sectionEl.querySelectorAll(".content-grid-wrapper > .content-grid").forEach((grid) => {
    attachCarouselScrollDetection(grid);
  });

  sectionEl.querySelectorAll(".thumbnail-wrapper > img.thumbnail").forEach((img) => {
    bindThumbnailFallback(img, img.parentElement);
    runFallbackIfBroken(img);
  });

  sectionEl.querySelectorAll(".training-card .training-bg-wrapper > img").forEach((img) => {
    bindPosterFallback(img, img.parentElement, img.closest(".training-card"));
    runFallbackIfBroken(img);
  });

  const categorySelector = sectionEl.querySelector(".stats-category-selector");
  if (categorySelector && inputs?.careerRows) {
    const subsection = categorySelector.closest(".subsection");
    bindStatsCategorySelector({
      categorySelector,
      table: subsection.querySelector(".stats-table"),
      statsOverview: subsection.querySelector(".stats-overview"),
      viewStatsLink: subsection.querySelector(".subsection-header .view-all-link"),
      careerRows: inputs.careerRows,
      statsLinks: section.statsLinks,
    });
  }
}

/**
 * Hydrates the prerendered sections in place, re-rendering any stale ones.
 * Resolves once every section is interactive.
 */
export async function hydrateSections(state) {
  const { config } = state;
  const main = document.querySelector("main");
  await Promise.all(
    config.sections.map(async (section, index) => {
      const sectionEl = document.getElementById(section.id);
      const inputs = state.sections?.[section.id];
      if (!sectionEl || sectionEl.parentElement !== main) return;
      if (isSectionStale(inputs, state.countFormat)) {
        const fresh = await renderSection(section, index, config);
        sectionEl.replaceWith(fresh);
      } else {
        hydrateSection(sectionEl, section, inputs);
      }
    }),
  );
}
