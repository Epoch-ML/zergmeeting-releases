import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { extractSourceApplication } from "./package-macos.mjs";

function requireString(value, message) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(message);
  }
  return value.trim();
}

async function assertExactRegularFiles(directory, expectedNames) {
  const entries = await readdir(directory, { withFileTypes: true });
  const unexpected = entries
    .filter((entry) => !entry.isFile() || !expectedNames.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (unexpected.length !== 0) {
    throw new Error(
      "source-stage input contains unexpected entries: " + unexpected.join(", "),
    );
  }
  const actualNames = new Set(entries.map((entry) => entry.name));
  const missing = [...expectedNames].filter((name) => !actualNames.has(name)).sort();
  if (missing.length !== 0) {
    throw new Error("source-stage input is missing required entries: " + missing.join(", "));
  }
}

function assertMetadata(metadata, request) {
  if (metadata?.schema_version !== 2 || metadata.product !== "Zerg Meeting") {
    throw new Error("source-stage metadata schema or product is invalid");
  }
  const allowedFields = new Set([
    "apple_signature",
    "channel",
    "platform",
    "product",
    "release_tag",
    "schema_version",
    "source_sha",
    "version",
  ]);
  const unexpectedFields = Object.keys(metadata)
    .filter((name) => !allowedFields.has(name))
    .sort();
  if (unexpectedFields.length !== 0) {
    throw new Error(
      "source-stage metadata contains unexpected fields: " +
        unexpectedFields.join(", "),
    );
  }
  const expected = {
    version: request.version,
    channel: request.channel,
    release_tag: request.releaseTag,
    source_sha: request.sourceSha,
    platform: "darwin-aarch64",
    apple_signature: "none",
  };
  const labels = {
    apple_signature: "Apple signature state",
    channel: "channel",
    platform: "platform",
    release_tag: "release tag",
    source_sha: "source SHA",
    version: "version",
  };
  for (const [name, value] of Object.entries(expected)) {
    if (metadata[name] !== value) {
      throw new Error(
        `source-stage ${labels[name]} does not match the release request`,
      );
    }
  }
}

export async function prepareSourceStage(options) {
  const inputDirectory = resolve(requireString(
    options.inputDirectory,
    "source-stage input directory is required",
  ));
  const outputDirectory = resolve(requireString(
    options.outputDirectory,
    "source-stage output directory is required",
  ));
  const publicKeyPath = resolve(requireString(
    options.publicKeyPath,
    "channel updater trust root is required",
  ));
  const request = options.request;
  const version = requireString(request?.version, "release request version is required");
  const archiveName = `ZergMeeting_${version}_aarch64.source.app.tar.gz`;
  await assertExactRegularFiles(inputDirectory, new Set([
    archiveName,
    "build-metadata.json",
    "updater.pubkey",
  ]));

  const metadata = JSON.parse(
    await readFile(join(inputDirectory, "build-metadata.json"), "utf8"),
  );
  assertMetadata(metadata, request);
  const stagedKey = await readFile(join(inputDirectory, "updater.pubkey"));
  const trustedKey = await readFile(publicKeyPath);
  if (!stagedKey.equals(trustedKey)) {
    throw new Error("source-stage updater key does not match the channel trust root");
  }

  const extraction = await extractSourceApplication({
    archivePath: join(inputDirectory, archiveName),
    outputDirectory,
    maxArchiveBytes: options.maxArchiveBytes,
    maxEntryCount: options.maxEntryCount,
    maxFileBytes: options.maxFileBytes,
    maxUncompressedBytes: options.maxUncompressedBytes,
  });
  if (basename(extraction.applicationPath) !== "Zerg Meeting.app") {
    throw new Error("source-stage archive did not extract one Zerg Meeting.app");
  }
  return { ...extraction, metadata };
}
