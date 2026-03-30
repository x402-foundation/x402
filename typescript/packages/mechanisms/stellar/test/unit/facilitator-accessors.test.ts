import { describe, it, expect, vi, beforeEach } from "vitest";
import { STELLAR_TESTNET_CAIP2 } from "../../src/constants";
import { ExactStellarScheme } from "../../src/exact/facilitator/scheme";
import { createEd25519Signer } from "../../src/signer";
import * as stellarUtils from "../../src/utils";

vi.mock("../../src/utils", async () => {
  const actual = await vi.importActual<typeof stellarUtils>("../../src/utils");
  return {
    ...actual,
    getRpcClient: vi.fn(),
  };
});

describe("ExactStellarScheme - getExtra", () => {
  const mockRpcClient = {
    getLatestLedger: vi.fn(),
  };
  let scheme: ExactStellarScheme;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(stellarUtils.getRpcClient).mockReturnValue(mockRpcClient as never);
  });

  it("should return areFeesSponsored", () => {
    const signer = createEd25519Signer(
      "SDV3OZOPGIO6GQAVI7T6ZJ7NSNFB26JX6QZYCI64TBC7BAZY6FQVAXXK",
      STELLAR_TESTNET_CAIP2,
    );

    scheme = new ExactStellarScheme([signer]);

    const result = scheme.getExtra(STELLAR_TESTNET_CAIP2);

    expect(result).toEqual({ areFeesSponsored: true });
    expect(mockRpcClient.getLatestLedger).not.toHaveBeenCalled();
  });

  it("should return consistent areFeesSponsored on each call", () => {
    const signer = createEd25519Signer(
      "SDV3OZOPGIO6GQAVI7T6ZJ7NSNFB26JX6QZYCI64TBC7BAZY6FQVAXXK",
      STELLAR_TESTNET_CAIP2,
    );

    scheme = new ExactStellarScheme([signer]);

    const result1 = scheme.getExtra(STELLAR_TESTNET_CAIP2);
    expect(result1).toEqual({ areFeesSponsored: true });

    const result2 = scheme.getExtra(STELLAR_TESTNET_CAIP2);
    expect(result2).toEqual({ areFeesSponsored: true });

    expect(mockRpcClient.getLatestLedger).not.toHaveBeenCalled();
  });

  it("should use custom areFeesSponsored", () => {
    const signer = createEd25519Signer(
      "SDV3OZOPGIO6GQAVI7T6ZJ7NSNFB26JX6QZYCI64TBC7BAZY6FQVAXXK",
      STELLAR_TESTNET_CAIP2,
    );

    scheme = new ExactStellarScheme([signer], { areFeesSponsored: false });

    const result = scheme.getExtra(STELLAR_TESTNET_CAIP2);
    expect(result).toEqual({ areFeesSponsored: false });
  });

  it("should return consistent areFeesSponsored with multiple signers", () => {
    const signer1 = createEd25519Signer(
      "SDV3OZOPGIO6GQAVI7T6ZJ7NSNFB26JX6QZYCI64TBC7BAZY6FQVAXXK",
      STELLAR_TESTNET_CAIP2,
    );
    const signer2 = createEd25519Signer(
      "SA6LFVPCYMDQILBRXQ2B2HRPK6DV2TX4FTQQQHWFPSCSY4H2RTCD3XAK",
      STELLAR_TESTNET_CAIP2,
    );

    scheme = new ExactStellarScheme([signer1, signer2]);

    // Call getExtra multiple times to ensure consistency
    for (let i = 0; i < 10; i++) {
      const result = scheme.getExtra(STELLAR_TESTNET_CAIP2);
      expect(result).toEqual({ areFeesSponsored: true });
    }

    expect(mockRpcClient.getLatestLedger).not.toHaveBeenCalled();
  });
});

