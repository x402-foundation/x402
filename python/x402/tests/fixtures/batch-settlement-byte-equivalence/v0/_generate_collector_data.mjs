// Reproduce L2.5-L2.8 with viem; see COLLECTOR_DATA.md for provenance and scope.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { encodeAbiParameters, keccak256 } from "viem";

const require = createRequire(import.meta.url);
const viemVersion = require("viem/package.json").version;
if (viemVersion !== "2.48.11") {
  throw new Error(`Expected viem 2.48.11, found ${viemVersion}`);
}

const files = [
  "L2.5-erc3009-deposit-nonce.json",
  "L2.6-erc3009-collector-data.json",
  "L2.7-eip2612-permit-data.json",
  "L2.8-permit2-collector-data.json",
];
const encode = (types, values) =>
  encodeAbiParameters(
    types.map(type => ({ type })),
    values,
  );

// ABI layouts copied from batch-settlement/encoding.ts at faa1c694c66a3732aaabbce93bdae140e521a67d.
function expectedBytes(fn, input) {
  switch (fn) {
    case "build_erc3009_deposit_nonce":
      return keccak256(encode(["bytes32", "uint256"], [input.channelId, BigInt(input.salt)]));
    case "build_erc3009_collector_data":
      return encode(
        ["uint256", "uint256", "uint256", "bytes"],
        [BigInt(input.validAfter), BigInt(input.validBefore), BigInt(input.salt), input.signature],
      );
    case "build_eip2612_permit_data":
      return encode(
        ["uint256", "uint256", "uint8", "bytes32", "bytes32"],
        [BigInt(input.value), BigInt(input.deadline), input.v, input.r, input.s],
      );
    case "build_permit2_collector_data":
      return encode(
        ["uint256", "uint256", "bytes", "bytes"],
        [
          BigInt(input.nonce),
          BigInt(input.deadline),
          input.permit2Signature,
          input.eip2612PermitData,
        ],
      );
    default:
      throw new Error(`Unknown fixture function: ${fn}`);
  }
}

for (const file of files) {
  const path = new URL(file, import.meta.url);
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  fixture.expected_bytes = expectedBytes(fixture.function, fixture.input);
  fixture.meta = {
    generator: "_generate_collector_data.mjs",
    generator_version: "2",
    viem_version: viemVersion,
  };
  writeFileSync(path, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`Generated ${file}`);
}
