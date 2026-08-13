#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { auditWorkflowPolicy } from "./workflow-policy.mjs";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MAX_DIFF_BYTES = 262_144;
const MAX_WORKFLOW_BYTES = 262_144;
const CANDIDATE_WORKFLOW_PATH = ".github/workflows/release.yml";
const ROUTINE_PROTECTED_INPUT_PATHS = new Set([
  "package.json",
  "package-lock.json",
]);

export class AnchoredPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "AnchoredPolicyError";
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function diagnostic(code, message) {
  return { code, message };
}

function validChangedPaths(paths) {
  if (!Array.isArray(paths)) return false;
  let serializedBytes = 0;
  const uniquePaths = new Set();
  for (const path of paths) {
    if (
      typeof path !== "string" || path.length === 0 || path.length > 512 ||
      path.includes("\0") || path.startsWith("/") ||
      path.split("/").includes("..") || uniquePaths.has(path)
    ) return false;
    serializedBytes += Buffer.byteLength(path) + 1;
    if (serializedBytes > MAX_DIFF_BYTES) return false;
    uniquePaths.add(path);
  }
  return true;
}

function isProtectedPolicyPath(path) {
  if (path === CANDIDATE_WORKFLOW_PATH) return false;
  return path.startsWith("scripts/") ||
    path.startsWith("keys/") ||
    path.startsWith("macos/") ||
    path.startsWith(".github/");
}

function isRoutineProtectedInputPath(path) {
  return ROUTINE_PROTECTED_INPUT_PATHS.has(path);
}

export function auditAnchoredPullRequestData(input) {
  if (!isPlainObject(input)) {
    throw new AnchoredPolicyError("anchored pull request data must be an object");
  }
  const diagnostics = [];
  if (typeof input.routineProtectedChangeApproved !== "boolean") {
    diagnostics.push(diagnostic(
      "approval-boundary",
      "routine protected-input review must be an explicit boolean",
    ));
  }
  if (!SHA_PATTERN.test(input.baseSha) || !SHA_PATTERN.test(input.headSha)) {
    diagnostics.push(diagnostic(
      "immutable-sha-boundary",
      "base and head must be immutable lowercase commit SHAs",
    ));
  }
  if (!validChangedPaths(input.changedPaths)) {
    diagnostics.push(diagnostic(
      "diff-boundary",
      "the candidate diff path list exceeds its public bounds",
    ));
  } else if (input.changedPaths.some(isProtectedPolicyPath)) {
    diagnostics.push(diagnostic(
      "protected-policy-change",
      "protected-base policy code requires a separately audited bootstrap",
    ));
  } else if (
    input.changedPaths.some(isRoutineProtectedInputPath) &&
    input.routineProtectedChangeApproved !== true
  ) {
    diagnostics.push(diagnostic(
      "protected-input-review",
      "routine protected inputs require a head-bound independent review",
    ));
  }
  if (
    input.candidateMode !== "100644" ||
    !Number.isSafeInteger(input.candidateSize) ||
    input.candidateSize < 1 ||
    input.candidateSize > MAX_WORKFLOW_BYTES ||
    typeof input.candidateWorkflow !== "string" ||
    Buffer.byteLength(input.candidateWorkflow) !== input.candidateSize
  ) {
    diagnostics.push(diagnostic(
      "candidate-blob-boundary",
      "candidate release workflow must be one bounded regular Git blob",
    ));
  } else {
    try {
      const workflowDiagnostics = auditWorkflowPolicy(input.candidateWorkflow);
      if (workflowDiagnostics.length > 0) {
        diagnostics.push(diagnostic(
          "candidate-workflow",
          "candidate release workflow violates the protected-base contract",
        ));
      }
    } catch {
      diagnostics.push(diagnostic(
        "candidate-workflow",
        "candidate release workflow cannot be audited as YAML data",
      ));
    }
  }
  return diagnostics.sort((left, right) => left.code.localeCompare(right.code));
}

async function readBounded(path, maximum, description) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > maximum) {
    throw new AnchoredPolicyError(`${description} exceeds its byte boundary`);
  }
  return readFile(path);
}

async function main() {
  if (process.argv.length !== 9) {
    throw new AnchoredPolicyError(
      "usage: anchored-policy.mjs BASE_SHA HEAD_SHA DIFF_Z MODE SIZE CANDIDATE.yml ROUTINE_REVIEWED",
    );
  }
  const [, , baseSha, headSha, diffPath, candidateMode, candidateSizeText,
    candidatePath, routineReviewedText] = process.argv;
  if (routineReviewedText !== "true" && routineReviewedText !== "false") {
    throw new AnchoredPolicyError(
      "routine protected-input review must be true or false",
    );
  }
  const diff = await readBounded(diffPath, MAX_DIFF_BYTES, "candidate diff");
  if (diff.length > 0 && diff[diff.length - 1] !== 0) {
    throw new AnchoredPolicyError("candidate diff must be NUL terminated");
  }
  const changedPaths = diff.length === 0
    ? []
    : diff.toString("utf8").slice(0, -1).split("\0");
  const candidate = await readBounded(
    candidatePath,
    MAX_WORKFLOW_BYTES,
    "candidate workflow",
  );
  const diagnostics = auditAnchoredPullRequestData({
    baseSha,
    headSha,
    changedPaths,
    candidateMode,
    candidateSize: Number(candidateSizeText),
    candidateWorkflow: candidate.toString("utf8"),
    routineProtectedChangeApproved: routineReviewedText === "true",
  });
  process.stdout.write(`${JSON.stringify({ diagnostics }, null, 2)}\n`);
  if (diagnostics.length > 0) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`anchored-policy: ${error.message}`);
    process.exitCode = 1;
  });
}