describe("ExactStellarScheme - getSigners", () => {
  const mockRpcClient = {
    getLatestLedger: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(stellarUtils.getRpcClient).mockReturnValue(mockRpcClient as never);
  });

  it("should return all signer addresses with a single signer", () => {
    const signer = createEd25519Signer(
      "SDV3OZOPGIO6GQAVI7T6ZJ7NSNFB26JX6QZYCI64TBC7BAZY6FQVAXXK",
      STELLAR_TESTNET_CAIP2,
    );

    const scheme = new ExactStellarScheme([signer]);
    const signers = scheme.getSigners(STELLAR_TESTNET_CAIP2);

    expect(signers).toEqual([signer.address]);
  });

  it("should return all signer addresses with multiple signers", () => {
    const signer1 = createEd25519Signer(
      "SDV3OZOPGIO6GQAVI7T6ZJ7NSNFB26JX6QZYCI64TBC7BAZY6FQVAXXK",
      STELLAR_TESTNET_CAIP2,
    );
    const signer2 = createEd25519Signer(
      "SA6LFVPCYMDQILBRXQ2B2HRPK6DV2TX4FTQQQHWFPSCSY4H2RTCD3XAK",
      STELLAR_TESTNET_CAIP2,
    );

    const scheme = new ExactStellarScheme([signer1, signer2]);
    const signers = scheme.getSigners(STELLAR_TESTNET_CAIP2);

    expect(signers).toHaveLength(2);
    expect(signers).toContain(signer1.address);
    expect(signers).toContain(signer2.address);
  });

  it("should include feeBumpSigner address when configured", () => {
    const signer = createEd25519Signer(
      "SDV3OZOPGIO6GQAVI7T6ZJ7NSNFB26JX6QZYCI64TBC7BAZY6FQVAXXK",
      STELLAR_TESTNET_CAIP2,
    );
    const feeBumpSigner = createEd25519Signer(
      "SA6LFVPCYMDQILBRXQ2B2HRPK6DV2TX4FTQQQHWFPSCSY4H2RTCD3XAK",
      STELLAR_TESTNET_CAIP2,
    );

    const scheme = new ExactStellarScheme([signer], { feeBumpSigner });
    const signers = scheme.getSigners(STELLAR_TESTNET_CAIP2);

    expect(signers).toHaveLength(2);
    expect(signers).toContain(signer.address);
    expect(signers).toContain(feeBumpSigner.address);
  });

  it("should not duplicate feeBumpSigner if it is also a regular signer", () => {
    const signer = createEd25519Signer(
      "SDV3OZOPGIO6GQAVI7T6ZJ7NSNFB26JX6QZYCI64TBC7BAZY6FQVAXXK",
      STELLAR_TESTNET_CAIP2,
    );

    const scheme = new ExactStellarScheme([signer], { feeBumpSigner: signer });
    const signers = scheme.getSigners(STELLAR_TESTNET_CAIP2);

    expect(signers).toHaveLength(1);
    expect(signers).toEqual([signer.address]);
  });

  it("should include feeBumpSigner with multiple regular signers", () => {
    const signer1 = createEd25519Signer(
      "SDV3OZOPGIO6GQAVI7T6ZJ7NSNFB26JX6QZYCI64TBC7BAZY6FQVAXXK",
      STELLAR_TESTNET_CAIP2,
    );
    const signer2 = createEd25519Signer(
      "SA6LFVPCYMDQILBRXQ2B2HRPK6DV2TX4FTQQQHWFPSCSY4H2RTCD3XAK",
      STELLAR_TESTNET_CAIP2,
    );
    const feeBumpSigner = createEd25519Signer(
      "SACGSSH2Y7Q6P6BK3BBKGH5Z2RDSQQGD2XHOCDYQN7N6BU37HE2OLKMD",
      STELLAR_TESTNET_CAIP2,
    );

    const scheme = new ExactStellarScheme([signer1, signer2], { feeBumpSigner });
    const signers = scheme.getSigners(STELLAR_TESTNET_CAIP2);

    expect(signers).toHaveLength(3);
    expect(signers).toContain(signer1.address);
    expect(signers).toContain(signer2.address);
    expect(signers).toContain(feeBumpSigner.address);
  });

  it("should not include feeBumpSigner when not configured", () => {
    const signer = createEd25519Signer(
      "SDV3OZOPGIO6GQAVI7T6ZJ7NSNFB26JX6QZYCI64TBC7BAZY6FQVAXXK",
      STELLAR_TESTNET_CAIP2,
    );

    const scheme = new ExactStellarScheme([signer]);
    const signers = scheme.getSigners(STELLAR_TESTNET_CAIP2);

    expect(signers).toHaveLength(1);
    expect(signers).toEqual([signer.address]);
  });
});
