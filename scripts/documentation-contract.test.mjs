import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

test("documents the phase-aware root feed and custom Pages deployment boundary", () => {
  for (const contract of [
    /cutover may contain only the root `\.nojekyll` and `index\.html` files/,
    /Each `preview` or `stable` subtree is optional/,
    /if present, must contain `latest\.json` plus at least one matching `releases\/VERSION\.json`/,
    /Live preflight requires at least one complete channel subtree/,
    /custom OIDC deployment client calls the GitHub Pages Deployments API/,
    /does not cancel a queued deployment/,
  ]) {
    assert.match(readme, contract);
  }
  assert.doesNotMatch(readme, /official Pages (?:deployment action|actions)/);
  assert.doesNotMatch(readme, /site\/(?:preview|stable)|latest-(?:stable|canary)\.json/);
});
