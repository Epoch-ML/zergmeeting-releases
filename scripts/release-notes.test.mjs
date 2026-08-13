import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";

import { makeReleaseNotes } from "./release-notes.mjs";

const execFileAsync = promisify(execFile);
const temporaryDirectories = [];

after(async () => {
  await Promise.all(
    temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ZergMeeting public release notes", () => {
  it("preserves the verified release description", () => {
    assert.equal(
      makeReleaseNotes({
        version: "0.1.9",
        channel: "stable",
        sourceSha: "0123456789abcdef0123456789abcdef01234567",
      }),
      "ZergMeeting 0.1.9 (stable, Apple Silicon macOS)\n\n" +
        "Built from Epoch-ML/zerg commit 0123456789abcdef0123456789abcdef01234567 " +
        "after source, dependency, Apple platform-signature, updater-signature, " +
        "and artifact verification.\n\n" +
        "Important upgrade notice: installations that do not embed this channel's " +
        "public updater root need one manual installation of this release. " +
        "Automatic in-app updates begin between releases from this public boundary.\n",
    );
  });

  it("requires one manual bridge from every pre-fix desktop release", () => {
    const notes = makeReleaseNotes({
      version: "0.1.9",
      channel: "stable",
      sourceSha: "0123456789abcdef0123456789abcdef01234567",
    });

    assert.match(notes, /Important upgrade notice:/u);
    assert.match(notes, /public updater root/u);
    assert.match(notes, /need one manual installation/u);
    assert.match(notes, /Automatic in-app updates begin/u);
    assert.doesNotMatch(notes, /through 0\.1\.8/u);
  });

  it("writes one new notes file and refuses to overwrite it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zergmeeting-release-notes-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "notes.md");
    const arguments_ = [
      new URL("./release-notes.mjs", import.meta.url).pathname,
      outputPath,
      "0.1.9-preview.1",
      "preview",
      "fedcba9876543210fedcba9876543210fedcba98",
    ];

    await execFileAsync(process.execPath, arguments_);
    assert.equal(
      await readFile(outputPath, "utf8"),
      "ZergMeeting 0.1.9-preview.1 (preview, Apple Silicon macOS)\n\n" +
        "Built from Epoch-ML/zerg commit fedcba9876543210fedcba9876543210fedcba98 " +
        "after source, dependency, Apple platform-signature, updater-signature, " +
        "and artifact verification.\n\n" +
        "Important upgrade notice: installations that do not embed this channel's " +
        "public updater root need one manual installation of this release. " +
        "Automatic in-app updates begin between releases from this public boundary.\n",
    );
    await assert.rejects(
      execFileAsync(process.execPath, arguments_),
      (error) => error.code === 1 && /EEXIST/u.test(error.stderr),
    );
  });

  it("rejects every incomplete CLI invocation before writing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zergmeeting-release-notes-invalid-"));
    temporaryDirectories.push(directory);
    const scriptPath = new URL("./release-notes.mjs", import.meta.url).pathname;
    const completeArguments = [
      join(directory, "notes.md"),
      "0.2.2",
      "stable",
      "0123456789abcdef0123456789abcdef01234567",
    ];

    for (let count = 0; count < completeArguments.length; count += 1) {
      await assert.rejects(
        execFileAsync(process.execPath, [scriptPath, ...completeArguments.slice(0, count)]),
        (error) =>
          error.code === 1 &&
          /^Error: usage: release-notes\.mjs OUTPUT_PATH VERSION CHANNEL SOURCE_SHA$/mu
            .test(error.stderr),
      );
    }
    assert.deepEqual(await readdir(directory), []);
  });

  it("can be imported by a process without a script argument", async () => {
    const moduleUrl = new URL("./release-notes.mjs", import.meta.url).href;
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(moduleUrl)})`,
    ]);

    assert.equal(stdout, "");
    assert.equal(stderr, "");
  });
});
