#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateRequestFile } from "./release-request.mjs";
import { prepareSourceStage } from "./source-stage.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

function numericEnvironment(name, fallback) {
  const raw = process.env[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

async function main() {
  if (process.argv.length !== 5) {
    throw new Error(
      "usage: extract-macos-stage.mjs REQUEST.json INPUT_DIRECTORY OUTPUT_DIRECTORY",
    );
  }
  const [, , requestPath, inputDirectory, outputDirectory] = process.argv;
  const request = await validateRequestFile(requestPath);
  const publicKeyName = request.channel === "stable"
    ? "zergmeeting-stable-updater.pubkey"
    : "zergmeeting-preview-updater.pubkey";
  const result = await prepareSourceStage({
    inputDirectory,
    outputDirectory,
    publicKeyPath: resolve(scriptDirectory, "..", "keys", publicKeyName),
    request,
    maxArchiveBytes: numericEnvironment("ZERGMEETING_STAGE_MAX_ARCHIVE_BYTES", 1_073_741_824),
    maxEntryCount: numericEnvironment("ZERGMEETING_STAGE_MAX_ENTRY_COUNT", 16_384),
    maxFileBytes: numericEnvironment("ZERGMEETING_STAGE_MAX_FILE_BYTES", 536_870_912),
    maxUncompressedBytes: numericEnvironment(
      "ZERGMEETING_STAGE_MAX_UNCOMPRESSED_BYTES",
      2_147_483_648,
    ),
  });
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `app_path=${result.applicationPath}\n`);
  }
  process.stdout.write(`${JSON.stringify({
    applicationPath: result.applicationPath,
    entryCount: result.entryCount,
    uncompressedBytes: result.uncompressedBytes,
  })}\n`);
}

main().catch((error) => {
  console.error(`extract-macos-stage: ${error.message}`);
  process.exitCode = 1;
});
