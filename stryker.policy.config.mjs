const suites = Object.freeze({
  anchor: Object.freeze({
    source: "scripts/anchored-policy.mjs",
    tests: ["scripts/anchored-policy.test.mjs"],
  }),
  preflight: Object.freeze({
    source: "scripts/repository-preflight.mjs",
    tests: ["scripts/repository-preflight.test.mjs"],
  }),
  workflow: Object.freeze({
    source: "scripts/workflow-policy.mjs",
    tests: [
      "scripts/workflow-policy.test.mjs",
      "scripts/anchored-policy.test.mjs",
    ],
  }),
});

const selected = process.env.ZERGMEETING_MUTATION_TARGET;
if (selected === undefined || !Object.hasOwn(suites, selected)) {
  throw new Error(
    `ZERGMEETING_MUTATION_TARGET must be one of: ${Object.keys(suites).join(", ")}`,
  );
}
const suite = suites[selected];

export default {
  mutate: [suite.source],
  testRunner: "command",
  commandRunner: {
    command: `node --test ${suite.tests.join(" ")}`,
  },
  ignorePatterns: [
    "node_modules",
    ".stryker-tmp",
    "dist",
    "build",
    "target",
  ],
  concurrency: 4,
  coverageAnalysis: "off",
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: `reports/mutation-policy-${selected}.json` },
  thresholds: { high: 90, low: 80, break: 0 },
  timeoutMS: 10_000,
  tempDirName: `.stryker-tmp/${selected}`,
  cleanTempDir: "always",
};
