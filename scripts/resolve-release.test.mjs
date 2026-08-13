import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";

import {
  ReleaseResolutionError,
  resolveReleaseByTag,
  resolveReleaseFile,
} from "./resolve-release.mjs";

const execFileAsync = promisify(execFile);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

async function makeTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "zergmeeting-release-resolution-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("GitHub draft release resolution", () => {
  it("selects one exact draft tag across paginated results", () => {
    const draft = {
      id: 366160021,
      tag_name: "zergmeeting-preview-v0.2.0-preview.3",
      draft: true,
      prerelease: true,
      assets: [],
    };
    const pages = [
      [{ id: 1, tag_name: draft.tag_name + "-old", draft: false }],
      [draft, { id: 2, tag_name: "zergmeeting-v0.1.0", draft: false }],
    ];

    assert.deepEqual(resolveReleaseByTag(pages, draft.tag_name), draft);
    assert.equal(resolveReleaseByTag(pages, "zergmeeting-preview-v9.9.9"), null);
  });

  it("selects an exact published release with the same contract", () => {
    const published = {
      id: 42,
      tag_name: "zergmeeting-v1.2.3",
      draft: false,
      prerelease: false,
      immutable: true,
    };
    assert.deepEqual(resolveReleaseByTag([[published]], published.tag_name), published);
  });

  it("fails closed when more than one release has the exact tag", () => {
    const tag = "zergmeeting-preview-v0.2.0-preview.3";
    assert.throws(
      () => resolveReleaseByTag([
        [{ id: 1, tag_name: tag }],
        [{ id: 2, tag_name: tag }],
      ], tag),
      new ReleaseResolutionError(
        `release listing contains 2 exact matches for ${tag}`,
      ),
    );
  });

  it("rejects malformed pages, entries, and tags", () => {
    for (const pages of [null, {}, [], [[]]]) {
      if (Array.isArray(pages) && pages.every(Array.isArray)) continue;
      assert.throws(
        () => resolveReleaseByTag(pages, "zergmeeting-v1.0.0"),
        /array of API pages/,
      );
    }
    for (const entry of [null, [], "release", 7, {}]) {
      assert.throws(
        () => resolveReleaseByTag([[entry]], "zergmeeting-v1.0.0"),
        /non-object entry|missing tag_name/,
      );
    }
    for (const tag of [null, "", "zergmeeting-v1.0.0\n", 7]) {
      assert.throws(
        () => resolveReleaseByTag([[]], tag),
        /release tag must be non-empty text without controls/,
      );
    }
    assert.equal(new ReleaseResolutionError("problem").name, "ReleaseResolutionError");
  });

  it("resolves the bounded regular listing through the CLI", async () => {
    const directory = await makeTemporaryDirectory();
    const listingPath = join(directory, "releases.json");
    const tag = "zergmeeting-preview-v0.2.0-preview.3";
    await writeFile(listingPath, JSON.stringify([[{
      id: 366160021,
      tag_name: tag,
      draft: true,
    }]]));

    assert.equal((await resolveReleaseFile(listingPath, tag)).id, 366160021);
    const execution = await execFileAsync(process.execPath, [
      resolve("scripts", "resolve-release.mjs"),
      listingPath,
      tag,
    ]);
    assert.deepEqual(JSON.parse(execution.stdout), {
      id: 366160021,
      tag_name: tag,
      draft: true,
    });
    assert.equal(execution.stderr, "");

    const linkPath = join(directory, "releases-link.json");
    await symlink(listingPath, linkPath);
    await assert.rejects(
      resolveReleaseFile(linkPath, tag),
      /release listing must be a regular, non-symlink file/,
    );
    await writeFile(listingPath, "not-json");
    await assert.rejects(
      resolveReleaseFile(listingPath, tag),
      /release listing must contain valid JSON/,
    );
  });
});
