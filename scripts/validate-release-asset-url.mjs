import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

export function validateReleaseAssetUrl({
  assetUrl,
  assetName,
  repository,
  releaseTag,
  releaseIsDraft,
}) {
  assert.equal(typeof releaseIsDraft, "boolean");
  const [owner, repositoryName, ...extraRepositoryParts] = repository.split("/");
  assert.ok(owner.length > 0);
  assert.ok(repositoryName.length > 0);
  assert.deepEqual(extraRepositoryParts, []);

  const url = new URL(assetUrl);
  assert.equal(url.origin, "https://github.com");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.equal(url.search, "");
  assert.equal(url.hash, "");

  const segments = url.pathname.slice(1).split("/").map(decodeURIComponent);
  assert.equal(segments.length, 6);
  assert.deepEqual(segments.slice(0, 4), [
    owner,
    repositoryName,
    "releases",
    "download",
  ]);
  assert.equal(segments[5], assetName);

  const releaseSegment = segments[4];
  const isCanonicalTag = releaseSegment === releaseTag;
  const isGitHubDraftSlug = /^untagged-[0-9a-f]{20}$/.test(releaseSegment);
  assert.equal(isCanonicalTag || (releaseIsDraft && isGitHubDraftSlug), true);

  return {
    owner,
    repository: repositoryName,
    release: releaseSegment,
    asset: assetName,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [assetUrl, assetName, repository, releaseTag, draftValue, ...extraArguments] =
    process.argv.slice(2);
  assert.deepEqual(extraArguments, []);
  assert.ok(draftValue === "true" || draftValue === "false");
  validateReleaseAssetUrl({
    assetUrl,
    assetName,
    repository,
    releaseTag,
    releaseIsDraft: draftValue === "true",
  });
}
