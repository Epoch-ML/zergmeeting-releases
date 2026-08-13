import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { compare, valid } from "semver";

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function feedDestinations(channel, version) {
  if (channel !== "preview" && channel !== "stable") {
    throw new Error("channel must be preview or stable");
  }
  if (typeof version !== "string" || !SEMVER_PATTERN.test(version)) {
    throw new Error("version must be strict SemVer without a v prefix");
  }
  return {
    latest: join(channel, "latest.json"),
    metadata: join(channel, "releases", `${version}.json`),
  };
}

export async function stageReleaseFeed({ channel, pagesDirectory, releaseDirectory, version }) {
  const destinations = feedDestinations(channel, version);
  const latestDestination = join(pagesDirectory, destinations.latest);
  const metadataDestination = join(pagesDirectory, destinations.metadata);
  await mkdir(dirname(latestDestination), { recursive: true });
  await mkdir(dirname(metadataDestination), { recursive: true });
  const metadataSource = join(releaseDirectory, "release-metadata.json");
  let existingMetadata = null;
  try {
    existingMetadata = await readFile(metadataDestination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (
    existingMetadata !== null &&
    !existingMetadata.equals(await readFile(metadataSource))
  ) {
    throw new Error(
      `refusing to replace immutable version metadata: ${destinations.metadata}`,
    );
  }

  const latestSource = join(releaseDirectory, "latest.json");
  const candidateLatest = await readFile(latestSource);
  let candidateManifest;
  try {
    candidateManifest = JSON.parse(candidateLatest.toString("utf8"));
  } catch {
    throw new Error("candidate latest manifest must contain valid JSON");
  }
  if (candidateManifest.version !== version) {
    throw new Error("candidate latest manifest version does not match the release");
  }

  let currentLatest = null;
  try {
    currentLatest = await readFile(latestDestination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (currentLatest !== null) {
    let currentManifest;
    try {
      currentManifest = JSON.parse(currentLatest.toString("utf8"));
    } catch {
      throw new Error("current channel manifest must contain valid JSON");
    }
    const currentVersion = currentManifest.version;
    if (
      typeof currentVersion !== "string" ||
      valid(currentVersion) !== currentVersion
    ) {
      throw new Error("current channel manifest version must be strict SemVer");
    }
    const precedence = compare(version, currentVersion);
    if (precedence < 0) {
      throw new Error(
        `candidate version ${version} is older than current ${currentVersion}`,
      );
    }
    if (precedence === 0 && version !== currentVersion) {
      throw new Error(
        `candidate version ${version} does not outrank current ${currentVersion}`,
      );
    }
    if (precedence === 0 && !candidateLatest.equals(currentLatest)) {
      throw new Error(
        `refusing to replace ${version} latest manifest with different bytes`,
      );
    }
  }

  await copyFile(metadataSource, metadataDestination);
  await copyFile(latestSource, latestDestination);
  return destinations;
}

async function main() {
  if (process.argv.length !== 6) {
    throw new Error(
      "usage: feed-policy.mjs CHANNEL VERSION RELEASE_DIRECTORY PAGES_DIRECTORY",
    );
  }
  const [, , channel, version, releaseDirectory, pagesDirectory] = process.argv;
  const result = await stageReleaseFeed({
    channel,
    pagesDirectory,
    releaseDirectory,
    version,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`feed-policy: ${error.message}`);
    process.exitCode = 1;
  });
}
