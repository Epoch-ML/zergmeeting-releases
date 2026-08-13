/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  cleanTempDir: "always",
  concurrency: 2,
  coverageAnalysis: "off",
  mutate: ["scripts/deploy-pages.mjs"],
  packageManager: "npm",
  reporters: ["clear-text", "progress", "json"],
  testRunner: "command",
  commandRunner: {
    command: "node --test scripts/deploy-pages.test.mjs",
  },
  thresholds: { break: null, high: 80, low: 60 },
  timeoutMS: 5_000,
};

export default config;
