#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateRequestFile } from "./release-request.mjs";

const REPOSITORY_PATTERN = /^[0-9A-Za-z_.-]+\/[0-9A-Za-z_.-]+$/;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));

function requireString(value, message) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(message);
  }
  return value.trim();
}

async function exactlyOneFile(directory, predicate, description) {
  const entries = await readdir(directory, { withFileTypes: true });
  const matches = entries
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort();
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${description}; found ${matches.length}`);
  }
  return matches[0];
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function assertExactInputEntries(directory, expectedNames) {
  const entries = await readdir(directory, { withFileTypes: true });
  const unexpected = entries
    .filter((entry) => !entry.isFile() || !expectedNames.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (unexpected.length !== 0) {
    throw new Error(
      "release input contains unexpected entries: " + unexpected.join(", "),
    );
  }
  if (entries.length !== expectedNames.size) {
    throw new Error("release input is missing one or more required entries");
  }
}

function assertBuildMetadata(metadata, request) {
  if (metadata?.schema_version !== 1 || metadata.product !== "Zerg Meeting") {
    throw new Error("build metadata schema or product is invalid");
  }
  if (metadata.version !== request.version) {
    throw new Error("build version does not match the release request");
  }
  if (metadata.channel !== request.channel) {
    throw new Error("build channel does not match the release request");
  }
  if (metadata.release_tag !== request.releaseTag) {
    throw new Error("build release tag does not match the release request");
  }
  if (metadata.source_sha !== request.sourceSha) {
    throw new Error("build source SHA does not match the release request");
  }
  if (metadata.platform !== "darwin-aarch64") {
    throw new Error("build platform must be darwin-aarch64");
  }
  if (request.channel === "stable" && metadata.apple_notarized !== true) {
    throw new Error("stable release requires verified Apple notarization");
  }
  if (request.channel === "preview" && metadata.apple_notarized !== false) {
    throw new Error("preview build metadata must record no Apple notarization");
  }
}

export async function collectSignedRelease(options) {
  const inputDirectory = resolve(requireString(
    options.inputDirectory,
    "input directory is required",
  ));
  const outputDirectory = resolve(requireString(
    options.outputDirectory,
    "output directory is required",
  ));
  const publicKeyPath = resolve(requireString(
    options.publicKeyPath,
    "independent updater public key is required",
  ));
  const releaseRepository = requireString(
    options.releaseRepository,
    "release repository is required",
  );
  if (!REPOSITORY_PATTERN.test(releaseRepository)) {
    throw new Error("release repository must use owner/name syntax");
  }
  if (
    outputDirectory === "/" ||
    outputDirectory === inputDirectory ||
    inputDirectory.startsWith(`${outputDirectory}/`)
  ) {
    throw new Error("release output directory is unsafe");
  }

  const request = options.request;
  const buildMetadata = JSON.parse(
    await readFile(join(inputDirectory, "build-metadata.json"), "utf8"),
  );
  assertBuildMetadata(buildMetadata, request);

  const sourcePublicKey = await readFile(join(inputDirectory, "updater.pubkey"));
  const trustedPublicKey = await readFile(publicKeyPath);
  if (!sourcePublicKey.equals(trustedPublicKey)) {
    throw new Error(
      "source updater key does not match the independent release trust root",
    );
  }

  const archivePath = await exactlyOneFile(
    inputDirectory,
    (name) => name.endsWith(".app.tar.gz"),
    "macOS updater archive",
  );
  const expectedArchiveName = `ZergMeeting_${request.version}_aarch64.app.tar.gz`;
  if (basename(archivePath) !== expectedArchiveName) {
    throw new Error(`updater archive name must be ${expectedArchiveName}`);
  }
  const signaturePath = `${archivePath}.sig`;
  const signature = (await readFile(signaturePath, "utf8")).trim();
  if (signature === "") {
    throw new Error("updater signature must not be empty");
  }
  const diskImagePath = await exactlyOneFile(
    inputDirectory,
    (name) => name.endsWith(".dmg"),
    "macOS disk image",
  );
  const expectedDiskImageName = `ZergMeeting_${request.version}_aarch64.dmg`;
  if (basename(diskImagePath) !== expectedDiskImageName) {
    throw new Error(`disk image name must be ${expectedDiskImageName}`);
  }
  await assertExactInputEntries(inputDirectory, new Set([
    "build-metadata.json",
    "updater.pubkey",
    basename(archivePath),
    basename(signaturePath),
    basename(diskImagePath),
  ]));

  const archiveName = basename(archivePath);
  const archiveUrl = `https://github.com/${releaseRepository}/releases/download/${encodeURIComponent(
    request.releaseTag,
  )}/${encodeURIComponent(archiveName)}`;
  const manifest = {
    version: request.version,
    notes: "",
    pub_date: request.requestedAt,
    platforms: {
      "darwin-aarch64": {
        signature,
        url: archiveUrl,
      },
    },
  };

  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  const sourceArtifacts = [archivePath, signaturePath, diskImagePath];
  const assets = [];
  const checksums = [];
  const metadataArtifacts = [];
  for (const sourcePath of sourceArtifacts) {
    const name = basename(sourcePath);
    const destination = join(outputDirectory, name);
    await copyFile(sourcePath, destination);
    const digest = await sha256(destination);
    assets.push(destination);
    checksums.push(`${digest}  ${name}`);
    metadataArtifacts.push({ name, sha256: digest });
  }

  const checksumsPath = join(outputDirectory, "checksums.txt");
  await writeFile(checksumsPath, `${checksums.sort().join("\n")}\n`);
  const metadataPath = join(outputDirectory, "release-metadata.json");
  await writeFile(metadataPath, `${JSON.stringify({
    schema_version: 1,
    product: "Zerg Meeting",
    version: request.version,
    channel: request.channel,
    platform: "darwin-aarch64",
    source_sha: request.sourceSha,
    apple_notarized: buildMetadata.apple_notarized,
    artifacts: metadataArtifacts,
  }, null, 2)}\n`);
  await writeFile(
    join(outputDirectory, "latest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  return {
    assets: [...assets, checksumsPath, metadataPath],
    manifest,
  };
}

async function main() {
  if (process.argv.length !== 5) {
    throw new Error(
      "usage: collect-release.mjs REQUEST.json INPUT_DIRECTORY OUTPUT_DIRECTORY",
    );
  }
  const [, , requestPath, inputDirectory, outputDirectory] = process.argv;
  const request = await validateRequestFile(requestPath);
  const result = await collectSignedRelease({
    inputDirectory,
    outputDirectory,
    publicKeyPath: resolve(
      scriptDirectory,
      "..",
      "keys",
      request.channel === "stable"
        ? "zergmeeting-stable-updater.pubkey"
        : "zergmeeting-preview-updater.pubkey",
    ),
    releaseRepository: "Epoch-ML/zergmeeting-releases",
    request,
  });
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `release_dir=${resolve(outputDirectory)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ assetCount: result.assets.length })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`collect-release: ${error.message}`);
    process.exitCode = 1;
  });
}
