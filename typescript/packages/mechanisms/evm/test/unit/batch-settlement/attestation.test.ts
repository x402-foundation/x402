import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, type Log } from "viem";
import { batchSettlementABI } from "../../../src/batch-settlement/abi";
import {
  claimedRowKeysFromLogs,
  claimKey,
  decodeClaimAttestation,
} from "../../../src/batch-settlement/attestation";
import { BATCH_SETTLEMENT_ADDRESS } from "../../../src/batch-settlement/constants";
import { chargeCountsMetadata } from "../../../src/batch-settlement/chargeCounts";
import type { ChannelConfig } from "../../../src/batch-settlement/types";
import { toContractChannelConfig } from "../../../src/batch-settlement/facilitator/utils";
import { computeChannelId } from "../../../src/batch-settlement/utils";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const NETWORK = "eip155:84532";

function channelWithSalt(saltSuffix: string): ChannelConfig {
  return {
    payer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    payerAuthorizer: ZERO,
    receiver: "0x9876543210987654321098765432109876543210",
    receiverAuthorizer: "0x1111111111111111111111111111111111111111",
    token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    withdrawDelay: 900,
    salt: `0x${"00".repeat(31)}${saltSuffix}`,
  };
}

const CHANNEL = channelWithSalt("00");
const CHANNEL_A = channelWithSalt("0a");
const CHANNEL_B = channelWithSalt("0b");
const CHANNEL_C = channelWithSalt("0c");

function claimRows(channels: readonly ChannelConfig[], totals: readonly bigint[] = []) {
  return channels.map((channel, index) => ({
    voucher: {
      channel: toContractChannelConfig(channel),
      maxClaimableAmount: 1000n,
    },
    signature: "0xcafe" as `0x${string}`,
    totalClaimed: totals[index] ?? 1n,
  }));
}

function claimCalldata(
  functionName: "claim" | "claimWithSignature" = "claim",
  channels: readonly ChannelConfig[] = [CHANNEL],
  totals: readonly bigint[] = [],
): `0x${string}` {
  const claims = claimRows(channels, totals);
  return functionName === "claim"
    ? encodeFunctionData({ abi: batchSettlementABI, functionName, args: [claims] })
    : encodeFunctionData({
        abi: batchSettlementABI,
        functionName,
        args: [claims, "0xdead"],
      });
}

function refundCalldata(): `0x${string}` {
  return encodeFunctionData({
    abi: batchSettlementABI,
    functionName: "refund",
    args: [toContractChannelConfig(CHANNEL), 100n],
  });
}

function multicallCalldata(inner: readonly `0x${string}`[]): `0x${string}` {
  return encodeFunctionData({ abi: batchSettlementABI, functionName: "multicall", args: [inner] });
}

function buildClaimedLog(
  channelId: `0x${string}`,
  claimAmount: bigint,
  newTotalClaimed: bigint,
  address: `0x${string}` = BATCH_SETTLEMENT_ADDRESS,
  sender: `0x${string}` = CHANNEL.receiver,
): Log {
  return {
    address,
    topics: encodeEventTopics({
      abi: batchSettlementABI,
      eventName: "Claimed",
      args: {
        channelId,
        sender,
      },
    }),
    data: encodeAbiParameters(
      [{ type: "uint128" }, { type: "uint128" }],
      [claimAmount, newTotalClaimed],
    ),
    blockHash: null,
    blockNumber: null,
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false,
  } as Log;
}

