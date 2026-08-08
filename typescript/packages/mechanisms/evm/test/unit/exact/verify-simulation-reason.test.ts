import { describe, it, expect, beforeEach, vi } from "vitest";
import { ExactEvmScheme } from "../../../src/exact/facilitator/scheme";
import { ExactEvmScheme as ClientExactEvmScheme } from "../../../src/exact/client/scheme";
import type { ClientEvmSigner, FacilitatorEvmSigner } from "../../../src/signer";
import { PaymentRequirements, PaymentPayload } from "@x402/core/types";
import * as Errors from "../../../src/exact/facilitator/errors";

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "1000000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2" },
};

interface VerifyOutcome {
  reason: string | undefined;
  /** How many times the diagnostic probe's multicall ran. */
  diagnosticCalls: number;
}

describe("verify: EIP-3009 simulation failure reason", () => {
  let client: ClientExactEvmScheme;
  let mockClientSigner: ClientEvmSigner;

  beforeEach(() => {
    mockClientSigner = {
      address: "0x1234567890123456789012345678901234567890",
      signTypedData: vi.fn().mockResolvedValue("0xmocksignature"),
      readContract: vi.fn().mockResolvedValue(BigInt(0)),
    };
    client = new ClientExactEvmScheme(mockClientSigner);
  });

  /**
   * Runs verify against a deployed ERC-1271 payer whose off-chain signature check passes, so
   * verify reaches the transfer simulation.
   *
   * @param simulationError - what the simulated transferWithAuthorization throws
   * @returns the reason verify reports and how many times the diagnostic probe ran
   */
  async function verifyOutcomeFor(simulationError: Error): Promise<VerifyOutcome> {
    let diagnosticCalls = 0;
    const signer: FacilitatorEvmSigner = {
      getAddresses: vi.fn().mockReturnValue(["0x742D35CC6634c0532925A3b844BC9E7595F0BEb0"]),
      readContract: vi.fn().mockImplementation(async (args: { functionName?: string }) => {
        // The payer's own validator accepts the signature: this is a valid ERC-1271 payer.
        if (args?.functionName === "isValidSignature") return "0x1626ba7e";
        if (args?.functionName === "tryAggregate") diagnosticCalls++;
        throw simulationError;
      }),
      verifyTypedData: vi.fn().mockResolvedValue(true),
      writeContract: vi.fn().mockResolvedValue("0xtxhash"),
      sendTransaction: vi.fn().mockResolvedValue("0xtxhash"),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
      getCode: vi.fn().mockResolvedValue("0x6080604052"),
    };
    const facilitator = new ExactEvmScheme(signer);

    const paymentPayload = await client.createPaymentPayload(2, requirements);
    const fullPayload: PaymentPayload = {
      ...paymentPayload,
      accepted: requirements,
      resource: { url: "test", description: "", mimeType: "" },
    };

    const response = await facilitator.verify(fullPayload, requirements);
    expect(response.isValid).toBe(false);
    return { reason: response.invalidReason, diagnosticCalls };
  }

  // A token whose transferWithAuthorization verifies with ecrecover only rejects every contract
  // payer: no retry, no funding and no configuration change makes this payment succeed. The
  // on-chain revert reason says so, and settle already maps that reason to ErrInvalidSignature
  // through parseEip3009TransferError. Verify must report the same terminal reason.
  it("reports a reverted simulation with the revert's own reason, not the retryable code", async () => {
    const { reason } = await verifyOutcomeFor(
      new Error("execution reverted: EIP3009: invalid signature"),
    );

    expect(reason).not.toBe(Errors.ErrEip3009SimulationFailed);
    expect(reason).toBe(Errors.ErrInvalidSignature);
  });

  // A transport failure says nothing about the payload, so the retryable code stays correct — and
  // the probe must not run, since it would send four more reads down the same dead path.
  it("keeps the retryable code after a transport failure without probing", async () => {
    const { reason, diagnosticCalls } = await verifyOutcomeFor(
      new Error("dial tcp 10.0.0.1:8545: connect: connection refused"),
    );

    expect(reason).toBe(Errors.ErrEip3009SimulationFailed);
    expect(diagnosticCalls).toBe(0);
  });

  // A revert whose reason no parser recognises still deserves the probe: the node answered, so
  // the diagnostic reads can run and may identify a used nonce or an insufficient balance.
  it("still probes when the revert reason is not recognised", async () => {
    const { reason, diagnosticCalls } = await verifyOutcomeFor(
      new Error("execution reverted: Pausable: paused"),
    );

    expect(diagnosticCalls).toBeGreaterThan(0);
    expect(reason).toBe(Errors.ErrEip3009SimulationFailed);
  });
});
