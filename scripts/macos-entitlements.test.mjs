import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import test from "node:test";

const entitlementUrl = new URL(
  "../macos/ZergMeeting.entitlements.plist",
  import.meta.url,
);
const signingScript = await readFile(
  new URL("./sign-macos-app.sh", import.meta.url),
  "utf8",
);

async function optionalEntitlementFile() {
  try {
    return {
      bytes: await readFile(entitlementUrl),
      metadata: await lstat(entitlementUrl),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { bytes: Buffer.alloc(0), metadata: null };
    throw error;
  }
}

function booleanEntitlements(source) {
  const entries = [...source.matchAll(
    /<key>([^<]+)<\/key>\s*<(true|false)\/>/g,
  )].map(([, key, value]) => [key, value === "true"]);
  assert.equal(
    new Set(entries.map(([key]) => key)).size,
    entries.length,
    "the canonical entitlement dictionary cannot contain duplicate keys",
  );
  return Object.fromEntries(entries);
}

test("publishes one exact bounded entitlement contract for ZergMeeting", async () => {
  const { bytes, metadata } = await optionalEntitlementFile();
  assert.deepEqual(
    {
      bytes: bytes.length,
      file: metadata?.isFile() ?? false,
      link: metadata?.isSymbolicLink() ?? false,
      mode: metadata === null ? null : metadata.mode & 0o777,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    {
      bytes: 1_174,
      file: true,
      link: false,
      mode: 0o644,
      sha256: "ccab21fe6a702430657f64b82192c313c292095ab6186441b51d9294af5a9e67",
    },
  );
  assert.deepEqual(booleanEntitlements(bytes.toString("utf8")), {
    "com.apple.security.app-sandbox": false,
    "com.apple.security.network.client": true,
    "com.apple.security.device.audio-input": true,
    "com.apple.security.cs.allow-jit": true,
    "com.apple.security.cs.allow-unsigned-executable-memory": true,
  });
  assert.doesNotMatch(
    bytes.toString("utf8"),
    /<key>com\.apple\.security\.(?:cs\.disable-library-validation|get-task-allow)<\/key>/,
  );
});

test("applies the media entitlements only to the outer application signature", () => {
  assert.match(
    signingScript,
    /usage: \$0 APPLICATION\.app IDENTITY CHANNEL VERSION ENTITLEMENTS\.plist/,
  );
  assert.match(signingScript, /entitlements="\$5"/);
  assert.match(
    signingScript,
    /! -f "\$entitlements" \|\| -L "\$entitlements"/,
  );
  assert.match(signingScript, /codesign "\$\{sign_args\[@\]\}" "\$path"/);
  assert.match(signingScript, /codesign "\$\{sign_args\[@\]\}" "\$nested"/);
  assert.match(
    signingScript,
    /outer_sign_args=\("\$\{sign_args\[@\]\}" --entitlements "\$entitlements"\)/,
  );
  assert.match(signingScript, /codesign "\$\{outer_sign_args\[@\]\}" "\$app"/);
  assert.doesNotMatch(signingScript, /outer_sign_args\[@\].*"\$(?:path|nested)"/);
});