describe("decodeClaimAttestation", () => {
  it("joins a standalone claim to its Claimed event by channelId", () => {
    const channelId = computeChannelId(CHANNEL, NETWORK);
    const attestation = decodeClaimAttestation(
      claimCalldata(),
      [buildClaimedLog(channelId, 500n, 1n)],
      NETWORK,
      chargeCountsMetadata([4]),
    );
    expect(attestation.functionName).toBe("claim");
    expect(attestation.chargeCounts).toEqual([4n]);
    expect(attestation.channels).toEqual([
      {
        channelId,
        claimed: true,
        chargeCount: "4",
        claimAmount: "500",
        newTotalClaimed: "1",
      },
    ]);
  });

  it("unwraps multicall([claim, refund]) into claim rows with m on the outer input", () => {
    const channelId = computeChannelId(CHANNEL, NETWORK);
    const outer = multicallCalldata([claimCalldata(), refundCalldata()]);

    const attestation = decodeClaimAttestation(
      outer,
      [buildClaimedLog(channelId, 1n, 1n)],
      NETWORK,
      chargeCountsMetadata([4]),
    );
    expect(attestation.functionName).toBe("multicall");
    expect(attestation.chargeCounts).toEqual([4n]);
    expect(attestation.channels).toEqual([
      { channelId, claimed: true, claimAmount: "1", newTotalClaimed: "1", chargeCount: "4" },
    ]);
  });

  it("collects rows across every claim leg in call order", () => {
    const outer = multicallCalldata([
      claimCalldata("claim", [CHANNEL_A, CHANNEL_B]),
      claimCalldata("claimWithSignature", [CHANNEL_C]),
    ]);
    const logs = [CHANNEL_A, CHANNEL_B, CHANNEL_C].map(channel =>
      buildClaimedLog(computeChannelId(channel, NETWORK), 1n, 1n),
    );

    const attestation = decodeClaimAttestation(
      outer,
      logs,
      NETWORK,
      chargeCountsMetadata([1, 2, 3]),
    );
    expect(attestation.channels?.map(row => (row.claimed ? row.chargeCount : undefined))).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(attestation.channels?.map(row => row.channelId)).toEqual(
      [CHANNEL_A, CHANNEL_B, CHANNEL_C].map(channel => computeChannelId(channel, NETWORK)),
    );
  });

  it("attests nothing for a no-op row and never shifts counts onto other channels", () => {
    const idA = computeChannelId(CHANNEL_A, NETWORK);
    const idB = computeChannelId(CHANNEL_B, NETWORK);
    const idC = computeChannelId(CHANNEL_C, NETWORK);
    // Row B was a no-op: only A and C emitted Claimed. A position-based zip would give
    // C the count of B.
    const attestation = decodeClaimAttestation(
      claimCalldata("claim", [CHANNEL_A, CHANNEL_B, CHANNEL_C]),
      [buildClaimedLog(idA, 1n, 1n), buildClaimedLog(idC, 1n, 1n)],
      NETWORK,
      chargeCountsMetadata([4, 2, 7]),
    );
    expect(attestation.channels).toEqual([
      { channelId: idA, claimed: true, claimAmount: "1", newTotalClaimed: "1", chargeCount: "4" },
      { channelId: idB, claimed: false },
      { channelId: idC, claimed: true, claimAmount: "1", newTotalClaimed: "1", chargeCount: "7" },
    ]);
  });

  it("attributes both rows when the same channel is claimed twice with increasing totals", () => {
    const idA = computeChannelId(CHANNEL_A, NETWORK);
    const attestation = decodeClaimAttestation(
      claimCalldata("claim", [CHANNEL_A, CHANNEL_A], [5n, 8n]),
      [buildClaimedLog(idA, 5n, 5n), buildClaimedLog(idA, 3n, 8n)],
      NETWORK,
      chargeCountsMetadata([3, 2]),
    );
    expect(attestation.channels).toEqual([
      { channelId: idA, claimed: true, claimAmount: "5", newTotalClaimed: "5", chargeCount: "3" },
      { channelId: idA, claimed: true, claimAmount: "3", newTotalClaimed: "8", chargeCount: "2" },
    ]);
  });

  it("attests only the applied row when a later duplicate row is a no-op", () => {
    const idA = computeChannelId(CHANNEL_A, NETWORK);
    // Row 2 (total 5) is below the total row 1 already set (8), so it emits no Claimed.
    const attestation = decodeClaimAttestation(
      claimCalldata("claim", [CHANNEL_A, CHANNEL_A], [8n, 5n]),
      [buildClaimedLog(idA, 8n, 8n)],
      NETWORK,
      chargeCountsMetadata([3, 2]),
    );
    expect(attestation.channels).toEqual([
      { channelId: idA, claimed: true, claimAmount: "8", newTotalClaimed: "8", chargeCount: "3" },
      { channelId: idA, claimed: false },
    ]);
  });

  it("consumes each Claimed event once when identical rows are repeated", () => {
    const idA = computeChannelId(CHANNEL_A, NETWORK);
    const attestation = decodeClaimAttestation(
      claimCalldata("claim", [CHANNEL_A, CHANNEL_A], [5n, 5n]),
      [buildClaimedLog(idA, 5n, 5n)],
      NETWORK,
      chargeCountsMetadata([3, 2]),
    );
    expect(attestation.channels).toEqual([
      { channelId: idA, claimed: true, claimAmount: "5", newTotalClaimed: "5", chargeCount: "3" },
      { channelId: idA, claimed: false },
    ]);
  });

  it("withholds chargeCount when Claimed.sender is not a trusted sender", () => {
    const channelId = computeChannelId(CHANNEL, NETWORK);
    const logs = [buildClaimedLog(channelId, 1n, 1n)];
    const metadata = chargeCountsMetadata([4]);
    const row = { channelId, claimed: true, claimAmount: "1", newTotalClaimed: "1" };

    const untrusted = decodeClaimAttestation(claimCalldata(), logs, NETWORK, metadata, [ZERO]);
    expect(untrusted.channels).toEqual([row]);

    const trusted = decodeClaimAttestation(claimCalldata(), logs, NETWORK, metadata, [
      CHANNEL.receiver.toUpperCase().replace("0X", "0x"),
    ]);
    expect(trusted.channels).toEqual([{ ...row, chargeCount: "4" }]);
  });

  it("attests nothing for a retried batch that emitted no Claimed events", () => {
    const attestation = decodeClaimAttestation(
      claimCalldata(),
      [],
      NETWORK,
      chargeCountsMetadata([4]),
    );
    expect(attestation.channels).toEqual([
      { channelId: computeChannelId(CHANNEL, NETWORK), claimed: false },
    ]);
  });

  it("ignores Claimed events from other emitters", () => {
    const channelId = computeChannelId(CHANNEL, NETWORK);
    const forged = buildClaimedLog(channelId, 1n, 1n, "0x0000000000000000000000000000000000000001");
    const attestation = decodeClaimAttestation(
      claimCalldata(),
      [forged],
      NETWORK,
      chargeCountsMetadata([4]),
    );
    expect(attestation.channels).toEqual([{ channelId, claimed: false }]);
  });

  it("ignores counts whose length differs from the number of claim rows", () => {
    const channelId = computeChannelId(CHANNEL, NETWORK);
    const attestation = decodeClaimAttestation(
      claimCalldata(),
      [buildClaimedLog(channelId, 1n, 1n)],
      NETWORK,
      chargeCountsMetadata([4, 9]),
    );
    expect(attestation.chargeCounts).toBeUndefined();
    expect(attestation.channels).toEqual([
      { channelId, claimed: true, claimAmount: "1", newTotalClaimed: "1" },
    ]);
  });

  it("decodes claim rows when no metadata is present", () => {
    const attestation = decodeClaimAttestation(claimCalldata(), [], NETWORK);
    expect(attestation.chargeCounts).toBeUndefined();
    expect(attestation.channels).toEqual([
      { channelId: computeChannelId(CHANNEL, NETWORK), claimed: false },
    ]);
  });

  it("decodes claimWithSignature", () => {
    const channelId = computeChannelId(CHANNEL, NETWORK);
    const attestation = decodeClaimAttestation(
      claimCalldata("claimWithSignature"),
      [buildClaimedLog(channelId, 500n, 1n)],
      NETWORK,
      chargeCountsMetadata([2]),
    );
    expect(attestation.functionName).toBe("claimWithSignature");
    expect(attestation.channels).toEqual([
      { channelId, claimed: true, claimAmount: "500", newTotalClaimed: "1", chargeCount: "2" },
    ]);
  });

  it("returns null channels for refund-only multicall", () => {
    const attestation = decodeClaimAttestation(
      multicallCalldata([refundCalldata()]),
      [],
      NETWORK,
      chargeCountsMetadata([1]),
    );
    expect(attestation.functionName).toBe("multicall");
    expect(attestation.channels).toBeNull();
  });

  it("returns unknown for undecodable calldata without throwing", () => {
    const attestation = decodeClaimAttestation("0xabcd", [], NETWORK);
    expect(attestation.functionName).toBe("unknown");
    expect(attestation.channels).toBeNull();
  });

  it("marks rows unclaimed when receipt logs cannot be parsed", () => {
    const attestation = decodeClaimAttestation(
      claimCalldata(),
      [{ not: "a log" }],
      NETWORK,
      chargeCountsMetadata([1]),
    );
    expect(attestation.channels).toEqual([
      { channelId: computeChannelId(CHANNEL, NETWORK), claimed: false },
    ]);
  });

  it("returns null channels when a multicall leg is not decodable", () => {
    const attestation = decodeClaimAttestation(multicallCalldata(["0xdeadbeef"]), [], NETWORK);
    expect(attestation.functionName).toBe("multicall");
    expect(attestation.channels).toBeNull();
  });
});

describe("claimedRowKeysFromLogs", () => {
  it("returns row keys of Claimed events from the contract only", () => {
    const idA = computeChannelId(CHANNEL_A, NETWORK);
    const idB = computeChannelId(CHANNEL_B, NETWORK);
    const keys = claimedRowKeysFromLogs([
      buildClaimedLog(idA, 1n, 7n),
      buildClaimedLog(idA, 1n, 9n),
      buildClaimedLog(idB, 1n, 1n, "0x0000000000000000000000000000000000000001"),
    ]);
    expect([...keys]).toEqual([claimKey(idA, 7n), claimKey(idA, 9n)]);
  });

  it("returns an empty set for missing or unparseable logs", () => {
    expect(claimedRowKeysFromLogs(undefined).size).toBe(0);
    expect(claimedRowKeysFromLogs([{ not: "a log" }]).size).toBe(0);
  });
});
