#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MAX_SIGNATURE_DETAILS_BYTES = 1_048_576;

export class SourceSignatureError extends Error {
  constructor(message) {
    super(message);
    this.name = "SourceSignatureError";
  }
}

function fieldValues(lines, name) {
  const prefix = `${name}=`;
  return lines
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

export function verifySourceSignature(details, codesignExitCode) {
  if (typeof details !== "string") {
    throw new SourceSignatureError("codesign details must be text");
  }
  if (
    !Number.isSafeInteger(codesignExitCode) ||
    codesignExitCode < 0 ||
    codesignExitCode > 255
  ) {
    throw new SourceSignatureError("codesign exit code must be an integer from 0 to 255");
  }

  const lines = details.replaceAll("\r\n", "\n").split("\n");
  const authorities = fieldValues(lines, "Authority");
  if (authorities.length !== 0) {
    throw new SourceSignatureError(
      "source app contains an Authority signing identity",
    );
  }

  const teamIdentifiers = fieldValues(lines, "TeamIdentifier");
  if (
    teamIdentifiers.length > 1 ||
    (teamIdentifiers.length === 1 && teamIdentifiers[0] !== "not set")
  ) {
    throw new SourceSignatureError(
      "source app contains a TeamIdentifier signing identity",
    );
  }

  if (codesignExitCode === 0) {
    const signatures = fieldValues(lines, "Signature");
    if (signatures.length !== 1 || signatures[0] !== "adhoc") {
      throw new SourceSignatureError(
        "source app has an unrecognized successful codesign inspection",
      );
    }
    return { kind: "adhoc" };
  }

  const isUnsigned = lines.some((line) =>
    line.endsWith(": code object is not signed at all")
  );
  if (!isUnsigned) {
    throw new SourceSignatureError(
      "codesign could not establish an unsigned source app",
    );
  }
  return { kind: "unsigned" };
}

export async function verifySourceSignatureFile(path, codesignExitCode) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new SourceSignatureError(
      "codesign details must be a regular, non-symlink file",
    );
  }
  if (metadata.size > MAX_SIGNATURE_DETAILS_BYTES) {
    throw new SourceSignatureError("codesign details exceed the size limit");
  }
  return verifySourceSignature(await readFile(path, "utf8"), codesignExitCode);
}

function parseExitCode(raw) {
  if (!/^(?:0|[1-9]\d*)$/.test(raw ?? "")) {
    throw new SourceSignatureError(
      "codesign exit code must be an integer from 0 to 255",
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 255) {
    throw new SourceSignatureError(
      "codesign exit code must be an integer from 0 to 255",
    );
  }
  return value;
}

async function main() {
  if (process.argv.length !== 4) {
    throw new SourceSignatureError(
      "usage: verify-source-signature.mjs DETAILS_FILE CODESIGN_EXIT_CODE",
    );
  }
  const result = await verifySourceSignatureFile(
    process.argv[2],
    parseExitCode(process.argv[3]),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`verify-source-signature: ${error.message}`);
    process.exitCode = 1;
  });
}
