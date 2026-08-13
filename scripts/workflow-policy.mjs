#!/usr/bin/env node

import { readFile, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { parseDocument } from "yaml";

const readFileAsync = promisify(readFile);

export class WorkflowPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkflowPolicyError";
  }
}

function requireMapping(value, description) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowPolicyError(`${description} must be a mapping`);
  }
  return value;
}

function parseWorkflow(source) {
  if (typeof source !== "string" || source.trim() === "") {
    throw new WorkflowPolicyError("workflow source must be non-empty text");
  }
  const document = parseDocument(source, {
    maxAliasCount: 0,
    prettyErrors: false,
    strict: true,
  });
  if (document.errors.length > 0) {
    throw new WorkflowPolicyError("workflow source must be valid YAML");
  }
  const workflow = document.toJS({ maxAliasCount: 0 });
  return requireMapping(workflow, "workflow root");
}

const canonicalWorkflow = parseWorkflow(readFileSync(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
));
const canonicalPolicyWorkflow = parseWorkflow(readFileSync(
  new URL("../.github/workflows/policy.yml", import.meta.url),
  "utf8",
));

function expressionUsesSecretsContext(expression) {
  let inString = false;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === "'") {
      if (inString && expression[index + 1] === "'") index += 1;
      else inString = !inString;
      continue;
    }
    if (inString || !/[A-Za-z_]/.test(character)) continue;
    let end = index + 1;
    while (end < expression.length && /[A-Za-z0-9_]/.test(expression[end])) {
      end += 1;
    }
    if (expression.slice(index, end).toLowerCase() === "secrets") return true;
    index = end - 1;
  }
  return false;
}

function secretReferencesInString(value) {
  const references = [];
  let start = value.indexOf("${{");
  while (start !== -1) {
    let inString = false;
    let closed = false;
    for (let index = start + 3; index < value.length - 1; index += 1) {
      if (value[index] === "'") {
        if (inString && value[index + 1] === "'") index += 1;
        else inString = !inString;
      } else if (!inString && value[index] === "}" && value[index + 1] === "}") {
        closed = true;
        const expression = value.slice(start + 3, index);
        if (expressionUsesSecretsContext(expression)) {
          const canonical = expression.trim().match(/^secrets\.([A-Z0-9_]+)$/);
          references.push({
            canonical: canonical !== null,
            name: canonical?.[1] ?? null,
          });
        }
        start = value.indexOf("${{", index + 2);
        break;
      }
    }
    if (!closed) break;
  }
  return references;
}

function collectSecretReferences(value, references = []) {
  if (typeof value === "string") {
    references.push(...secretReferencesInString(value));
  } else if (Array.isArray(value)) {
    for (const item of value) collectSecretReferences(item, references);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectSecretReferences(item, references);
    }
  }
  return references;
}

function collectSecretReferencesOutsideStepEnv(step) {
  const references = [];
  for (const [key, value] of Object.entries(step)) {
    if (key !== "env") collectSecretReferences(value, references);
  }
  return references;
}

function normalizedNeeds(value) {
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return [...value].sort();
  }
  throw new WorkflowPolicyError("job needs must be a string or string array");
}

