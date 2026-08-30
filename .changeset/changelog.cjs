// Resilient changelog generator for Changesets.
//
// We want the enriched GitHub changelog (author + PR links from
// `@changesets/changelog-github`), but that generator hits the GitHub GraphQL
// API while `changeset version` runs, and that call is intermittently flaky
// ("Failed to parse data from GitHub" / "Premature close"). A transient blip
// there was hard-failing the entire Release Version workflow on merge.
//
// This wrapper keeps the enriched output on the happy path, retries a couple of
// times on failure, and finally falls back to the built-in changelog format so
// a network hiccup can never block a release.

const github = require("@changesets/changelog-github").default;
const fallback = require("@changesets/cli/changelog").default;

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function resilient(name, githubFn, fallbackFn, args) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await githubFn(...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[changesets] GitHub changelog enrichment (${name}) failed on attempt ${attempt}/${MAX_ATTEMPTS}: ${message}`,
      );
      if (attempt === MAX_ATTEMPTS) {
        console.warn(
          `[changesets] Falling back to the built-in changelog format for ${name}.`,
        );
        return fallbackFn(...args);
      }
      await sleep(BASE_DELAY_MS * attempt);
    }
  }
  // Unreachable: the final attempt either returns or falls back above.
  return fallbackFn(...args);
}

module.exports = {
  getReleaseLine: (changeset, type, options) =>
    resilient(
      "getReleaseLine",
      github.getReleaseLine,
      fallback.getReleaseLine,
      [changeset, type, options],
    ),
  getDependencyReleaseLine: (changesets, dependenciesUpdated, options) =>
    resilient(
      "getDependencyReleaseLine",
      github.getDependencyReleaseLine,
      fallback.getDependencyReleaseLine,
      [changesets, dependenciesUpdated, options],
    ),
};
