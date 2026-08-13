#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { validateRequestFile } from "./release-request.mjs";

const ASSET_NAME_PATTERN = /^[0-9A-Za-z._+-]+$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const REPOSITORY_PATTERN = /^[0-9A-Za-z_.-]+\/[0-9A-Za-z_.-]+$/;
const MAX_CONTROL_FILE_BYTES = 1_048_576;
const MAX_BINARY_FILE_BYTES = 536_870_912;
const MAX_TOTAL_PAYLOAD_BYTES = 1_073_741_824;

export class ReleasePayloadError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleasePayloadError";
  }
}

function requireText(value, message) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReleasePayloadError(message);
  }
  return value.trim();
}

function assertSameNames(actual, expected, message) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (left.length !== right.length || left.some((name, index) => name !== right[index])) {
    throw new ReleasePayloadError(
      `${message}: expected ${right.join(", ")}; found ${left.join(", ")}`,
    );
  }
}

async function readControlFile(path) {
  return readFile(path, "utf8");
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function listSafeAssetNames(directory, description) {
  const directoryMetadata = await lstat(directory);
  if (!directoryMetadata.isDirectory()) {
    throw new ReleasePayloadError(
      `${description} must be a real, non-symlink directory`,
    );
  }
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !ASSET_NAME_PATTERN.test(entry.name)) {
      throw new ReleasePayloadError(
        `${description} contains an unsafe entry: ${entry.name}`,
      );
    }
  }
  return entries.map((entry) => entry.name).sort();
}

function parseJson(text, description) {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ReleasePayloadError(`${description} must contain valid JSON`);
    }
    throw error;
  }
}

function maxAssetBytes(name) {
  if (
    name === "checksums.txt" ||
    name === "latest.json" ||
    name === "release-metadata.json" ||
    name.endsWith(".sig")
  ) {
    return MAX_CONTROL_FILE_BYTES;
  }
  return MAX_BINARY_FILE_BYTES;
}

