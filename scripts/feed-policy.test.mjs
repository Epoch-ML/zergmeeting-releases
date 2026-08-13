import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { feedDestinations, stageReleaseFeed } from "./feed-policy.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ZergMeeting feed publication policy", () => {
  it("derives only channel-scoped destinations", () => {
    assert.deepEqual(feedDestinations("stable", "1.2.3"), {
      latest: "stable/latest.json",
      metadata: "stable/releases/1.2.3.json",
    });
    assert.deepEqual(feedDestinations("preview", "1.2.3-preview.4"), {
      latest: "preview/latest.json",
      metadata: "preview/releases/1.2.3-preview.4.json",
    });
  });

  it("publishes into an otherwise empty channel-scoped site tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "zergmeeting-feed-policy-"));
    temporaryDirectories.push(root);
    const releaseDirectory = join(root, "release");
    const pagesDirectory = join(root, "pages");
    await mkdir(releaseDirectory, { recursive: true });
    await mkdir(pagesDirectory, { recursive: true });

    const manifest = Buffer.from('{"version":"1.2.3"}\n');
    const metadata = Buffer.from('{"source_sha":"0123456789abcdef0123456789abcdef01234567"}\n');
    await writeFile(join(releaseDirectory, "latest.json"), manifest);
    await writeFile(join(releaseDirectory, "release-metadata.json"), metadata);

    await stageReleaseFeed({
      channel: "stable",
      pagesDirectory,
      releaseDirectory,
      version: "1.2.3",
    });

    assert.deepEqual(await readFile(join(pagesDirectory, "stable", "latest.json")), manifest);
    assert.deepEqual(
      await readFile(join(pagesDirectory, "stable", "releases", "1.2.3.json")),
      metadata,
    );
  });

  it("rejects an unknown channel before writing", async () => {
    assert.throws(
      () => feedDestinations("nightly", "1.2.3"),
      /channel must be preview or stable/,
    );
  });

  it("refuses to replace immutable version metadata with different bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "zergmeeting-feed-conflict-"));
    temporaryDirectories.push(root);
    const releaseDirectory = join(root, "release");
    const pagesDirectory = join(root, "pages");
    const metadataDirectory = join(pagesDirectory, "stable", "releases");
    await mkdir(releaseDirectory, { recursive: true });
    await mkdir(metadataDirectory, { recursive: true });
    await writeFile(join(releaseDirectory, "latest.json"), '{"version":"1.2.3"}\n');
    await writeFile(
      join(releaseDirectory, "release-metadata.json"),
      '{"source_sha":"new"}\n',
    );
    await writeFile(
      join(metadataDirectory, "1.2.3.json"),
      '{"source_sha":"existing"}\n',
    );

    await assert.rejects(
      stageReleaseFeed({
        channel: "stable",
        pagesDirectory,
        releaseDirectory,
        version: "1.2.3",
      }),
      /refusing to replace immutable version metadata/,
    );
    assert.equal(
      await readFile(join(metadataDirectory, "1.2.3.json"), "utf8"),
      '{"source_sha":"existing"}\n',
    );
  });

  it("refuses to roll a channel feed back or replace the same version's bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "zergmeeting-feed-monotonic-"));
    temporaryDirectories.push(root);
    const releaseDirectory = join(root, "release");
    const pagesDirectory = join(root, "pages");
    const channelDirectory = join(pagesDirectory, "preview");
    await mkdir(releaseDirectory, { recursive: true });
    await mkdir(channelDirectory, { recursive: true });
    const current = '{"version":"2.0.0-preview.2","notes":"current"}\n';
    await writeFile(join(channelDirectory, "latest.json"), current);
    await writeFile(
      join(releaseDirectory, "release-metadata.json"),
      '{"version":"2.0.0-preview.1","channel":"preview"}\n',
    );

    for (const [version, manifest, message] of [
      ["2.0.0-preview.1", '{"version":"2.0.0-preview.1"}\n', "older than current"],
      ["2.0.0-preview.2", '{"version":"2.0.0-preview.2","notes":"changed"}\n', "different bytes"],
      ["2.0.0-preview.2+rebuilt", '{"version":"2.0.0-preview.2+rebuilt"}\n', "does not outrank"],
    ]) {
      await writeFile(join(releaseDirectory, "latest.json"), manifest);
      await assert.rejects(
        stageReleaseFeed({
          channel: "preview",
          pagesDirectory,
          releaseDirectory,
          version,
        }),
        new RegExp(message),
      );
      assert.equal(
        await readFile(join(channelDirectory, "latest.json"), "utf8"),
        current,
      );
    }
  });

  it("advances a channel feed only to a strictly newer semantic version", async () => {
    const root = await mkdtemp(join(tmpdir(), "zergmeeting-feed-forward-"));
    temporaryDirectories.push(root);
    const releaseDirectory = join(root, "release");
    const pagesDirectory = join(root, "pages");
    const channelDirectory = join(pagesDirectory, "preview");
    await mkdir(releaseDirectory, { recursive: true });
    await mkdir(channelDirectory, { recursive: true });
    await writeFile(
      join(channelDirectory, "latest.json"),
      '{"version":"2.0.0-preview.1"}\n',
    );
    const next = '{"version":"2.0.0-preview.2"}\n';
    await writeFile(join(releaseDirectory, "latest.json"), next);
    await writeFile(
      join(releaseDirectory, "release-metadata.json"),
      '{"version":"2.0.0-preview.2","channel":"preview"}\n',
    );

    await stageReleaseFeed({
      channel: "preview",
      pagesDirectory,
      releaseDirectory,
      version: "2.0.0-preview.2",
    });

    assert.equal(
      await readFile(join(channelDirectory, "latest.json"), "utf8"),
      next,
    );
  });
});
