import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";

import { Header, Pax, create, list } from "tar";

import {
  extractSourceApplication,
  packageMacApplication,
} from "./package-macos.mjs";

const temporaryDirectories = [];
const execFileAsync = promisify(execFile);

async function writeRawTar(archivePath, entries) {
  const blocks = [];
  for (const entry of entries) {
    const contents = Buffer.from(entry.contents ?? "");
    const size = entry.size ?? contents.length;
    assert.equal(contents.length, size, `fixture size for ${entry.path}`);
    const header = new Header({
      gid: 0,
      linkpath: entry.linkpath ?? "",
      mode: entry.type === "Directory" ? 0o755 : 0o644,
      mtime: new Date("2020-01-01T00:00:00.000Z"),
      path: entry.path.length > 100 ? "Zerg Meeting.app/pax-placeholder" : entry.path,
      size,
      type: entry.type ?? "File",
      uid: 0,
    });
    const headerBlock = Buffer.alloc(512);
    assert.equal(header.encode(headerBlock), false, `fixture header for ${entry.path}`);
    if (entry.path.length > 100) {
      blocks.push(new Pax({ path: entry.path, size }).encode());
    }
    blocks.push(headerBlock, contents);
    const padding = (512 - (size % 512)) % 512;
    if (padding !== 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  await writeFile(archivePath, Buffer.concat(blocks));
}

async function assertMissing(path) {
  await assert.rejects(lstat(path), (error) => error.code === "ENOENT");
}

async function makeApplication() {
  const root = await mkdtemp(join(tmpdir(), "zergmeeting-macos-package-"));
  temporaryDirectories.push(root);
  const applicationPath = join(root, "bundle", "Zerg Meeting.app");
  const executablePath = join(applicationPath, "Contents", "MacOS", "zergmeeting");
  const resourcesPath = join(applicationPath, "Contents", "Resources");
  await mkdir(join(applicationPath, "Contents", "MacOS"), { recursive: true });
  await mkdir(resourcesPath, { recursive: true });
  await writeFile(executablePath, "#!/bin/sh\nexit 0\n");
  await chmod(executablePath, 0o755);
  await writeFile(join(resourcesPath, "version.txt"), "0.2.0\n");
  await symlink("../Resources/version.txt", join(applicationPath, "Contents", "version-link"));
  return { applicationPath, root };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("deterministic macOS updater packaging", () => {
  it("produces identical archives with a complete sorted app tree", async () => {
    const fixture = await makeApplication();
    await rm(join(fixture.applicationPath, "Contents", "version-link"));
    const first = join(fixture.root, "first.app.tar.gz");
    const second = join(fixture.root, "second.app.tar.gz");

    const firstResult = await packageMacApplication({
      applicationPath: fixture.applicationPath,
      outputPath: first,
    });
    assert.deepEqual(firstResult, {
      entryCount: 6,
      outputPath: first,
      uncompressedBytes: 23,
    });
    const firstMetadata = await lstat(first);
    await utimes(
      join(fixture.applicationPath, "Contents", "Resources", "version.txt"),
      new Date("2030-01-01T00:00:00.000Z"),
      new Date("2030-01-01T00:00:00.000Z"),
    );
    await packageMacApplication({
      applicationPath: fixture.applicationPath,
      maxArchiveBytes: firstMetadata.size,
      maxEntryCount: 6,
      maxFileBytes: 17,
      maxUncompressedBytes: 23,
      outputPath: second,
    });

    const firstBytes = await readFile(first);
    const secondBytes = await readFile(second);
    assert.equal(
      createHash("sha256").update(firstBytes).digest("hex"),
      createHash("sha256").update(secondBytes).digest("hex"),
    );
    assert.equal(firstBytes[8], 2, "gzip payload must use the pinned level-9 header");
    const names = [];
    const mtimes = [];
    await list({
      file: first,
      onentry: (entry) => {
        names.push(entry.path);
        if (entry.type === "File") mtimes.push(entry.mtime.toISOString());
      },
    });
    assert.deepEqual(names, [
      "Zerg Meeting.app/",
      "Zerg Meeting.app/Contents/",
      "Zerg Meeting.app/Contents/MacOS/",
      "Zerg Meeting.app/Contents/MacOS/zergmeeting",
      "Zerg Meeting.app/Contents/Resources/",
      "Zerg Meeting.app/Contents/Resources/version.txt",
    ]);
    assert.deepEqual(
      [...new Set(mtimes)],
      ["2020-01-01T00:00:00.000Z"],
    );
  });

  it("packages through the workflow CLI and reports invalid invocation", async () => {
    const fixture = await makeApplication();
    await rm(join(fixture.applicationPath, "Contents", "version-link"));
    const outputPath = join(fixture.root, "cli.app.tar.gz");
    const scriptPath = resolve("scripts", "package-macos.mjs");
    const execution = await execFileAsync(
      process.execPath,
      [scriptPath, fixture.applicationPath, outputPath],
    );
    assert.equal(execution.stdout.endsWith("\n"), true);
    assert.deepEqual(JSON.parse(execution.stdout), {
      entryCount: 6,
      outputPath,
      uncompressedBytes: 23,
    });
    assert.equal((await lstat(outputPath)).isFile(), true);

    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath]),
      (error) =>
        error.code === 1 &&
        error.stderr.includes(
          "package-macos: usage: package-macos.mjs APPLICATION.app OUTPUT.app.tar.gz",
        ),
    );
  });

  it("rejects a non-app input and output paths inside the application", async () => {
    const fixture = await makeApplication();
    await assert.rejects(
      packageMacApplication({
        applicationPath: join(fixture.root, "missing"),
        outputPath: join(fixture.root, "missing.tar.gz"),
      }),
      /application path must be one existing \.app directory/,
    );
    await assert.rejects(
      packageMacApplication({
        applicationPath: fixture.applicationPath,
        outputPath: join(fixture.applicationPath, "nested.tar.gz"),
      }),
      /archive output must be outside the application/,
    );
    await assert.rejects(
      packageMacApplication({
        applicationPath: fixture.applicationPath,
        outputPath: join(fixture.root, "outside.tar.gz"),
      }),
      /archive output must end with \.app\.tar\.gz/,
    );

    const regularFileApp = join(fixture.root, "Regular.app");
    await writeFile(regularFileApp, "not a bundle");
    await assert.rejects(
      packageMacApplication({
        applicationPath: regularFileApp,
        outputPath: join(fixture.root, "regular.app.tar.gz"),
      }),
      /application path must be one existing \.app directory/,
    );
    const linkedApp = join(fixture.root, "Linked.app");
    await symlink(fixture.applicationPath, linkedApp);
    await assert.rejects(
      packageMacApplication({
        applicationPath: linkedApp,
        outputPath: join(fixture.root, "linked-root.app.tar.gz"),
      }),
      /application path must be one existing \.app directory/,
    );
    const plainDirectory = join(fixture.root, "PlainDirectory");
    await mkdir(plainDirectory);
    await assert.rejects(
      packageMacApplication({
        applicationPath: plainDirectory,
        outputPath: join(fixture.root, "plain.app.tar.gz"),
      }),
      /application path must be one existing \.app directory/,
    );
    await assert.rejects(
      packageMacApplication({
        applicationPath: join(fixture.root, "Missing.app"),
        outputPath: join(fixture.root, "missing.app.tar.gz"),
      }),
      /application path must be one existing \.app directory/,
    );
  });

  it("rejects links from an untrusted source-stage application", async () => {
    const fixture = await makeApplication();
    await assert.rejects(
      packageMacApplication({
        applicationPath: fixture.applicationPath,
        outputPath: join(fixture.root, "linked.app.tar.gz"),
      }),
      /source application contains a symbolic link/,
    );

    await rm(join(fixture.applicationPath, "Contents", "version-link"));
    const socketDirectory = await mkdtemp(join(tmpdir(), "zergmeeting-socket-"));
    temporaryDirectories.push(socketDirectory);
    const listeningSocketPath = join(socketDirectory, "control.sock");
    const socketPath = join(fixture.applicationPath, "Contents", "control.sock");
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(listeningSocketPath, resolve);
    });
    await rename(listeningSocketPath, socketPath);
    try {
      await assert.rejects(
        packageMacApplication({
          applicationPath: fixture.applicationPath,
          outputPath: join(fixture.root, "socket.app.tar.gz"),
        }),
        /source application contains a special entry/,
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("extracts one bounded regular app tree without executing payload files", async () => {
    const fixture = await makeApplication();
    await rm(join(fixture.applicationPath, "Contents", "version-link"));
    const archivePath = join(fixture.root, "ZergMeeting.source.app.tar.gz");
    const extractionRoot = join(fixture.root, "extracted");
    await packageMacApplication({
      applicationPath: fixture.applicationPath,
      outputPath: archivePath,
    });

    const result = await extractSourceApplication({
      archivePath,
      maxArchiveBytes: (await lstat(archivePath)).size,
      maxEntryCount: 6,
      maxFileBytes: 17,
      maxUncompressedBytes: 23,
      outputDirectory: extractionRoot,
    });

    assert.equal(result.applicationPath, join(extractionRoot, "Zerg Meeting.app"));
    assert.equal(
      await readFile(join(result.applicationPath, "Contents", "MacOS", "zergmeeting"), "utf8"),
      "#!/bin/sh\nexit 0\n",
    );
    assert.equal(result.entryCount, 6);
    assert.equal(result.uncompressedBytes, 23);
  });

  it("rejects every non-contained archive member path and a missing explicit root", async () => {
    const fixture = await makeApplication();
    const unsafePaths = [
      "Other.app/file",
      "Zerg Meeting.app/../escape",
      "Zerg Meeting.app/./escape",
      "Zerg Meeting.app//escape",
      "Zerg Meeting.app\\escape",
      "/Zerg Meeting.app/escape",
    ];
    for (const [index, unsafePath] of unsafePaths.entries()) {
      const archivePath = join(fixture.root, `unsafe-${index}.app.tar.gz`);
      await writeRawTar(archivePath, [
        { path: "Zerg Meeting.app/", type: "Directory" },
        { contents: "x", path: unsafePath },
      ]);
      await assert.rejects(
        extractSourceApplication({
          archivePath,
          outputDirectory: join(fixture.root, `unsafe-output-${index}`),
        }),
        /archive path must remain under Zerg Meeting\.app/,
      );
    }

    const missingRoot = join(fixture.root, "missing-root.app.tar.gz");
    await writeRawTar(missingRoot, [
      { path: "Zerg Meeting.app/Contents/", type: "Directory" },
    ]);
    await assert.rejects(
      extractSourceApplication({
        archivePath: missingRoot,
        outputDirectory: join(fixture.root, "missing-root-output"),
      }),
      /archive must contain exactly one Zerg Meeting\.app root/,
    );

    const longPathArchive = join(fixture.root, "long-path.app.tar.gz");
    const longPath = "Zerg Meeting.app/" + "a".repeat(4_080);
    assert.equal(longPath.length, 4_097);
    await writeRawTar(longPathArchive, [
      { path: "Zerg Meeting.app/", type: "Directory" },
      { contents: "x", path: longPath },
    ]);
    await assert.rejects(
      extractSourceApplication({
        archivePath: longPathArchive,
        outputDirectory: join(fixture.root, "long-path-output"),
      }),
      /archive path must remain under Zerg Meeting\.app/,
    );
  });

  it("accepts an empty regular member without counting phantom bytes", async () => {
    const fixture = await makeApplication();
    await rm(join(fixture.applicationPath, "Contents", "version-link"));
    await writeFile(
      join(fixture.applicationPath, "Contents", "Resources", "empty.txt"),
      "",
    );
    const archivePath = join(fixture.root, "empty-file.app.tar.gz");
    const packageResult = await packageMacApplication({
      applicationPath: fixture.applicationPath,
      outputPath: archivePath,
    });
    assert.equal(packageResult.entryCount, 7);
    assert.equal(packageResult.uncompressedBytes, 23);

    const extraction = await extractSourceApplication({
      archivePath,
      outputDirectory: join(fixture.root, "empty-file-output"),
    });
    assert.equal(
      (await readFile(join(extraction.applicationPath, "Contents", "Resources", "empty.txt"))).length,
      0,
    );
  });

  it("rejects duplicate archive members", async () => {
    const fixture = await makeApplication();
    const duplicateArchive = join(fixture.root, "duplicate.app.tar.gz");
    await writeRawTar(duplicateArchive, [
      { path: "Zerg Meeting.app/", type: "Directory" },
      { contents: "first", path: "Zerg Meeting.app/value" },
      { contents: "second", path: "Zerg Meeting.app/value" },
    ]);
    await assert.rejects(
      extractSourceApplication({
        archivePath: duplicateArchive,
        outputDirectory: join(fixture.root, "duplicate-output"),
      }),
      /archive contains a duplicate path: Zerg Meeting\.app\/value/,
    );

    const fileRootArchive = join(fixture.root, "file-root.app.tar.gz");
    await writeRawTar(fileRootArchive, [
      { contents: "not an application directory", path: "Zerg Meeting.app" },
    ]);
    await assert.rejects(
      extractSourceApplication({
        archivePath: fileRootArchive,
        outputDirectory: join(fixture.root, "file-root-output"),
      }),
      /archive Zerg Meeting\.app root must be a directory/,
    );

  });

  it("keeps extraction outside the archive and removes a partially extracted tree", async () => {
    const fixture = await makeApplication();
    await rm(join(fixture.applicationPath, "Contents", "version-link"));
    const safeArchive = join(fixture.root, "safe-placement.app.tar.gz");
    await packageMacApplication({
      applicationPath: fixture.applicationPath,
      outputPath: safeArchive,
    });
    await assert.rejects(
      extractSourceApplication({
        archivePath: safeArchive,
        outputDirectory: fixture.root,
      }),
      /extraction output directory is unsafe/,
    );
    await assert.rejects(
      extractSourceApplication({
        archivePath: safeArchive,
        outputDirectory: "/",
      }),
      /extraction output directory is unsafe/,
    );
    await assert.rejects(
      extractSourceApplication({
        archivePath: safeArchive,
        outputDirectory: join(fixture.root, "missing-parent", "output"),
      }),
      (error) => error.code === "ENOENT",
    );

    const conflictingArchive = join(fixture.root, "conflicting.app.tar.gz");
    await writeRawTar(conflictingArchive, [
      { path: "Zerg Meeting.app/", type: "Directory" },
      { contents: "file", path: "Zerg Meeting.app/parent" },
      { contents: "child", path: "Zerg Meeting.app/parent/child" },
    ]);
    const partialOutput = join(fixture.root, "partial-output");
    await assert.rejects(
      extractSourceApplication({
        archivePath: conflictingArchive,
        outputDirectory: partialOutput,
      }),
      /archive path hierarchy conflicts at Zerg Meeting\.app\/parent/,
    );
    await assertMissing(partialOutput);

    const reverseConflictArchive = join(fixture.root, "reverse-conflicting.app.tar.gz");
    await writeRawTar(reverseConflictArchive, [
      { path: "Zerg Meeting.app/", type: "Directory" },
      { contents: "child", path: "Zerg Meeting.app/parent/child" },
      { contents: "file", path: "Zerg Meeting.app/parent" },
    ]);
    await assert.rejects(
      extractSourceApplication({
        archivePath: reverseConflictArchive,
        outputDirectory: join(fixture.root, "reverse-partial-output"),
      }),
      /archive path hierarchy conflicts at Zerg Meeting\.app\/parent/,
    );
  });

  it("rejects archive links, path traversal, and entry or byte budget overruns", async () => {
    const fixture = await makeApplication();
    const linkedArchive = join(fixture.root, "linked-source.app.tar.gz");
    await create(
      {
        cwd: join(fixture.root, "bundle"),
        file: linkedArchive,
        gzip: true,
        portable: true,
      },
      ["Zerg Meeting.app"],
    );
    await assert.rejects(
      extractSourceApplication({
        archivePath: linkedArchive,
        outputDirectory: join(fixture.root, "linked-output"),
      }),
      /archive entries must be regular files or directories/,
    );

    await rm(join(fixture.applicationPath, "Contents", "version-link"));
    const safeArchive = join(fixture.root, "safe-source.app.tar.gz");
    await packageMacApplication({
      applicationPath: fixture.applicationPath,
      outputPath: safeArchive,
    });
    await assert.rejects(
      extractSourceApplication({
        archivePath: safeArchive,
        outputDirectory: join(fixture.root, "count-output"),
        maxEntryCount: 5,
      }),
      /archive entry count exceeds 5/,
    );
    await assert.rejects(
      extractSourceApplication({
        archivePath: safeArchive,
        outputDirectory: join(fixture.root, "byte-output"),
        maxUncompressedBytes: 22,
      }),
      /archive uncompressed size exceeds 22 bytes/,
    );

    const outsidePath = join(fixture.root, "outside.txt");
    const traversalArchive = join(fixture.root, "traversal.app.tar.gz");
    await writeFile(outsidePath, "outside");
    await create(
      {
        cwd: join(fixture.root, "bundle"),
        file: traversalArchive,
        gzip: true,
        portable: true,
        preservePaths: true,
      },
      ["../outside.txt"],
    );
    await assert.rejects(
      extractSourceApplication({
        archivePath: traversalArchive,
        outputDirectory: join(fixture.root, "traversal-output"),
      }),
      /archive path must remain under Zerg Meeting\.app/,
    );
  });

  it("fails closed on invalid limits, oversized files, archives, and reused outputs", async () => {
    const fixture = await makeApplication();
    await rm(join(fixture.applicationPath, "Contents", "version-link"));
    await assert.rejects(
      packageMacApplication({
        applicationPath: fixture.applicationPath,
        outputPath: join(fixture.root, "file-limit.app.tar.gz"),
        maxFileBytes: 16,
      }),
      /archive file exceeds 16 bytes/,
    );
    await assert.rejects(
      packageMacApplication({
        applicationPath: fixture.applicationPath,
        outputPath: join(fixture.root, "archive-limit.app.tar.gz"),
        maxArchiveBytes: 1,
      }),
      /archive exceeds 1 bytes/,
    );
    await assert.rejects(
      packageMacApplication({
        applicationPath: fixture.applicationPath,
        outputPath: join(fixture.root, "invalid-limit.app.tar.gz"),
        maxEntryCount: 0,
      }),
      /maximum archive entry count must be a positive safe integer/,
    );

    const archivePath = join(fixture.root, "safe.app.tar.gz");
    await packageMacApplication({
      applicationPath: fixture.applicationPath,
      outputPath: archivePath,
    });
    const reusedOutput = join(fixture.root, "existing-output");
    await mkdir(reusedOutput);
    await assert.rejects(
      extractSourceApplication({ archivePath, outputDirectory: reusedOutput }),
      /extraction output directory must not already exist/,
    );
    const linkedArchive = join(fixture.root, "linked-archive.app.tar.gz");
    await symlink(archivePath, linkedArchive);
    await assert.rejects(
      extractSourceApplication({
        archivePath: linkedArchive,
        outputDirectory: join(fixture.root, "linked-archive-output"),
      }),
      /source archive must be one regular non-symlink file/,
    );
    await assert.rejects(
      extractSourceApplication({
        archivePath: fixture.root,
        outputDirectory: join(fixture.root, "directory-archive-output"),
      }),
      /source archive must be one regular non-symlink file/,
    );
    await assert.rejects(
      extractSourceApplication({
        archivePath,
        maxArchiveBytes: (await lstat(archivePath)).size - 1,
        outputDirectory: join(fixture.root, "compressed-limit-output"),
      }),
      /archive exceeds .* bytes/,
    );
  });
});
