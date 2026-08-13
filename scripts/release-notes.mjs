import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function makeReleaseNotes({ version, channel, sourceSha }) {
  return [
    `ZergMeeting ${version} (${channel}, Apple Silicon macOS)`,
    "",
    `Built from Epoch-ML/zerg commit ${sourceSha} after source, dependency, Apple platform-signature, updater-signature, and artifact verification.`,
    "",
    "Important upgrade notice: installations that do not embed this channel's public updater root need one manual installation of this release. Automatic in-app updates begin between releases from this public boundary.",
    "",
  ].join("\n");
}

async function main() {
  const [outputPath, version, channel, sourceSha] = process.argv.slice(2);
  if ([outputPath, version, channel, sourceSha].some((value) => value === undefined)) {
    throw new Error(
      "usage: release-notes.mjs OUTPUT_PATH VERSION CHANNEL SOURCE_SHA",
    );
  }
  await writeFile(
    outputPath,
    makeReleaseNotes({ version, channel, sourceSha }),
    { flag: "wx" },
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
