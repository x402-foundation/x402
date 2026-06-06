/**
 * Generates EIP-712 byte-equivalence fixtures for the batch-settlement Python SDK.
 *
 * This script is intentionally self-contained: it imports only `viem` and
 * inlines the EIP-712 domain and type definitions. The output JSON files are
 * the source-of-truth that the Python `test_byte_equivalence_fixtures` test
 * verifies against.
 *
 * When the TS SDK constants or types change (e.g. a new field is added to
 * `ChannelConfig`), update the inline definitions below and re-run this
 * script to regenerate the fixtures. The CI drift-detection job will fail
 * if a regenerated fixture differs from the committed one.
 *
 * Run:
 *   cd python/x402/tests/fixtures/batch-settlement-byte-equivalence/v0
 *   npm install && npx tsx _generator.ts
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { hashTypedData, type Address, type Hex } from "viem";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Domain (mirrors batch-settlement/constants.ts) ---------------------------
//
// Upstream source-of-truth for these constants:
//   typescript/packages/mechanisms/evm/src/batch-settlement/constants.ts
// When the SDK constants change, mirror the change here and re-run this
// generator. The CI drift-detection job will catch a forgotten update.

const BATCH_SETTLEMENT_ADDRESS =
  "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003" as Address;
const BATCH_SETTLEMENT_DOMAIN_BASE = {
  name: "x402 Batch Settlement",
  version: "1",
} as const;
const TEST_CHAIN_ID = 84532; // Base Sepolia

const domain = {
  ...BATCH_SETTLEMENT_DOMAIN_BASE,
  chainId: TEST_CHAIN_ID,
  verifyingContract: BATCH_SETTLEMENT_ADDRESS,
} as const;

// --- EIP-712 type definitions (mirrors batch-settlement/constants.ts) ---------

const channelConfigTypes = {
  ChannelConfig: [
    { name: "payer", type: "address" },
    { name: "payerAuthorizer", type: "address" },
    { name: "receiver", type: "address" },
    { name: "receiverAuthorizer", type: "address" },
    { name: "token", type: "address" },
    { name: "withdrawDelay", type: "uint40" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

const voucherTypes = {
  Voucher: [
    { name: "channelId", type: "bytes32" },
    { name: "maxClaimableAmount", type: "uint128" },
  ],
} as const;

const refundTypes = {
  Refund: [
    { name: "channelId", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "amount", type: "uint128" },
  ],
} as const;

const claimBatchTypes = {
  ClaimBatch: [{ name: "claims", type: "ClaimEntry[]" }],
  ClaimEntry: [
    { name: "channelId", type: "bytes32" },
    { name: "maxClaimableAmount", type: "uint128" },
    { name: "totalClaimed", type: "uint128" },
  ],
} as const;

// --- Vector inputs (aligned with python/x402/tests/.../test_channel.py mocks) -

const PAYER = "0x1111111111111111111111111111111111111111" as Address;
const RECEIVER = "0x3333333333333333333333333333333333333333" as Address;
const RECEIVER_AUTHORIZER =
  "0x4444444444444444444444444444444444444444" as Address;
const TOKEN = "0x5555555555555555555555555555555555555555" as Address;
const ZERO_SALT = ("0x" + "00".repeat(32)) as Hex;
const WITHDRAW_DELAY = 900;

const channelConfigInput = {
  payer: PAYER,
  payerAuthorizer: PAYER, // self-authorized baseline
  receiver: RECEIVER,
  receiverAuthorizer: RECEIVER_AUTHORIZER,
  token: TOKEN,
  withdrawDelay: WITHDRAW_DELAY,
  salt: ZERO_SALT,
};

const channelConfigDigest = hashTypedData({
  domain,
  types: channelConfigTypes,
  primaryType: "ChannelConfig",
  message: channelConfigInput,
});

const voucherInput = {
  channelId: channelConfigDigest,
  maxClaimableAmount: 1000n,
};

const voucherDigest = hashTypedData({
  domain,
  types: voucherTypes,
  primaryType: "Voucher",
  message: voucherInput,
});

const refundInput = {
  channelId: channelConfigDigest,
  nonce: 0n,
  amount: 500n,
};

const refundDigest = hashTypedData({
  domain,
  types: refundTypes,
  primaryType: "Refund",
  message: refundInput,
});

const claimBatchInput = {
  claims: [
    {
      channelId: channelConfigDigest,
      maxClaimableAmount: 1000n,
      totalClaimed: 500n,
    },
  ],
};

const claimBatchDigest = hashTypedData({
  domain,
  types: claimBatchTypes,
  primaryType: "ClaimBatch",
  message: claimBatchInput,
});

// --- Write fixtures ----------------------------------------------------------

type Fixture = {
  vector: string;
  description: string;
  domain: typeof domain;
  primaryType: string;
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  input: unknown;
  expected_digest: Hex;
  meta: {
    generator: string;
    generator_version: string;
    viem_version: string;
  };
};

const VIEM_VERSION = "2.48.11"; // mirrors typescript/packages/mechanisms/evm/package.json
const GENERATOR_VERSION = "1";

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function writeFixture(name: string, fixture: Fixture): void {
  const outPath = join(__dirname, `${name}.json`);
  writeFileSync(outPath, JSON.stringify(fixture, bigintReplacer, 2) + "\n", "utf8");
  console.log(`wrote ${outPath}`);
}

writeFixture("L2.1-channel-config", {
  vector: "L2.1",
  description:
    "ChannelConfig EIP-712 digest (baseline flat scalar struct; also serves as channelId).",
  domain,
  primaryType: "ChannelConfig",
  types: channelConfigTypes,
  input: channelConfigInput,
  expected_digest: channelConfigDigest,
  meta: {
    generator: "_generator.ts",
    generator_version: GENERATOR_VERSION,
    viem_version: VIEM_VERSION,
  },
});

writeFixture("L2.2-voucher", {
  vector: "L2.2",
  description:
    "Voucher EIP-712 digest (flat scalar: channelId from L2.1 + maxClaimableAmount).",
  domain,
  primaryType: "Voucher",
  types: voucherTypes,
  input: voucherInput,
  expected_digest: voucherDigest,
  meta: {
    generator: "_generator.ts",
    generator_version: GENERATOR_VERSION,
    viem_version: VIEM_VERSION,
  },
});

writeFixture("L2.3-claim-batch", {
  vector: "L2.3",
  description:
    "ClaimBatch EIP-712 digest (array of ClaimEntry struct; single-entry baseline).",
  domain,
  primaryType: "ClaimBatch",
  types: claimBatchTypes,
  input: claimBatchInput,
  expected_digest: claimBatchDigest,
  meta: {
    generator: "_generator.ts",
    generator_version: GENERATOR_VERSION,
    viem_version: VIEM_VERSION,
  },
});

writeFixture("L2.4-refund", {
  vector: "L2.4",
  description:
    "Refund EIP-712 digest (flat scalar: channelId + nonce + amount).",
  domain,
  primaryType: "Refund",
  types: refundTypes,
  input: refundInput,
  expected_digest: refundDigest,
  meta: {
    generator: "_generator.ts",
    generator_version: GENERATOR_VERSION,
    viem_version: VIEM_VERSION,
  },
});
