import { describe, expect, it } from "vitest";
import {
  checkTransferExecutorSettlement,
  type TransferExecutorSettlementExpectation,
} from "../../src/exact/facilitator/transferExecutorRecord";
import type {
  HederaContractLog,
  HederaTransactionRecord,
  HederaTransactionRecordEntry,
  HederaTransferEntry,
} from "../../src/types";
import { addressTopic, recordEntry, transferEntry } from "../helpers/transferExecutor";

const PAYER = "0.0.5001";
const PAY_TO = "0.0.4001";
const FEE_PAYER = "0.0.9000";
const OTHER_FACILITATOR = "0.0.9001";
const FEE_COLLECTOR = "0.0.802";
const STAKING_REWARD_ACCOUNT = "0.0.800";
const THIRD_PARTY = "0.0.6001";
const OTHER_THIRD_PARTY = "0.0.6002";
const TOKEN = "0.0.456858";
const OTHER_TOKEN = "0.0.429274";
const NFT_TOKEN = "0.0.7777";
const EXECUTOR_ADDRESS = "0x0000000000000000000000000000000000001b58";

const FEE_PAYER_ALIAS = "0x8Fd9aA1b2C3d4E5f60718293A4b5C6d7E8f90a1B";

const AMOUNT = 100_000_000n;
const FEE = 19_682_562n;

/**
 * Builds the parent entry of a contract call: the fee payer pays the fee to `0.0.802`.
 *
 * @param feePayer - Account charged the fee
 * @returns Parent entry
 */
function feeParent(feePayer = FEE_PAYER): HederaTransactionRecordEntry {
  return recordEntry({
    chargedFee: FEE.toString(),
    hbarTransfers: [transferEntry(FEE_COLLECTOR, FEE), transferEntry(feePayer, -FEE)],
  });
}

/**
 * Builds a consensus record. Defaults to an HBAR payment from `PAYER` to `PAY_TO`
 * carried by a child, with the fee in the parent (the #3205 fixture's shape).
 *
 * @param overrides - Fields to set
 * @returns Record
 */
function record(overrides: Partial<HederaTransactionRecord> = {}): HederaTransactionRecord {
  return {
    transactionId: `${FEE_PAYER}@1755500000.000000000`,
    status: "SUCCESS",
    transactionFee: FEE.toString(),
    parent: feeParent(),
    children: [
      recordEntry({
        hbarTransfers: [transferEntry(PAYER, -AMOUNT), transferEntry(PAY_TO, AMOUNT)],
      }),
    ],
    logs: [],
    ...overrides,
  };
}

/**
 * Builds the expected payment. Defaults to `AMOUNT` HBAR from `PAYER` to `PAY_TO`.
 *
 * @param overrides - Fields to set
 * @returns Expectation
 */
function expectation(
  overrides: Partial<TransferExecutorSettlementExpectation> = {},
): TransferExecutorSettlementExpectation {
  return {
    asset: "0.0.0",
    amount: AMOUNT.toString(),
    payer: PAYER,
    payToAccountId: PAY_TO,
    feePayer: FEE_PAYER,
    facilitatorAccounts: [FEE_PAYER],
    facilitatorEvmAddresses: [],
    ...overrides,
  };
}

/**
 * Keccak-256 of a UTF-8 string: an oracle for event topic hashes, independent of the code under test.
 *
 * @param text - Input text
 * @returns 0x-hex digest
 */
