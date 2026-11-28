// Recompute the reference digests from the committed domain, types and inputs.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { hashTypedData } from "viem";

const require = createRequire(import.meta.url);
const viemVersion = require("viem/package.json").version;
if (viemVersion !== "2.48.11") {
  throw new Error(`Expected viem 2.48.11, found ${viemVersion}`);
}

const files = [
  "L2.1-channel-config.json",
  "L2.2-voucher.json",
  "L2.3-claim-batch.json",
  "L2.4-refund.json",
];
for (const file of files) {
  const path = new URL(file, import.meta.url);
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  fixture.expected_digest = hashTypedData({
    domain: fixture.domain,
    types: fixture.types,
    primaryType: fixture.primaryType,
    message: fixture.input,
  });
  fixture.meta = {
    generator: "_generate_digests.mjs",
    generator_version: "2",
    viem_version: viemVersion,
  };
  writeFileSync(path, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`Generated ${file}`);
}
