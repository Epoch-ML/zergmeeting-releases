import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";

import {
  SourceSignatureError,
  verifySourceSignature,
  verifySourceSignatureFile,
} from "./verify-source-signature.mjs";

const execFileAsync = promisify(execFile);
const temporaryDirectories = [];
const failedArtifactDetails = `Executable=/private/tmp/Zerg Meeting.app/Contents/MacOS/app
Identifier=app-7e1991a48a45aedd
CodeDirectory v=20400 flags=0x20002(adhoc,linker-signed)
Signature=adhoc
TeamIdentifier=not set
`;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

async function makeTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "zergmeeting-source-signature-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("ZergMeeting source signature policy", () => {
  it("accepts the failed release artifact's ad-hoc linker signature", () => {
    assert.deepEqual(verifySourceSignature(failedArtifactDetails, 0), {
      kind: "adhoc",
    });
    assert.deepEqual(
      verifySourceSignature("Signature=adhoc\r\nTeamIdentifier=not set\r\n", 0),
      { kind: "adhoc" },
    );
    assert.equal(new SourceSignatureError("problem").name, "SourceSignatureError");
  });

  it("accepts only codesign's explicit unsigned failure", () => {
    assert.deepEqual(
      verifySourceSignature(
        "/private/tmp/Zerg Meeting.app: code object is not signed at all\n",
        255,
      ),
      { kind: "unsigned" },
    );
    assert.throws(
      () => verifySourceSignature("resource envelope is obsolete\n", 1),
      new SourceSignatureError(
        "codesign could not establish an unsigned source app",
      ),
    );
    assert.throws(
      () => verifySourceSignature("Signature=adhoc\n", 1),
      /could not establish an unsigned source app/,
    );
  });

  it("rejects every actual certificate authority or signing team", () => {
    const identitySigned = [
      "Signature=adhoc\nAuthority=Developer ID Application: Example (ABC123)\nTeamIdentifier=not set\n",
      "Signature=adhoc\nTeamIdentifier=ABC123\n",
      "Signature=adhoc\nTeamIdentifier=not set\nTeamIdentifier=not set\n",
    ];
    for (const details of identitySigned) {
      assert.throws(
        () => verifySourceSignature(details, 0),
        /source app contains (?:an Authority|a TeamIdentifier) signing identity/,
      );
    }
  });

  it("fails closed for successful but unrecognized codesign output", () => {
    for (const details of [
      "",
      "Signature=adhoc\nSignature=adhoc\n",
      "Signature=certificate\nTeamIdentifier=not set\n",
      "TeamIdentifier=not set\n",
    ]) {
      assert.throws(
        () => verifySourceSignature(details, 0),
        /unrecognized successful codesign inspection/,
      );
    }
    for (const code of [-1, 256, 1.5, Number.NaN, "0"]) {
      assert.throws(
        () => verifySourceSignature("Signature=adhoc\n", code),
        /codesign exit code must be an integer from 0 to 255/,
      );
    }
    assert.throws(
      () => verifySourceSignature(Buffer.from("Signature=adhoc\n"), 0),
      /codesign details must be text/,
    );
  });

  it("validates the bounded details file and CLI result", async () => {
    const directory = await makeTemporaryDirectory();
    const detailsPath = join(directory, "signature.txt");
    await writeFile(detailsPath, failedArtifactDetails);

    assert.deepEqual(await verifySourceSignatureFile(detailsPath, 0), {
      kind: "adhoc",
    });
    const execution = await execFileAsync(process.execPath, [
      resolve("scripts", "verify-source-signature.mjs"),
      detailsPath,
      "0",
    ]);
    assert.deepEqual(JSON.parse(execution.stdout), { kind: "adhoc" });
    assert.equal(execution.stderr, "");

    const symlinkPath = join(directory, "signature-link.txt");
    await symlink(detailsPath, symlinkPath);
    await assert.rejects(
      verifySourceSignatureFile(symlinkPath, 0),
      /codesign details must be a regular, non-symlink file/,
    );
    await assert.rejects(
      verifySourceSignatureFile(directory, 0),
      /codesign details must be a regular, non-symlink file/,
    );
    const maximumDetails = Buffer.alloc(1_048_576, 0x20);
    maximumDetails.write("Signature=adhoc\n", 0, "utf8");
    await writeFile(detailsPath, maximumDetails);
    assert.deepEqual(await verifySourceSignatureFile(detailsPath, 0), {
      kind: "adhoc",
    });
    await writeFile(detailsPath, Buffer.alloc(1_048_577));
    await assert.rejects(
      verifySourceSignatureFile(detailsPath, 0),
      /codesign details exceed the size limit/,
    );
  });

  it("rejects malformed CLI exit codes and invocation", async () => {
    const directory = await makeTemporaryDirectory();
    const detailsPath = join(directory, "signature.txt");
    const scriptPath = resolve("scripts", "verify-source-signature.mjs");
    await writeFile(detailsPath, failedArtifactDetails);

    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath]),
      (error) =>
        error.code === 1 &&
        error.stderr ===
          "verify-source-signature: usage: verify-source-signature.mjs DETAILS_FILE CODESIGN_EXIT_CODE\n",
    );
    for (const exitCode of ["-1", "00", "01", "256", "1.5"]) {
      await assert.rejects(
        execFileAsync(process.execPath, [scriptPath, detailsPath, exitCode]),
        (error) =>
          error.code === 1 &&
          error.stderr ===
            "verify-source-signature: codesign exit code must be an integer from 0 to 255\n",
      );
    }

    const unsignedPath = join(directory, "unsigned.txt");
    await writeFile(
      unsignedPath,
      "/private/tmp/Zerg Meeting.app: code object is not signed at all\n",
    );
    for (const exitCode of ["1", "10", "255"]) {
      const execution = await execFileAsync(process.execPath, [
        scriptPath,
        unsignedPath,
        exitCode,
      ]);
      assert.deepEqual(JSON.parse(execution.stdout), { kind: "unsigned" });
    }
  });
});