function sameValue(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function workflowMetadata(workflow) {
  const { jobs: _jobs, ...metadata } = workflow;
  return metadata;
}

function jobMetadata(job) {
  const { needs, steps: _steps, ...metadata } = job;
  return { ...metadata, needs: normalizedNeeds(needs) };
}

function addDiagnostic(diagnostics, code, job, step, message) {
  diagnostics.push({ code, job, step, message });
}

function credentialKindForJob(job) {
  if (job === "build-macos") return "source";
  if (job === "apple-sign") return "apple";
  if (job === "sign-updater-preview" || job === "sign-updater-stable") {
    return "updater";
  }
  if (job === "promote-feed") return "feed";
  return null;
}

const CREDENTIAL_BINDINGS = Object.freeze({
  ZERG_SOURCE_DEPLOY_KEY: Object.freeze({
    job: "build-macos",
    step: "Check out the exact SHA and matching source tag",
    env: "SOURCE_DEPLOY_KEY",
    kind: "source",
  }),
  ZERGMEETING_APPLE_API_ISSUER: Object.freeze({
    job: "apple-sign",
    step: "Apply preview ad-hoc or fail-closed stable Apple signing",
    env: "ZERGMEETING_APPLE_API_ISSUER",
    kind: "apple",
  }),
  ZERGMEETING_APPLE_API_KEY_ID: Object.freeze({
    job: "apple-sign",
    step: "Apply preview ad-hoc or fail-closed stable Apple signing",
    env: "ZERGMEETING_APPLE_API_KEY_ID",
    kind: "apple",
  }),
  ZERGMEETING_APPLE_API_PRIVATE_KEY: Object.freeze({
    job: "apple-sign",
    step: "Apply preview ad-hoc or fail-closed stable Apple signing",
    env: "ZERGMEETING_APPLE_API_PRIVATE_KEY",
    kind: "apple",
  }),
  ZERGMEETING_APPLE_CERTIFICATE: Object.freeze({
    job: "apple-sign",
    step: "Apply preview ad-hoc or fail-closed stable Apple signing",
    env: "ZERGMEETING_APPLE_CERTIFICATE",
    kind: "apple",
  }),
  ZERGMEETING_APPLE_CERTIFICATE_PASSWORD: Object.freeze({
    job: "apple-sign",
    step: "Apply preview ad-hoc or fail-closed stable Apple signing",
    env: "ZERGMEETING_APPLE_CERTIFICATE_PASSWORD",
    kind: "apple",
  }),
  ZERGMEETING_APPLE_SIGNING_IDENTITY: Object.freeze({
    job: "apple-sign",
    step: "Apply preview ad-hoc or fail-closed stable Apple signing",
    env: "ZERGMEETING_APPLE_SIGNING_IDENTITY",
    kind: "apple",
  }),
  ZERGMEETING_PREVIEW_TAURI_SIGNING_PRIVATE_KEY: Object.freeze({
    job: "sign-updater-preview",
    step: "Sign only the preview updater archive",
    env: "TAURI_SIGNING_PRIVATE_KEY",
    kind: "updater",
  }),
  ZERGMEETING_PREVIEW_TAURI_SIGNING_PRIVATE_KEY_PASSWORD: Object.freeze({
    job: "sign-updater-preview",
    step: "Sign only the preview updater archive",
    env: "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    kind: "updater",
  }),
  ZERGMEETING_STABLE_TAURI_SIGNING_PRIVATE_KEY: Object.freeze({
    job: "sign-updater-stable",
    step: "Sign only the stable updater archive",
    env: "TAURI_SIGNING_PRIVATE_KEY",
    kind: "updater",
  }),
  ZERGMEETING_STABLE_TAURI_SIGNING_PRIVATE_KEY_PASSWORD: Object.freeze({
    job: "sign-updater-stable",
    step: "Sign only the stable updater archive",
    env: "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    kind: "updater",
  }),
  ZERGMEETING_FEED_DEPLOY_KEY: Object.freeze({
    job: "promote-feed",
    step: "Push the prepared release-data commit",
    env: "ZERGMEETING_FEED_DEPLOY_KEY",
    kind: "feed",
  }),
});

function stepIdentity(step) {
  if (typeof step.name === "string") return step.name;
  if (typeof step.uses === "string") return `uses ${step.uses}`;
  return "unnamed step";
}

const CREDENTIAL_PROGRAM_DIAGNOSTICS = Object.freeze({
  source: Object.freeze({
    code: "source-credential-window",
    message: "source credentials may execute only the protected checkout program",
  }),
  apple: Object.freeze({
    code: "apple-secret-window",
    message: "Apple credentials may execute only the protected signing program",
  }),
  updater: Object.freeze({
    code: "updater-secret-window",
    message: "updater keys may execute only the protected offline signing program",
  }),
  feed: Object.freeze({
    code: "feed-credential-contract",
    message: "the feed key may execute only the protected release-data push program",
  }),
});

function auditCredentialProgram(
  diagnostics,
  kind,
  job,
  stepName,
  run,
  expectedRun,
) {
  if (run === expectedRun) return;
  const contract = CREDENTIAL_PROGRAM_DIAGNOSTICS[kind];
  addDiagnostic(
    diagnostics,
    contract.code,
    job,
    stepName,
    contract.message,
  );
}

function auditJobShape(diagnostics, jobName, job, expected) {
  if (job.uses !== undefined || job.secrets !== undefined) {
    addDiagnostic(
      diagnostics,
      "job-contract",
      jobName,
      null,
      "release jobs may not call reusable workflows or forward secrets",
    );
  }
  if (!sameValue(jobMetadata(job), jobMetadata(expected))) {
    addDiagnostic(
      diagnostics,
      "job-contract",
      jobName,
      null,
      "job execution metadata differs from the protected contract",
    );
  }
  if (
    job["runs-on"] !== expected["runs-on"] ||
    !sameValue(job.permissions, expected.permissions) ||
    !sameValue(job.environment, expected.environment) ||
    !sameValue(normalizedNeeds(job.needs), normalizedNeeds(expected.needs))
  ) {
    addDiagnostic(
      diagnostics,
      "job-contract",
      jobName,
      null,
      "runner, permissions, environment, or dependencies differ",
    );
  }
  if (!sameValue(job.environment, expected.environment)) {
    addDiagnostic(
      diagnostics,
      "environment-boundary",
      jobName,
      null,
      "job environment differs from the protected contract",
    );
  }
  if (!Array.isArray(job.steps) || !Array.isArray(expected.steps)) {
    throw new WorkflowPolicyError(`${jobName} job steps must be an array`);
  }
  if (job.steps.length !== expected.steps.length) {
    addDiagnostic(
      diagnostics,
      "job-contract",
      jobName,
      null,
      "job step count differs from the protected contract",
    );
  }
  const maximum = Math.max(job.steps.length, expected.steps.length);
  for (let index = 0; index < maximum; index += 1) {
    const step = job.steps[index];
    const expectedStep = expected.steps[index];
    if (step === undefined || expectedStep === undefined) continue;
    requireMapping(step, `${jobName} step ${index + 1}`);
    requireMapping(expectedStep, `${jobName} expected step ${index + 1}`);
    if (!sameValue(step, expectedStep)) {
      const actionStep = typeof step.uses === "string" ||
        typeof expectedStep.uses === "string";
      addDiagnostic(
        diagnostics,
        actionStep ? "action-contract" : "job-contract",
        jobName,
        stepIdentity(step),
        actionStep
          ? "action step differs from the protected-base version"
          : "run step differs from the protected-base version",
      );
    }
  }
}

export function auditWorkflowPolicy(source) {
  const workflow = parseWorkflow(source);
  const jobs = requireMapping(workflow.jobs, "workflow jobs");
  const expectedJobs = requireMapping(canonicalWorkflow.jobs, "canonical jobs");
  const diagnostics = [];
  const occurrences = [];

  if (!sameValue(workflowMetadata(workflow), workflowMetadata(canonicalWorkflow))) {
    addDiagnostic(
      diagnostics,
      "workflow-contract",
      "workflow",
      null,
      "workflow execution metadata differs from the protected-base version",
    );
  }

  const triggers = workflow.on !== null && typeof workflow.on === "object" &&
      !Array.isArray(workflow.on)
    ? workflow.on
    : {};
  const triggerNames = Object.keys(triggers).sort();
  const dispatch = triggers.workflow_dispatch !== null &&
      typeof triggers.workflow_dispatch === "object" &&
      !Array.isArray(triggers.workflow_dispatch)
    ? triggers.workflow_dispatch
    : {};
  const inputs = dispatch.inputs !== null && typeof dispatch.inputs === "object" &&
      !Array.isArray(dispatch.inputs)
    ? dispatch.inputs
    : {};
  if (
    !sameValue(triggerNames, ["workflow_dispatch"]) ||
    !sameValue(Object.keys(inputs).sort(), ["request"])
  ) {
    addDiagnostic(
      diagnostics,
      "trigger-contract",
      "workflow",
      null,
      "release workflow must dispatch only one existing request path",
    );
  }
  if (!sameValue(workflow.permissions, { contents: "read" })) {
    addDiagnostic(
      diagnostics,
      "permission-boundary",
      "workflow",
      null,
      "workflow permissions must be exactly contents: read",
    );
  }

  const jobNames = Object.keys(jobs).sort();
  const expectedJobNames = Object.keys(expectedJobs).sort();
  if (!sameValue(jobNames, expectedJobNames)) {
    addDiagnostic(
      diagnostics,
      "job-contract",
      "workflow",
      null,
      "release workflow must contain exactly the approved job set",
    );
  }

  const outerSecretReferences = collectSecretReferences(
    Object.fromEntries(Object.entries(workflow).filter(([key]) => key !== "jobs")),
  );
  if (outerSecretReferences.length > 0) {
    addDiagnostic(
      diagnostics,
      outerSecretReferences.some(({ canonical }) => !canonical)
        ? "secret-expression-boundary"
        : "secret-outside-step-env",
      "workflow",
      null,
      "secrets are allowed only in one consuming step env",
    );
  }

  for (const [jobName, rawJob] of Object.entries(jobs)) {
    const job = requireMapping(rawJob, `${jobName} job`);
    const expected = expectedJobs[jobName];
    if (expected !== undefined) auditJobShape(diagnostics, jobName, job, expected);

    const jobReferences = collectSecretReferences(job.env ?? {});
    if (jobReferences.length > 0) {
      addDiagnostic(
        diagnostics,
        jobReferences.some(({ canonical }) => !canonical)
          ? "secret-expression-boundary"
          : "job-secret-scope",
        jobName,
        null,
        "job-level environments may not expose credentials",
      );
    }
    if (job.steps === undefined) continue;
    if (!Array.isArray(job.steps)) {
      throw new WorkflowPolicyError(`${jobName} job steps must be an array`);
    }
    for (const [index, rawStep] of job.steps.entries()) {
      const step = requireMapping(rawStep, `${jobName} step ${index + 1}`);
      const stepName = stepIdentity(step);
      const expectedStep = expected !== undefined && Array.isArray(expected.steps)
        ? expected.steps[index]
        : undefined;
      const envReferences = collectSecretReferences(step.env ?? {});
      const outsideReferences = collectSecretReferencesOutsideStepEnv(step);
      if (
        envReferences.some(({ canonical }) => !canonical) ||
        outsideReferences.some(({ canonical }) => !canonical)
      ) {
        addDiagnostic(
          diagnostics,
          "secret-expression-boundary",
          jobName,
          stepName,
          "secret contexts must use one canonical dot expression",
        );
        const kind = credentialKindForJob(jobName);
        if (kind !== null) {
          addDiagnostic(
            diagnostics,
            `${kind}-credential-contract`,
            jobName,
            stepName,
            `the ${kind} boundary rejects non-canonical secret access`,
          );
        }
      }
      if (outsideReferences.some(({ canonical }) => canonical)) {
        addDiagnostic(
          diagnostics,
          "secret-outside-step-env",
          jobName,
          stepName,
          "secret expressions are permitted only in the consuming step env",
        );
      }
      if (step.env !== undefined) {
        const env = requireMapping(step.env, `${jobName} ${stepName} env`);
        for (const [envName, value] of Object.entries(env)) {
          for (const reference of collectSecretReferences(value)) {
            if (!reference.canonical) continue;
            occurrences.push({
              env: envName,
              job: jobName,
              name: reference.name,
              step: stepName,
              value,
            });
            if (CREDENTIAL_BINDINGS[reference.name] === undefined) {
              addDiagnostic(
                diagnostics,
                "credential-allowlist",
                jobName,
                stepName,
                `secret ${reference.name} is not approved`,
              );
            }
          }
        }
      }
      const secretNames = new Set(
        envReferences.filter(({ canonical }) => canonical).map(({ name }) => name),
      );
      const run = typeof step.run === "string" ? step.run : "";
      const credentialKind = credentialKindForJob(jobName);
      if (credentialKind !== null && secretNames.size > 0) {
        const expectedRun = expectedStep !== undefined &&
            typeof expectedStep.run === "string"
          ? expectedStep.run
          : null;
        auditCredentialProgram(
          diagnostics,
          credentialKind,
          jobName,
          stepName,
          run,
          expectedRun,
        );
      }
    }
  }

  const kinds = new Set(Object.values(CREDENTIAL_BINDINGS).map(({ kind }) => kind));
  for (const kind of kinds) {
    const expected = Object.entries(CREDENTIAL_BINDINGS)
      .filter(([, binding]) => binding.kind === kind);
    const valid = expected.every(([name, binding]) => {
      const matching = occurrences.filter((occurrence) => occurrence.name === name);
      return matching.length === 1 &&
        matching[0].job === binding.job &&
        matching[0].step === binding.step &&
        matching[0].env === binding.env &&
        matching[0].value === `\${{ secrets.${name} }}`;
    });
    if (!valid) {
      addDiagnostic(
        diagnostics,
        `${kind}-credential-contract`,
        "workflow",
        null,
        `every ${kind} secret must occur once at its exact boundary`,
      );
    }
  }

  return [...new Map(diagnostics.map((diagnostic) => [
    `${diagnostic.code}:${diagnostic.job}:${diagnostic.step ?? ""}`,
    diagnostic,
  ])).values()].sort((left, right) =>
    `${left.code}:${left.job}:${left.step ?? ""}`.localeCompare(
      `${right.code}:${right.job}:${right.step ?? ""}`,
    )
  );
}

export function auditPolicyWorkflow(source) {
  const workflow = parseWorkflow(source);
  const secretReferences = collectSecretReferences(workflow);
  if (
    sameValue(workflow, canonicalPolicyWorkflow) &&
    secretReferences.length === 0
  ) {
    return [];
  }
  return [{
    code: "policy-ci-contract",
    job: "policy",
    step: null,
    message: "pull-request CI must execute the exact secret-free public policy gates",
  }];
}

async function main() {
  if (
    process.argv.length !== 3 &&
    !(process.argv.length === 4 && process.argv[3] === "--policy-ci")
  ) {
    throw new WorkflowPolicyError(
      "usage: workflow-policy.mjs WORKFLOW.yml [--policy-ci]",
    );
  }
  const source = await readFileAsync(process.argv[2], "utf8");
  const diagnostics = process.argv[3] === "--policy-ci"
    ? auditPolicyWorkflow(source)
    : auditWorkflowPolicy(source);
  process.stdout.write(`${JSON.stringify({ diagnostics }, null, 2)}\n`);
  if (diagnostics.length > 0) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`workflow-policy: ${error.message}`);
    process.exitCode = 1;
  });
}
