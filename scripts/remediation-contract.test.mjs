import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

const release = parse(await readFile(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
));
const anchor = parse(await readFile(
  new URL("../.github/workflows/policy-anchor.yml", import.meta.url),
  "utf8",
));

function step(job, name) {
  const matches = (release.jobs[job]?.steps ?? []).filter(
    (candidate) => candidate.name === name,
  );
  assert.equal(matches.length, 1, `${job} must contain one ${name} step`);
  return matches[0];
}

test("commits canonical LF-terminated updater roots", async () => {
  for (const name of ["preview", "stable"]) {
    const bytes = await readFile(
      new URL(`../keys/zergmeeting-${name}-updater.pubkey`, import.meta.url),
    );
    assert.equal(bytes.at(-1), 10, `${name} root must end in LF`);
    assert.notEqual(bytes.at(-2), 10, `${name} root must have one trailing LF`);
    const encoded = bytes.toString("utf8").trim();
    assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/);
    assert.equal(Buffer.from(encoded, "base64").toString("base64"), encoded);
  }
});

test("compares canonical dot-named source roots without raw-byte coupling", () => {
  const compare = step(
    "build-macos",
    "Compare both tag-selected updater keys with independent trust roots",
  );
  assert.match(compare.run, /src-tauri\/updater\.preview\.pubkey/);
  assert.match(compare.run, /src-tauri\/updater\.stable\.pubkey/);
  assert.match(compare.run, /readFile[\s\S]*\.trim\(\)/);
  assert.match(compare.run, /canonical base64/);
  assert.doesNotMatch(compare.run, /cmp --silent/);

  const config = step(
    "build-macos",
    "Write and verify the ZergMeeting release configuration",
  );
  assert.match(config.run, /updater\.stable\.pubkey/);
  assert.match(config.run, /updater\.preview\.pubkey/);
  assert.match(config.run, /committedKey\.trim\(\)/);
  assert.match(config.run, /trustedKey\.trim\(\)/);
  assert.match(config.run, /createUpdaterArtifacts, false/);
});

test("builds exact local ZTC inputs before staging a symlink-free runtime", () => {
  const stage = step(
    "build-macos",
    "Stage and verify the pinned standalone meeting runtime",
  );
  assert.deepEqual(stage.env, {
    ZERGMEETING_NODE_ARCHIVE:
      "${{ runner.temp }}/node-v22.23.2-darwin-arm64.tar.gz",
    ZERGMEETING_NODE_SHA256:
      "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
    ZERGMEETING_ZTC_CAPTURE_BIN:
      "${{ runner.temp }}/zergmeeting-capture-target/aarch64-apple-darwin/release/ztc-capture",
    ZERGMEETING_ZTC_PACKAGE:
      "${{ runner.temp }}/zergmeeting-ztc-package/zerg-ztc-0.2.0-beta.1.tgz",
  });
  for (const token of [
    "cargo build --locked --release --target aarch64-apple-darwin",
    "source/ztc/packages/ztc-capture/Cargo.toml",
    "--target-dir \"$RUNNER_TEMP/zergmeeting-capture-target\"",
    "npm run build --prefix source/ztc",
    "npm pack --prefix source/ztc",
    "npm run release:stage",
    "test ! -e \"$stage/node_modules/.bin\"",
    "node_modules/zerg-ztc/dist/cli_main.js",
  ]) {
    assert.ok(stage.run.includes(token), token);
  }
  assert.match(stage.run, /find "\$stage" -type l/);
});

test("compiles the selected updater channel and verifies installed sidecar names", () => {
  const build = step(
    "build-macos",
    "Build the unsigned app without release signing credentials",
  );
  assert.equal(
    build.env.ZERGMEETING_UPDATE_CHANNEL,
    "${{ needs.validate.outputs.channel }}",
  );
  const verify = step(
    "build-macos",
    "Verify the exact bundled ZergMeeting release assets",
  );
  assert.match(verify.run, /Contents\/MacOS\/node"/);
  assert.match(verify.run, /Contents\/MacOS\/ztc-capture"/);
  assert.doesNotMatch(verify.run, /Contents\/MacOS\/node-aarch64-apple-darwin/);
  assert.doesNotMatch(
    verify.run,
    /Contents\/MacOS\/ztc-capture-aarch64-apple-darwin/,
  );
  assert.match(verify.run, /node_modules\/zerg-ztc\/dist\/cli_main\.js/);
  assert.match(verify.run, /test ! -e "\$resources\/node_modules\/\.bin"/);
});

test("validates base identity before generating release-only configuration", () => {
  const bind = step(
    "build-macos",
    "Bind source media capabilities to the public entitlement contract",
  );
  assert.match(bind.run, /productName[\s\S]*Zerg Meeting/);
  assert.match(bind.run, /identifier[\s\S]*com\.zergai\.meeting/);
  assert.doesNotMatch(bind.run, /beforeBuildCommand/);
  assert.doesNotMatch(bind.run, /release:stage/);
});

test("accepts reviewed routine lock inputs without weakening immutable policy", () => {
  assert.deepEqual(anchor.on.pull_request_target.types, [
    "opened",
    "reopened",
    "synchronize",
    "labeled",
    "unlabeled",
  ]);
  const job = anchor.jobs["anchored-policy"];
  const review = job.steps.find(
    (candidate) => candidate.name === "Resolve head-bound independent review",
  );
  assert.deepEqual(review.env, {
    APPROVAL_LABEL: "zergmeeting-release-policy-reviewed",
    EVENT_ACTION: "${{ github.event.action }}",
    EVENT_LABEL: "${{ github.event.label.name || '' }}",
    EVENT_SENDER: "${{ github.event.sender.login }}",
    EVENT_SENDER_TYPE: "${{ github.event.sender.type }}",
    PR_AUTHOR: "${{ github.event.pull_request.user.login }}",
    REPOSITORY_READ_TOKEN: "${{ github.token }}",
    RUN_ATTEMPT: "${{ github.run_attempt }}",
    TRIGGERING_ACTOR: "${{ github.triggering_actor }}",
  });
  assert.match(
    review.run,
    /EVENT_ACTION" == "labeled"[\s\S]*RUN_ATTEMPT" == "1"[\s\S]*TRIGGERING_ACTOR" == "\$EVENT_SENDER"[\s\S]*EVENT_SENDER" != "\$PR_AUTHOR"/,
  );
  assert.match(review.run, /\.role_name[\s\S]*admin[\s\S]*maintain[\s\S]*write/);
  assert.match(review.run, /mktemp[\s\S]*chmod 600[\s\S]*curl --config/);
  assert.doesNotMatch(review.run, /pull_request\.labels/);

  const materialize = job.steps.find(
    (candidate) => candidate.name === "Materialize only bounded candidate data",
  );
  assert.equal(
    materialize.env.ROUTINE_PROTECTED_CHANGE_APPROVED,
    "${{ steps.protected-input-review.outputs.approved }}",
  );
  assert.match(materialize.run, /"\$ROUTINE_PROTECTED_CHANGE_APPROVED"/);
});

test("keeps derived Git authorization out of process arguments", () => {
  const fetch = anchor.jobs["anchored-policy"].steps.find(
    (candidate) => candidate.name ===
      "Fetch the immutable pull request objects without checkout",
  );
  assert.match(fetch.run, /GIT_CONFIG_COUNT/);
  assert.match(fetch.run, /GIT_CONFIG_VALUE_0/);
  assert.match(fetch.run, /unset REPOSITORY_READ_TOKEN authorization/);
  assert.doesNotMatch(fetch.run, /-c "\$header_key=AUTHORIZATION: basic \$authorization"/);
});
