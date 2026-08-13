import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";

import {
  ReleaseRequestError,
  validateReleaseRequest,
  validateRequestFile,
} from "./release-request.mjs";

const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const requestedAt = "2026-08-05T20:00:00.000Z";
const updaterPublicKeySha256 = "a".repeat(64);
const temporaryDirectories = [];
const execFileAsync = promisify(execFile);

function makeRequest(overrides = {}) {
  return {
    schema_version: 1,
    product: "zergmeeting-desktop",
    channel: "preview",
    version: "0.1.9-preview.1",
    release_tag: "zergmeeting-preview-v0.1.9-preview.1",
    source_repository: "Epoch-ML/zerg",
    source_sha: sourceSha,
    source_ref: "refs/tags/zergmeeting-preview-v0.1.9-preview.1",
    requested_at: requestedAt,
    updater_public_key_sha256: updaterPublicKeySha256,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ZergMeeting release request validation", () => {
  it("accepts one canonical preview request and derives immutable build metadata", () => {
    const result = validateReleaseRequest(makeRequest(), {
      requestFilename: "zergmeeting-preview-v0.1.9-preview.1.json",
    });

    assert.deepEqual(result, {
      channel: "preview",
      requestedAt,
      releaseTag: "zergmeeting-preview-v0.1.9-preview.1",
      sourceRef: "refs/tags/zergmeeting-preview-v0.1.9-preview.1",
      sourceRepository: "Epoch-ML/zerg",
      sourceSha,
      updaterPublicKeySha256,
      version: "0.1.9-preview.1",
    });
  });

  it("accepts numeric stable versions and rejects prerelease stable versions", () => {
    const stable = makeRequest({
      channel: "stable",
      version: "12.34.56",
      release_tag: "zergmeeting-v12.34.56",
      source_ref: "refs/tags/zergmeeting-v12.34.56",
    });
    assert.equal(
      validateReleaseRequest(stable, { requestFilename: "zergmeeting-v12.34.56.json" }).channel,
      "stable",
    );

    assert.throws(
      () => validateReleaseRequest({
        ...stable,
        version: "12.34.56-rc.1",
        release_tag: "zergmeeting-v12.34.56-rc.1",
        source_ref: "refs/tags/zergmeeting-v12.34.56-rc.1",
      }, { requestFilename: "zergmeeting-v12.34.56-rc.1.json" }),
      new ReleaseRequestError("stable release versions must use MAJOR.MINOR.PATCH"),
    );
    assert.throws(
      () => validateReleaseRequest({
        ...stable,
        version: "12.34.56+rebuilt",
        release_tag: "zergmeeting-v12.34.56+rebuilt",
        source_ref: "refs/tags/zergmeeting-v12.34.56+rebuilt",
      }),
      /stable release versions must use MAJOR\.MINOR\.PATCH/,
    );
  });

  it("rejects non-objects, missing fields, wrong schema, and blank versions", () => {
    for (const value of [null, [], "request", 42]) {
      assert.throws(
        () => validateReleaseRequest(value),
        /release request must be a JSON object/,
      );
    }
    for (const field of Object.keys(makeRequest())) {
      const request = makeRequest();
      delete request[field];
      assert.throws(
        () => validateReleaseRequest(request),
        new RegExp("missing release request field: " + field),
      );
    }
    assert.throws(
      () => validateReleaseRequest(makeRequest({ schema_version: 2 })),
      /schema version must be 1/,
    );
    for (const version of [null, 2, "", "   "]) {
      assert.throws(
        () => validateReleaseRequest(makeRequest({ version })),
        /version is required/,
      );
    }
    assert.equal(new ReleaseRequestError("problem").name, "ReleaseRequestError");
  });

  it("enforces channel-specific SemVer, SHA, and updater-root boundaries", () => {
    const invalidVersions = [
      "v0.2.0",
      "x0.2.0",
      "0.2.0suffix!",
      "01.2.3",
      "1.02.3",
      "1.2.03",
      "1.2",
      "1.2.3.4",
      "1.2.3-01",
      "1.2.3+",
      "1.2.3+build.",
      "1.2.3-rc.1",
      "1.2.3-preview.0",
      "1.2.3-preview.01",
      "1.2.3-preview.1+rebuilt",
    ];
    for (const version of invalidVersions) {
      assert.throws(
        () => validateReleaseRequest(makeRequest({
          version,
          release_tag: "zergmeeting-preview-v" + version,
          source_ref: "refs/tags/zergmeeting-preview-v" + version,
        })),
        /preview release versions must use MAJOR\.MINOR\.PATCH-preview\.N/,
      );
    }
    assert.equal(validateReleaseRequest(makeRequest()).version, "0.1.9-preview.1");

    for (const source_sha of ["x" + sourceSha, sourceSha + "0"]) {
      assert.throws(
        () => validateReleaseRequest(makeRequest({ source_sha })),
        /exactly 40 lowercase hexadecimal characters/,
      );
    }
    assert.equal(validateReleaseRequest(makeRequest()).sourceSha, sourceSha);

    for (const updater_public_key_sha256 of [
      "f".repeat(63),
      "f".repeat(65),
      "F".repeat(64),
      "g".repeat(64),
    ]) {
      assert.throws(
        () => validateReleaseRequest(makeRequest({ updater_public_key_sha256 })),
        /updater public key SHA-256 must contain exactly 64 lowercase hexadecimal characters/,
      );
    }
    assert.equal(
      validateReleaseRequest(makeRequest()).updaterPublicKeySha256,
      updaterPublicKeySha256,
    );
  });

  it("rejects schema drift, malformed provenance, and a mismatched filename", () => {
    assert.throws(
      () => validateReleaseRequest(makeRequest({
        release_tag: "zergmeeting-preview-v0.1.9-preview.2",
      })),
      /release tag must be zergmeeting-preview-v0.1.9-preview.1/,
    );
    assert.throws(
      () => validateReleaseRequest(makeRequest({ unexpected: true }), {
        requestFilename: "zergmeeting-preview-v0.1.9-preview.1.json",
      }),
      /unexpected release request field: unexpected/,
    );
    assert.throws(
      () => validateReleaseRequest(makeRequest({ source_sha: "too-short" }), {
        requestFilename: "zergmeeting-preview-v0.1.9-preview.1.json",
      }),
      /source SHA must contain exactly 40 lowercase hexadecimal characters/,
    );
    assert.throws(
      () => validateReleaseRequest(makeRequest(), {
        requestFilename: "wrong.json",
      }),
      /request filename must be zergmeeting-preview-v0.1.9-preview.1.json/,
    );
  });

  it("rejects another product, repository, channel, ref, or non-canonical timestamp", () => {
    const invalidRequests = [
      [makeRequest({ product: "Other" }), /product must be zergmeeting-desktop/],
      [makeRequest({ source_repository: "Epoch-ML/other" }), /source repository must be Epoch-ML\/zerg/],
      [makeRequest({ channel: "nightly" }), /channel must be preview or stable/],
      [makeRequest({ source_ref: "refs/heads/main" }), /source ref must be refs\/tags\/zergmeeting-preview-v0.1.9-preview.1/],
      [makeRequest({ requested_at: "not-a-date" }), /timestamp must be canonical ISO-8601/],
      [makeRequest({ requested_at: null }), /timestamp must be canonical ISO-8601/],
      [makeRequest({ requested_at: 1 }), /timestamp must be canonical ISO-8601/],
      [makeRequest({ requested_at: "2026-08-05T20:00:00Z" }), /timestamp must be canonical ISO-8601/],
      [makeRequest({ requested_at: "2026-08-05 20:00:00Z" }), /timestamp must be canonical ISO-8601/],
      [
        makeRequest({ requested_at: "2026-08-05T20:00:00.000Z\ninjected=value" }),
        /timestamp must be canonical ISO-8601/,
      ],
    ];

    for (const [request, expected] of invalidRequests) {
      assert.throws(
        () => validateReleaseRequest(request, {
          requestFilename: `${request.release_tag}.json`,
        }),
        expected,
      );
    }
  });

  it("parses a request file while rejecting malformed JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zergmeeting-public-request-test-"));
    temporaryDirectories.push(directory);
    const validPath = join(directory, "zergmeeting-preview-v0.1.9-preview.1.json");
    const invalidPath = join(directory, "zergmeeting-preview-v0.1.9-preview.2.json");
    const wrongNamePath = join(directory, "wrong.json");
    const symlinkPath = join(directory, "zergmeeting-preview-v0.1.9-preview.3.json");
    await writeFile(validPath, `${JSON.stringify(makeRequest(), null, 2)}\n`);
    await writeFile(invalidPath, "{ invalid json\n");
    await writeFile(wrongNamePath, JSON.stringify(makeRequest()));
    await symlink(validPath, symlinkPath);

    const request = await validateRequestFile(validPath);
    assert.equal(request.releaseTag, "zergmeeting-preview-v0.1.9-preview.1");
    await assert.rejects(validateRequestFile(invalidPath), /valid JSON/);
    await assert.rejects(validateRequestFile(wrongNamePath), /request filename must be/);
    await assert.rejects(
      validateRequestFile(symlinkPath),
      /request file must be a regular, non-symlink file/,
    );
    await assert.rejects(
      validateRequestFile(join(directory, "missing.json")),
      (error) => error.code === "ENOENT",
    );
    await assert.rejects(
      validateRequestFile(directory),
      /request file must be a regular, non-symlink file/,
    );
  });

  it("emits every validated CLI output and fails without an input path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zergmeeting-request-cli-test-"));
    temporaryDirectories.push(directory);
    const requestPath = join(directory, "zergmeeting-preview-v0.1.9-preview.1.json");
    const outputPath = join(directory, "github-output.txt");
    await writeFile(requestPath, JSON.stringify(makeRequest()));
    await writeFile(outputPath, "");
    const scriptPath = resolve("scripts", "release-request.mjs");

    const execution = await execFileAsync(process.execPath, [scriptPath, requestPath], {
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });
    assert.deepEqual(JSON.parse(execution.stdout), {
      channel: "preview",
      requestedAt,
      releaseTag: "zergmeeting-preview-v0.1.9-preview.1",
      sourceRef: "refs/tags/zergmeeting-preview-v0.1.9-preview.1",
      sourceRepository: "Epoch-ML/zerg",
      sourceSha,
      updaterPublicKeySha256,
      version: "0.1.9-preview.1",
    });
    const withoutOutput = await execFileAsync(process.execPath, [scriptPath, requestPath], {
      env: { ...process.env, GITHUB_OUTPUT: "" },
    });
    assert.equal(JSON.parse(withoutOutput.stdout).releaseTag, "zergmeeting-preview-v0.1.9-preview.1");
    assert.equal(await readFile(outputPath, "utf8"), [
      "channel=preview",
      "requested_at=" + requestedAt,
      "release_tag=zergmeeting-preview-v0.1.9-preview.1",
      "source_ref=refs/tags/zergmeeting-preview-v0.1.9-preview.1",
      "source_repository=Epoch-ML/zerg",
      "source_sha=" + sourceSha,
      "updater_public_key_sha256=" + updaterPublicKeySha256,
      "version=0.1.9-preview.1",
      "",
    ].join("\n"));

    await writeFile(
      requestPath,
      JSON.stringify(makeRequest({
        requested_at: "2026-08-05T20:00:00.000Z\ninjected=value",
      })),
    );
    await writeFile(outputPath, "");
    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath, requestPath], {
        env: { ...process.env, GITHUB_OUTPUT: outputPath },
      }),
      (error) =>
        error.code === 1 &&
        error.stderr.includes("timestamp must be canonical ISO-8601"),
    );
    assert.equal(await readFile(outputPath, "utf8"), "");

    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath]),
      (error) =>
        error.code === 1 &&
        error.stderr.includes("usage: release-request.mjs <request.json>"),
    );
  });
});
