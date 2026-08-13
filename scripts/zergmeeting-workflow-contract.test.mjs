import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { parse } from "yaml";

const workflow = parse(await readFile(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
));

function requireJob(name) {
  const job = workflow.jobs?.[name];
  assert.ok(job && typeof job === "object", `workflow must expose the ${name} job`);
  return job;
}

function requireStep(job, name) {
  const matches = (job.steps || []).filter((step) => step?.name === name);
  assert.equal(matches.length, 1, `${name} must be one unique workflow step`);
  return matches[0];
}

describe("ZergMeeting source-build release contract", () => {
  it("binds each request to the selected independent updater root before private source access", () => {
    const validate = requireJob("validate");
    const rootStep = requireStep(validate, "Bind the request to the channel updater root");
    assert.equal(rootStep.env.REQUEST_UPDATER_PUBLIC_KEY_SHA256, "${{ steps.request.outputs.updater_public_key_sha256 }}");
    assert.match(rootStep.run, /keys\/zergmeeting-(preview|stable)-updater\.pubkey/);
    assert.match(rootStep.run, /createHash\("sha256"\)/);
    assert.match(rootStep.run, /canonical base64/);
    assert.match(rootStep.run, /REQUEST_UPDATER_PUBLIC_KEY_SHA256/);

    const build = requireJob("build-macos");
    const checkoutIndex = build.steps.findIndex((step) => step.name === "Check out the exact SHA and matching source tag");
    assert.ok(checkoutIndex >= 0, "private source checkout must remain explicit");
    assert.ok(
      workflow.jobs.validate.steps.findIndex((step) => step.name === rootStep.name) < validate.steps.length,
      "the public trust-root binding must be part of validation",
    );
    assert.deepEqual(build.needs, ["validate"]);
  });

  it("runs the exact ZergMeeting source gates from the monorepo package", () => {
    const build = requireJob("build-macos");
    const install = requireStep(build, "Install locked dependencies and security tooling");
    assert.match(
      install.run,
      /^\s*npm ci --prefix source\/zapps\/zergmeeting\s*$/m,
    );
    assert.match(
      install.run,
      /^\s*npm ci --prefix source\/ztc\s*$/m,
    );
    assert.match(
      install.run,
      /^\s*npm ci --ignore-scripts --no-audit --no-fund --prefix source\/zapps\/zergmeeting\/scripts\/release\s*$/m,
    );
    assert.doesNotMatch(
      install.run,
      /npm ci[^\n]*--omit(?:=|\s+)optional/,
      "the locked install must retain optional native builder dependencies",
    );

    const sourceGate = requireStep(build, "Test and audit the exact source");
    assert.equal(sourceGate["working-directory"], undefined);
    const orderedNativeGate = [
      "npm run audit:web-production --prefix source/zapps/zergmeeting",
      "npm --prefix source/ztc audit --omit=dev --audit-level=moderate",
      "npm run test:release --prefix source/zapps/zergmeeting",
      "npm run test:meeting-runtime --prefix source/zapps/zergmeeting",
    ];
    const gateIndexes = orderedNativeGate.map((command) => {
      assert.equal(
        sourceGate.run.split("\n").filter((line) => line.trim() === command).length,
        1,
        `source gate must execute ${command} exactly once`,
      );
      return sourceGate.run.indexOf(command);
    });
    assert.ok(
      gateIndexes[0] < gateIndexes[1] && gateIndexes[1] < gateIndexes[2] &&
        gateIndexes[2] < gateIndexes[3],
      "the bounded web and zero-vulnerability source audits must precede tests",
    );
    for (const command of [
      "npm run typecheck --prefix source/zapps/zergmeeting",
      "npm run build --prefix source/zapps/zergmeeting",
      "cargo test --locked --manifest-path source/zapps/zergmeeting/src-tauri/Cargo.toml",
      "cargo clippy --locked --all-targets --manifest-path source/zapps/zergmeeting/src-tauri/Cargo.toml -- -D warnings",
      "cargo fmt --all --manifest-path source/zapps/zergmeeting/src-tauri/Cargo.toml -- --check",
    ]) {
      assert.ok(sourceGate.run.includes(command), `source gate must execute ${command}`);
    }

    const sourceGateIndex = build.steps.indexOf(sourceGate);
    const appBuild = requireStep(
      build,
      "Build the unsigned app without release signing credentials",
    );
    const appBuildIndex = build.steps.indexOf(appBuild);
    assert.ok(
      sourceGateIndex >= 0 && appBuildIndex > sourceGateIndex,
      "the verified native frontend must pass its source gate before Tauri builds it",
    );
    assert.deepEqual(appBuild.env, {
      ZERGMEETING_UPDATE_CHANNEL: "${{ needs.validate.outputs.channel }}",
    });
  });

  it("binds source media capabilities to public bytes before source execution", () => {
    const build = requireJob("build-macos");
    const bindIndex = build.steps.findIndex(
      (step) => step.name === "Bind source media capabilities to the public entitlement contract",
    );
    const cleanupIndex = build.steps.findIndex(
      (step) => step.name === "Delete ephemeral source deploy key",
    );
    const sourceGateIndex = build.steps.findIndex(
      (step) => step.name === "Test and audit the exact source",
    );
    assert.ok(
      cleanupIndex >= 0 && bindIndex > cleanupIndex && sourceGateIndex > bindIndex,
      "public media bytes must bind after credential deletion and before source execution",
    );

    const binding = build.steps[bindIndex];
    assert.equal(binding.env, undefined);
    assert.equal(binding["working-directory"], undefined);
    assert.doesNotMatch(JSON.stringify(binding), /secrets\.|SOURCE_DEPLOY_KEY/);
    for (const variable of [
      "public_entitlements",
      "source_entitlements",
      "source_config",
      "source_info",
    ]) {
      assert.match(
        binding.run,
        new RegExp(`test -f "\\$${variable}" && test ! -L "\\$${variable}"`),
        `${variable} must be one regular non-symlink file`,
      );
    }
    for (const token of [
      "source/zapps/zergmeeting/src-tauri/tauri.conf.json",
      "config.productName",
      "Zerg Meeting",
      "config.identifier",
      "com.zergai.meeting",
      "config.bundle.macOS.infoPlist",
      "Info.plist",
      "cmp --silent",
      "macos/ZergMeeting.entitlements.plist",
      "source/zapps/zergmeeting/src-tauri/Entitlements.plist",
    ]) {
      assert.ok(binding.run.includes(token), `media binding must enforce ${token}`);
    }
    assert.doesNotMatch(binding.run, /beforeBuildCommand|release:stage/);
  });

  it("generates the fail-closed production config without a mutable updater flag", () => {
    const build = requireJob("build-macos");
    const config = requireStep(build, "Write and verify the ZergMeeting release configuration");
    assert.equal(config["working-directory"], "source/zapps/zergmeeting");
    assert.deepEqual(config.env, {
      ZERGMEETING_UPDATE_CHANNEL: "${{ needs.validate.outputs.channel }}",
      ZERGMEETING_VERSION: "${{ needs.validate.outputs.version }}",
    });
    assert.match(config.run, /npm run release:config/);
    assert.match(config.run, /com\.zergai\.meeting/);
    assert.match(config.run, /Zerg Meeting/);
    assert.doesNotMatch(JSON.stringify(build), /UPDATER_ENABLED/);
    assert.doesNotMatch(JSON.stringify(build), /TAURI_UPDATER_PUBKEY/);
  });

  it("builds, stages, and publishes one Apple Silicon macOS application", () => {
    const build = requireJob("build-macos");
    const toolchain = requireStep(build, "Install pinned Rust toolchain");
    assert.match(toolchain.run, /aarch64-apple-darwin/);
    assert.equal(toolchain.run.match(/--target aarch64-apple-darwin/g)?.length, 1);

    const appBuild = requireStep(build, "Build the unsigned app without release signing credentials");
    assert.equal(appBuild["working-directory"], "source/zapps/zergmeeting");
    assert.match(appBuild.run, /--target aarch64-apple-darwin/);
    assert.match(appBuild.run, /--config src-tauri\/tauri\.release\.conf\.json/);

    const stage = requireStep(build, "Package a bounded unsigned source stage");
    assert.equal(stage["working-directory"], "source/zapps/zergmeeting");
    assert.match(stage.run, /target\/aarch64-apple-darwin\/release\/bundle/);
    assert.match(stage.run, /ZergMeeting_\$\{ZERGMEETING_DESKTOP_VERSION\}_aarch64\.source\.app\.tar\.gz/);
    assert.match(stage.run, /platform: "darwin-aarch64"/);
    assert.match(stage.run, /product: "Zerg Meeting"/);

    const resources = requireStep(build, "Verify the exact bundled ZergMeeting release assets");
    assert.match(resources.run, /Contents\/Resources\/desktop-runtime/);
    assert.match(resources.run, /meeting-bridge\.mjs/);
    assert.match(resources.run, /node_modules\/zerg-ztc\/dist\/cli_main\.js/);
    assert.match(resources.run, /Contents\/MacOS\/node"/);
    assert.match(resources.run, /Contents\/MacOS\/ztc-capture"/);
    assert.doesNotMatch(resources.run, /Contents\/MacOS\/node-aarch64-apple-darwin/);
    assert.doesNotMatch(resources.run, /Contents\/MacOS\/ztc-capture-aarch64-apple-darwin/);
    assert.match(resources.run, /test ! -e "\$resources\/node_modules\/\.bin"/);
    assert.match(resources.run, /v22\.23\.2/);
    assert.match(resources.run, /find "\$resources" -type l/);

    const runtime = requireStep(build, "Stage and verify the pinned standalone meeting runtime");
    assert.match(runtime.run, /node-v22\.23\.2-darwin-arm64\.tar\.gz/);
    assert.match(runtime.run, /shasum -a 256 -c/);
    assert.match(runtime.run, /npm run release:stage/);
  });

  it("validates the Apple Silicon slice before Apple credentials and signs the disk image", () => {
    const apple = requireJob("apple-sign");
    const hostile = requireStep(apple, "Verify and extract the hostile source stage");
    assert.match(hostile.run, /ZergMeeting_\$\{VERSION\}_aarch64\.source\.app\.tar\.gz/);
    assert.match(hostile.run, /lipo -archs/);
    assert.match(hostile.run, /arm64/);
    assert.match(hostile.run, /test "\$\(wc -w .*" -eq 1/);
    assert.doesNotMatch(JSON.stringify(hostile), /ZERGMEETING_APPLE_/);

    const signing = requireStep(apple, "Apply preview ad-hoc or fail-closed stable Apple signing");
    assert.match(signing.run, /ZergMeeting_\$\{VERSION\}_aarch64\.dmg/);
    assert.match(signing.run, /codesign --force --timestamp --sign "\$identity" "\$dmg"/);
    assert.match(signing.run, /notarytool submit "\$dmg"/);
    assert.match(signing.run, /stapler validate "\$dmg"/);
    assert.match(signing.run, /spctl --assess --type open --context context:primary-signature/);
    assert.match(signing.run, /source=Notarized Developer ID/);
  });

  it("semantically verifies outer-app media entitlements after signing and fresh extraction", () => {
    const apple = requireJob("apple-sign");
    const signing = requireStep(
      apple,
      "Apply preview ad-hoc or fail-closed stable Apple signing",
    );
    assert.match(
      signing.run,
      /scripts\/sign-macos-app\.sh "\$app" "\$identity" "\$CHANNEL" "\$VERSION" \\\n+\s+macos\/ZergMeeting\.entitlements\.plist/,
    );
    for (const token of [
      "codesign -d --entitlements - --xml \"$app\"",
      "plutil -convert json",
      "assert.deepEqual(actual, expected)",
      '"com.apple.security.network.client": true',
      '"com.apple.security.device.audio-input": true',
      '"com.apple.security.cs.allow-jit": true',
      '"com.apple.security.cs.allow-unsigned-executable-memory": true',
      '"com.apple.security.app-sandbox": false',
    ]) {
      assert.ok(signing.run.includes(token), `Apple signing must enforce ${token}`);
    }
    assert.doesNotMatch(signing.run, /source\/zapps|git -C source|npm run|cargo/);

    const smoke = requireStep(
      requireJob("signed-smoke"),
      "Audit and launch the signed Apple Silicon application",
    );
    const entitlementAudit = smoke.run.indexOf(
      "codesign -d --entitlements - --xml \"$app\"",
    );
    const launch = smoke.run.indexOf('"$executable" >"$log"');
    assert.ok(
      entitlementAudit >= 0 && launch > entitlementAudit,
      "fresh extraction must verify signed entitlements before launching",
    );
    for (const token of [
      "plutil -convert json",
      "assert.deepEqual(actual, expected)",
      '"com.apple.security.device.audio-input": true',
    ]) {
      assert.ok(smoke.run.includes(token), `fresh smoke must enforce ${token}`);
    }
    assert.doesNotMatch(smoke.run, /source\/zapps|git -C source|npm run|cargo/);
  });

  it("signs and publishes the exact Apple Silicon updater archive", () => {
    const previewSign = requireStep(
      requireJob("sign-updater-preview"),
      "Sign only the preview updater archive",
    );
    const stableSign = requireStep(
      requireJob("sign-updater-stable"),
      "Sign only the stable updater archive",
    );
    assert.match(previewSign.run, /ZergMeeting_\$\{VERSION\}_aarch64\.app\.tar\.gz/);
    assert.match(stableSign.run, /ZergMeeting_\$\{VERSION\}_aarch64\.app\.tar\.gz/);
    const collect = requireStep(
      requireJob("sign-updater"),
      "Collect and verify the immutable release payload",
    );
    assert.match(collect.run, /scripts\/collect-release\.mjs/);
    assert.match(collect.run, /darwin-aarch64/);
    assert.match(collect.run, /manifest\.platforms\["darwin-aarch64"\]/);
    assert.match(collect.run, /Object\.keys\(manifest\.platforms\), \["darwin-aarch64"\]/);
  });

  it("destroys Apple credentials before credential-free payload packaging", () => {
    const apple = requireJob("apple-sign");
    const signingIndex = apple.steps.findIndex(
      (step) => step.name === "Apply preview ad-hoc or fail-closed stable Apple signing",
    );
    const cleanupIndex = apple.steps.findIndex(
      (step) => step.name === "Delete ephemeral Apple credentials",
    );
    const packageIndex = apple.steps.findIndex(
      (step) => step.name === "Package the credential-free signed payload",
    );
    const uploadIndex = apple.steps.findIndex(
      (step) => step.uses?.startsWith("actions/upload-artifact@"),
    );
    assert.ok(
      signingIndex >= 0 && signingIndex < cleanupIndex && cleanupIndex < packageIndex &&
        packageIndex < uploadIndex,
      "Apple cleanup must separate signing from packaging and artifact upload",
    );

    const signing = apple.steps[signingIndex];
    const cleanup = apple.steps[cleanupIndex];
    const packaging = apple.steps[packageIndex];
    assert.equal(cleanup.if, "always()");
    assert.doesNotMatch(signing.run, /package-macos\.mjs|build-metadata\.json/);
    assert.doesNotMatch(JSON.stringify(packaging), /secrets\.|ZERGMEETING_APPLE_/);
    assert.match(packaging.run, /ZergMeeting_\$\{VERSION\}_aarch64\.app\.tar\.gz/);
    assert.match(packaging.run, /darwin-aarch64/);
    assert.match(packaging.run, /SHA256SUMS/);
  });

  it("gates updater signing on a fresh secret-free signed-app smoke", () => {
    const smoke = requireJob("signed-smoke");
    assert.deepEqual(smoke.needs, ["validate", "apple-sign"]);
    assert.equal(smoke["runs-on"], "macos-15");
    assert.equal(smoke.environment, undefined);
    assert.deepEqual(smoke.permissions, { contents: "read" });
    assert.doesNotMatch(JSON.stringify(smoke), /secrets\.|ZERGMEETING_APPLE_|TAURI_SIGNING_PRIVATE_KEY/);

    const audit = requireStep(smoke, "Audit and launch the signed Apple Silicon application");
    for (const token of [
      "shasum -a 256 -c SHA256SUMS",
      "lipo -archs",
      "arm64",
      "arm64",
      "codesign --verify --deep --strict",
      "hdiutil verify",
      "stapler validate",
      "spctl --assess",
      "kill -0 \"$app_pid\"",
    ]) {
      assert.ok(audit.run.includes(token), `signed smoke must execute ${token}`);
    }

    for (const [jobName, stepName] of [
      ["sign-updater-preview", "Sign only the preview updater archive"],
      ["sign-updater-stable", "Sign only the stable updater archive"],
    ]) {
      const updater = requireJob(jobName);
      assert.deepEqual(updater.needs, ["validate", "signed-smoke"]);
      const sign = requireStep(updater, stepName);
      const signIndex = sign.run.indexOf("tauri signer sign");
      const unsetIndex = sign.run.indexOf("unset TAURI_SIGNING_PRIVATE_KEY");
      assert.ok(signIndex >= 0 && unsetIndex > signIndex);
    }
  });

  it("isolates preview and stable updater credentials on separate runners", () => {
    const preview = requireJob("sign-updater-preview");
    const stable = requireJob("sign-updater-stable");
    const aggregate = requireJob("sign-updater");

    assert.equal(preview.environment, "zergmeeting-preview-updater");
    assert.equal(stable.environment, "zergmeeting-stable-updater");
    assert.equal(preview.if, "needs.validate.outputs.channel == 'preview'");
    assert.equal(stable.if, "needs.validate.outputs.channel == 'stable'");
    assert.deepEqual(preview.needs, ["validate", "signed-smoke"]);
    assert.deepEqual(stable.needs, ["validate", "signed-smoke"]);

    const previewSign = requireStep(preview, "Sign only the preview updater archive");
    assert.deepEqual(previewSign.env, {
      TAURI_SIGNING_PRIVATE_KEY: "${{ secrets.ZERGMEETING_PREVIEW_TAURI_SIGNING_PRIVATE_KEY }}",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD:
        "${{ secrets.ZERGMEETING_PREVIEW_TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
    });
    const stableSign = requireStep(stable, "Sign only the stable updater archive");
    assert.deepEqual(stableSign.env, {
      TAURI_SIGNING_PRIVATE_KEY: "${{ secrets.ZERGMEETING_STABLE_TAURI_SIGNING_PRIVATE_KEY }}",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD:
        "${{ secrets.ZERGMEETING_STABLE_TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
    });
    assert.doesNotMatch(JSON.stringify(preview), /ZERGMEETING_STABLE_TAURI/);
    assert.doesNotMatch(JSON.stringify(stable), /ZERGMEETING_PREVIEW_TAURI/);

    assert.equal(aggregate.environment, undefined);
    assert.deepEqual(aggregate.needs, [
      "validate",
      "sign-updater-preview",
      "sign-updater-stable",
    ]);
    assert.doesNotMatch(JSON.stringify(aggregate), /secrets\.|TAURI_SIGNING_PRIVATE_KEY/);
    requireStep(aggregate, "Verify the updater signature with the public trust root");
    requireStep(aggregate, "Collect and verify the immutable release payload");
  });

  it("destroys the source deploy key before materializing source bytes", () => {
    const build = requireJob("build-macos");
    const checkout = requireStep(build, "Check out the exact SHA and matching source tag");
    const lastFetch = checkout.run.lastIndexOf("git -C source fetch");
    const unset = checkout.run.indexOf("unset SOURCE_DEPLOY_KEY");
    const remove = checkout.run.lastIndexOf('rm -f "$key_path"');
    const materialize = checkout.run.indexOf("git -C source checkout --detach");
    assert.ok(
      lastFetch >= 0 && unset > lastFetch && remove > lastFetch && materialize > unset &&
        materialize > remove,
      "the source credential must be destroyed after fetch and before checkout",
    );
    assert.match(checkout.run, /trap 'rm -f "\$key_path"' EXIT/);
  });

  it("executes feed policy before a single bounded deploy-key push step", () => {
    const feed = requireJob("promote-feed");
    const secretSteps = feed.steps.filter((step) => JSON.stringify(step).includes("secrets."));
    assert.deepEqual(
      secretSteps.map((step) => step.name),
      ["Push the prepared release-data commit"],
    );

    const stage = requireStep(feed, "Stage and commit only the channel-scoped Pages feed");
    assert.doesNotMatch(JSON.stringify(stage), /secrets\.|ssh-key/);
    assert.match(stage.run, /https:\/\/github\.com\/\$GITHUB_REPOSITORY\.git/);
    assert.match(stage.run, /feed-policy\.mjs/);
    assert.match(stage.run, /core\.hooksPath/);

    const push = requireStep(feed, "Push the prepared release-data commit");
    assert.deepEqual(Object.keys(push.env), ["ZERGMEETING_FEED_DEPLOY_KEY"]);
    assert.match(push.run, /git -C "\$data_repo" push/);
    assert.match(push.run, /refs\/heads\/release-data/);
    assert.match(push.run, /unset ZERGMEETING_FEED_DEPLOY_KEY/);
    assert.doesNotMatch(push.run, /node |npm |feed-policy|git commit|git add/);

    for (const step of feed.steps.filter((step) => step.uses?.startsWith("actions/checkout@"))) {
      assert.equal(step.with?.["persist-credentials"], false);
      assert.equal(step.with?.["ssh-key"], undefined);
    }
  });
});
