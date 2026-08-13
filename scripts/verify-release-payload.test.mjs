import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";

import { verifyReleasePayload } from "./verify-release-payload.mjs";

const execFileAsync = promisify(execFile);
const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const requestedAt = "2026-08-06T10:22:39.000Z";
const version = "0.2.0-preview.9";
const releaseTag = `zergmeeting-preview-v${version}`;
const releaseRepository = "Epoch-ML/zergmeeting-releases";
const updaterPublicKeySha256 = "a".repeat(64);
const temporaryDirectories = [];

function request() {
  return {
    channel: "preview",
    requestedAt,
    releaseTag,
    sourceRef: `refs/tags/${releaseTag}`,
    sourceRepository: "Epoch-ML/zerg",
    sourceSha,
    updaterPublicKeySha256,
    version,
  };
}

function rawRequest() {
  return {
    schema_version: 1,
    product: "zergmeeting-desktop",
    channel: "preview",
    version,
    release_tag: releaseTag,
    source_repository: "Epoch-ML/zerg",
    source_sha: sourceSha,
    source_ref: `refs/tags/${releaseTag}`,
    requested_at: requestedAt,
    updater_public_key_sha256: updaterPublicKeySha256,
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function makePayload(label, payloadRequest = request()) {
  const root = await mkdtemp(join(tmpdir(), "zergmeeting-release-payload-"));
  temporaryDirectories.push(root);
  const directory = join(root, "release");
  await mkdir(directory);
  const archiveName = `ZergMeeting_${payloadRequest.version}_aarch64.app.tar.gz`;
  const signatureName = `${archiveName}.sig`;
  const diskImageName = `ZergMeeting_${payloadRequest.version}_aarch64.dmg`;
  const archive = Buffer.from(`gzip archive bytes from ${label}`);
  const signature = Buffer.from(
    `untrusted comment: signature from tauri secret key\n${label.padEnd(96, "-")}\n`,
  ).toString("base64");
  const diskImage = Buffer.from(`disk image bytes from ${label}`);
  const artifacts = [
    { name: archiveName, bytes: archive },
    { name: signatureName, bytes: Buffer.from(`${signature}\n`) },
    { name: diskImageName, bytes: diskImage },
  ];
  for (const artifact of artifacts) {
    await writeFile(join(directory, artifact.name), artifact.bytes);
  }
  const artifactMetadata = artifacts.map((artifact) => ({
    name: artifact.name,
    sha256: sha256(artifact.bytes),
  }));
  const checksumLines = artifactMetadata
    .map((artifact) => `${artifact.sha256}  ${artifact.name}`)
    .sort();
  await writeFile(join(directory, "checksums.txt"), `${checksumLines.join("\n")}\n`);
  await writeFile(
    join(directory, "release-metadata.json"),
    `${JSON.stringify({
      schema_version: 1,
      product: "Zerg Meeting",
      version: payloadRequest.version,
      channel: payloadRequest.channel,
      platform: "darwin-aarch64",
      source_sha: payloadRequest.sourceSha,
      apple_notarized: payloadRequest.channel === "stable",
      artifacts: artifactMetadata,
    }, null, 2)}\n`,
  );
  await writeFile(
    join(directory, "latest.json"),
    `${JSON.stringify({
      version: payloadRequest.version,
      notes: "",
      pub_date: payloadRequest.requestedAt,
      platforms: {
        "darwin-aarch64": {
          signature,
          url:
            `https://github.com/${releaseRepository}/releases/download/` +
            `${encodeURIComponent(payloadRequest.releaseTag)}/${encodeURIComponent(archiveName)}`,
        },
      },
    }, null, 2)}\n`,
  );
  return {
    archive,
    archiveName,
    directory,
    diskImageName,
    root,
    signature,
    signatureName,
  };
}

async function rewriteJson(directory, name, update) {
  const path = join(directory, name);
  const value = JSON.parse(await readFile(path, "utf8"));
  update(value);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function replaceSignature(fixture, signature) {
  const signatureBytes = Buffer.from(`${signature}\n`);
  await writeFile(join(fixture.directory, fixture.signatureName), signatureBytes);
  const digest = sha256(signatureBytes);
  await rewriteJson(fixture.directory, "release-metadata.json", (metadata) => {
    metadata.artifacts.find(
      (artifact) => artifact.name === fixture.signatureName,
    ).sha256 = digest;
  });
  await rewriteJson(fixture.directory, "latest.json", (manifest) => {
    manifest.platforms["darwin-aarch64"].signature = signature;
  });
  const checksumPath = join(fixture.directory, "checksums.txt");
  const checksumLines = (await readFile(checksumPath, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => line.endsWith(`  ${fixture.signatureName}`)
      ? `${digest}  ${fixture.signatureName}`
      : line)
    .sort();
  await writeFile(checksumPath, `${checksumLines.join("\n")}\n`);
}

async function expectPayloadError(options, expectedMessage) {
  await assert.rejects(
    verifyReleasePayload(options),
    (error) => {
      assert.equal(error.name, "ReleasePayloadError");
      assert.equal(error.message, expectedMessage);
      return true;
    },
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

describe("canonical ZergMeeting release payload verification", () => {
  it("verifies exact artifact integrity and request provenance through API and CLI", async () => {
    const fixture = await makePayload("canonical release");
    const result = await verifyReleasePayload({
      directory: fixture.directory,
      releaseRepository,
      request: request(),
    });

    assert.equal(result.archiveName, fixture.archiveName);
    assert.equal(result.hashes[fixture.archiveName], sha256(fixture.archive));
    assert.deepEqual(result.assetNames, [
      `ZergMeeting_${version}_aarch64.app.tar.gz`,
      `ZergMeeting_${version}_aarch64.app.tar.gz.sig`,
      `ZergMeeting_${version}_aarch64.dmg`,
      "checksums.txt",
      "latest.json",
      "release-metadata.json",
    ].sort());

    const requestPath = join(fixture.root, `${releaseTag}.json`);
    await writeFile(requestPath, `${JSON.stringify(rawRequest(), null, 2)}\n`);
    const execution = await execFileAsync(process.execPath, [
      resolve("scripts", "verify-release-payload.mjs"),
      requestPath,
      fixture.directory,
      releaseRepository,
    ]);
    assert.deepEqual(JSON.parse(execution.stdout), { assetCount: 6 });
    assert.equal(execution.stderr, "");
    const optionalExecution = await execFileAsync(process.execPath, [
      resolve("scripts", "verify-release-payload.mjs"),
      requestPath,
      fixture.directory,
      releaseRepository,
      fixture.directory,
    ]);
    assert.deepEqual(JSON.parse(optionalExecution.stdout), { assetCount: 6 });
    assert.equal(optionalExecution.stderr, "");
  });

  it("accepts canonical immutable bytes when regenerated bytes differ but names match", async () => {
    const regenerated = await makePayload("retry regenerated at a later timestamp");
    const canonical = await makePayload("already published immutable release");
    const regeneratedResult = await verifyReleasePayload({
      directory: regenerated.directory,
      releaseRepository,
      request: request(),
    });
    const canonicalResult = await verifyReleasePayload({
      directory: canonical.directory,
      expectedNamesDirectory: regenerated.directory,
      releaseRepository,
      request: request(),
    });

    assert.notEqual(
      canonicalResult.hashes[canonical.archiveName],
      regeneratedResult.hashes[regenerated.archiveName],
    );
    assert.equal(
      canonicalResult.hashes[canonical.archiveName],
      sha256(canonical.archive),
    );
  });

  it("rejects corrupted bytes and plausible but wrong provenance", async () => {
    const corrupted = await makePayload("canonical release");
    await writeFile(join(corrupted.directory, corrupted.archiveName), "other gzip bytes");
    await assert.rejects(
      verifyReleasePayload({
        directory: corrupted.directory,
        releaseRepository,
        request: request(),
      }),
      /checksum does not match release artifact/,
    );

    const wrongSource = await makePayload("canonical release");
    const metadataPath = join(wrongSource.directory, "release-metadata.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    metadata.source_sha = "abcdef0123456789abcdef0123456789abcdef01";
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    await assert.rejects(
      verifyReleasePayload({
        directory: wrongSource.directory,
        releaseRepository,
        request: request(),
      }),
      /release metadata provenance does not match request/,
    );
  });

  it("rejects unsafe entries and canonical/regenerated name drift", async () => {
    const unsafe = await makePayload("canonical release");
    await symlink(
      join(unsafe.directory, unsafe.archiveName),
      join(unsafe.directory, "unexpected-link"),
    );
    await assert.rejects(
      verifyReleasePayload({
        directory: unsafe.directory,
        releaseRepository,
        request: request(),
      }),
      /release payload contains an unsafe entry: unexpected-link/,
    );

    const regenerated = await makePayload("retry regenerated");
    const canonical = await makePayload("canonical release");
    await writeFile(join(regenerated.directory, "unexpected.txt"), "extra");
    await assert.rejects(
      verifyReleasePayload({
        directory: canonical.directory,
        expectedNamesDirectory: regenerated.directory,
        releaseRepository,
        request: request(),
      }),
      /canonical and regenerated release asset names differ/,
    );
  });

  it("validates option, repository, request, and directory boundaries", async () => {
    const fixture = await makePayload("canonical release");
    const valid = {
      directory: fixture.directory,
      releaseRepository,
      request: request(),
    };
    await verifyReleasePayload({
      ...valid,
      directory: `  ${fixture.directory}  `,
      releaseRepository: `  ${releaseRepository}  `,
    });

    for (const directory of [null, 42, "  "]) {
      await expectPayloadError(
        { ...valid, directory },
        "release directory is required",
      );
    }
    for (const invalidRepository of [
      null,
      42,
      "  ",
    ]) {
      await expectPayloadError(
        { ...valid, releaseRepository: invalidRepository },
        "release repository is required",
      );
    }
    for (const invalidRepository of [
      "!Epoch-ML/zergmeeting-releases",
      "Epoch-ML/zergmeeting-releases!",
      "Epoch-ML/zergmeeting-releases/extra",
    ]) {
      await expectPayloadError(
        { ...valid, releaseRepository: invalidRepository },
        "release repository must use owner/name syntax",
      );
    }
    for (const invalidRequest of [null, "request", []]) {
      await expectPayloadError(
        { ...valid, request: invalidRequest },
        "validated release request is required",
      );
    }
    await expectPayloadError(
      { ...valid, expectedNamesDirectory: "  " },
      "expected-names directory must be non-empty",
    );
    await expectPayloadError(
      { ...valid, expectedNamesDirectory: 42 },
      "expected-names directory must be non-empty",
    );

    const filePath = join(fixture.root, "not-a-directory");
    await writeFile(filePath, "file");
    await expectPayloadError(
      { ...valid, directory: filePath },
      "release payload must be a real, non-symlink directory",
    );
    const directoryLink = join(fixture.root, "release-link");
    await symlink(fixture.directory, directoryLink);
    await expectPayloadError(
      { ...valid, directory: directoryLink },
      "release payload must be a real, non-symlink directory",
    );
    await expectPayloadError(
      { ...valid, expectedNamesDirectory: filePath },
      "expected-names payload must be a real, non-symlink directory",
    );
  });

  it("rejects unsafe names, role ambiguity, missing assets, and empty binaries", async () => {
    for (const unsafeName of ["!leading-invalid", "trailing-invalid!"]) {
      const fixture = await makePayload("canonical release");
      await writeFile(join(fixture.directory, unsafeName), "extra");
      await expectPayloadError(
        {
          directory: fixture.directory,
          releaseRepository,
          request: request(),
        },
        `release payload contains an unsafe entry: ${unsafeName}`,
      );
    }

    const directoryEntry = await makePayload("canonical release");
    await mkdir(join(directoryEntry.directory, "unexpected-directory"));
    await expectPayloadError(
      {
        directory: directoryEntry.directory,
        releaseRepository,
        request: request(),
      },
      "release payload contains an unsafe entry: unexpected-directory",
    );

    const noArchive = await makePayload("canonical release");
    await rename(
      join(noArchive.directory, noArchive.archiveName),
      join(noArchive.directory, "archive.bin"),
    );
    await expectPayloadError(
      {
        directory: noArchive.directory,
        releaseRepository,
        request: request(),
      },
      "release payload must contain exactly one updater archive and disk image",
    );

    const noDiskImage = await makePayload("canonical release");
    await rename(
      join(noDiskImage.directory, noDiskImage.diskImageName),
      join(noDiskImage.directory, "disk-image.bin"),
    );
    await expectPayloadError(
      {
        directory: noDiskImage.directory,
        releaseRepository,
        request: request(),
      },
      "release payload must contain exactly one updater archive and disk image",
    );

    for (const extraName of ["other.app.tar.gz", "other.dmg"]) {
      const ambiguous = await makePayload("canonical release");
      await writeFile(join(ambiguous.directory, extraName), "extra");
      await expectPayloadError(
        {
          directory: ambiguous.directory,
          releaseRepository,
          request: request(),
        },
        "release payload must contain exactly one updater archive and disk image",
      );
    }

    for (const [fixtureField, wrongName] of [
      ["archiveName", "ZergMeeting_9.9.9_aarch64.app.tar.gz"],
      ["diskImageName", "ZergMeeting_9.9.9_aarch64.dmg"],
    ]) {
      const wrongVersionName = await makePayload("canonical release");
      await rename(
        join(wrongVersionName.directory, wrongVersionName[fixtureField]),
        join(wrongVersionName.directory, wrongName),
      );
      await expectPayloadError(
        {
          directory: wrongVersionName.directory,
          releaseRepository,
          request: request(),
        },
        "release payload artifact names do not match the requested Apple Silicon build",
      );
    }

    const wrongSignatureName = await makePayload("canonical release");
    await rename(
      join(wrongSignatureName.directory, wrongSignatureName.signatureName),
      join(wrongSignatureName.directory, "other.sig"),
    );
    await assert.rejects(
      verifyReleasePayload({
        directory: wrongSignatureName.directory,
        releaseRepository,
        request: request(),
      }),
      /release payload asset names differ/,
    );

    for (const emptyName of ["archiveName", "signatureName", "diskImageName"]) {
      const empty = await makePayload("canonical release");
      await writeFile(join(empty.directory, empty[emptyName]), "");
      await expectPayloadError(
        {
          directory: empty.directory,
          releaseRepository,
          request: request(),
        },
        `release artifact is empty: ${empty[emptyName]}`,
      );
    }
  });

  it("enforces canonical checksum text, exact names, ordering, and bytes", async () => {
    const empty = await makePayload("canonical release");
    await writeFile(join(empty.directory, "checksums.txt"), "");
    await expectPayloadError(
      {
        directory: empty.directory,
        releaseRepository,
        request: request(),
      },
      "release artifact is empty: checksums.txt",
    );

    const oversized = await makePayload("canonical release");
    await writeFile(
      join(oversized.directory, "checksums.txt"),
      Buffer.alloc(1_048_577, 65),
    );
    await expectPayloadError(
      {
        directory: oversized.directory,
        releaseRepository,
        request: request(),
      },
      "release artifact exceeds size limit: checksums.txt",
    );

    for (const controlName of ["latest.json", "release-metadata.json"]) {
      const oversizedControl = await makePayload("canonical release");
      await truncate(
        join(oversizedControl.directory, controlName),
        1_048_577,
      );
      await expectPayloadError(
        {
          directory: oversizedControl.directory,
          releaseRepository,
          request: request(),
        },
        `release artifact exceeds size limit: ${controlName}`,
      );
    }

    const exactLimit = await makePayload("canonical release");
    await writeFile(
      join(exactLimit.directory, "checksums.txt"),
      `${"A".repeat(1_048_575)}\n`,
    );
    await expectPayloadError(
      {
        directory: exactLimit.directory,
        releaseRepository,
        request: request(),
      },
      "checksum manifest contains an invalid entry",
    );

    const oversizedBinary = await makePayload("canonical release");
    await truncate(
      join(oversizedBinary.directory, oversizedBinary.archiveName),
      536_870_913,
    );
    await expectPayloadError(
      {
        directory: oversizedBinary.directory,
        releaseRepository,
        request: request(),
      },
      `release artifact exceeds size limit: ${oversizedBinary.archiveName}`,
    );

    const oversizedSignature = await makePayload("canonical release");
    await truncate(
      join(oversizedSignature.directory, oversizedSignature.signatureName),
      1_048_577,
    );
    await expectPayloadError(
      {
        directory: oversizedSignature.directory,
        releaseRepository,
        request: request(),
      },
      `release artifact exceeds size limit: ${oversizedSignature.signatureName}`,
    );

    const oversizedTotal = await makePayload("canonical release");
    await truncate(
      join(oversizedTotal.directory, oversizedTotal.archiveName),
      536_870_912,
    );
    await truncate(
      join(oversizedTotal.directory, oversizedTotal.diskImageName),
      536_870_912,
    );
    await expectPayloadError(
      {
        directory: oversizedTotal.directory,
        releaseRepository,
        request: request(),
      },
      "release payload exceeds total size limit",
    );

    for (const transform of [
      (text) => text.trimEnd(),
      (text) => text.replaceAll("\n", "\r\n"),
    ]) {
      const nonCanonical = await makePayload("canonical release");
      const checksumPath = join(nonCanonical.directory, "checksums.txt");
      await writeFile(
        checksumPath,
        transform(await readFile(checksumPath, "utf8")),
      );
      await expectPayloadError(
        {
          directory: nonCanonical.directory,
          releaseRepository,
          request: request(),
        },
        "checksum manifest must use canonical LF text",
      );
    }

    for (const transform of [
      (line) => `!${line}`,
      (line) => `${line}!`,
    ]) {
      const malformed = await makePayload("canonical release");
      const checksumPath = join(malformed.directory, "checksums.txt");
      const lines = (await readFile(checksumPath, "utf8")).trimEnd().split("\n");
      lines[0] = transform(lines[0]);
      await writeFile(checksumPath, `${lines.join("\n")}\n`);
      await expectPayloadError(
        {
          directory: malformed.directory,
          releaseRepository,
          request: request(),
        },
        "checksum manifest contains an invalid entry",
      );
    }

    const duplicate = await makePayload("canonical release");
    const duplicatePath = join(duplicate.directory, "checksums.txt");
    const duplicateLines = (await readFile(duplicatePath, "utf8"))
      .trimEnd()
      .split("\n");
    duplicateLines[1] = duplicateLines[0];
    await writeFile(duplicatePath, `${duplicateLines.sort().join("\n")}\n`);
    await assert.rejects(
      verifyReleasePayload({
        directory: duplicate.directory,
        releaseRepository,
        request: request(),
      }),
      /checksum manifest artifact names differ/,
    );

    const unsorted = await makePayload("canonical release");
    const unsortedPath = join(unsorted.directory, "checksums.txt");
    const unsortedLines = (await readFile(unsortedPath, "utf8"))
      .trimEnd()
      .split("\n")
      .reverse();
    await writeFile(unsortedPath, `${unsortedLines.join("\n")}\n`);
    await expectPayloadError(
      {
        directory: unsorted.directory,
        releaseRepository,
        request: request(),
      },
      "checksum manifest entries must be sorted",
    );
  });

  it("validates every release-metadata trust and integrity field", async () => {
    const emptyMetadata = await makePayload("canonical release");
    await writeFile(join(emptyMetadata.directory, "release-metadata.json"), "");
    await expectPayloadError(
      {
        directory: emptyMetadata.directory,
        releaseRepository,
        request: request(),
      },
      "release artifact is empty: release-metadata.json",
    );

    const invalidJson = await makePayload("canonical release");
    await writeFile(join(invalidJson.directory, "release-metadata.json"), "{");
    await expectPayloadError(
      {
        directory: invalidJson.directory,
        releaseRepository,
        request: request(),
      },
      "release metadata must contain valid JSON",
    );

    for (const update of [
      () => null,
      (metadata) => ({ ...metadata, schema_version: 2 }),
      (metadata) => ({ ...metadata, product: "Other" }),
    ]) {
      const invalidSchema = await makePayload("canonical release");
      const metadataPath = join(invalidSchema.directory, "release-metadata.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      await writeFile(
        metadataPath,
        `${JSON.stringify(update(metadata), null, 2)}\n`,
      );
      await expectPayloadError(
        {
          directory: invalidSchema.directory,
          releaseRepository,
          request: request(),
        },
        "release metadata schema or product is invalid",
      );
    }

    for (const [field, value] of [
      ["version", "9.9.9"],
      ["channel", "stable"],
      ["platform", "darwin-arm64"],
      ["source_sha", "abcdef0123456789abcdef0123456789abcdef01"],
    ]) {
      const wrongProvenance = await makePayload("canonical release");
      await rewriteJson(
        wrongProvenance.directory,
        "release-metadata.json",
        (metadata) => {
          metadata[field] = value;
        },
      );
      await expectPayloadError(
        {
          directory: wrongProvenance.directory,
          releaseRepository,
          request: request(),
        },
        "release metadata provenance does not match request",
      );
    }

    const wrongNotarization = await makePayload("canonical release");
    await rewriteJson(
      wrongNotarization.directory,
      "release-metadata.json",
      (metadata) => {
        metadata.apple_notarized = true;
      },
    );
    await expectPayloadError(
      {
        directory: wrongNotarization.directory,
        releaseRepository,
        request: request(),
      },
      "release metadata Apple notarization is invalid",
    );

    const stableRequest = {
      ...request(),
      channel: "stable",
      releaseTag: "zergmeeting-v0.2.0",
      sourceRef: "refs/tags/zergmeeting-v0.2.0",
      version: "0.2.0",
    };
    const stable = await makePayload("stable canonical release", stableRequest);
    const stableResult = await verifyReleasePayload({
      directory: stable.directory,
      releaseRepository,
      request: stableRequest,
    });
    assert.equal(stableResult.archiveName, "ZergMeeting_0.2.0_aarch64.app.tar.gz");

    const nonArray = await makePayload("canonical release");
    await rewriteJson(nonArray.directory, "release-metadata.json", (metadata) => {
      metadata.artifacts = {};
    });
    await expectPayloadError(
      {
        directory: nonArray.directory,
        releaseRepository,
        request: request(),
      },
      "release metadata artifacts must be an array",
    );

    const invalidArtifactUpdates = [
      (metadata) => { metadata.artifacts[0] = null; },
      (metadata) => { metadata.artifacts[0] = "artifact"; },
      (metadata) => { metadata.artifacts[0] = []; },
      (metadata) => { metadata.artifacts[0].name = `!${metadata.artifacts[0].name}`; },
      (metadata) => { metadata.artifacts[0].name += "!"; },
      (metadata) => { metadata.artifacts[0].sha256 = `!${metadata.artifacts[0].sha256}`; },
      (metadata) => { metadata.artifacts[0].sha256 += "!"; },
    ];
    for (const update of invalidArtifactUpdates) {
      const invalidArtifact = await makePayload("canonical release");
      await rewriteJson(
        invalidArtifact.directory,
        "release-metadata.json",
        update,
      );
      await expectPayloadError(
        {
          directory: invalidArtifact.directory,
          releaseRepository,
          request: request(),
        },
        "release metadata contains an invalid artifact",
      );
    }

    const wrongDigest = await makePayload("canonical release");
    await rewriteJson(
      wrongDigest.directory,
      "release-metadata.json",
      (metadata) => {
        metadata.artifacts[0].sha256 = "0".repeat(64);
      },
    );
    await expectPayloadError(
      {
        directory: wrongDigest.directory,
        releaseRepository,
        request: request(),
      },
      `release metadata digest does not match artifact: ${wrongDigest.archiveName}`,
    );

    const duplicateArtifact = await makePayload("canonical release");
    await rewriteJson(
      duplicateArtifact.directory,
      "release-metadata.json",
      (metadata) => {
        metadata.artifacts[1] = { ...metadata.artifacts[0] };
      },
    );
    await assert.rejects(
      verifyReleasePayload({
        directory: duplicateArtifact.directory,
        releaseRepository,
        request: request(),
      }),
      /release metadata artifact names differ/,
    );
  });

  it("validates every updater-manifest provenance, platform, signature, and URL field", async () => {
    const emptyManifest = await makePayload("canonical release");
    await writeFile(join(emptyManifest.directory, "latest.json"), "");
    await expectPayloadError(
      {
        directory: emptyManifest.directory,
        releaseRepository,
        request: request(),
      },
      "release artifact is empty: latest.json",
    );

    const invalidJson = await makePayload("canonical release");
    await writeFile(join(invalidJson.directory, "latest.json"), "[");
    await expectPayloadError(
      {
        directory: invalidJson.directory,
        releaseRepository,
        request: request(),
      },
      "updater manifest must contain valid JSON",
    );

    for (const update of [
      () => null,
      (manifest) => ({ ...manifest, version: "9.9.9" }),
      (manifest) => ({ ...manifest, notes: "changed" }),
      (manifest) => ({ ...manifest, pub_date: "2026-08-06T10:22:40.000Z" }),
    ]) {
      const wrongProvenance = await makePayload("canonical release");
      const manifestPath = join(wrongProvenance.directory, "latest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      await writeFile(
        manifestPath,
        `${JSON.stringify(update(manifest), null, 2)}\n`,
      );
      await expectPayloadError(
        {
          directory: wrongProvenance.directory,
          releaseRepository,
          request: request(),
        },
        "updater manifest provenance does not match request",
      );
    }

    for (const platforms of [
      {},
      { "darwin-arm64": { signature: "value", url: "value" } },
      {
        "darwin-aarch64": { signature: "value", url: "value" },
        "darwin-arm64": { signature: "value", url: "value" },
      },
    ]) {
      const wrongPlatforms = await makePayload("canonical release");
      await rewriteJson(wrongPlatforms.directory, "latest.json", (manifest) => {
        manifest.platforms = platforms;
      });
      await assert.rejects(
        verifyReleasePayload({
          directory: wrongPlatforms.directory,
          releaseRepository,
          request: request(),
        }),
        /updater manifest platforms differ/,
      );
    }

    const nullPlatform = await makePayload("canonical release");
    await rewriteJson(nullPlatform.directory, "latest.json", (manifest) => {
      manifest.platforms["darwin-aarch64"] = null;
    });
    await expectPayloadError(
      {
        directory: nullPlatform.directory,
        releaseRepository,
        request: request(),
      },
      "updater manifest signature does not match the signature asset",
    );

    const wrongSignature = await makePayload("canonical release");
    await rewriteJson(wrongSignature.directory, "latest.json", (manifest) => {
      manifest.platforms["darwin-aarch64"].signature = "different";
    });
    await expectPayloadError(
      {
        directory: wrongSignature.directory,
        releaseRepository,
        request: request(),
      },
      "updater manifest signature does not match the signature asset",
    );

    const malformedSignatures = [
      ["A".repeat(32), "updater signature must be substantive base64"],
      ["A".repeat(33), "updater signature must be substantive base64"],
      [`!${"A".repeat(35)}`, "updater signature must be substantive base64"],
      [`${"A".repeat(35)}!`, "updater signature must be substantive base64"],
      [Buffer.alloc(31).toString("base64"), "updater signature must use canonical base64"],
      [Buffer.alloc(32).toString("base64"), "updater signature must use canonical base64"],
    ];
    const canonicalPadding = Buffer.alloc(40).toString("base64");
    const nonCanonicalPadding = `${canonicalPadding.slice(0, -3)}B==`;
    assert.notEqual(
      Buffer.from(nonCanonicalPadding, "base64").toString("base64"),
      nonCanonicalPadding,
    );
    malformedSignatures.push([
      nonCanonicalPadding,
      "updater signature must use canonical base64",
    ]);
    for (const [signature, expectedMessage] of malformedSignatures) {
      const malformed = await makePayload("canonical release");
      await replaceSignature(malformed, signature);
      await expectPayloadError(
        {
          directory: malformed.directory,
          releaseRepository,
          request: request(),
        },
        expectedMessage,
      );
    }

    const wrongUrl = await makePayload("canonical release");
    await rewriteJson(wrongUrl.directory, "latest.json", (manifest) => {
      manifest.platforms["darwin-aarch64"].url =
        "https://github.com/Epoch-ML/zergmeeting-releases/releases/download/other/file";
    });
    await expectPayloadError(
      {
        directory: wrongUrl.directory,
        releaseRepository,
        request: request(),
      },
      "updater manifest URL does not identify the immutable release archive",
    );
  });

  it("fails the CLI closed on missing or excess boundary arguments", async () => {
    const script = resolve("scripts", "verify-release-payload.mjs");
    const expectedStderr =
      "verify-release-payload: usage: verify-release-payload.mjs " +
      "REQUEST.json RELEASE_DIRECTORY OWNER/REPOSITORY " +
      "[EXPECTED_NAMES_DIRECTORY]\n";
    for (const arguments_ of [[], ["a", "b", "c", "d", "e"]]) {
      await assert.rejects(
        execFileAsync(process.execPath, [script, ...arguments_]),
        (error) => {
          assert.equal(error.code, 1);
          assert.equal(error.stdout, "");
          assert.equal(error.stderr, expectedStderr);
          return true;
        },
      );
    }
  });
});
