import { OpenPaymentsClientError } from "@interledger/open-payments";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ExactOpenPaymentsScheme } from "../../src/exact/client/scheme";
import type { OpenPaymentsClientConfig } from "../../src/types";
import type { PaymentRequirements } from "@x402/core/types";

global.fetch = vi.fn();

const makeWalletDiscoveryResponse = (overrides?: Record<string, unknown>) => ({
  ok: true,
  json: async () => ({
    resourceServer: "https://resource.example.com",
    authServer: "https://auth.example.com",
    assetCode: "USD",
    assetScale: 2,
    ...overrides,
  }),
});

const makeClientWalletDiscoveryResponse = () =>
  makeWalletDiscoveryResponse({
    resourceServer: "https://client-resource.example.com",
    authServer: "https://client-auth.example.com",
  });

const mockOpenPaymentsClient = {
  grant: {
    request: vi.fn(),
  },
  incomingPayment: {
    create: vi.fn(),
    get: vi.fn(),
  },
  quote: {
    create: vi.fn(),
  },
  outgoingPayment: {
    create: vi.fn(),
  },
  token: {
    rotate: vi.fn(),
  },
};

const makeConfig = (overrides?: Partial<OpenPaymentsClientConfig>): OpenPaymentsClientConfig => ({
  clientWalletAddress: "https://wallet.example.com/client",
  keyId: "test-key-id",
  privateKey: "dGVzdF9wcml2YXRlX2tleQ==",
  grantToken: "initial-grant-token",
  grantTokenManageUrl: "https://auth.example.com/token/manage-url",
  ...overrides,
});

const makeRequirements = (overrides?: Partial<PaymentRequirements>): PaymentRequirements => ({
  scheme: "exact",
  network: "ilp:openpayments",
  amount: "100",
  asset: "USD",
  payTo: "https://wallet.example.com/server",
  maxTimeoutSeconds: 10,
  extra: { assetScale: 2 },
  ...overrides,
});

