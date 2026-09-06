import { vi } from "vitest";
import { KEETA_MAINNET_CAIP2, KEETA_TESTNET_CAIP2 } from "../../src/constants";

const { mockUserClientDestroy, mockUserClientFromNetwork } = vi.hoisted(() => {
  const destroy = vi.fn().mockResolvedValue(undefined);
  return {
    mockUserClientDestroy: destroy,
    mockUserClientFromNetwork: () => ({ destroy }),
  };
});

vi.mock("@keetanetwork/keetanet-client", async importOriginal => {
  const actual = await importOriginal<typeof import("@keetanetwork/keetanet-client")>();
  return {
    ...actual,
    UserClient: Object.assign(actual.UserClient, {
      fromNetwork: vi.fn(mockUserClientFromNetwork),
    }),
  };
});

import * as KeetaNet from "@keetanetwork/keetanet-client";
import { KTA_MAINNET_ADDRESS, KTA_TESTNET_ADDRESS } from "../../src/utils";

export { mockUserClientDestroy };

/** Valid token addresses used as USDC stand-ins in unit tests (no RPC). */
export const USDC_TESTNET_ADDRESS = KTA_MAINNET_ADDRESS;
export const USDC_MAINNET_ADDRESS = KTA_TESTNET_ADDRESS;

export async function mockGetUsdcAddress(network: string): Promise<string> {
  if (network === KEETA_TESTNET_CAIP2) {
    return USDC_TESTNET_ADDRESS;
  }
  if (network === KEETA_MAINNET_CAIP2) {
    return USDC_MAINNET_ADDRESS;
  }
  throw new Error(`No USDC address configured for network: ${network}`);
}

export function getNewKeetaAccount() {
  return KeetaNet.lib.Account.fromSeed(
    KeetaNet.lib.Account.generateRandomSeed({ asString: true }),
    0,
  );
}