function keccak256(text: string): string {
  const mask = (1n << 64n) - 1n;
  const rotl = (lane: bigint, by: number) =>
    ((lane << BigInt(by)) | (lane >> BigInt(64 - by))) & mask;
  const rate = 136;
  const bytes = [...Buffer.from(text, "utf8"), 0x01];
  while (bytes.length % rate !== 0) bytes.push(0);
  bytes[bytes.length - 1] |= 0x80;
  const state = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < bytes.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane++) {
      for (let b = 0; b < 8; b++) {
        state[lane] ^= BigInt(bytes[offset + lane * 8 + b]) << BigInt(8 * b);
      }
    }
    let lfsr = 1;
    for (let round = 0; round < 24; round++) {
      const c = [0, 1, 2, 3, 4].map(
        x => state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20],
      );
      for (let x = 0; x < 5; x++) {
        const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
        for (let y = 0; y < 25; y += 5) state[x + y] ^= d;
      }
      let [x, y, current] = [1, 0, state[1]];
      for (let step = 0; step < 24; step++) {
        [x, y] = [y, (2 * x + 3 * y) % 5];
        const next = state[x + 5 * y];
        state[x + 5 * y] = rotl(current, (((step + 1) * (step + 2)) / 2) % 64);
        current = next;
      }
      for (let row = 0; row < 25; row += 5) {
        const r = state.slice(row, row + 5);
        for (let col = 0; col < 5; col++) {
          state[row + col] = r[col] ^ (~r[(col + 1) % 5] & mask & r[(col + 2) % 5]);
        }
      }
      for (let j = 0; j < 7; j++) {
        lfsr = ((lfsr << 1) ^ ((lfsr >> 7) * 0x71)) % 256;
        if (lfsr & 2) state[0] ^= 1n << BigInt((1 << j) - 1);
      }
    }
  }
  let digest = "0x";
  for (let i = 0; i < 32; i++) {
    digest += ((state[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn).toString(16).padStart(2, "0");
  }
  return digest;
}

/**
 * Long-zero EVM address of a `shard.realm.num` id.
 *
 * @param entityId - Hedera entity id
 * @returns 0x-hex address
 */
function longZero(entityId: string): string {
  const [shard, realm, num] = entityId.split(".").map(BigInt);
  return `0x${shard.toString(16).padStart(8, "0")}${realm.toString(16).padStart(16, "0")}${num.toString(16).padStart(16, "0")}`;
}

const TRANSFER_TOPIC = keccak256("Transfer(address,address,uint256)");
const TRANSFER_SINGLE_TOPIC = keccak256("TransferSingle(address,address,address,uint256,uint256)");
const TRANSFER_BATCH_TOPIC = keccak256(
  "TransferBatch(address,address,address,uint256[],uint256[])",
);

/**
 * Builds an ERC-20/721 `Transfer` log.
 *
 * @param emitter - Contract that emitted the log
 * @param from - Sender address
 * @param to - Receiver address
 * @returns Log
 */
function transferLog(emitter: string, from: string, to: string): HederaContractLog {
  return {
    address: emitter,
    topics: [TRANSFER_TOPIC, addressTopic(from), addressTopic(to)],
    data: `0x${5n.toString(16).padStart(64, "0")}`,
  };
}

/**
 * Builds an ERC-1155 `TransferSingle` or `TransferBatch` log.
 *
 * @param topic - Event topic
 * @param operator - Operator address
 * @param from - Sender address
 * @param to - Receiver address
 * @returns Log
 */
function erc1155Log(topic: string, operator: string, from: string, to: string): HederaContractLog {
  return {
    address: EXECUTOR_ADDRESS,
    topics: [topic, addressTopic(operator), addressTopic(from), addressTopic(to)],
    data: "0x",
  };
}

describe("checkTransferExecutorSettlement", () => {
  describe("malformed input", () => {
    const withAmount = (amount: string) =>
      record({
        children: [
          recordEntry({
            hbarTransfers: [{ accountId: PAYER, amount }, transferEntry(PAY_TO, AMOUNT)],
          }),
        ],
      });

    it.each([
      ["a transfer amount with trailing text", withAmount("100000000abc")],
      ["an empty transfer amount", withAmount("")],
      ["a hex transfer amount", withAmount("0x5f5e100")],
      ["a fractional transfer amount", withAmount("-1.5")],
      ["a malformed transaction fee", record({ transactionFee: "19682562 tinybars" })],
      ["a negative transaction fee", record({ transactionFee: "-1" })],
      [
        "a malformed token amount",
        record({
          children: [
            recordEntry({ tokenTransfers: { [TOKEN]: [{ accountId: PAYER, amount: "lots" }] } }),
          ],
        }),
      ],
      [
        "a malformed token id",
        record({
          children: [
            recordEntry({
              hbarTransfers: [transferEntry(PAYER, -AMOUNT), transferEntry(PAY_TO, AMOUNT)],
            }),
            recordEntry({
              tokenTransfers: {
                "not-a-token": [transferEntry(PAYER, -5n), transferEntry(THIRD_PARTY, 5n)],
              },
            }),
          ],
        }),
      ],
      [
        "a malformed staking reward",
        record({
          children: [
            recordEntry({ stakingRewardTransfers: [{ accountId: PAYER, amount: "1e3" }] }),
          ],
        }),
      ],
    ])("fails %s", (_, malformed) => {
      const verdict = checkTransferExecutorSettlement(malformed, expectation());
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_check_failed" });
    });

    it.each(["", "1e8", "-100000000"])("fails an expected amount of %j", amount => {
      const verdict = checkTransferExecutorSettlement(record(), expectation({ amount }));
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_check_failed" });
    });

    it("fails a structurally broken record instead of throwing", () => {
      const broken = { ...record(), children: undefined } as unknown as HederaTransactionRecord;
      const verdict = checkTransferExecutorSettlement(broken, expectation());
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_check_failed" });
    });
  });

  // Each record fails two adjacent checks; the earlier check's code wins.
  describe("precedence", () => {
    const payment = recordEntry({
      hbarTransfers: [transferEntry(PAYER, -AMOUNT), transferEntry(PAY_TO, AMOUNT)],
    });
    const payerOverDebited = recordEntry({
      hbarTransfers: [
        transferEntry(PAYER, -(AMOUNT + 1n)),
        transferEntry(PAY_TO, AMOUNT),
        transferEntry(THIRD_PARTY, 1n),
      ],
    });
    const otherFacilitatorDrained = recordEntry({
      hbarTransfers: [transferEntry(OTHER_FACILITATOR, -5n), transferEntry(THIRD_PARTY, 5n)],
    });
    const twoAccounts = {
      facilitatorAccounts: [FEE_PAYER, OTHER_FACILITATOR],
      facilitatorEvmAddresses: [FEE_PAYER_ALIAS],
    };

    it.each<[string, HederaTransactionRecord, string]>([
      [
        "status before malformed amounts",
        record({ status: "INSUFFICIENT_GAS", transactionFee: "unknown" }),
        "settlement_status_not_success",
      ],
      [
        "malformed amounts before payee credit",
        record({
          transactionFee: "unknown",
          children: [
            recordEntry({
              hbarTransfers: [
                transferEntry(PAYER, -(AMOUNT - 1n)),
                transferEntry(PAY_TO, AMOUNT - 1n),
              ],
            }),
          ],
        }),
        "settlement_check_failed",
      ],
      [
        "payee credit before facilitator accounts",
        record({
          children: [
            recordEntry({
              hbarTransfers: [
                transferEntry(PAYER, -(AMOUNT - 1n)),
                transferEntry(PAY_TO, AMOUNT - 1n),
              ],
            }),
            otherFacilitatorDrained,
          ],
        }),
        "settlement_payee_credit_mismatch",
      ],
      [
        "facilitator account debits before payer debit",
        record({ children: [payerOverDebited, otherFacilitatorDrained] }),
        "settlement_unexpected_transfer",
      ],
      [
        "facilitator logs before payer debit",
        record({
          children: [payerOverDebited],
          logs: [transferLog(EXECUTOR_ADDRESS, FEE_PAYER_ALIAS, longZero(THIRD_PARTY))],
        }),
        "settlement_unexpected_transfer",
      ],
      [
        "facilitator account debits before undecodable transfer logs",
        record({
          children: [payment, otherFacilitatorDrained],
          logs: [{ address: EXECUTOR_ADDRESS, topics: [TRANSFER_TOPIC], data: "0x" }],
        }),
        "settlement_unexpected_transfer",
      ],
      [
        "undecodable transfer logs before payer debit",
        record({
          children: [payerOverDebited],
          logs: [{ address: EXECUTOR_ADDRESS, topics: [TRANSFER_TOPIC], data: "0x" }],
        }),
        "settlement_check_failed",
      ],
      [
        "payer debit before fee payer debit",
        record({
          parent: recordEntry({
            chargedFee: FEE.toString(),
            hbarTransfers: [
              transferEntry(FEE_COLLECTOR, FEE - 1n),
              transferEntry(FEE_PAYER, -(FEE - 1n)),
            ],
          }),
          children: [payerOverDebited],
        }),
        "settlement_payer_debit_mismatch",
      ],
      [
        "fee payer debit before third-party debits",
        record({
          parent: recordEntry({
            chargedFee: FEE.toString(),
            hbarTransfers: [
              transferEntry(FEE_COLLECTOR, FEE),
              transferEntry(FEE_PAYER, -(FEE - 1n)),
              transferEntry(THIRD_PARTY, -1n),
            ],
          }),
          children: [payment],
        }),
        "settlement_fee_payer_debit_mismatch",
      ],
      [
        "third-party debits before other lists",
        record({
          children: [
            payment,
            recordEntry({
              hbarTransfers: [
                transferEntry(THIRD_PARTY, -5n),
                transferEntry(OTHER_THIRD_PARTY, 5n),
              ],
            }),
            recordEntry({
              tokenTransfers: {
                [OTHER_TOKEN]: [transferEntry(PAYER, -5n), transferEntry(THIRD_PARTY, 5n)],
              },
            }),
          ],
        }),
        "settlement_unexpected_debit",
      ],
    ])("reports %s", (_, faulty, errorReason) => {
      const verdict = checkTransferExecutorSettlement(faulty, expectation(twoAccounts));
      expect(verdict).toMatchObject({ ok: false, errorReason });
    });
  });

  describe("status", () => {
    it("fails a record whose status is not SUCCESS", () => {
      const verdict = checkTransferExecutorSettlement(
        record({ status: "CONTRACT_REVERT_EXECUTED" }),
        expectation(),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_status_not_success" });
      expect(verdict.ok === false && verdict.errorMessage).toContain("CONTRACT_REVERT_EXECUTED");
    });
  });

  describe("HBAR", () => {
    it("accepts a payment carried by a child record with the fee in the parent", () => {
      expect(checkTransferExecutorSettlement(record(), expectation())).toEqual({ ok: true });
    });
  });

  describe("HTS", () => {
    const htsExpectation = (overrides: Partial<TransferExecutorSettlementExpectation> = {}) =>
      expectation({ asset: TOKEN, ...overrides });
    const htsRecord = (transfers: HederaTransferEntry[], parent = feeParent()) =>
      record({ parent, children: [recordEntry({ tokenTransfers: { [TOKEN]: transfers } })] });

    it("accepts a token payment carried by a child record", () => {
      const verdict = checkTransferExecutorSettlement(
        htsRecord([transferEntry(PAYER, -AMOUNT), transferEntry(PAY_TO, AMOUNT)]),
        htsExpectation(),
      );
      expect(verdict).toEqual({ ok: true });
    });

    it("accepts the payer as fee payer, debited the fee in HBAR and the amount in the token", () => {
      const verdict = checkTransferExecutorSettlement(
        htsRecord([transferEntry(PAYER, -AMOUNT), transferEntry(PAY_TO, AMOUNT)], feeParent(PAYER)),
        htsExpectation({ feePayer: PAYER, facilitatorAccounts: [PAYER] }),
      );
      expect(verdict).toEqual({ ok: true });
    });

    it("judges the payTo credit in the token, not in HBAR", () => {
      const verdict = checkTransferExecutorSettlement(
        htsRecord([transferEntry(PAYER, -(AMOUNT - 1n)), transferEntry(PAY_TO, AMOUNT - 1n)]),
        htsExpectation(),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_payee_credit_mismatch" });
      expect(verdict.ok === false && verdict.errorMessage).toContain(TOKEN);
    });

    it("fails a payer debited more than the amount in the token", () => {
      const verdict = checkTransferExecutorSettlement(
        htsRecord([
          transferEntry(PAYER, -(AMOUNT + 1n)),
          transferEntry(PAY_TO, AMOUNT),
          transferEntry(THIRD_PARTY, 1n),
        ]),
        htsExpectation(),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_payer_debit_mismatch" });
    });
  });

  describe("payer debit", () => {
    it.each([
      [
        "over",
        [
          transferEntry(PAYER, -(AMOUNT + 1n)),
          transferEntry(PAY_TO, AMOUNT),
          transferEntry(THIRD_PARTY, 1n),
        ],
        AMOUNT + 1n,
      ],
      [
        "under",
        [
          transferEntry(PAYER, -(AMOUNT - 1n)),
          transferEntry(THIRD_PARTY, -1n),
          transferEntry(PAY_TO, AMOUNT),
        ],
        AMOUNT - 1n,
      ],
    ])("fails a payer debited %s the amount", (_, transfers, debited) => {
      const verdict = checkTransferExecutorSettlement(
        record({ children: [recordEntry({ hbarTransfers: transfers })] }),
        expectation(),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_payer_debit_mismatch" });
      const message = verdict.ok === false ? verdict.errorMessage : "";
      expect(message).toContain(PAYER);
      expect(message).toContain(AMOUNT.toString());
      expect(message).toContain(debited.toString());
    });

    it("accepts the payer as fee payer with one HBAR debit of amount plus fee", () => {
      const verdict = checkTransferExecutorSettlement(
        record({ parent: feeParent(PAYER) }),
        expectation({ feePayer: PAYER, facilitatorAccounts: [PAYER] }),
      );
      expect(verdict).toEqual({ ok: true });
    });

    it("reports the amount and fee parts separately when the payer is the fee payer", () => {
      const verdict = checkTransferExecutorSettlement(
        record({
          parent: feeParent(PAYER),
          children: [
            recordEntry({
              hbarTransfers: [
                transferEntry(PAYER, -(AMOUNT - 5n)),
                transferEntry(THIRD_PARTY, -5n),
                transferEntry(PAY_TO, AMOUNT),
              ],
            }),
          ],
        }),
        expectation({ feePayer: PAYER, facilitatorAccounts: [PAYER] }),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_payer_debit_mismatch" });
      const message = verdict.ok === false ? verdict.errorMessage : "";
      expect(message).toContain(`amount part ${AMOUNT - 5n}`);
      expect(message).toContain(`fee part ${FEE}`);
    });
  });

  describe("fee payer debit", () => {
    it("fails a fee payer debited less than the transaction fee", () => {
      const verdict = checkTransferExecutorSettlement(
        record({
          parent: recordEntry({
            chargedFee: FEE.toString(),
            hbarTransfers: [
              transferEntry(FEE_COLLECTOR, FEE - 1n),
              transferEntry(FEE_PAYER, -(FEE - 1n)),
            ],
          }),
        }),
        expectation(),
      );
      expect(verdict).toMatchObject({
        ok: false,
        errorReason: "settlement_fee_payer_debit_mismatch",
      });
      const message = verdict.ok === false ? verdict.errorMessage : "";
      expect(message).toContain(FEE_PAYER);
      expect(message).toContain(FEE.toString());
      expect(message).toContain((FEE - 1n).toString());
    });
  });

  describe("facilitator accounts", () => {
    const payment = recordEntry({
      hbarTransfers: [transferEntry(PAYER, -AMOUNT), transferEntry(PAY_TO, AMOUNT)],
    });
    const twoAccounts = { facilitatorAccounts: [FEE_PAYER, OTHER_FACILITATOR] };

    it("fails a fee payer debited more than the transaction fee", () => {
      const verdict = checkTransferExecutorSettlement(
        record({
          parent: recordEntry({
            chargedFee: FEE.toString(),
            hbarTransfers: [
              transferEntry(FEE_COLLECTOR, FEE),
              transferEntry(FEE_PAYER, -(FEE + 5n)),
              transferEntry(THIRD_PARTY, 5n),
            ],
          }),
        }),
        expectation(),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_unexpected_transfer" });
      const message = verdict.ok === false ? verdict.errorMessage : "";
      expect(message).toContain(FEE_PAYER);
      expect(message).toContain(FEE.toString());
      expect(message).toContain((FEE + 5n).toString());
    });

    it("fails another facilitator account debited HBAR", () => {
      const verdict = checkTransferExecutorSettlement(
        record({
          children: [
            payment,
            recordEntry({
              hbarTransfers: [
                transferEntry(OTHER_FACILITATOR, -5n),
                transferEntry(THIRD_PARTY, 5n),
              ],
            }),
          ],
        }),
        expectation(twoAccounts),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_unexpected_transfer" });
      expect(verdict.ok === false && verdict.errorMessage).toContain(OTHER_FACILITATOR);
    });

    it("fails another facilitator account debited in the payment token", () => {
      const verdict = checkTransferExecutorSettlement(
        record({
          children: [
            recordEntry({
              tokenTransfers: {
                [TOKEN]: [
                  transferEntry(PAYER, -AMOUNT),
                  transferEntry(PAY_TO, AMOUNT),
                  transferEntry(OTHER_FACILITATOR, -5n),
                  transferEntry(THIRD_PARTY, 5n),
                ],
              },
            }),
          ],
        }),
        expectation({ asset: TOKEN, ...twoAccounts }),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_unexpected_transfer" });
      expect(verdict.ok === false && verdict.errorMessage).toContain(TOKEN);
    });

    it("fails a payer that is the fee payer debited more than amount plus fee", () => {
      const verdict = checkTransferExecutorSettlement(
        record({
          parent: feeParent(PAYER),
          children: [
            recordEntry({
              hbarTransfers: [
                transferEntry(PAYER, -(AMOUNT + 5n)),
                transferEntry(PAY_TO, AMOUNT),
                transferEntry(THIRD_PARTY, 5n),
              ],
            }),
          ],
        }),
        expectation({ feePayer: PAYER, facilitatorAccounts: [PAYER] }),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_unexpected_transfer" });
      const message = verdict.ok === false ? verdict.errorMessage : "";
      expect(message).toContain(`amount ${AMOUNT} + fee ${FEE}`);
      expect(message).toContain(`amount part ${AMOUNT + 5n}, fee part ${FEE}`);
    });

    it.each([
      [
        "HBAR",
        "0.0.0",
        {
          hbarTransfers: [transferEntry(OTHER_FACILITATOR, -AMOUNT), transferEntry(PAY_TO, AMOUNT)],
        },
      ],
      [
        "a token",
        TOKEN,
        {
          tokenTransfers: {
            [TOKEN]: [transferEntry(OTHER_FACILITATOR, -AMOUNT), transferEntry(PAY_TO, AMOUNT)],
          },
        },
      ],
    ])(
      "fails a facilitator account as payer debited the amount in %s when it is not the fee payer",
      (_, asset, lists) => {
        const verdict = checkTransferExecutorSettlement(
          record({ children: [recordEntry(lists)] }),
          expectation({ asset, payer: OTHER_FACILITATOR, ...twoAccounts }),
        );
        expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_unexpected_transfer" });
        const message = verdict.ok === false ? verdict.errorMessage : "";
        expect(message).toContain(OTHER_FACILITATOR);
        expect(message).toContain(`debited ${AMOUNT}`);
      },
    );

    it("fails a payer that is the fee payer debited more than the amount in the token", () => {
      const verdict = checkTransferExecutorSettlement(
        record({
          parent: feeParent(PAYER),
          children: [
            recordEntry({
              tokenTransfers: {
                [TOKEN]: [
                  transferEntry(PAYER, -(AMOUNT + 1n)),
                  transferEntry(PAY_TO, AMOUNT),
                  transferEntry(THIRD_PARTY, 1n),
                ],
              },
            }),
          ],
        }),
        expectation({ asset: TOKEN, feePayer: PAYER, facilitatorAccounts: [PAYER] }),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_unexpected_transfer" });
      expect(verdict.ok === false && verdict.errorMessage).toContain(`debited ${AMOUNT + 1n}`);
    });
  });

  describe("logs", () => {
    const facilitator = {
      facilitatorAccounts: [FEE_PAYER],
      facilitatorEvmAddresses: [longZero(FEE_PAYER), FEE_PAYER_ALIAS],
    };
    const thirdPartyAddress = longZero(THIRD_PARTY);

    it("derives event topics from a correct keccak-256", () => {
      expect(keccak256("")).toBe(
        "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
      );
    });

    it.each([
      ["alias, matched case-insensitively", FEE_PAYER_ALIAS.toLowerCase()],
      ["long-zero address", longZero(FEE_PAYER)],
    ])("fails a Transfer log out of a facilitator %s", (_, from) => {
      const verdict = checkTransferExecutorSettlement(
        record({ logs: [transferLog(EXECUTOR_ADDRESS, from, thirdPartyAddress)] }),
        expectation(facilitator),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_unexpected_transfer" });
      expect(verdict.ok === false && verdict.errorMessage).toContain(from.toLowerCase());
    });

    it("accepts a Transfer log out of an account the facilitator does not control", () => {
      const verdict = checkTransferExecutorSettlement(
        record({ logs: [transferLog(EXECUTOR_ADDRESS, thirdPartyAddress, longZero(FEE_PAYER))] }),
        expectation(facilitator),
      );
      expect(verdict).toEqual({ ok: true });
    });

    it.each([
      ["TransferSingle", TRANSFER_SINGLE_TOPIC],
      ["TransferBatch", TRANSFER_BATCH_TOPIC],
    ])("fails an ERC-1155 %s log out of a facilitator account", (_, topic) => {
      const verdict = checkTransferExecutorSettlement(
        record({
          logs: [erc1155Log(topic, thirdPartyAddress, FEE_PAYER_ALIAS, thirdPartyAddress)],
        }),
        expectation(facilitator),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_unexpected_transfer" });
    });

    it("reads the ERC-1155 sender from the from topic, not the operator topic", () => {
      const verdict = checkTransferExecutorSettlement(
        record({
          logs: [
            erc1155Log(
              TRANSFER_SINGLE_TOPIC,
              FEE_PAYER_ALIAS,
              thirdPartyAddress,
              thirdPartyAddress,
            ),
          ],
        }),
        expectation(facilitator),
      );
      expect(verdict).toEqual({ ok: true });
    });

    it("ignores a log that is not a transfer event, even one naming a facilitator address", () => {
      const approval = keccak256("Approval(address,address,uint256)");
      const verdict = checkTransferExecutorSettlement(
        record({
          logs: [
            {
              address: EXECUTOR_ADDRESS,
              topics: [approval, addressTopic(FEE_PAYER_ALIAS), addressTopic(thirdPartyAddress)],
              data: "0x",
            },
          ],
        }),
        expectation(facilitator),
      );
      expect(verdict).toEqual({ ok: true });
    });

    // A transfer log whose sender can't be decoded can't prove it moved nothing out of a
    // facilitator address, so it fails closed.
    it.each<[string, string[]]>([
      ["Transfer with no from topic", [TRANSFER_TOPIC]],
      ["Transfer whose from topic is not a 32-byte word", [TRANSFER_TOPIC, "0x01"]],
      [
        "TransferSingle with no from topic",
        [TRANSFER_SINGLE_TOPIC, addressTopic(thirdPartyAddress)],
      ],
      [
        "TransferSingle whose from topic is not a 32-byte word",
        [
          TRANSFER_SINGLE_TOPIC,
          addressTopic(thirdPartyAddress),
          `0x${"0".repeat(62)}`,
          addressTopic(thirdPartyAddress),
        ],
      ],
      ["TransferBatch with no from topic", [TRANSFER_BATCH_TOPIC, addressTopic(thirdPartyAddress)]],
      [
        "TransferBatch whose from topic is not a 32-byte word",
        [
          TRANSFER_BATCH_TOPIC,
          addressTopic(thirdPartyAddress),
          `0x${"g".repeat(64)}`,
          addressTopic(thirdPartyAddress),
        ],
      ],
    ])("fails a %s", (_, topics) => {
      const verdict = checkTransferExecutorSettlement(
        record({ logs: [{ address: EXECUTOR_ADDRESS, topics, data: "0x" }] }),
        expectation(facilitator),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_check_failed" });
      expect(verdict.ok === false && verdict.errorMessage).toContain(EXECUTOR_ADDRESS);
    });

    it("skips the facade Transfer log of a token whose movement the token lists already show", () => {
      const verdict = checkTransferExecutorSettlement(
        record({
          parent: feeParent(PAYER),
          children: [
            recordEntry({
              tokenTransfers: {
                [TOKEN]: [transferEntry(PAYER, -AMOUNT), transferEntry(PAY_TO, AMOUNT)],
              },
            }),
          ],
          logs: [transferLog(longZero(TOKEN), longZero(PAYER), longZero(PAY_TO))],
        }),
        expectation({
          asset: TOKEN,
          feePayer: PAYER,
          facilitatorAccounts: [PAYER],
          facilitatorEvmAddresses: [longZero(PAYER)],
        }),
      );
      expect(verdict).toEqual({ ok: true });
    });

    it("does not skip a Transfer log from a token absent from the token lists", () => {
      const verdict = checkTransferExecutorSettlement(
        record({ logs: [transferLog(longZero(OTHER_TOKEN), FEE_PAYER_ALIAS, thirdPartyAddress)] }),
        expectation(facilitator),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_unexpected_transfer" });
    });
  });

  describe("third-party debit", () => {
    const payment = recordEntry({
      hbarTransfers: [transferEntry(PAYER, -AMOUNT), transferEntry(PAY_TO, AMOUNT)],
    });

    it("fails a third party debited HBAR", () => {
      const verdict = checkTransferExecutorSettlement(
        record({
          children: [
            payment,
            recordEntry({
              hbarTransfers: [
                transferEntry(THIRD_PARTY, -5n),
                transferEntry(OTHER_THIRD_PARTY, 5n),
              ],
            }),
          ],
        }),
        expectation(),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_unexpected_debit" });
      const message = verdict.ok === false ? verdict.errorMessage : "";
      expect(message).toContain(THIRD_PARTY);
      expect(message).toContain("5");
    });

    it("fails a third party debited in the payment token", () => {
      const verdict = checkTransferExecutorSettlement(
        record({
          children: [
            recordEntry({
              tokenTransfers: {
                [TOKEN]: [
                  transferEntry(PAYER, -AMOUNT),
                  transferEntry(PAY_TO, AMOUNT),
                  transferEntry(THIRD_PARTY, -5n),
                  transferEntry(OTHER_THIRD_PARTY, 5n),
                ],
              },
            }),
          ],
        }),
        expectation({ asset: TOKEN }),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_unexpected_debit" });
    });

    it("fails a third party debited in another token before judging other lists", () => {
      const verdict = checkTransferExecutorSettlement(
        record({
          children: [
            payment,
            recordEntry({
              tokenTransfers: {
                [OTHER_TOKEN]: [
                  transferEntry(THIRD_PARTY, -5n),
                  transferEntry(OTHER_THIRD_PARTY, 5n),
                ],
              },
            }),
          ],
        }),
        expectation(),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_unexpected_debit" });
      expect(verdict.ok === false && verdict.errorMessage).toContain(OTHER_TOKEN);
    });
  });

  // A balanced record that passes the debit checks cannot carry an extra credit, so these
  // records credit more than they debit.
  describe("extra credits", () => {
    it("fails positive non-payTo HBAR changes that do not sum to the transaction fee", () => {
      const verdict = checkTransferExecutorSettlement(
        record({
          children: [
            recordEntry({
              hbarTransfers: [
                transferEntry(PAYER, -AMOUNT),
                transferEntry(PAY_TO, AMOUNT),
                transferEntry(THIRD_PARTY, 7n),
              ],
            }),
          ],
        }),
        expectation(),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_unexpected_transfer" });
      const message = verdict.ok === false ? verdict.errorMessage : "";
      expect(message).toContain(FEE.toString());
      expect(message).toContain((FEE + 7n).toString());
    });

    it("fails a token credit to anyone but payTo", () => {
      const verdict = checkTransferExecutorSettlement(
        record({
          children: [
            recordEntry({
              tokenTransfers: {
                [TOKEN]: [
                  transferEntry(PAYER, -AMOUNT),
                  transferEntry(PAY_TO, AMOUNT),
                  transferEntry(THIRD_PARTY, 3n),
                ],
              },
            }),
          ],
        }),
        expectation({ asset: TOKEN }),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_unexpected_transfer" });
      expect(verdict.ok === false && verdict.errorMessage).toContain(THIRD_PARTY);
    });

    it("fails a token payment whose HBAR credits do not sum to the transaction fee", () => {
      const verdict = checkTransferExecutorSettlement(
        record({
          parent: recordEntry({
            chargedFee: FEE.toString(),
            hbarTransfers: [
              transferEntry(FEE_COLLECTOR, FEE),
              transferEntry(FEE_PAYER, -FEE),
              transferEntry(PAY_TO, 7n),
            ],
          }),
          children: [
            recordEntry({
              tokenTransfers: {
                [TOKEN]: [transferEntry(PAYER, -AMOUNT), transferEntry(PAY_TO, AMOUNT)],
              },
            }),
          ],
        }),
        expectation({ asset: TOKEN }),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_unexpected_transfer" });
    });
  });

  describe("other lists", () => {
    const payment = recordEntry({
      hbarTransfers: [transferEntry(PAYER, -AMOUNT), transferEntry(PAY_TO, AMOUNT)],
    });

    it.each([
      ["moved by the payer", [transferEntry(PAYER, -5n), transferEntry(THIRD_PARTY, 5n)]],
      ["minted to a third party", [transferEntry(THIRD_PARTY, 5n)]],
    ])("fails an unrelated token %s", (_, transfers) => {
      const verdict = checkTransferExecutorSettlement(
        record({
          children: [payment, recordEntry({ tokenTransfers: { [OTHER_TOKEN]: transfers } })],
        }),
        expectation(),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_unexpected_transfer" });
      expect(verdict.ok === false && verdict.errorMessage).toContain(OTHER_TOKEN);
    });

    it("accepts an unrelated token list that nets to zero for every account", () => {
      const verdict = checkTransferExecutorSettlement(
        record({
          children: [
            payment,
            recordEntry({
              tokenTransfers: {
                [OTHER_TOKEN]: [transferEntry(PAYER, -5n), transferEntry(THIRD_PARTY, 5n)],
              },
            }),
            recordEntry({
              tokenTransfers: {
                [OTHER_TOKEN]: [transferEntry(THIRD_PARTY, -5n), transferEntry(PAYER, 5n)],
              },
            }),
          ],
        }),
        expectation(),
      );
      expect(verdict).toEqual({ ok: true });
    });

    it.each([
      ["changes owner", THIRD_PARTY, OTHER_THIRD_PARTY],
      ["is minted", null, THIRD_PARTY],
    ])("fails when an NFT %s", (_, senderAccountId, receiverAccountId) => {
      const verdict = checkTransferExecutorSettlement(
        record({
          children: [
            payment,
            recordEntry({
              nftTransfers: [
                { tokenId: NFT_TOKEN, serialNumber: "7", senderAccountId, receiverAccountId },
              ],
            }),
          ],
        }),
        expectation(),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_unexpected_transfer" });
      expect(verdict.ok === false && verdict.errorMessage).toContain(`${NFT_TOKEN} serial 7`);
    });
  });

  // Only the payouts the record marks as staking rewards are netted out.
  describe("staking rewards", () => {
    const REWARD = 1_133n;

    it.each([
      [
        "the payer, in a child",
        feeParent(),
        recordEntry({
          hbarTransfers: [
            transferEntry(PAYER, -(AMOUNT - REWARD)),
            transferEntry(PAY_TO, AMOUNT),
            transferEntry(STAKING_REWARD_ACCOUNT, -REWARD),
          ],
          stakingRewardTransfers: [transferEntry(PAYER, REWARD)],
        }),
      ],
      [
        "payTo, in a child",
        feeParent(),
        recordEntry({
          hbarTransfers: [
            transferEntry(PAYER, -AMOUNT),
            transferEntry(PAY_TO, AMOUNT + REWARD),
            transferEntry(STAKING_REWARD_ACCOUNT, -REWARD),
          ],
          stakingRewardTransfers: [transferEntry(PAY_TO, REWARD)],
        }),
      ],
      [
        "the fee payer, in the parent",
        recordEntry({
          chargedFee: FEE.toString(),
          hbarTransfers: [
            transferEntry(FEE_COLLECTOR, FEE),
            transferEntry(FEE_PAYER, -(FEE - REWARD)),
            transferEntry(STAKING_REWARD_ACCOUNT, -REWARD),
          ],
          stakingRewardTransfers: [transferEntry(FEE_PAYER, REWARD)],
        }),
        recordEntry({
          hbarTransfers: [transferEntry(PAYER, -AMOUNT), transferEntry(PAY_TO, AMOUNT)],
        }),
      ],
    ])("accepts a staking reward paid to %s", (_, parent, child) => {
      const verdict = checkTransferExecutorSettlement(
        record({ parent, children: [child] }),
        expectation(),
      );
      expect(verdict).toEqual({ ok: true });
    });

    it("fails a 0.0.800 debit the record does not mark as a staking reward", () => {
      const verdict = checkTransferExecutorSettlement(
        record({
          children: [
            recordEntry({
              hbarTransfers: [transferEntry(PAYER, -AMOUNT), transferEntry(PAY_TO, AMOUNT)],
            }),
            recordEntry({
              hbarTransfers: [
                transferEntry(STAKING_REWARD_ACCOUNT, -REWARD),
                transferEntry(THIRD_PARTY, REWARD),
              ],
            }),
          ],
        }),
        expectation(),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_unexpected_debit" });
      expect(verdict.ok === false && verdict.errorMessage).toContain(STAKING_REWARD_ACCOUNT);
    });

    it("nets out only the marked part of a larger 0.0.800 debit", () => {
      const verdict = checkTransferExecutorSettlement(
        record({
          children: [
            recordEntry({
              hbarTransfers: [
                transferEntry(PAYER, -(AMOUNT - REWARD)),
                transferEntry(PAY_TO, AMOUNT),
                transferEntry(THIRD_PARTY, REWARD),
                transferEntry(STAKING_REWARD_ACCOUNT, -2n * REWARD),
              ],
              stakingRewardTransfers: [transferEntry(PAYER, REWARD)],
            }),
          ],
        }),
        expectation(),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_unexpected_debit" });
      expect(verdict.ok === false && verdict.errorMessage).toContain(REWARD.toString());
    });

    it("does not credit a marked reward that 0.0.800 never paid", () => {
      const verdict = checkTransferExecutorSettlement(
        record({
          children: [
            recordEntry({
              hbarTransfers: [transferEntry(PAYER, -AMOUNT), transferEntry(PAY_TO, AMOUNT)],
              stakingRewardTransfers: [transferEntry(PAYER, REWARD)],
            }),
          ],
        }),
        expectation(),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_payer_debit_mismatch" });
    });
  });

  describe("payee credit", () => {
    it.each([
      [
        "short",
        AMOUNT - 1n,
        [transferEntry(PAYER, -(AMOUNT - 1n)), transferEntry(PAY_TO, AMOUNT - 1n)],
      ],
      [
        "over",
        AMOUNT + 1n,
        [transferEntry(PAYER, -(AMOUNT + 1n)), transferEntry(PAY_TO, AMOUNT + 1n)],
      ],
      ["zero", 0n, [transferEntry(PAYER, -AMOUNT), transferEntry(THIRD_PARTY, AMOUNT)]],
    ])("fails a %s credit to payTo", (_, credited, transfers) => {
      const verdict = checkTransferExecutorSettlement(
        record({ children: [recordEntry({ hbarTransfers: transfers })] }),
        expectation(),
      );
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_payee_credit_mismatch" });
      const message = verdict.ok === false ? verdict.errorMessage : "";
      expect(message).toContain(PAY_TO);
      expect(message).toContain(AMOUNT.toString());
      expect(message).toContain(credited.toString());
    });

    it("fails a SUCCESS record that moved nothing", () => {
      const verdict = checkTransferExecutorSettlement(record({ children: [] }), expectation());
      expect(verdict).toMatchObject({ ok: false, errorReason: "settlement_payee_credit_mismatch" });
    });

    it("compares an alias payTo by the account id it resolved to", () => {
      // The quote named payTo by its EVM alias; settle resolved it to PAY_TO, and the
      // record credits the account id.
      const verdict = checkTransferExecutorSettlement(
        record(),
        expectation({ payToAccountId: PAY_TO }),
      );
      expect(verdict).toEqual({ ok: true });
    });

    it("sums the payTo credit across parent and children", () => {
      const half = AMOUNT / 2n;
      const verdict = checkTransferExecutorSettlement(
        record({
          parent: recordEntry({
            chargedFee: FEE.toString(),
            hbarTransfers: [
              transferEntry(FEE_COLLECTOR, FEE),
              transferEntry(FEE_PAYER, -FEE),
              transferEntry(PAYER, -half),
              transferEntry(PAY_TO, half),
            ],
          }),
          children: [
            recordEntry({
              hbarTransfers: [transferEntry(PAYER, -half), transferEntry(PAY_TO, half)],
            }),
          ],
        }),
        expectation(),
      );
      expect(verdict).toEqual({ ok: true });
    });
  });
});