describe("ExactOpenPaymentsScheme (Client)", () => {
  let client: ExactOpenPaymentsScheme;

  beforeEach(() => {
    client = new ExactOpenPaymentsScheme(makeConfig());
    (client as any).openPaymentsClient = mockOpenPaymentsClient;
    vi.clearAllMocks();
    // Default: auth servers auto-approve non-interactive grants (incoming-payment:create and quote:create)
    mockOpenPaymentsClient.grant.request.mockResolvedValue({
      access_token: { value: "non-interactive-token", manage: "https://auth.example.com/manage" },
    });
  });

  describe("construction", () => {
    it("should expose correct scheme", () => {
      expect(client.scheme).toBe("exact");
    });
  });

  describe("getGrantToken", () => {
    it("should return the current grant token", () => {
      expect(client.getGrantToken()).toBe("initial-grant-token");
    });
  });

  describe("updateGrantToken", () => {
    it("should update the grant token", () => {
      client.updateGrantToken("new-token");
      expect(client.getGrantToken()).toBe("new-token");
    });

    it("should update manage URL when provided", () => {
      client.updateGrantToken("new-token", "https://auth.example.com/new-manage");
      expect(client.getGrantToken()).toBe("new-token");
    });

    it("should not reset the SDK client instance (grant token is not part of SDK client config)", () => {
      client.updateGrantToken("new-token");
      expect((client as any).openPaymentsClient).toBe(mockOpenPaymentsClient);
    });
  });

  describe("createPaymentPayload", () => {
    const setupHappyPath = () => {
      // Server wallet discovery, then client wallet discovery
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(makeWalletDiscoveryResponse())
        .mockResolvedValueOnce(makeClientWalletDiscoveryResponse());

      mockOpenPaymentsClient.incomingPayment.create.mockResolvedValue({
        id: "https://wallet.example.com/server/incoming-payments/abc123",
      });
      mockOpenPaymentsClient.quote.create.mockResolvedValue({
        id: "https://client-resource.example.com/quotes/q1",
      });
      mockOpenPaymentsClient.outgoingPayment.create.mockResolvedValue({ id: "op1" });
      // Poll: first PENDING, then COMPLETED
      mockOpenPaymentsClient.incomingPayment.get
        .mockResolvedValueOnce({ completed: false })
        .mockResolvedValueOnce({ completed: true });
    };

    it("should return payload with incomingPaymentUrl on success", async () => {
      setupHappyPath();
      const result = await client.createPaymentPayload(2, makeRequirements());
      expect(result.x402Version).toBe(2);
      expect(result.payload).toEqual({
        incomingPaymentUrl: "https://wallet.example.com/server/incoming-payments/abc123",
      });
    });

    it("should discover both server and client wallet addresses", async () => {
      setupHappyPath();
      await client.createPaymentPayload(2, makeRequirements());
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(vi.mocked(global.fetch).mock.calls[0][0]).toBe("https://wallet.example.com/server");
      expect(vi.mocked(global.fetch).mock.calls[1][0]).toBe("https://wallet.example.com/client");
    });

    it("should create incoming payment with correct body", async () => {
      setupHappyPath();
      await client.createPaymentPayload(2, makeRequirements());
      expect(mockOpenPaymentsClient.incomingPayment.create).toHaveBeenCalledWith(
        { url: "https://resource.example.com", accessToken: "non-interactive-token" },
        expect.objectContaining({
          walletAddress: "https://wallet.example.com/server",
          incomingAmount: {
            value: "100",
            assetCode: "USD",
            assetScale: 2,
          },
        }),
      );
    });

    it("should create quote pointing to incoming payment", async () => {
      setupHappyPath();
      await client.createPaymentPayload(2, makeRequirements());
      expect(mockOpenPaymentsClient.quote.create).toHaveBeenCalledWith(
        { url: "https://client-resource.example.com", accessToken: "non-interactive-token" },
        expect.objectContaining({
          walletAddress: "https://wallet.example.com/client",
          receiver: "https://wallet.example.com/server/incoming-payments/abc123",
          method: "ilp",
        }),
      );
    });

    it("should create outgoing payment using quote id", async () => {
      setupHappyPath();
      await client.createPaymentPayload(2, makeRequirements());
      expect(mockOpenPaymentsClient.outgoingPayment.create).toHaveBeenCalledWith(
        { url: "https://client-resource.example.com", accessToken: "initial-grant-token" },
        expect.objectContaining({
          walletAddress: "https://wallet.example.com/client",
          quoteId: "https://client-resource.example.com/quotes/q1",
        }),
      );
    });

    it("should poll for COMPLETED status before returning", async () => {
      setupHappyPath();
      await client.createPaymentPayload(2, makeRequirements());
      // get called twice: once PENDING, once COMPLETED
      expect(mockOpenPaymentsClient.incomingPayment.get).toHaveBeenCalledTimes(2);
    });

    it("should throw when incoming payment response has no id", async () => {
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(makeWalletDiscoveryResponse())
        .mockResolvedValueOnce(makeClientWalletDiscoveryResponse());
      mockOpenPaymentsClient.incomingPayment.create.mockResolvedValue({});

      await expect(client.createPaymentPayload(2, makeRequirements())).rejects.toThrow(
        "Incoming payment response missing id",
      );
    });

    it("should throw when quote response has no id or url", async () => {
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(makeWalletDiscoveryResponse())
        .mockResolvedValueOnce(makeClientWalletDiscoveryResponse());
      mockOpenPaymentsClient.incomingPayment.create.mockResolvedValue({
        id: "https://wallet.example.com/server/incoming-payments/abc123",
      });
      mockOpenPaymentsClient.quote.create.mockResolvedValue({});

      await expect(client.createPaymentPayload(2, makeRequirements())).rejects.toThrow(
        "Quote response missing id/url",
      );
    });

    it("should continue polling after a transient network error during poll", async () => {
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(makeWalletDiscoveryResponse())
        .mockResolvedValueOnce(makeClientWalletDiscoveryResponse());
      mockOpenPaymentsClient.incomingPayment.create.mockResolvedValue({
        id: "https://wallet.example.com/server/incoming-payments/abc123",
      });
      mockOpenPaymentsClient.quote.create.mockResolvedValue({ id: "q1" });
      mockOpenPaymentsClient.outgoingPayment.create.mockResolvedValue({ id: "op1" });
      // First poll: network error; second poll: completed
      mockOpenPaymentsClient.incomingPayment.get
        .mockRejectedValueOnce(new Error("socket hang up"))
        .mockResolvedValueOnce({ completed: true });

      const result = await client.createPaymentPayload(2, makeRequirements());
      expect(result.payload).toEqual({
        incomingPaymentUrl: "https://wallet.example.com/server/incoming-payments/abc123",
      });
      expect(mockOpenPaymentsClient.incomingPayment.get).toHaveBeenCalledTimes(2);
    });

    it("should stop polling and throw on a 4xx error during poll", async () => {
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(makeWalletDiscoveryResponse())
        .mockResolvedValueOnce(makeClientWalletDiscoveryResponse());
      mockOpenPaymentsClient.incomingPayment.create.mockResolvedValue({
        id: "https://wallet.example.com/server/incoming-payments/abc123",
      });
      mockOpenPaymentsClient.quote.create.mockResolvedValue({ id: "q1" });
      mockOpenPaymentsClient.outgoingPayment.create.mockResolvedValue({ id: "op1" });
      mockOpenPaymentsClient.incomingPayment.get.mockRejectedValue(
        new OpenPaymentsClientError("Unauthorized", { description: "Unauthorized", status: 401 }),
      );

      await expect(client.createPaymentPayload(2, makeRequirements())).rejects.toThrow(
        "Unauthorized",
      );
      expect(mockOpenPaymentsClient.incomingPayment.get).toHaveBeenCalledTimes(1);
    });

    it("should throw when payment does not complete within maxTimeoutSeconds", async () => {
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(makeWalletDiscoveryResponse())
        .mockResolvedValueOnce(makeClientWalletDiscoveryResponse());
      mockOpenPaymentsClient.incomingPayment.create.mockResolvedValue({
        id: "https://wallet.example.com/server/incoming-payments/abc123",
      });
      mockOpenPaymentsClient.quote.create.mockResolvedValue({ id: "q1" });
      mockOpenPaymentsClient.outgoingPayment.create.mockResolvedValue({});
      mockOpenPaymentsClient.incomingPayment.get.mockResolvedValue({ completed: false });

      await expect(
        client.createPaymentPayload(2, makeRequirements({ maxTimeoutSeconds: 0.05 })),
      ).rejects.toThrow("Condition not met within");
    });

    it("should throw when assetScale is missing from requirements", async () => {
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(makeWalletDiscoveryResponse())
        .mockResolvedValueOnce(makeClientWalletDiscoveryResponse());
      mockOpenPaymentsClient.incomingPayment.create.mockResolvedValue({
        id: "https://wallet.example.com/server/incoming-payments/abc123",
      });

      await expect(client.createPaymentPayload(2, makeRequirements({ extra: {} }))).rejects.toThrow(
        "assetScale is missing from payment requirements",
      );
    });

    it("should throw when auth server requires interactive grant", async () => {
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(makeWalletDiscoveryResponse())
        .mockResolvedValueOnce(makeClientWalletDiscoveryResponse());
      // Simulate a pending (interactive) grant response
      mockOpenPaymentsClient.grant.request.mockResolvedValue({
        interact: { redirect: "https://auth.example.com/interact/123" },
        continue: { uri: "https://auth.example.com/continue", wait: 5 },
      });

      await expect(client.createPaymentPayload(2, makeRequirements())).rejects.toThrow(
        "requires interactive grant",
      );
    });

    describe("token rotation on outgoing payment 401/403", () => {
      it("should rotate token and retry outgoing payment on 401", async () => {
        vi.mocked(global.fetch)
          .mockResolvedValueOnce(makeWalletDiscoveryResponse())
          .mockResolvedValueOnce(makeClientWalletDiscoveryResponse());
        mockOpenPaymentsClient.incomingPayment.create.mockResolvedValue({
          id: "https://wallet.example.com/server/incoming-payments/abc",
        });
        mockOpenPaymentsClient.quote.create.mockResolvedValue({ id: "q1" });

        const authError = new OpenPaymentsClientError("Unauthorized", {
          description: "Unauthorized",
          status: 401,
        });
        mockOpenPaymentsClient.outgoingPayment.create
          .mockRejectedValueOnce(authError)
          .mockResolvedValueOnce({ id: "op1" });
        mockOpenPaymentsClient.token.rotate.mockResolvedValue({
          access_token: { value: "rotated-token", manage: "https://auth.example.com/manage" },
        });
        mockOpenPaymentsClient.incomingPayment.get.mockResolvedValue({ completed: true });

        await client.createPaymentPayload(2, makeRequirements());
        expect(mockOpenPaymentsClient.token.rotate).toHaveBeenCalledTimes(1);
        expect(mockOpenPaymentsClient.outgoingPayment.create).toHaveBeenCalledTimes(2);
      });

      it("should rotate token and retry outgoing payment on 403", async () => {
        vi.mocked(global.fetch)
          .mockResolvedValueOnce(makeWalletDiscoveryResponse())
          .mockResolvedValueOnce(makeClientWalletDiscoveryResponse());
        mockOpenPaymentsClient.incomingPayment.create.mockResolvedValue({
          id: "https://wallet.example.com/server/incoming-payments/abc",
        });
        mockOpenPaymentsClient.quote.create.mockResolvedValue({ id: "q1" });

        const authError = new OpenPaymentsClientError("Forbidden", {
          description: "Forbidden",
          status: 403,
        });
        mockOpenPaymentsClient.outgoingPayment.create
          .mockRejectedValueOnce(authError)
          .mockResolvedValueOnce({ id: "op1" });
        mockOpenPaymentsClient.token.rotate.mockResolvedValue({
          access_token: { value: "rotated-token", manage: "https://auth.example.com/manage" },
        });
        mockOpenPaymentsClient.incomingPayment.get.mockResolvedValue({ completed: true });

        await client.createPaymentPayload(2, makeRequirements());
        expect(mockOpenPaymentsClient.token.rotate).toHaveBeenCalledTimes(1);
        expect(mockOpenPaymentsClient.outgoingPayment.create).toHaveBeenCalledTimes(2);
      });
    });

    it("should skip token rotation when no grantTokenManageUrl is set", async () => {
      client = new ExactOpenPaymentsScheme(makeConfig({ grantTokenManageUrl: undefined }));
      (client as any).openPaymentsClient = mockOpenPaymentsClient;
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(makeWalletDiscoveryResponse())
        .mockResolvedValueOnce(makeClientWalletDiscoveryResponse());

      mockOpenPaymentsClient.incomingPayment.create.mockResolvedValue({
        id: "https://wallet.example.com/server/incoming-payments/abc",
      });
      mockOpenPaymentsClient.quote.create.mockResolvedValue({ id: "q1" });

      const authError = new OpenPaymentsClientError("Unauthorized", {
        description: "Unauthorized",
        status: 401,
      });
      mockOpenPaymentsClient.outgoingPayment.create.mockRejectedValue(authError);

      // Without a manage URL, the auth error is re-thrown immediately without a retry
      await expect(client.createPaymentPayload(2, makeRequirements())).rejects.toThrow(
        "Unauthorized",
      );
      expect(mockOpenPaymentsClient.outgoingPayment.create).toHaveBeenCalledTimes(1);
      expect(mockOpenPaymentsClient.token.rotate).not.toHaveBeenCalled();
    });
  });
});
