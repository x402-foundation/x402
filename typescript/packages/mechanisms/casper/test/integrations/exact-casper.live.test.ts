import { describe, expect, it } from "vitest";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { type FacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { NETWORK_CASPER_TESTNET } from "../../src/constants";
import { ExactCasperScheme as ExactCasperClient } from "../../src/exact/client/scheme";
import { ExactCasperScheme as ExactCasperFacilitator } from "../../src/exact/facilitator/scheme";
import { ExactCasperScheme as ExactCasperServer } from "../../src/exact/server/scheme";
import { createClientCasperSigner, createFacilitatorCasperSigner } from "../../src/signer";
import type { CasperAuthorizationState, ExactCasperPayload } from "../../src/types";

const CLIENT_PRIVATE_KEY = process.env.CASPER_CLIENT_PRIVATE_KEY;
const CLIENT_PRIVATE_KEY_ALGORITHM =
  process.env.CASPER_CLIENT_PRIVATE_KEY_ALGORITHM === "secp256k1" ? 2 : 1;
const FACILITATOR_PRIVATE_KEY = process.env.CASPER_FACILITATOR_PRIVATE_KEY;
const FACILITATOR_PRIVATE_KEY_ALGORITHM =
  process.env.CASPER_FACILITATOR_PRIVATE_KEY_ALGORITHM === "secp256k1" ? 2 : 1;
const PAY_TO = process.env.CASPER_PAY_TO;
const ASSET = process.env.CASPER_ASSET;
const TOKEN_NAME = process.env.CASPER_TOKEN_NAME;
const TOKEN_VERSION = process.env.CASPER_TOKEN_VERSION;
const TOKEN_DECIMALS = process.env.CASPER_TOKEN_DECIMALS
  ? parseInt(process.env.CASPER_TOKEN_DECIMALS, 10)
  : 9;
const NETWORK = (process.env.CASPER_NETWORK || NETWORK_CASPER_TESTNET) as Network;
const RPC_URL = process.env.CASPER_RPC_URL || "https://node.testnet.casper.network/rpc";
const RUN_LIVE = process.env.CASPER_RUN_LIVE === "1";

const missingLiveEnv =
  !RUN_LIVE ||
  !CLIENT_PRIVATE_KEY ||
  !FACILITATOR_PRIVATE_KEY ||
  !PAY_TO ||
  !ASSET ||
  !TOKEN_NAME ||
  !TOKEN_VERSION;

const describeLive = missingLiveEnv ? describe.skip : describe;

if (missingLiveEnv) {
  console.warn(
    "[exact-casper.live] skipped: set CASPER_RUN_LIVE=1, CASPER_CLIENT_PRIVATE_KEY, CASPER_FACILITATOR_PRIVATE_KEY, CASPER_PAY_TO, CASPER_ASSET, CASPER_TOKEN_NAME, and CASPER_TOKEN_VERSION to run.",
  );
}

class CasperFacilitatorClient implements FacilitatorClient {
  readonly scheme = "exact";
  readonly network = NETWORK;
  readonly x402Version = 2;

  /**
   * Create a facilitator client wrapper.
   *
   * @param facilitator - x402 facilitator.
   */
  constructor(private readonly facilitator: x402Facilitator) {}

  /**
   * Verify payment.
   *
   * @param paymentPayload - Payment payload.
   * @param paymentRequirements - Payment requirements.
   * @returns Verify response.
   */
  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.facilitator.verify(paymentPayload, paymentRequirements);
  }

  /**
   * Settle payment.
   *
   * @param paymentPayload - Payment payload.
   * @param paymentRequirements - Payment requirements.
   * @returns Settle response.
   */
  settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    return this.facilitator.settle(paymentPayload, paymentRequirements);
  }

  /**
   * Get supported kinds.
   *
   * @returns Supported response.
   */
  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve(this.facilitator.getSupported());
  }
}

describeLive(
  "Exact Casper live integration",
  () => {
    it("verifies and settles an exact Casper payment on Casper testnet", async () => {
      const clientSigner = await createClientCasperSigner(
        CLIENT_PRIVATE_KEY!,
        CLIENT_PRIVATE_KEY_ALGORITHM,
      );
      const facilitatorSigner = await createFacilitatorCasperSigner(
        FACILITATOR_PRIVATE_KEY!,
        FACILITATOR_PRIVATE_KEY_ALGORITHM,
        { [NETWORK]: RPC_URL },
        {
          getBalance: async () => 10n ** 30n,
          getAuthorizationState: async (): Promise<CasperAuthorizationState> => "unused",
          assertTransferWithAuthorizationSupported: async () => {},
        },
      );

      const client = new x402Client().register(NETWORK, new ExactCasperClient(clientSigner));
      const facilitator = new x402Facilitator().register(
        NETWORK,
        new ExactCasperFacilitator(facilitatorSigner),
      );
      const server = new x402ResourceServer(new CasperFacilitatorClient(facilitator));
      server.register(NETWORK, new ExactCasperServer());
      await server.initialize();

      const accepts = await server.buildPaymentRequirements({
        scheme: "exact",
        network: NETWORK,
        payTo: PAY_TO!,
        price: {
          amount: "3000000000",
          asset: ASSET!,
          extra: {
            name: TOKEN_NAME!,
            version: TOKEN_VERSION!,
            decimals: TOKEN_DECIMALS,
          },
        },
        maxTimeoutSeconds: 300,
      });
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, {
        url: "https://example.com/casper",
        description: "Casper integration resource",
        mimeType: "application/json",
      });

      expect(accepts).toEqual([
        expect.objectContaining({
          scheme: "exact",
          network: NETWORK,
          asset: ASSET!,
          amount: "3000000000",
          payTo: PAY_TO!,
          maxTimeoutSeconds: 300,
          extra: expect.objectContaining({
            name: TOKEN_NAME!,
            version: TOKEN_VERSION!,
          }),
        }),
      ]);

      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      expect(paymentPayload.x402Version).toBe(2);
      expect(paymentPayload.accepted.scheme).toBe("exact");
      expect(paymentPayload.accepted.network).toBe(NETWORK);
      expect(paymentPayload.accepted.extra).toMatchObject({
        name: TOKEN_NAME!,
        version: TOKEN_VERSION!,
      });

      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      expect(verifyResponse.isValid).toBe(true);

      const exactPayload = paymentPayload.payload as ExactCasperPayload;
      expect(verifyResponse.payer).toBe(exactPayload.authorization.from);

      const settleResponse = await server.settlePayment(paymentPayload, accepted!);
      expect(settleResponse.success).toBe(true);
      expect(settleResponse.network).toBe(NETWORK);
      expect(settleResponse.transaction).toMatch(/^[0-9a-fA-F]{64}$/);
      expect(settleResponse.payer).toBe(exactPayload.authorization.from);
    });
  },
  30_000 /* wait up to 30 seconds for execution of transaction in the Casper network */,
);
