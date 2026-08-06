/**
 * Exact/EIP-3009 integration test with a deployed Coinbase Smart Wallet (ERC-4337).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { x402ResourceServer } from "@x402/core/server";
import {
  buildExactServer,
  buildExactEip3009Accepts,
  runExactFlow,
  type MatrixEnv,
} from "./helpers/matrixCommon";
import { createCoinbaseSmartWalletClientSigner } from "./helpers/smartAccounts";

const env: Pick<
  MatrixEnv,
  "FACILITATOR_PRIVATE_KEY" | "CLIENT_4337_ADDRESS" | "CLIENT_4337_OWNER_PRIVATE_KEY"
> = {
  FACILITATOR_PRIVATE_KEY: process.env.FACILITATOR_PRIVATE_KEY as `0x${string}` | undefined,
  CLIENT_4337_ADDRESS: process.env.CLIENT_4337_ADDRESS as `0x${string}` | undefined,
  CLIENT_4337_OWNER_PRIVATE_KEY: process.env.CLIENT_4337_OWNER_PRIVATE_KEY as
    | `0x${string}`
    | undefined,
};

describe.skipIf(!env.FACILITATOR_PRIVATE_KEY)("Exact / ERC-4337 — Coinbase Smart Wallet", () => {
  let server: x402ResourceServer;
  let facilAddr: `0x${string}`;

  beforeAll(() => {
    const fixtures = buildExactServer(env.FACILITATOR_PRIVATE_KEY!);
    server = fixtures.server;
    facilAddr = fixtures.facilAcct.address;
  });

  it.skipIf(!env.CLIENT_4337_ADDRESS || !env.CLIENT_4337_OWNER_PRIVATE_KEY)(
    "exact / EIP-3009 — full verify+settle flow",
    { timeout: 60000 },
    async () => {
      const ownerAcct = privateKeyToAccount(env.CLIENT_4337_OWNER_PRIVATE_KEY!);
      const clientSigner = createCoinbaseSmartWalletClientSigner(
        ownerAcct,
        env.CLIENT_4337_ADDRESS!,
      );
      const settle = await runExactFlow(
        clientSigner,
        buildExactEip3009Accepts(facilAddr),
        server,
        "exact-4337-coinbase-smart-wallet",
      );
      expect(settle.payer.toLowerCase()).toBe(env.CLIENT_4337_ADDRESS!.toLowerCase());
    },
  );
});
