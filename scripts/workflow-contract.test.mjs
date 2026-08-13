import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const workflow = await readFile(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);

describe("ZergMeeting release workflow contract", () => {
  it("serializes releases and validates one immutable request", () => {
    const triggerBlock = workflow.slice(
      workflow.indexOf("on:"),
      workflow.indexOf("\npermissions:"),
    );
    assert.match(triggerBlock, /workflow_dispatch:/);
    assert.doesNotMatch(triggerBlock, /push:/);
    assert.match(workflow, /group: zergmeeting-v2-release/);
    assert.match(workflow, /cancel-in-progress: false/);
    assert.match(workflow, /node scripts\/release-request\.mjs/);
  });

  it("binds manual main dispatch to an immutable request and pre-existing tag", () => {
    assert.match(workflow, /GITHUB_REF.*refs\/heads\/main/);
    assert.match(workflow, /DISPATCH_REQUEST/);
    assert.match(workflow, /git diff --name-status --no-renames -z/);
    assert.match(workflow, /git log --format=%H --diff-filter=A/);
    assert.match(workflow, /request_commit/);
    assert.match(workflow, /cmp --silent/);
    assert.match(workflow, /git ls-remote .*--tags origin/);
    assert.match(workflow, /refs\/tags\/\$RELEASE_TAG\^\{\}/);
    assert.match(workflow, /tag_target.*request_commit/s);
    const tagCheck = workflow.indexOf("Require the pre-existing public release tag");
    const build = workflow.indexOf("\n  build-macos:");
    assert.ok(tagCheck > 0 && tagCheck < build);
  });

  it("installs and verifies locked validator dependencies before reading a request", () => {
    const validateStart = workflow.indexOf("\n  validate:");
    const buildStart = workflow.indexOf("\n  build-macos:");
    const validateJob = workflow.slice(validateStart, buildStart);
    const install = validateJob.indexOf(
      "Install and test the public request validator",
    );
    const requestValidation = validateJob.indexOf(
      "Validate request schema and provenance",
    );

    assert.ok(install > 0 && install < requestValidation);
    assert.match(
      validateJob,
      /npm ci --ignore-scripts --no-audit --no-fund/,
    );
    assert.match(validateJob, /npm audit --audit-level=moderate/);
    assert.match(validateJob, /npm test/);
  });

  it("checks out exact source with authenticated host metadata", () => {
    const checkoutStart = workflow.indexOf(
      "Check out the exact SHA and matching source tag",
    );
    const cleanupStart = workflow.indexOf(
      "Delete ephemeral source deploy key",
    );
    const checkoutStep = workflow.slice(checkoutStart, cleanupStart);

    assert.match(workflow, /ZERG_SOURCE_DEPLOY_KEY/);
    assert.match(checkoutStep, /GITHUB_META_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(checkoutStep, /api\.github\.com\/meta/);
    assert.match(
      checkoutStep,
      /--header "Authorization: Bearer \$GITHUB_META_TOKEN"/,
    );
    assert.match(workflow, /git init source/);
    assert.match(workflow, /source_sha/);
    assert.match(workflow, /source_ref/);
    assert.match(workflow, /\^\{commit\}/);
    assert.match(workflow, /git -C source show -s --format=%ct "\$SOURCE_SHA"/);
    assert.match(workflow, /source_commit_requested_at/);
    assert.match(workflow, /source_commit_requested_at.*ZERGMEETING_RELEASE_DATE/s);
    assert.match(workflow, /Delete ephemeral source deploy key/);
  });

  it("fetches only requested refs and never hydrates unrelated source LFS objects", () => {
    const checkoutStart = workflow.indexOf(
      "Check out the exact SHA and matching source tag",
    );
    const cleanupStart = workflow.indexOf(
      "Delete ephemeral source deploy key",
    );
    const checkoutStep = workflow.slice(checkoutStart, cleanupStart);

    assert.equal(
      checkoutStep.match(/git -C source fetch --no-tags/g)?.length,
      2,
    );
    assert.match(
      checkoutStep,
      /GIT_LFS_SKIP_SMUDGE=1 git -C source checkout --detach "\$SOURCE_SHA"/,
    );
  });

  it("keeps exact-source gates free of release metadata and scopes later inputs", () => {
    const buildStart = workflow.indexOf("\n  build-macos:");
    const appleStart = workflow.indexOf("\n  apple-sign:");
    const buildJob = workflow.slice(buildStart, appleStart);
    const jobEnvironment = buildJob.slice(0, buildJob.indexOf("\n    steps:"));
    const sourceGate = buildJob.slice(
      buildJob.indexOf("Test and audit the exact source"),
      buildJob.indexOf("Write and verify the ZergMeeting release configuration"),
    );
    const releaseVariables = [
      "ZERGMEETING_DESKTOP_VERSION",
      "ZERGMEETING_RELEASE_DATE",
      "ZERGMEETING_RELEASE_REPOSITORY",
      "ZERGMEETING_RELEASE_TAG",
      "ZERGMEETING_SOURCE_SHA",
      "ZERGMEETING_UPDATE_BASE_URL",
      "ZERGMEETING_UPDATE_CHANNEL",
      "ZERGMEETING_VERSION",
      "VITE_ZERGMEETING_UPDATER_ENABLED",
      "ZERGMEETING_NATIVE_CHANNEL",
      "ZERGMEETING_NATIVE_VERSION",
      "NUXT_PUBLIC_API_BASE_URL",
    ];

    for (const name of releaseVariables) {
      assert.doesNotMatch(jobEnvironment, new RegExp(`\\n      ${name}:`));
      assert.doesNotMatch(sourceGate, new RegExp(`\\b${name}\\b`));
    }

    const timestampStep = buildJob.slice(
      buildJob.indexOf("Verify the deterministic source commit timestamp"),
      buildJob.indexOf("Install pinned Rust toolchain"),
    );
    assert.match(
      timestampStep,
      /ZERGMEETING_RELEASE_DATE: \$\{\{ needs\.validate\.outputs\.requested_at \}\}/,
    );

    const configStep = buildJob.slice(
      buildJob.indexOf("Write and verify the ZergMeeting release configuration"),
      buildJob.indexOf("Build the unsigned app without release signing credentials"),
    );
    for (const binding of [
      "ZERGMEETING_UPDATE_CHANNEL: ${{ needs.validate.outputs.channel }}",
      "ZERGMEETING_VERSION: ${{ needs.validate.outputs.version }}",
    ]) {
      assert.ok(configStep.includes(binding));
    }

    const applicationBuildStep = buildJob.slice(
      buildJob.indexOf("Build the unsigned app without release signing credentials"),
      buildJob.indexOf("Package a bounded unsigned source stage"),
    );
    assert.doesNotMatch(applicationBuildStep, /UPDATER_ENABLED|TAURI_UPDATER_PUBKEY/);

    const packageStep = buildJob.slice(
      buildJob.indexOf("Package a bounded unsigned source stage"),
      buildJob.indexOf("actions/upload-artifact"),
    );
    for (const binding of [
      "ZERGMEETING_DESKTOP_VERSION: ${{ needs.validate.outputs.version }}",
      "ZERGMEETING_RELEASE_TAG: ${{ needs.validate.outputs.release_tag }}",
      "ZERGMEETING_SOURCE_SHA: ${{ needs.validate.outputs.source_sha }}",
      "ZERGMEETING_UPDATE_CHANNEL: ${{ needs.validate.outputs.channel }}",
    ]) {
      assert.ok(packageStep.includes(binding));
    }
  });

  it("separates preview ad-hoc signing from fail-closed stable credentials", () => {
    assert.match(workflow, /identity="-"/);
    for (const name of [
      "ZERGMEETING_APPLE_CERTIFICATE",
      "ZERGMEETING_APPLE_CERTIFICATE_PASSWORD",
      "ZERGMEETING_APPLE_SIGNING_IDENTITY",
      "ZERGMEETING_APPLE_API_ISSUER",
      "ZERGMEETING_APPLE_API_KEY_ID",
      "ZERGMEETING_APPLE_API_PRIVATE_KEY",
      "ZERGMEETING_PREVIEW_TAURI_SIGNING_PRIVATE_KEY",
      "ZERGMEETING_PREVIEW_TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
      "ZERGMEETING_STABLE_TAURI_SIGNING_PRIVATE_KEY",
      "ZERGMEETING_STABLE_TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    ]) {
      assert.match(workflow, new RegExp(name));
    }
    assert.match(workflow, /runs-on: macos-15/);
    assert.match(workflow, /xcrun stapler validate/);
    for (const environment of [
      "zergmeeting-preview-build",
      "zergmeeting-stable-build",
      "zergmeeting-apple-preview",
      "zergmeeting-apple-stable",
      "zergmeeting-preview-updater",
      "zergmeeting-stable-updater",
    ]) {
      assert.match(workflow, new RegExp(environment));
    }
  });

  it("tests, audits, signs, and verifies before publishing", () => {
    assert.match(
      workflow,
      /npm audit --omit=dev --audit-level=moderate --prefix source\/zapps\/zergmeeting/,
    );
    assert.match(workflow, /cargo-audit --version 0\.22\.2/);
    assert.match(workflow, /npm test/);
    assert.match(workflow, /npm run (?:typecheck|tauri:build)/);
    assert.match(workflow, /cargo clippy/);
    assert.match(workflow, /minisign -Vm/);
    assert.match(workflow, /sha256sum -c checksums\.txt/);
    assert.match(workflow, /scripts\/package-macos\.mjs/);
  });

  it("selects one source app and creates one signed disk image on the Apple host", () => {
    assert.match(workflow, /find "\$bundle_root\/macos" -maxdepth 1 -type d -name '\*\.app'/);
    assert.match(workflow, /"\$\{#apps\[@\]\}" -ne 1/);
    assert.match(workflow, /hdiutil create/);
    assert.match(workflow, /ZergMeeting_\$\{VERSION\}_aarch64\.dmg/);
  });

  it("publishes immutable assets and only channel-scoped Pages feeds", () => {
    assert.match(workflow, /gh release create/);
    assert.match(workflow, /curl --fail --location/);
    assert.match(workflow, /cmp --silent/);
    assert.match(workflow, /--branch release-data/);
    assert.match(workflow, /node release-repository\/scripts\/feed-policy\.mjs/);
    assert.doesNotMatch(workflow, /latest-stable\.json/);
    assert.doesNotMatch(workflow, /latest-canary\.json/);
    assert.doesNotMatch(workflow, /Legacy root feeds changed/);
    assert.match(workflow, /encodeURIComponent\(process\.env\.RELEASE_TAG\)/);
    assert.match(workflow, /browser_download_url/);
    assert.match(workflow, /scripts\/validate-release-asset-url\.mjs/);
  });

  it("publishes the canonical generated release notes", () => {
    const publishStart = workflow.indexOf("\n  publish:");
    const feedStart = workflow.indexOf("\n  promote-feed:");
    const publishJob = workflow.slice(publishStart, feedStart);
    const generateNotes = publishJob.indexOf(
      'node release-repository/scripts/release-notes.mjs \\\n' +
        '            "$notes_file" \\\n' +
        '            "$VERSION" \\\n' +
        '            "$CHANNEL" \\\n' +
        '            "$SOURCE_SHA"',
    );
    const createRelease = publishJob.indexOf('gh release create "${create_args[@]}"');

    assert.ok(generateNotes >= 0, "the publish job must generate canonical release notes");
    assert.ok(generateNotes < createRelease, "notes must be generated before publication");
    assert.match(publishJob, /--notes-file "\$notes_file"/);
    assert.match(publishJob, /NOTES_FILE="\$notes_file"/);
    assert.match(publishJob, /release\.body !== expectedBody/);
  });

  it("keeps queued Pages deployments recoverable before HTTPS verification", () => {
    assert.doesNotMatch(workflow, /actions\/configure-pages@/);
    assert.doesNotMatch(workflow, /actions\/upload-pages-artifact@/);
    assert.doesNotMatch(workflow, /actions\/deploy-pages@/);
    const deployJob = workflow.indexOf("deploy-pages:");
    const promoteJob = workflow.slice(
      workflow.indexOf("\n  promote-feed:"),
      workflow.indexOf("\n  deploy-pages:"),
    );
    const deployBlock = workflow.slice(deployJob);
    const deployScript = workflow.indexOf("node scripts/deploy-pages.mjs");
    const httpsVerification = workflow.indexOf(
      "Verify the published channel manifest over HTTPS",
    );
    assert.ok(deployJob > 0);
    assert.ok(deployJob < deployScript);
    assert.ok(deployScript < httpsVerification);
    assert.doesNotMatch(
      deployBlock,
      /actions\/deploy-pages@/,
      "the upstream action cancels a recoverable queue after ten minutes",
    );
    assert.match(deployBlock, /timeout-minutes: 35/);
    assert.match(deployBlock, /PAGES_DEPLOY_TIMEOUT_MS: "1800000"/);
    assert.match(
      deployBlock,
      /PAGES_ARTIFACT_ID: \$\{\{ needs\.promote-feed\.outputs\.pages_artifact_id \}\}/,
    );
    assert.match(promoteJob, /Build the deterministic Pages artifact/);
    assert.match(promoteJob, /find pages[\s\S]*-type l/);
    assert.match(promoteJob, /archive must not contain git metadata/);
    assert.match(promoteJob, /tar[\s\S]*--sort=name[\s\S]*--mtime=/);
    assert.match(
      promoteJob,
      /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/,
    );
    assert.match(promoteJob, /name: github-pages/);
    assert.match(deployBlock, /run: node scripts\/deploy-pages\.mjs/);
    assert.match(
      promoteJob,
      /pages_artifact_id: \$\{\{ steps\.pages-artifact\.outputs\.artifact-id \}\}/,
    );
    assert.match(promoteJob, /id: pages-artifact[\s\S]*name: github-pages/);
    assert.match(promoteJob, /name: github-pages/);
    assert.match(promoteJob, /path: \$\{\{ runner\.temp \}\}\/artifact\.tar/);
    assert.match(promoteJob, /retention-days: 1/);
  });

  it("resumes after a post-release failure without ever creating a tag", () => {
    assert.match(workflow, /Verify the tag and create or resume the immutable GitHub Release/);
    assert.match(workflow, /expected_prerelease/);
    assert.match(workflow, /remote-asset-names\.txt/);
    assert.match(workflow, /diff --unified/);
    assert.match(workflow, /Existing release metadata does not match/);
    assert.match(workflow, /release\.body/);
    assert.match(workflow, /gh release create "\$\{create_args\[@\]\}"/);
    assert.match(workflow, /--verify-tag/);
    assert.doesNotMatch(workflow, /--target "\$REQUEST_COMMIT"/);
    assert.doesNotMatch(workflow, /git tag(?:\s|$)/);
    assert.doesNotMatch(workflow, /git push[^\n]*refs\/tags/);
    assert.match(workflow, /--draft/);
    assert.match(workflow, /gh release upload/);
    assert.match(workflow, /gh release edit "\$RELEASE_TAG"/);
    assert.match(workflow, /--draft=false/);
    assert.match(workflow, /\.immutable == true/);
    assert.match(workflow, /GitHub did not mark the published release immutable/);
    assert.match(workflow, /refs\/tags\/\$RELEASE_TAG:refs\/tags\/\$RELEASE_TAG/);
    assert.match(workflow, /refs\/tags\/\$\{RELEASE_TAG\}\^\{commit\}/);
    assert.doesNotMatch(workflow, /Release .* already exists; assets are immutable/);

    const create = workflow.indexOf("gh release create");
    const upload = workflow.indexOf("gh release upload");
    const complete = workflow.indexOf("diff --unified");
    const publish = workflow.indexOf("gh release edit");
    const immutable = workflow.indexOf(
      "GitHub did not mark the published release immutable",
    );
    const publicDownload = workflow.indexOf(
      "Download and verify canonical public release assets",
    );
    const feed = workflow.indexOf("Stage and commit only the channel-scoped Pages feed");
    assert.ok(create < upload);
    assert.ok(upload < complete);
    assert.ok(complete < publish);
    assert.ok(publish < immutable);
    assert.ok(immutable < publicDownload);
    assert.ok(publish < publicDownload);
    assert.ok(publicDownload < feed);
  });

  it("allows the transient draft slug but revalidates canonical URLs after publication", () => {
    const publishStart = workflow.indexOf("\n  publish:");
    const feedStart = workflow.indexOf("\n  promote-feed:");
    const publishJob = workflow.slice(publishStart, feedStart);
    const draftValidation = publishJob.indexOf(
      'validate-release-asset-url.mjs \\\n              "$asset_url" \\\n              "$asset_name" \\\n              "$GITHUB_REPOSITORY" \\\n              "$RELEASE_TAG" \\\n              "$release_is_draft"',
    );
    const publishRelease = publishJob.indexOf("gh release edit");
    const immutableCheck = publishJob.indexOf(
      "GitHub did not mark the published release immutable",
    );
    const canonicalValidation = publishJob.indexOf(
      'validate-release-asset-url.mjs \\\n              "$asset_url" \\\n              "$asset_name" \\\n              "$GITHUB_REPOSITORY" \\\n              "$RELEASE_TAG" \\\n              "false"',
    );

    assert.ok(draftValidation > 0 && draftValidation < publishRelease);
    assert.ok(publishRelease < immutableCheck);
    assert.ok(immutableCheck < canonicalValidation);
  });

  it("recovers published immutable retries from canonical public bytes", () => {
    const publishStart = workflow.indexOf("\n  publish:");
    const feedStart = workflow.indexOf("\n  promote-feed:");
    const pagesStart = workflow.indexOf("\n  deploy-pages:");
    const publishJob = workflow.slice(publishStart, feedStart);
    const feedJob = workflow.slice(feedStart, pagesStart);
    const pagesJob = workflow.slice(pagesStart);

    assert.match(
      publishJob,
      /Existing draft release asset bytes do not match/,
      "draft retries must retain exact regenerated-local byte comparison",
    );
    assert.match(
      publishJob,
      /Published release must already be immutable/,
      "published recovery must trust only an immutable GitHub Release",
    );
    assert.match(
      publishJob,
      /git -C release-repository show[\s\\]+"\$\{REQUEST_COMMIT\}:\$\{updater_key_path\}"/,
      "canonical signatures must use the request-bound updater key",
    );
    assert.match(
      publishJob,
      /\.digest \| select\(type == "string" and test\("\^sha256:\[0-9a-f\]\{64\}\$"\)\)/,
      "authenticated assets must have GitHub's exact SHA-256 digest",
    );
    assert.match(publishJob, /Authenticated release asset size mismatch/);
    assert.match(publishJob, /Authenticated release asset digest mismatch/);
    assert.match(
      publishJob,
      /Download and verify canonical public release assets/,
    );
    assert.match(publishJob, /name: zergmeeting-v2-canonical-release/);
    assert.match(feedJob, /name: zergmeeting-v2-canonical-release/);
    assert.match(pagesJob, /name: zergmeeting-v2-canonical-release/);
    assert.doesNotMatch(
      feedJob,
      /name: zergmeeting-v2-macos/,
      "feed promotion must not consume regenerated pre-publication bytes",
    );
    assert.doesNotMatch(
      pagesJob,
      /name: zergmeeting-v2-macos/,
      "Pages verification must not consume regenerated pre-publication bytes",
    );

    const canonicalDownload = publishJob.slice(
      publishJob.indexOf("Download and verify canonical public release assets"),
      publishJob.indexOf("name: zergmeeting-v2-canonical-release"),
    );
    assert.match(
      canonicalDownload,
      /cmp --silent "\$authenticated_asset" "\$public_asset"/,
    );
    assert.match(canonicalDownload, /--max-filesize "\$asset_size"/);
    assert.match(canonicalDownload, /Public release asset size mismatch/);
    assert.match(canonicalDownload, /total_public_bytes/);
    assert.match(canonicalDownload, /extractSourceApplication/);
    assert.match(canonicalDownload, /maxEntryCount: 16_384/);
    assert.match(canonicalDownload, /maxUncompressedBytes: 1_073_741_824/);
    assert.doesNotMatch(
      canonicalDownload,
      /cmp --silent "release\//,
      "published canonical bytes must not be compared with regenerated bytes",
    );
  });

  it("executes every exact release asset selector and rejects ambiguous records", async () => {
    const assetSelectors = [...workflow.matchAll(
      /'(\[\.assets\[\][^']*)'/g,
    )]
      .map((match) => match[1])
      .filter((selector) => selector.includes("select(length == 1)"));
    assert.equal(assetSelectors.length, 4);

    const asset = {
      digest: `sha256:${"a".repeat(64)}`,
      id: 17,
      name: "checksums.txt",
      size: 312,
      state: "uploaded",
    };
    for (const selector of assetSelectors) {
      const execution = await execFileAsync(
        "jq",
        [
          "-ncer",
          "--arg",
          "name",
          asset.name,
          "--argjson",
          "document",
          JSON.stringify({ assets: [asset] }),
          `$document | ${selector}`,
        ],
      );
      assert.deepEqual(JSON.parse(execution.stdout), asset);
      assert.equal(execution.stderr, "");
    }

    for (const assets of [[], [asset, asset]]) {
      await assert.rejects(
        execFileAsync(
          "jq",
          [
            "-ncer",
            "--arg",
            "name",
            asset.name,
            "--argjson",
            "document",
            JSON.stringify({ assets }),
            `$document | ${assetSelectors[0]}`,
          ],
        ),
        (error) => {
          assert.equal(error.code, 4);
          assert.equal(error.stdout, "");
          return true;
        },
      );
    }
  });

  it("executes every single-quoted jq program in the workflow", async () => {
    const jqInvocations = [...workflow.matchAll(/\bjq\b/g)];
    const jqPrograms = [...workflow.matchAll(
      /\bjq\b(?:[^'\\\n]|\\(?:\r?\n|.))*'([^']*)'/g,
    )].map((match) => match[1]);
    assert.equal(
      jqPrograms.length,
      jqInvocations.length,
      "every jq invocation must expose one single-quoted program to the audit",
    );

    const asset = {
      browser_download_url:
        "https://github.com/Epoch-ML/zergmeeting-releases/releases/download/example/checksums.txt",
      digest: `sha256:${"a".repeat(64)}`,
      id: 17,
      name: "checksums.txt",
      size: 312,
      state: "uploaded",
    };
    const document = {
      ...asset,
      assets: [asset],
      draft: false,
      id: 23,
      immutable: true,
      ssh_keys: ["ssh-ed25519 example"],
      status: "Accepted",
      tag_name: "zergmeeting-preview-v0.2.0-preview.3",
    };

    for (const program of jqPrograms) {
      const execution = await execFileAsync(
        "jq",
        [
          "-nc",
          "--arg",
          "name",
          asset.name,
          "--arg",
          "tag",
          document.tag_name,
          "--argjson",
          "expected_id",
          String(document.id),
          "--argjson",
          "document",
          JSON.stringify(document),
          `$document | (${program})`,
        ],
      );
      assert.notEqual(execution.stdout, "", `jq produced no output: ${program}`);
      assert.equal(execution.stderr, "", `jq wrote to stderr: ${program}`);
    }
  });

  it("finds draft and published releases by one exact tag match", () => {
    const publishStart = workflow.indexOf("\n  publish:");
    const feedStart = workflow.indexOf("\n  promote-feed:");
    const publishJob = workflow.slice(publishStart, feedStart);

    assert.match(publishJob, /gh api --paginate --slurp/);
    assert.match(publishJob, /scripts\/resolve-release\.mjs/);
    assert.doesNotMatch(
      publishJob,
      /releases\/tags\/\$RELEASE_TAG/,
      "the tag endpoint cannot resolve a draft release",
    );
  });

  it("isolates updater signing from private source and pins GitHub-owned actions", () => {
    assert.doesNotMatch(workflow, /uses: actions\/[A-Za-z0-9_-]+@v\d/);
    assert.doesNotMatch(workflow, /dtolnay\/rust-toolchain/);
    assert.match(workflow, /rustup toolchain install 1\.88\.0/);
    const signingSecretUses = workflow.match(
      /secrets\.ZERGMEETING_(?:PREVIEW|STABLE)_TAURI_SIGNING_PRIVATE_KEY(?:_PASSWORD)?/g,
    ) ?? [];
    assert.equal(signingSecretUses.length, 4);
    const jobEnv = workflow.match(/build-macos:[\s\S]*?steps:/)?.[0] ?? "";
    assert.doesNotMatch(jobEnv, /TAURI_SIGNING_PRIVATE_KEY/);
    const compile = workflow.indexOf(
      "Build the unsigned app without release signing credentials",
    );
    const signJob = workflow.indexOf("sign-updater-preview:");
    const signingSecrets = workflow.indexOf(
      "secrets.ZERGMEETING_PREVIEW_TAURI_SIGNING_PRIVATE_KEY",
    );
    assert.ok(compile < signJob);
    assert.ok(signJob < signingSecrets);
    const signerJob = workflow.slice(signJob, workflow.indexOf("\n  publish:"));
    assert.doesNotMatch(signerJob, /SOURCE_DEPLOY_KEY/);
    assert.doesNotMatch(signerJob, /source\/zapps\/zergmeeting/);
    assert.match(signerJob, /npm exec --offline -- tauri signer sign/);
    assert.match(workflow, /createUpdaterArtifacts, false/);
  });

  it("uses fresh source, Apple, and updater hosts with disjoint credentials", () => {
    const buildStart = workflow.indexOf("\n  build-macos:");
    const appleStart = workflow.indexOf("\n  apple-sign:");
    const updaterStart = workflow.indexOf("\n  sign-updater-preview:");
    const publishStart = workflow.indexOf("\n  publish:");
    assert.ok(buildStart > 0 && appleStart > buildStart);
    assert.ok(updaterStart > appleStart && publishStart > updaterStart);

    const buildJob = workflow.slice(buildStart, appleStart);
    const appleJob = workflow.slice(appleStart, updaterStart);
    const updaterJob = workflow.slice(updaterStart, publishStart);
    assert.match(buildJob, /zergmeeting-(stable|preview)-build/);
    assert.match(buildJob, /--no-sign/);
    assert.doesNotMatch(buildJob, /ZERGMEETING_APPLE_|TAURI_SIGNING_PRIVATE_KEY|codesign|notarytool/);
    assert.match(appleJob, /zergmeeting-apple-/);
    assert.match(appleJob, /scripts\/extract-macos-stage\.mjs/);
    assert.match(appleJob, /ZERGMEETING_APPLE_CERTIFICATE/);
    assert.match(appleJob, /codesign/);
    assert.match(appleJob, /notarytool/);
    assert.doesNotMatch(appleJob, /ZERG_SOURCE_DEPLOY_KEY|source\/zapps\/zergmeeting|git init source/);
    assert.match(updaterJob, /ZERGMEETING_PREVIEW_TAURI_SIGNING_PRIVATE_KEY/);
    assert.match(updaterJob, /ZERGMEETING_STABLE_TAURI_SIGNING_PRIVATE_KEY/);
    assert.doesNotMatch(updaterJob, /ZERG_SOURCE_DEPLOY_KEY|ZERGMEETING_APPLE_|source\/zapps\/zergmeeting/);
  });

  it("binds every channel to a distinct embedded and signing trust root", () => {
    assert.match(workflow, /keys\/zergmeeting-preview-updater\.pubkey/);
    assert.match(workflow, /keys\/zergmeeting-stable-updater\.pubkey/);
    assert.match(workflow, /updater\.preview\.pubkey/);
    assert.match(workflow, /updater\.stable\.pubkey/);
    assert.doesNotMatch(workflow, /keys\/zergmeeting-updater-v2\.pubkey/);
    assert.doesNotMatch(workflow, /src-tauri\/updater-v2\.pubkey/);
  });

  it("treats source archives as hostile before Apple credentials are imported", () => {
    const extract = workflow.indexOf("Verify and extract the hostile source stage");
    const appleSecrets = workflow.indexOf(
      "ZERGMEETING_APPLE_CERTIFICATE: ${{ secrets.ZERGMEETING_APPLE_CERTIFICATE }}",
    );
    const hostileStage = workflow.slice(extract, appleSecrets);
    assert.ok(extract > 0 && appleSecrets > extract);
    assert.match(workflow, /aarch64\.source\.app\.tar\.gz/);
    assert.match(workflow, /ZERGMEETING_STAGE_MAX_ENTRY_COUNT/);
    assert.match(workflow, /ZERGMEETING_STAGE_MAX_UNCOMPRESSED_BYTES/);
    assert.doesNotMatch(
      hostileStage,
      /(?:^|\n)\s*["']?\$app\/Contents\/MacOS\/zergmeeting["']?(?:\s|$)/,
      "the hostile application executable must be inspected, never launched",
    );
    assert.match(hostileStage, /codesign_status=0/);
    assert.match(hostileStage, /scripts\/verify-source-signature\.mjs/);
    assert.doesNotMatch(
      hostileStage,
      /grep -Eq '\^\(Authority\|TeamIdentifier\)='/,
      "TeamIdentifier=not set is an ad-hoc sentinel, not a signing identity",
    );
  });

  it("bounds draft discovery and refreshes the resolved positive release ID", () => {
    const publishJob = workflow.slice(
      workflow.indexOf("\n  publish:"),
      workflow.indexOf("\n  promote-feed:"),
    );

    assert.match(publishJob, /wait_for_created_release\(\)/);
    assert.match(publishJob, /for attempt in \{1\.\.12\}/);
    assert.match(publishJob, /The newly created draft release did not converge/);
    assert.match(publishJob, /\.draft == true/);
    assert.match(publishJob, /\.id[\s\S]*type == "number"[\s\S]*floor == \./);
    assert.match(publishJob, /refresh_release\(\)/);
    assert.match(
      publishJob,
      /gh api "repos\/\$GITHUB_REPOSITORY\/releases\/\$release_id"/,
    );
  });

  it("isolates release publication from release-data authority on a fresh runner", () => {
    const publishStart = workflow.indexOf("\n  publish:");
    const feedStart = workflow.indexOf("\n  promote-feed:");
    const pagesStart = workflow.indexOf("\n  deploy-pages:");
    assert.ok(
      publishStart > 0 && feedStart > publishStart && pagesStart > feedStart,
      "feed promotion must be a separate job between release publication and Pages deployment",
    );

    const publishJob = workflow.slice(publishStart, feedStart);
    const feedJob = workflow.slice(feedStart, pagesStart);
    assert.match(publishJob, /permissions:\n      contents: write/);
    assert.doesNotMatch(
      publishJob,
      /ZERGMEETING_FEED_DEPLOY_KEY|name: zergmeeting-feed|--branch release-data|git push/,
    );
    assert.match(feedJob, /needs:[\s\S]*- publish/);
    assert.match(feedJob, /permissions:\n      contents: read/);
    assert.match(feedJob, /name: zergmeeting-feed/);
    assert.match(
      feedJob,
      /ZERGMEETING_FEED_DEPLOY_KEY: \$\{\{ secrets\.ZERGMEETING_FEED_DEPLOY_KEY \}\}/,
    );
    assert.doesNotMatch(feedJob, /ssh-key:/);
    assert.match(feedJob, /actions\/download-artifact@/);
    assert.match(
      feedJob,
      /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/,
    );
    assert.doesNotMatch(
      feedJob,
      /GH_TOKEN|github\.token|contents: write|gh release/,
    );

    const pagesHeader = workflow.slice(
      pagesStart,
      workflow.indexOf("\n    steps:", pagesStart),
    );
    assert.match(pagesHeader, /needs:[\s\S]*- promote-feed/);
  });

  it("pins runner toolchains and avoids floating package-manager installs", () => {
    assert.doesNotMatch(workflow, /ubuntu-latest/);
    assert.match(workflow, /runs-on: ubuntu-24\.04/);
    assert.doesNotMatch(workflow, /node-version: "22"/);
    assert.match(workflow, /node-version: "22\.23\.2"/);
    assert.doesNotMatch(workflow, /brew install/);
    assert.doesNotMatch(workflow, /apt-get install/);
    assert.match(workflow, /minisign\/releases\/download\/0\.12/);
    assert.match(
      workflow,
      /9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73/,
    );
    assert.doesNotMatch(workflow, /cargo install minisign/);
    assert.doesNotMatch(workflow, /npm audit --omit=dev --audit-level=high/);
    assert.match(workflow, /npm audit --omit=dev --audit-level=moderate/);
    assert.match(
      workflow,
      /npm audit --omit=dev --audit-level=moderate --prefix source\/zapps\/zergmeeting/,
    );
    assert.equal(
      workflow.match(/npm audit --audit-level=moderate/g)?.length,
      6,
    );
  });
});
