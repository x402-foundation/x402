import { nativeToScVal } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STELLAR_PUBNET_CAIP2, STELLAR_TESTNET_CAIP2 } from "../../src/constants";
import { ExactStellarScheme } from "../../src/exact/client/scheme";
import * as stellarUtils from "../../src/utils";
import type { ClientStellarSigner } from "../../src/signer";
import type { RpcConfig } from "../../src/utils";
import type { PaymentRequirements } from "@x402/core/types";

const { mockAssembledTransactionBuild } = vi.hoisted(() => ({
  mockAssembledTransactionBuild: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk");
  return {
    ...actual,
    contract: {
      ...actual.contract,
      AssembledTransaction: {
        ...actual.contract.AssembledTransaction,
        build: mockAssembledTransactionBuild,
      },
    },
  };
});

vi.mock("../../src/utils", async () => {
  const actual = await vi.importActual<typeof stellarUtils>("../../src/utils");
  return {
    ...actual,
    getEstimatedLedgerCloseTimeSeconds: vi.fn().mockResolvedValue(5),
    getRpcUrl: vi.fn(),
    getRpcClient: vi.fn(),
    isStellarNetwork: vi.fn(),
    validateStellarAssetAddress: vi.fn(),
    validateStellarDestinationAddress: vi.fn(),
  };
});

describe("ExactStellarScheme", () => {
  const mockSignerAddress = "GBBO4ZDDZTSM2IUKQYBAST3CFHNPFXECGEFTGWTA2WELR2BIWDK57UVE";
  const mockSigner: ClientStellarSigner = {
    address: mockSignerAddress,
    signAuthEntry: vi.fn().mockResolvedValue({ signedAuthEntry: "signed" }),
  };

  const validPaymentReq: PaymentRequirements = {
    scheme: "exact",
    network: STELLAR_TESTNET_CAIP2,
    amount: "1000000",
    payTo: "GCHEI4PQEFJOA27MNZRPQNLGURS6KASW76X5UZCUZIXCOJLKXYCXOR2W",
    maxTimeoutSeconds: 60,
    asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    extra: { areFeesSponsored: true },
  };

  const mockTransaction = {
    simulation: {},
    needsNonInvokerSigningBy: vi.fn(),
    signAuthEntries: vi.fn(),
    simulate: vi.fn(),
    built: { toXDR: vi.fn().mockReturnValue("mock-xdr") },
  };

  const setupSuccessfulTransaction = () => {
    mockTransaction.needsNonInvokerSigningBy.mockReturnValueOnce([mockSignerAddress]);
    mockTransaction.needsNonInvokerSigningBy.mockReturnValueOnce([]);
  };

  const mockRpcServer = {
    getLatestLedger: vi.fn().mockResolvedValue({ sequence: 100000 }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(stellarUtils.isStellarNetwork).mockReturnValue(true);
    vi.mocked(stellarUtils.validateStellarAssetAddress).mockReturnValue(true);
    vi.mocked(stellarUtils.validateStellarDestinationAddress).mockReturnValue(true);
    vi.mocked(stellarUtils.getRpcUrl).mockReturnValue("https://soroban-testnet.stellar.org");
    vi.mocked(stellarUtils.getRpcClient).mockReturnValue(mockRpcServer as never);
    mockAssembledTransactionBuild.mockResolvedValue(mockTransaction);
  });

  describe("constructor", () => {
    it("should create instance with correct scheme and accept optional rpcConfig", () => {
      expect(new ExactStellarScheme(mockSigner).scheme).toBe("exact");
      expect(
        new ExactStellarScheme(mockSigner, { url: "https://custom-rpc.example.com" }).scheme,
      ).toBe("exact");
    });
  });

  describe("createPaymentPayload", () => {
    it.each([
      ["unsupported scheme", { scheme: "invalid" }, "Unsupported scheme: invalid"],
      ["unsupported network", { network: "base-sepolia" as never }, "Unsupported Stellar network"],
      ["invalid payTo", { payTo: "invalid-address" }, "Invalid Stellar destination address"],
      ["invalid asset", { asset: "invalid-asset" }, "Invalid Stellar asset address"],
      ["invalid amount (negative)", { amount: "-100" }, "Invalid amount"],
      ["invalid amount (zero)", { amount: "0" }, "Invalid amount"],
      ["invalid amount (non-integer)", { amount: "100.5" }, "Invalid amount"],
      ["invalid amount (empty string)", { amount: "" }, "Invalid amount"],
      ["invalid amount (non-numeric)", { amount: "abc" }, "Invalid amount"],
    ])("should throw for %s", async (_, overrides, expectedError) => {
      const client = new ExactStellarScheme(mockSigner);
      if ("network" in overrides && overrides.network) {
        vi.mocked(stellarUtils.isStellarNetwork).mockReturnValue(false);
      }
      if ("payTo" in overrides && overrides.payTo) {
        vi.mocked(stellarUtils.validateStellarDestinationAddress).mockReturnValue(false);
      }
      if ("asset" in overrides && overrides.asset) {
        vi.mocked(stellarUtils.validateStellarAssetAddress).mockReturnValue(false);
      }

      await expect(
        client.createPaymentPayload(2, { ...validPaymentReq, ...overrides } as PaymentRequirements),
      ).rejects.toThrow(expectedError);
    });

    it("should work with both TESTNET and PUBNET networks", async () => {
      const client = new ExactStellarScheme(mockSigner);
      setupSuccessfulTransaction();

      await expect(client.createPaymentPayload(2, validPaymentReq)).resolves.toBeDefined();

      const pubnetReq = {
        ...validPaymentReq,
        network: STELLAR_PUBNET_CAIP2,
      } as PaymentRequirements;
      vi.mocked(stellarUtils.getRpcUrl).mockReturnValueOnce("https://mainnet-rpc.example.com");
      setupSuccessfulTransaction();

      await expect(client.createPaymentPayload(2, pubnetReq)).resolves.toBeDefined();
    });

    it("should accept G, C, or M addresses for payTo", async () => {
      const client = new ExactStellarScheme(mockSigner);
      const addresses = [
        validPaymentReq.payTo, // G address
        "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", // C address
        "MA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KAAAAAAAAAAAAFKBA", // M address
      ];

      for (const address of addresses) {
        setupSuccessfulTransaction();
        await expect(
          client.createPaymentPayload(2, { ...validPaymentReq, payTo: address }),
        ).resolves.toBeDefined();
      }
    });

    it("should use custom RPC URL from rpcConfig", async () => {
      const client = new ExactStellarScheme(mockSigner, { url: "https://custom-rpc.example.com" });
      setupSuccessfulTransaction();
      vi.mocked(stellarUtils.getRpcUrl).mockReturnValue("https://custom-rpc.example.com");

      await client.createPaymentPayload(2, validPaymentReq);

      expect(stellarUtils.getRpcUrl).toHaveBeenCalledWith(
        STELLAR_TESTNET_CAIP2,
        expect.objectContaining({ url: "https://custom-rpc.example.com" }),
      );
    });

    it("should throw for PUBNET without custom RPC URL", async () => {
      const client = new ExactStellarScheme(mockSigner);
      const pubnetReq = {
        ...validPaymentReq,
        network: STELLAR_PUBNET_CAIP2,
      } as PaymentRequirements;
      vi.mocked(stellarUtils.getRpcUrl).mockImplementation(
        (network: string, rpcConfig?: RpcConfig) => {
          if (network === STELLAR_PUBNET_CAIP2 && !rpcConfig?.url) {
            throw new Error(
              "Stellar mainnet requires a non-empty rpcUrl. For a list of RPC providers, see https://developers.stellar.org/docs/data/apis/rpc/providers#publicly-accessible-apis",
            );
          }
          return "https://soroban-testnet.stellar.org";
        },
      );

      await expect(client.createPaymentPayload(2, pubnetReq)).rejects.toThrow(
        /Stellar mainnet requires a non-empty rpcUrl/,
      );
    });

    it.each([
      ["wrong signer", ["DIFFERENT_ADDRESS"]],
      ["multiple signers", [mockSignerAddress, "ANOTHER_ADDRESS"]],
    ])("should throw if %s is needed", async (_, signers) => {
      const client = new ExactStellarScheme(mockSigner);
      mockTransaction.needsNonInvokerSigningBy.mockReturnValueOnce(signers);
      await expect(client.createPaymentPayload(2, validPaymentReq)).rejects.toThrow(
        /Expected to sign with/,
      );
    });

    it("should throw if signers still missing after signing", async () => {
      const client = new ExactStellarScheme(mockSigner);
      mockTransaction.needsNonInvokerSigningBy.mockReturnValueOnce([mockSignerAddress]);
      mockTransaction.needsNonInvokerSigningBy.mockReturnValueOnce(["STILL_MISSING"]);

      await expect(client.createPaymentPayload(2, validPaymentReq)).rejects.toThrow(
        /unexpected signer\(s\) required/,
      );
    });

    it.each([
      [
        "TESTNET",
        STELLAR_TESTNET_CAIP2,
        "Test SDF Network ; September 2015",
        "https://soroban-testnet.stellar.org",
        undefined,
      ],
      [
        "PUBNET",
        STELLAR_PUBNET_CAIP2,
        "Public Global Stellar Network ; September 2015",
        "https://mainnet-rpc.example.com",
        { url: "https://mainnet-rpc.example.com" },
      ],
    ])(
      "should build, sign, and return correct payment for %s",
      async (_, network, passphrase, rpcUrl, rpcConfig) => {
        const client = new ExactStellarScheme(mockSigner, rpcConfig);
        setupSuccessfulTransaction();
        const req = { ...validPaymentReq, network } as PaymentRequirements;
        vi.mocked(stellarUtils.getRpcUrl).mockReturnValue(rpcUrl);

        const result = await client.createPaymentPayload(2, req);

        expect(mockAssembledTransactionBuild).toHaveBeenCalledWith({
          contractId: req.asset,
          method: "transfer",
          args: [
            nativeToScVal(mockSignerAddress, { type: "address" }),
            nativeToScVal(req.payTo, { type: "address" }),
            nativeToScVal(req.amount, { type: "i128" }),
          ],
          networkPassphrase: passphrase,
          rpcUrl,
          parseResultXdr: expect.any(Function),
        });
        // Expiration is calculated as currentLedger (100000) + ceil(maxTimeoutSeconds / 5) = 100012
        expect(mockTransaction.signAuthEntries).toHaveBeenCalledWith({
          address: mockSignerAddress,
          signAuthEntry: mockSigner.signAuthEntry,
          expiration: 100012,
        });
        expect(mockTransaction.simulate).toHaveBeenCalled();
        expect(result).toEqual({
          x402Version: 2,
          payload: { transaction: "mock-xdr" },
        });
      },
    );
  });
});
