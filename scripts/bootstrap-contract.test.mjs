import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const requiredFiles = [
  ".github/workflows/policy-anchor.yml",
  ".github/workflows/policy.yml",
  ".github/workflows/release.yml",
  "README.md",
  "SECURITY.md",
  "keys/zergmeeting-preview-updater.pubkey",
  "keys/zergmeeting-stable-updater.pubkey",
  "macos/ZergMeeting.entitlements.plist",
  "scripts/anchored-policy.mjs",
  "scripts/repository-preflight.mjs",
  "scripts/workflow-policy.mjs",
];

describe("ZergMeeting public release boundary", () => {
  it("ships every independently reviewable trust-boundary component", () => {
    const missing = requiredFiles.filter((path) => !existsSync(path));
    assert.deepEqual(missing, [], `missing release-boundary files: ${missing.join(", ")}`);

    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    assert.match(workflow, /zapps\/zergmeeting/);
    assert.match(workflow, /zergmeeting-preview-updater/);
    assert.match(workflow, /ZergMeeting_\$\{VERSION\}_aarch64\.app\.tar\.gz/);
  });
});
