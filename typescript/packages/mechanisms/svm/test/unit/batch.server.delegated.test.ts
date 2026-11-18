import { generateKeyPairSigner } from "@solana/kit";
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";

import { BatchSvmScheme } from "../../src/batch-settlement/server/scheme";
import { SOLANA_DEVNET_CAIP2 } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";

const NETWORK = SOLANA_DEVNET_CAIP2;
const MINT = USDC_DEVNET_ADDRESS;
const RECEIVER = USDC_MAINNET_ADDRESS;

function requirements(): PaymentRequirements {
  return {
    amount: "1000",
    asset: MINT,
    maxTimeoutSeconds: 300,
    network: NETWORK,
    payTo: RECEIVER,
    scheme: "batch-settlement",
  };
}

function supported(extra: Record<string, unknown>) {
  return { extra, network: NETWORK, scheme: "batch-settlement", x402Version: 2 };
}

describe("batch-settlement server delegated receiver authorizer", () => {
  it("fails startup without a local signer or an advertised key", async () => {
    const facilitatorKey = await generateKeyPairSigner();
    const delegated = new BatchSvmScheme({});
    expect(
      delegated.validateFacilitatorSupport?.(
        NETWORK,
        supported({ feePayer: facilitatorKey.address }),
        [],
      ),
    ).toMatch(/receiverAuthorizer/);
    expect(
      delegated.validateFacilitatorSupport?.(
        NETWORK,
        supported({
          feePayer: facilitatorKey.address,
          receiverAuthorizer: facilitatorKey.address,
        }),
        [],
      ),
    ).toBeUndefined();

    await expect(
      delegated.enhancePaymentRequirements(
        requirements(),
        supported({
          feePayer: facilitatorKey.address,
          receiverAuthorizer: facilitatorKey.address,
        }),
        [],
      ),
    ).resolves.toMatchObject({
      extra: { receiverAuthorizer: facilitatorKey.address },
    });
    expect(() =>
      delegated.enhancePaymentRequirements(
        requirements(),
        supported({ feePayer: facilitatorKey.address }),
        [],
      ),
    ).toThrow(/valid extra.receiverAuthorizer/);
  });

  it("prefers the local signer when the facilitator advertises a different key", async () => {
    const local = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const server = new BatchSvmScheme({ receiverAuthorizer: local });
    expect(
      server.validateFacilitatorSupport?.(NETWORK, supported({ feePayer: other.address }), []),
    ).toBeUndefined();
    await expect(
      server.enhancePaymentRequirements(
        requirements(),
        supported({ feePayer: other.address, receiverAuthorizer: other.address }),
        [],
      ),
    ).resolves.toMatchObject({
      extra: { feePayer: other.address, receiverAuthorizer: local.address },
    });
  });
});
