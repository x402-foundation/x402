/**
 * Exact/EIP-3009 integration test with a deployed Biconomy Nexus (ERC-7579).
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
import { createNexusClientSigner, NEXUS_K1_VALIDATOR } from "./helpers/smartAccounts";

const env: Pick<
  MatrixEnv,
  | "FACILITATOR_PRIVATE_KEY"
  | "CLIENT_7579_ADDRESS"
  | "CLIENT_7579_OWNER_PRIVATE_KEY"
  | "CLIENT_7579_VALIDATOR"
> = {
  FACILITATOR_PRIVATE_KEY: process.env.FACILITATOR_PRIVATE_KEY as `0x${string}` | undefined,
  CLIENT_7579_ADDRESS: process.env.CLIENT_7579_ADDRESS as `0x${string}` | undefined,
  CLIENT_7579_OWNER_PRIVATE_KEY: process.env.CLIENT_7579_OWNER_PRIVATE_KEY as
    | `0x${string}`
    | undefined,
  CLIENT_7579_VALIDATOR:
    (process.env.CLIENT_7579_VALIDATOR as `0x${string}` | undefined) ?? NEXUS_K1_VALIDATOR,
};

describe.skipIf(!env.FACILITATOR_PRIVATE_KEY)("Exact / ERC-7579 — Biconomy Nexus", () => {
  let server: x402ResourceServer;
  let facilAddr: `0x${string}`;

  beforeAll(() => {
    const fixtures = buildExactServer(env.FACILITATOR_PRIVATE_KEY!);
    server = fixtures.server;
    facilAddr = fixtures.facilAcct.address;
  });

  it.skipIf(!env.CLIENT_7579_ADDRESS || !env.CLIENT_7579_OWNER_PRIVATE_KEY)(
    "exact / EIP-3009 — full verify+settle flow",
    { timeout: 60000 },
    async () => {
      const ownerAcct = privateKeyToAccount(env.CLIENT_7579_OWNER_PRIVATE_KEY!);
      const clientSigner = createNexusClientSigner(
        ownerAcct,
        env.CLIENT_7579_ADDRESS!,
        env.CLIENT_7579_VALIDATOR!,
      );
      const settle = await runExactFlow(
        clientSigner,
        buildExactEip3009Accepts(facilAddr),
        server,
        "exact-7579-biconomy-nexus",
      );
      expect(settle.payer.toLowerCase()).toBe(env.CLIENT_7579_ADDRESS!.toLowerCase());
    },
  );
});
