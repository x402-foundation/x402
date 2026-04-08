import { describe, expect, it } from "vitest";
import { discoverWalletAddress } from "../../src/utils";

/**
 * Hits a real Open Payments wallet-address URL (JSON with resourceServer + authServer).
 * Set OPENPAYMENTS_INTEGRATION_WALLET_URL in .env.integration (see package README).
 */
const walletUrl = process.env.OPENPAYMENTS_INTEGRATION_WALLET_URL;
const skip = !walletUrl;

describe.skipIf(skip)("Open Payments integration (wallet discovery)", () => {
  it("discovers resource and authorization server URLs", async () => {
    const info = await discoverWalletAddress(walletUrl!);
    expect(info.resourceServer).toMatch(/^https?:\/\//);
    expect(info.authServer).toMatch(/^https?:\/\//);
  });
});
