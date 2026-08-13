import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { validateReleaseAssetUrl } from "./validate-release-asset-url.mjs";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(
  new URL("./validate-release-asset-url.mjs", import.meta.url),
);

const validInput = {
  assetUrl:
    "https://github.com/Epoch-ML/zergmeeting-releases/releases/download/zergmeeting-v0.2.0/ZERGMEETING_0.2.0_aarch64.app.tar.gz",
  assetName: "ZERGMEETING_0.2.0_aarch64.app.tar.gz",
  repository: "Epoch-ML/zergmeeting-releases",
  releaseTag: "zergmeeting-v0.2.0",
  releaseIsDraft: false,
};

describe("release asset URL validation", () => {
  it("accepts only the canonical protected-tag URL shape", () => {
    assert.deepEqual(validateReleaseAssetUrl(validInput), {
      owner: "Epoch-ML",
      repository: "zergmeeting-releases",
      release: "zergmeeting-v0.2.0",
      asset: "ZERGMEETING_0.2.0_aarch64.app.tar.gz",
    });
    assert.deepEqual(
      validateReleaseAssetUrl({ ...validInput, releaseIsDraft: true }),
      {
        owner: "Epoch-ML",
        repository: "zergmeeting-releases",
        release: "zergmeeting-v0.2.0",
        asset: "ZERGMEETING_0.2.0_aarch64.app.tar.gz",
      },
    );
  });

  it("rejects credentials, metadata, and path substitutions", () => {
    const invalidInputs = [
      { assetUrl: validInput.assetUrl.replace("https://", "http://") },
      { assetUrl: validInput.assetUrl.replace("github.com", "user:pass@github.com") },
      { assetUrl: `${validInput.assetUrl}?download=1` },
      { assetUrl: `${validInput.assetUrl}#fragment` },
      { assetUrl: validInput.assetUrl.replace("Epoch-ML", "Other") },
      { assetUrl: validInput.assetUrl.replace("zergmeeting-v0.2.0", "untagged-deadbeef") },
      { assetUrl: `${validInput.assetUrl}/extra` },
      { repository: "/zergmeeting-releases" },
      { repository: "Epoch-ML/" },
      {
        assetUrl: validInput.assetUrl.replace("Epoch-ML", ""),
        repository: "/zergmeeting-releases",
      },
      {
        assetUrl: validInput.assetUrl.replace("zergmeeting-releases", ""),
        repository: "Epoch-ML/",
      },
      { repository: "Epoch-ML/zergmeeting-releases/extra" },
      { assetName: "different.tar.gz" },
      { releaseTag: "zergmeeting-v9.9.9" },
      { releaseIsDraft: "false" },
    ];

    for (const invalidInput of invalidInputs) {
      assert.throws(
        () => validateReleaseAssetUrl({ ...validInput, ...invalidInput }),
        { code: "ERR_ASSERTION" },
      );
    }
  });

  it("accepts GitHub's opaque draft slug only while the release is a draft", () => {
    const draftUrl = validInput.assetUrl.replace(
      "zergmeeting-v0.2.0",
      "untagged-dd63942194d4f7a6af82",
    );

    assert.deepEqual(
      validateReleaseAssetUrl({
        ...validInput,
        assetUrl: draftUrl,
        releaseIsDraft: true,
      }),
      {
        owner: "Epoch-ML",
        repository: "zergmeeting-releases",
        release: "untagged-dd63942194d4f7a6af82",
        asset: "ZERGMEETING_0.2.0_aarch64.app.tar.gz",
      },
    );

    assert.throws(
      () =>
        validateReleaseAssetUrl({
          ...validInput,
          assetUrl: draftUrl,
          releaseIsDraft: false,
        }),
      { code: "ERR_ASSERTION" },
    );

    for (const invalidDraftSlug of [
      "untagged-",
      "untagged-deadbeef",
      "untagged-DD63942194D4F7A6AF82",
      "untagged-dd63942194d4f7a6af8z",
      "xuntagged-dd63942194d4f7a6af82",
      "untagged-dd63942194d4f7a6af82x",
      "draft-dd63942194d4f7a6af82",
    ]) {
      assert.throws(
        () =>
          validateReleaseAssetUrl({
            ...validInput,
            assetUrl: validInput.assetUrl.replace(
              "zergmeeting-v0.2.0",
              invalidDraftSlug,
            ),
            releaseIsDraft: true,
          }),
        { code: "ERR_ASSERTION" },
      );
    }
  });

  it("enforces every CLI boundary used by the release workflow", async () => {
    const draftUrl = validInput.assetUrl.replace(
      "zergmeeting-v0.2.0",
      "untagged-dd63942194d4f7a6af82",
    );
    const validArguments = [
      cliPath,
      draftUrl,
      validInput.assetName,
      validInput.repository,
      validInput.releaseTag,
      "true",
    ];
    const accepted = await execFileAsync(process.execPath, validArguments);
    assert.equal(accepted.stdout, "");
    assert.equal(accepted.stderr, "");
    const acceptedPublished = await execFileAsync(process.execPath, [
      cliPath,
      validInput.assetUrl,
      validInput.assetName,
      validInput.repository,
      validInput.releaseTag,
      "false",
    ]);
    assert.equal(acceptedPublished.stdout, "");
    assert.equal(acceptedPublished.stderr, "");

    const invalidArgumentLists = [
      [cliPath],
      validArguments.slice(0, -1),
      [...validArguments, "extra"],
      [...validArguments.slice(0, -1), "maybe"],
      [...validArguments.slice(0, -1), "false"],
    ];
    for (const invalidArguments of invalidArgumentLists) {
      await assert.rejects(
        execFileAsync(process.execPath, invalidArguments),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, /AssertionError/);
          return true;
        },
      );
    }
  });
});
