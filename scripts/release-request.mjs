#!/usr/bin/env node

import { appendFile, lstat, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const ALLOWED_FIELDS = new Set([
  "schema_version",
  "product",
  "channel",
  "version",
  "release_tag",
  "source_repository",
  "source_sha",
  "source_ref",
  "requested_at",
  "updater_public_key_sha256",
]);
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const UPDATER_PUBLIC_KEY_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CORE_VERSION = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)";
const STABLE_VERSION_PATTERN = new RegExp(`^${CORE_VERSION}$`);
const PREVIEW_VERSION_PATTERN = new RegExp(`^${CORE_VERSION}-preview\\.(?:[1-9]\\d*)$`);

export class ReleaseRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseRequestError";
  }
}

function requireString(value, message) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReleaseRequestError(message);
  }
  return value;
}

export function validateReleaseRequest(request, { requestFilename } = {}) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new ReleaseRequestError("release request must be a JSON object");
  }

  for (const field of Object.keys(request)) {
    if (!ALLOWED_FIELDS.has(field)) {
      throw new ReleaseRequestError(`unexpected release request field: ${field}`);
    }
  }
  for (const field of ALLOWED_FIELDS) {
    if (!(field in request)) {
      throw new ReleaseRequestError(`missing release request field: ${field}`);
    }
  }

  if (request.schema_version !== 1) {
    throw new ReleaseRequestError("schema version must be 1");
  }
  if (request.product !== "zergmeeting-desktop") {
    throw new ReleaseRequestError("product must be zergmeeting-desktop");
  }
  if (request.channel !== "preview" && request.channel !== "stable") {
    throw new ReleaseRequestError("channel must be preview or stable");
  }

  const version = requireString(request.version, "version is required");
  if (request.channel === "stable" && !STABLE_VERSION_PATTERN.test(version)) {
    throw new ReleaseRequestError(
      "stable release versions must use MAJOR.MINOR.PATCH",
    );
  }
  if (request.channel === "preview" && !PREVIEW_VERSION_PATTERN.test(version)) {
    throw new ReleaseRequestError(
      "preview release versions must use MAJOR.MINOR.PATCH-preview.N",
    );
  }

  const expectedTag = request.channel === "stable"
    ? `zergmeeting-v${version}`
    : `zergmeeting-preview-v${version}`;
  if (request.release_tag !== expectedTag) {
    throw new ReleaseRequestError(`release tag must be ${expectedTag}`);
  }
  if (request.source_repository !== "Epoch-ML/zerg") {
    throw new ReleaseRequestError("source repository must be Epoch-ML/zerg");
  }
  if (!SOURCE_SHA_PATTERN.test(request.source_sha)) {
    throw new ReleaseRequestError(
      "source SHA must contain exactly 40 lowercase hexadecimal characters",
    );
  }

  const expectedRef = `refs/tags/${expectedTag}`;
  if (request.source_ref !== expectedRef) {
    throw new ReleaseRequestError(`source ref must be ${expectedRef}`);
  }
  let canonicalTimestamp = null;
  if (typeof request.requested_at === "string") {
    try {
      canonicalTimestamp = new Date(request.requested_at).toISOString();
    } catch {
      canonicalTimestamp = null;
    }
  }
  if (canonicalTimestamp !== request.requested_at) {
    throw new ReleaseRequestError(
      "release request timestamp must be canonical ISO-8601",
    );
  }

  if (!UPDATER_PUBLIC_KEY_SHA256_PATTERN.test(request.updater_public_key_sha256)) {
    throw new ReleaseRequestError(
      "updater public key SHA-256 must contain exactly 64 lowercase hexadecimal characters",
    );
  }

  const expectedFilename = `${expectedTag}.json`;
  if (requestFilename !== undefined && requestFilename !== expectedFilename) {
    throw new ReleaseRequestError(
      `request filename must be ${expectedFilename}`,
    );
  }

  return {
    channel: request.channel,
    requestedAt: request.requested_at,
    releaseTag: expectedTag,
    sourceRef: expectedRef,
    sourceRepository: request.source_repository,
    sourceSha: request.source_sha,
    updaterPublicKeySha256: request.updater_public_key_sha256,
    version,
  };
}

export async function validateRequestFile(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ReleaseRequestError(
      "request file must be a regular, non-symlink file",
    );
  }
  let request;
  try {
    request = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ReleaseRequestError("release request must contain valid JSON");
    }
    throw error;
  }
  return validateReleaseRequest(request, { requestFilename: basename(path) });
}

async function main() {
  const requestPath = process.argv[2];
  if (!requestPath) {
    throw new ReleaseRequestError("usage: release-request.mjs <request.json>");
  }
  const request = await validateRequestFile(requestPath);
  if (process.env.GITHUB_OUTPUT) {
    const outputs = [
      `channel=${request.channel}`,
      `requested_at=${request.requestedAt}`,
      `release_tag=${request.releaseTag}`,
      `source_ref=${request.sourceRef}`,
      `source_repository=${request.sourceRepository}`,
      `source_sha=${request.sourceSha}`,
      `updater_public_key_sha256=${request.updaterPublicKeySha256}`,
      `version=${request.version}`,
    ].join("\n");
    await appendFile(process.env.GITHUB_OUTPUT, `${outputs}\n`);
  }
  console.log(JSON.stringify(request));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`release-request: ${error.message}`);
    process.exitCode = 1;
  });
}
