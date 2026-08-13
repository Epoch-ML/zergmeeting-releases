import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { packageMacApplication } from "./package-macos.mjs";
import { prepareSourceStage } from "./source-stage.mjs";

const temporaryDirectories = [];
const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const previewKey = "preview updater trust root\n";

async function makeFixture(metadataOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "zergmeeting-source-stage-"));
  temporaryDirectories.push(root);
  const applicationPath = join(root, "application", "Zerg Meeting.app");
  await mkdir(join(applicationPath, "Contents", "MacOS"), { recursive: true });
  await writeFile(
    join(applicationPath, "Contents", "Info.plist"),
    "trusted tests parse this on the macOS runner\n",
  );
  const executable = join(applicationPath, "Contents", "MacOS", "zergmeeting");
  await writeFile(executable, "native bytes");
  await chmod(executable, 0o755);

  const inputDirectory = join(root, "input");
  const outputDirectory = join(root, "output");
  await mkdir(inputDirectory);
  const archiveName = "ZergMeeting_0.1.9-preview.1_aarch64.source.app.tar.gz";
  await packageMacApplication({
    applicationPath,
    outputPath: join(inputDirectory, archiveName),
  });
  await writeFile(join(inputDirectory, "updater.pubkey"), previewKey);
  await writeFile(join(root, "trusted.pubkey"), previewKey);
  await writeFile(join(inputDirectory, "build-metadata.json"), `${JSON.stringify({
    schema_version: 2,
    product: "Zerg Meeting",
    version: "0.1.9-preview.1",
    channel: "preview",
    release_tag: "zergmeeting-preview-v0.1.9-preview.1",
    source_sha: sourceSha,
    platform: "darwin-aarch64",
    apple_signature: "none",
    ...metadataOverrides,
  }, null, 2)}\n`);
  return {
    inputDirectory,
    outputDirectory,
    publicKeyPath: join(root, "trusted.pubkey"),
    request: {
      channel: "preview",
      releaseTag: "zergmeeting-preview-v0.1.9-preview.1",
      sourceSha,
      version: "0.1.9-preview.1",
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("hostile ZergMeeting source stage", () => {
  it("binds one unsigned app archive to the immutable request and channel key", async () => {
    const fixture = await makeFixture();
    const result = await prepareSourceStage({
      ...fixture,
      inputDirectory: `  ${fixture.inputDirectory}  `,
      outputDirectory: `  ${fixture.outputDirectory}  `,
      publicKeyPath: `  ${fixture.publicKeyPath}  `,
    });

    assert.equal(result.applicationPath, join(fixture.outputDirectory, "Zerg Meeting.app"));
    assert.equal(
      await readFile(join(result.applicationPath, "Contents", "MacOS", "zergmeeting"), "utf8"),
      "native bytes",
    );
    assert.equal(result.metadata.apple_signature, "none");
    assert.equal(result.metadata.source_sha, sourceSha);
  });

  it("rejects provenance, trust-root, and exact-input-set violations", async () => {
    const wrongSource = await makeFixture({
      source_sha: "abcdef0123456789abcdef0123456789abcdef01",
    });
    await assert.rejects(
      prepareSourceStage(wrongSource),
      /source-stage source SHA does not match the release request/,
    );

    const wrongKey = await makeFixture();
    await writeFile(
      join(wrongKey.inputDirectory, "updater.pubkey"),
      `${previewKey}\n`,
    );
    await assert.rejects(
      prepareSourceStage(wrongKey),
      /source-stage updater key does not match the channel trust root/,
    );

    const expectedNameLink = await makeFixture();
    await rm(join(expectedNameLink.inputDirectory, "updater.pubkey"));
    await symlink(
      "../trusted.pubkey",
      join(expectedNameLink.inputDirectory, "updater.pubkey"),
    );
    await assert.rejects(
      prepareSourceStage(expectedNameLink),
      /source-stage input contains unexpected entries: updater\.pubkey/,
    );

    const unexpectedRegular = await makeFixture();
    await writeFile(join(unexpectedRegular.inputDirectory, "extra.txt"), "extra");
    await assert.rejects(
      prepareSourceStage(unexpectedRegular),
      /source-stage input contains unexpected entries: extra\.txt/,
    );

    const linkedEntry = await makeFixture();
    await symlink(
      "build-metadata.json",
      join(linkedEntry.inputDirectory, "unexpected-link"),
    );
    await assert.rejects(
      prepareSourceStage(linkedEntry),
      /source-stage input contains unexpected entries: unexpected-link/,
    );

    const missingKey = await makeFixture();
    await rm(join(missingKey.inputDirectory, "updater.pubkey"));
    await assert.rejects(
      prepareSourceStage(missingKey),
      /source-stage input is missing required entries: updater\.pubkey/,
    );
  });

  it("rejects malformed boundary arguments and non-object metadata", async () => {
    const fixture = await makeFixture();
    const cases = [
      [{ ...fixture, inputDirectory: "  " }, /source-stage input directory is required/],
      [{ ...fixture, outputDirectory: null }, /source-stage output directory is required/],
      [{ ...fixture, publicKeyPath: 0 }, /channel updater trust root is required/],
      [{ ...fixture, request: undefined }, /release request version is required/],
    ];
    for (const [options, expected] of cases) {
      await assert.rejects(prepareSourceStage(options), expected);
    }

    const nullMetadata = await makeFixture();
    await writeFile(join(nullMetadata.inputDirectory, "build-metadata.json"), "null\n");
    await assert.rejects(
      prepareSourceStage(nullMetadata),
      /source-stage metadata schema or product is invalid/,
    );
  });

  it("rejects every source-stage metadata field that is not request-bound", async () => {
    const cases = [
      [{ schema_version: 1 }, /metadata schema or product is invalid/],
      [{ product: "Other" }, /metadata schema or product is invalid/],
      [{ version: "0.2.1" }, /source-stage version does not match/],
      [{ channel: "stable" }, /source-stage channel does not match/],
      [{ release_tag: "zergmeeting-preview-v0.2.1" }, /source-stage release tag does not match/],
      [{ platform: "darwin-arm64" }, /source-stage platform does not match/],
      [{ apple_signature: "developer-id" }, /source-stage Apple signature state does not match/],
    ];
    for (const [overrides, expected] of cases) {
      const fixture = await makeFixture(overrides);
      await assert.rejects(prepareSourceStage(fixture), expected);
    }

    const extraField = await makeFixture({ unbound_field: "hostile" });
    await assert.rejects(
      prepareSourceStage(extraField),
      /source-stage metadata contains unexpected fields: unbound_field/,
    );
  });
});
