#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MAX_RELEASE_LIST_BYTES = 16_777_216;

export class ReleaseResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseResolutionError";
  }
}

export function resolveReleaseByTag(pages, releaseTag) {
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new ReleaseResolutionError(
      "release listing must contain an array of API pages",
    );
  }
  if (
    typeof releaseTag !== "string" ||
    releaseTag.length === 0 ||
    /[\u0000-\u001f\u007f]/.test(releaseTag)
  ) {
    throw new ReleaseResolutionError("release tag must be non-empty text without controls");
  }

  const matches = [];
  for (const page of pages) {
    for (const release of page) {
      if (release === null || typeof release !== "object" || Array.isArray(release)) {
        throw new ReleaseResolutionError(
          "release listing contains a non-object entry",
        );
      }
      if (typeof release.tag_name !== "string") {
        throw new ReleaseResolutionError(
          "release listing entry is missing tag_name",
        );
      }
      if (release.tag_name === releaseTag) matches.push(release);
    }
  }

  if (matches.length > 1) {
    throw new ReleaseResolutionError(
      `release listing contains ${matches.length} exact matches for ${releaseTag}`,
    );
  }
  return matches[0] ?? null;
}

export async function resolveReleaseFile(path, releaseTag) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ReleaseResolutionError(
      "release listing must be a regular, non-symlink file",
    );
  }
  if (metadata.size > MAX_RELEASE_LIST_BYTES) {
    throw new ReleaseResolutionError("release listing exceeds the size limit");
  }

  let pages;
  try {
    pages = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ReleaseResolutionError("release listing must contain valid JSON");
    }
    throw error;
  }
  return resolveReleaseByTag(pages, releaseTag);
}

async function main() {
  if (process.argv.length !== 4) {
    throw new ReleaseResolutionError(
      "usage: resolve-release.mjs RELEASE_PAGES.json RELEASE_TAG",
    );
  }
  const release = await resolveReleaseFile(process.argv[2], process.argv[3]);
  process.stdout.write(`${JSON.stringify(release)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`resolve-release: ${error.message}`);
    process.exitCode = 1;
  });
}