function assertCanonicalBase64(value) {
  if (
    typeof value !== "string" ||
    value.length <= 32 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new ReleasePayloadError("updater signature must be substantive base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length <= 32 || decoded.toString("base64") !== value) {
    throw new ReleasePayloadError("updater signature must use canonical base64");
  }
}

export async function verifyReleasePayload(options) {
  const directory = resolve(requireText(
    options.directory,
    "release directory is required",
  ));
  const releaseRepository = requireText(
    options.releaseRepository,
    "release repository is required",
  );
  if (!REPOSITORY_PATTERN.test(releaseRepository)) {
    throw new ReleasePayloadError("release repository must use owner/name syntax");
  }
  const request = options.request;
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new ReleasePayloadError("validated release request is required");
  }

  const names = await listSafeAssetNames(directory, "release payload");
  if (options.expectedNamesDirectory !== undefined) {
    const expectedNamesDirectory = resolve(requireText(
      options.expectedNamesDirectory,
      "expected-names directory must be non-empty",
    ));
    const expectedNames = await listSafeAssetNames(
      expectedNamesDirectory,
      "expected-names payload",
    );
    assertSameNames(
      names,
      expectedNames,
      "canonical and regenerated release asset names differ",
    );
  }
  const archives = names.filter((name) => name.endsWith(".app.tar.gz"));
  const diskImages = names.filter((name) => name.endsWith(".dmg"));
  if (archives.length !== 1 || diskImages.length !== 1) {
    throw new ReleasePayloadError(
      "release payload must contain exactly one updater archive and disk image",
    );
  }
  const archiveName = archives[0];
  const signatureName = `${archiveName}.sig`;
  const diskImageName = diskImages[0];
  const expectedArchiveName = `ZergMeeting_${request.version}_aarch64.app.tar.gz`;
  const expectedDiskImageName = `ZergMeeting_${request.version}_aarch64.dmg`;
  if (archiveName !== expectedArchiveName || diskImageName !== expectedDiskImageName) {
    throw new ReleasePayloadError(
      "release payload artifact names do not match the requested Apple Silicon build",
    );
  }
  const binaryNames = [archiveName, signatureName, diskImageName];
  assertSameNames(
    names,
    [...binaryNames, "checksums.txt", "latest.json", "release-metadata.json"],
    "release payload asset names differ",
  );

  let totalPayloadBytes = 0;
  for (const name of names) {
    const metadata = await lstat(join(directory, name));
    if (metadata.size === 0) {
      throw new ReleasePayloadError(`release artifact is empty: ${name}`);
    }
    if (metadata.size > maxAssetBytes(name)) {
      throw new ReleasePayloadError(`release artifact exceeds size limit: ${name}`);
    }
    totalPayloadBytes += metadata.size;
    if (
      !Number.isSafeInteger(totalPayloadBytes) ||
      totalPayloadBytes > MAX_TOTAL_PAYLOAD_BYTES
    ) {
      throw new ReleasePayloadError("release payload exceeds total size limit");
    }
  }

  const hashes = new Map();
  for (const name of binaryNames) {
    hashes.set(name, await sha256(join(directory, name)));
  }

  const checksumsText = await readControlFile(
    join(directory, "checksums.txt"),
  );
  if (!checksumsText.endsWith("\n") || checksumsText.includes("\r")) {
    throw new ReleasePayloadError("checksum manifest must use canonical LF text");
  }
  const checksumLines = checksumsText.slice(0, -1).split("\n");
  const checksumNames = [];
  for (const line of checksumLines) {
    const match = /^([0-9a-f]{64})  ([0-9A-Za-z._+-]+)$/.exec(line);
    if (match === null) {
      throw new ReleasePayloadError("checksum manifest contains an invalid entry");
    }
    const [, digest, name] = match;
    if (hashes.get(name) !== digest) {
      throw new ReleasePayloadError(`checksum does not match release artifact: ${name}`);
    }
    checksumNames.push(name);
  }
  assertSameNames(
    checksumNames,
    binaryNames,
    "checksum manifest artifact names differ",
  );
  if (checksumLines.join("\n") !== [...checksumLines].sort().join("\n")) {
    throw new ReleasePayloadError("checksum manifest entries must be sorted");
  }

  const metadata = parseJson(
    await readControlFile(
      join(directory, "release-metadata.json"),
    ),
    "release metadata",
  );
  if (metadata?.schema_version !== 1 || metadata.product !== "Zerg Meeting") {
    throw new ReleasePayloadError("release metadata schema or product is invalid");
  }
  if (
    metadata.version !== request.version ||
    metadata.channel !== request.channel ||
    metadata.platform !== "darwin-aarch64" ||
    metadata.source_sha !== request.sourceSha
  ) {
    throw new ReleasePayloadError("release metadata provenance does not match request");
  }
  if (metadata.apple_notarized !== (request.channel === "stable")) {
    throw new ReleasePayloadError("release metadata Apple notarization is invalid");
  }
  if (!Array.isArray(metadata.artifacts)) {
    throw new ReleasePayloadError("release metadata artifacts must be an array");
  }
  const metadataNames = [];
  for (const artifact of metadata.artifacts) {
    if (
      artifact === null ||
      typeof artifact !== "object" ||
      Array.isArray(artifact) ||
      !ASSET_NAME_PATTERN.test(artifact.name ?? "") ||
      !DIGEST_PATTERN.test(artifact.sha256 ?? "")
    ) {
      throw new ReleasePayloadError("release metadata contains an invalid artifact");
    }
    if (hashes.get(artifact.name) !== artifact.sha256) {
      throw new ReleasePayloadError(
        `release metadata digest does not match artifact: ${artifact.name}`,
      );
    }
    metadataNames.push(artifact.name);
  }
  assertSameNames(
    metadataNames,
    binaryNames,
    "release metadata artifact names differ",
  );

  const manifest = parseJson(
    await readControlFile(join(directory, "latest.json")),
    "updater manifest",
  );
  if (
    manifest?.version !== request.version ||
    manifest.notes !== "" ||
    manifest.pub_date !== request.requestedAt
  ) {
    throw new ReleasePayloadError("updater manifest provenance does not match request");
  }
  const platformNames = Object.keys(manifest.platforms ?? {});
  assertSameNames(
    platformNames,
    ["darwin-aarch64"],
    "updater manifest platforms differ",
  );
  const signature = (
    await readControlFile(join(directory, signatureName))
  ).trim();
  assertCanonicalBase64(signature);
  const expectedUrl =
    `https://github.com/${releaseRepository}/releases/download/` +
    `${encodeURIComponent(request.releaseTag)}/${encodeURIComponent(archiveName)}`;
  for (const platformName of ["darwin-aarch64"]) {
    const platform = manifest.platforms[platformName];
    if (platform?.signature !== signature) {
      throw new ReleasePayloadError(
        "updater manifest signature does not match the signature asset",
      );
    }
    if (platform.url !== expectedUrl) {
      throw new ReleasePayloadError(
        "updater manifest URL does not identify the immutable release archive",
      );
    }
  }

  return {
    archiveName,
    assetNames: names,
    diskImageName,
    hashes: Object.fromEntries(hashes),
    signatureName,
  };
}

async function main() {
  if (process.argv.length !== 5 && process.argv.length !== 6) {
    throw new ReleasePayloadError(
      "usage: verify-release-payload.mjs REQUEST.json RELEASE_DIRECTORY OWNER/REPOSITORY [EXPECTED_NAMES_DIRECTORY]",
    );
  }
  const request = await validateRequestFile(process.argv[2]);
  const result = await verifyReleasePayload({
    directory: process.argv[3],
    expectedNamesDirectory: process.argv[5],
    releaseRepository: process.argv[4],
    request,
  });
  process.stdout.write(`${JSON.stringify({ assetCount: result.assetNames.length })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`verify-release-payload: ${error.message}`);
    process.exitCode = 1;
  });
}
