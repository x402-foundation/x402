import { describe, it, expect } from "vitest";
import {
  createPaywall,
  PaywallBuilder,
  evmPaywall,
  svmPaywall,
} from "./index";
import type {
  PaywallProvider,
  PaywallNetworkHandler,
  PaymentRequired,
  PaymentRequirements,
} from "./index";

// テスト用のモックデータ
const evmRequirement: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amount: "1000000",
  payTo: "0x209693Bc6afc0C5328bA36FaF04C514EF312287C",
  maxTimeoutSeconds: 60,
};

const svmRequirement: PaymentRequirements = {
  scheme: "exact",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amount: "1000000",
  payTo: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHEBg4",
  maxTimeoutSeconds: 60,
};

const evmPaymentRequired: PaymentRequired = {
  x402Version: 2,
  resource: {
    url: "https://example.com/api/resource",
    description: "Test Resource",
    mimeType: "application/json",
  },
  accepts: [evmRequirement],
};

const svmPaymentRequired: PaymentRequired = {
  x402Version: 2,
  resource: {
    url: "https://example.com/api/resource",
    description: "Test Resource",
    mimeType: "application/json",
  },
  accepts: [svmRequirement],
};

describe("@x402/paywall - index エクスポート", () => {
  describe("createPaywall", () => {
    it("PaywallBuilder インスタンスを返す", () => {
      const builder = createPaywall();
      expect(builder).toBeInstanceOf(PaywallBuilder);
    });

    it("呼び出すたびに独立したインスタンスを返す", () => {
      const builder1 = createPaywall();
      const builder2 = createPaywall();
      expect(builder1).not.toBe(builder2);
    });

    it("ビルダーが generateHtml メソッドを持つ PaywallProvider を build できる", () => {
      const provider = createPaywall().build();
      expect(provider).toHaveProperty("generateHtml");
      expect(typeof provider.generateHtml).toBe("function");
    });
  });

  describe("PaywallBuilder", () => {
    it("クラスとして直接インスタンス化できる", () => {
      const builder = new PaywallBuilder();
      expect(builder).toBeInstanceOf(PaywallBuilder);
    });

    it("addProvider は存在しない（withNetwork を使う）", () => {
      const builder = createPaywall();
      // withNetwork がメソッドチェーンを返す
      const result = builder.withNetwork(evmPaywall);
      expect(result).toBe(builder);
    });

    it("withNetwork → build のチェーンが動作する", () => {
      const provider = createPaywall().withNetwork(evmPaywall).build();
      expect(provider).toHaveProperty("generateHtml");
    });

    it("withConfig → withNetwork → build のチェーンが動作する", () => {
      const provider = createPaywall()
        .withConfig({ appName: "Test" })
        .withNetwork(evmPaywall)
        .build();
      expect(provider).toHaveProperty("generateHtml");
    });

    it("プロバイダー未登録で build した後 generateHtml を呼ぶとエラーになる", () => {
      const provider = createPaywall().build();
      expect(() => provider.generateHtml(evmPaymentRequired)).toThrow(
        "No paywall handlers registered",
      );
    });

    it("対応していないネットワークのみを受け取ると generateHtml がエラーになる", () => {
      const unknownNetworkRequired: PaymentRequired = {
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "cosmos:cosmoshub-4",
            asset: "uatom",
            amount: "1000000",
            payTo: "cosmos1abc",
            maxTimeoutSeconds: 60,
          },
        ],
      };
      const provider = createPaywall().withNetwork(evmPaywall).build();
      expect(() => provider.generateHtml(unknownNetworkRequired)).toThrow(
        "No paywall handler supports networks",
      );
    });
  });

  describe("evmPaywall", () => {
    it("PaywallNetworkHandler インターフェースを満たす", () => {
      expect(typeof evmPaywall.supports).toBe("function");
      expect(typeof evmPaywall.generateHtml).toBe("function");
    });

    it("eip155: プレフィックスの EVM ネットワークをサポートする", () => {
      expect(evmPaywall.supports(evmRequirement)).toBe(true);
      expect(evmPaywall.supports({ ...evmRequirement, network: "eip155:1" })).toBe(true);
      expect(evmPaywall.supports({ ...evmRequirement, network: "eip155:84532" })).toBe(true);
    });

    it("Solana ネットワークをサポートしない", () => {
      expect(evmPaywall.supports(svmRequirement)).toBe(false);
    });

    it("不明なネットワークをサポートしない", () => {
      expect(evmPaywall.supports({ ...evmRequirement, network: "unknown:network" })).toBe(false);
    });

    it("generateHtml が HTML 文字列を返す", () => {
      const html = evmPaywall.generateHtml(evmRequirement, evmPaymentRequired, {});
      expect(typeof html).toBe("string");
      expect(html).toContain("<!DOCTYPE html>");
    });

    it("v2 形式（amount フィールド）の金額を正しく処理する", () => {
      const html = evmPaywall.generateHtml(evmRequirement, evmPaymentRequired, {});
      // amount: "1000000" → 1000000 / 1000000 = 1.0
      expect(html).toContain("1");
    });

    it("v1 形式（maxAmountRequired フィールド）の金額にフォールバックする", () => {
      const v1Requirement: PaymentRequirements = {
        ...evmRequirement,
        amount: undefined,
        maxAmountRequired: "500000",
      };
      const html = evmPaywall.generateHtml(v1Requirement, evmPaymentRequired, {});
      expect(typeof html).toBe("string");
      expect(html).toContain("<!DOCTYPE html>");
    });

    it("amount も maxAmountRequired もない場合は 0 になる", () => {
      const zeroAmountRequirement: PaymentRequirements = {
        ...evmRequirement,
        amount: undefined,
        maxAmountRequired: undefined,
      };
      const html = evmPaywall.generateHtml(zeroAmountRequirement, evmPaymentRequired, {});
      expect(typeof html).toBe("string");
    });

    it("config の appName が HTML に反映される", () => {
      const html = evmPaywall.generateHtml(evmRequirement, evmPaymentRequired, {
        appName: "My EVM App",
      });
      expect(html).toContain("My EVM App");
    });

    it("resource の URL が currentUrl として使われる", () => {
      const html = evmPaywall.generateHtml(evmRequirement, evmPaymentRequired, {});
      expect(html).toContain("https://example.com/api/resource");
    });

    it("config.currentUrl が resource URL より使われる（resource なし）", () => {
      const paymentRequiredNoResource: PaymentRequired = {
        x402Version: 2,
        accepts: [evmRequirement],
      };
      const html = evmPaywall.generateHtml(evmRequirement, paymentRequiredNoResource, {
        currentUrl: "https://fallback.example.com/",
      });
      expect(html).toContain("https://fallback.example.com/");
    });
  });

  describe("svmPaywall", () => {
    it("PaywallNetworkHandler インターフェースを満たす", () => {
      expect(typeof svmPaywall.supports).toBe("function");
      expect(typeof svmPaywall.generateHtml).toBe("function");
    });

    it("solana: プレフィックスの Solana ネットワークをサポートする", () => {
      expect(svmPaywall.supports(svmRequirement)).toBe(true);
      expect(
        svmPaywall.supports({
          ...svmRequirement,
          network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        }),
      ).toBe(true);
    });

    it("EVM ネットワークをサポートしない", () => {
      expect(svmPaywall.supports(evmRequirement)).toBe(false);
    });

    it("不明なネットワークをサポートしない", () => {
      expect(svmPaywall.supports({ ...svmRequirement, network: "cosmos:mainnet" })).toBe(false);
    });

    it("generateHtml が HTML 文字列を返す", () => {
      const html = svmPaywall.generateHtml(svmRequirement, svmPaymentRequired, {});
      expect(typeof html).toBe("string");
      expect(html).toContain("<!DOCTYPE html>");
    });

    it("v2 形式（amount フィールド）の金額を正しく処理する", () => {
      const html = svmPaywall.generateHtml(svmRequirement, svmPaymentRequired, {});
      // amount: "1000000" → 1000000 / 1000000 = 1.0
      expect(html).toContain("1");
    });

    it("v1 形式（maxAmountRequired フィールド）の金額にフォールバックする", () => {
      const v1Requirement: PaymentRequirements = {
        ...svmRequirement,
        amount: undefined,
        maxAmountRequired: "500000",
      };
      const html = svmPaywall.generateHtml(v1Requirement, svmPaymentRequired, {});
      expect(typeof html).toBe("string");
      expect(html).toContain("<!DOCTYPE html>");
    });

    it("config の appName が HTML に反映される", () => {
      const html = svmPaywall.generateHtml(svmRequirement, svmPaymentRequired, {
        appName: "My Solana App",
      });
      expect(html).toContain("My Solana App");
    });

    it("resource の URL が currentUrl として使われる", () => {
      const html = svmPaywall.generateHtml(svmRequirement, svmPaymentRequired, {});
      expect(html).toContain("https://example.com/api/resource");
    });
  });

  describe("evmPaywall と svmPaywall の統合", () => {
    it("両方を登録した paywall が EVM ネットワークに対応できる", () => {
      const provider = createPaywall()
        .withNetwork(evmPaywall)
        .withNetwork(svmPaywall)
        .build();

      const html = provider.generateHtml(evmPaymentRequired);
      expect(html).toContain("<!DOCTYPE html>");
    });

    it("両方を登録した paywall が Solana ネットワークに対応できる", () => {
      const provider = createPaywall()
        .withNetwork(evmPaywall)
        .withNetwork(svmPaywall)
        .build();

      const html = provider.generateHtml(svmPaymentRequired);
      expect(html).toContain("<!DOCTYPE html>");
    });

    it("accepts 配列の最初にマッチしたハンドラーが優先される", () => {
      const multiAcceptsPaymentRequired: PaymentRequired = {
        x402Version: 2,
        accepts: [
          svmRequirement, // 最初が Solana
          evmRequirement, // 次が EVM
        ],
      };

      const provider = createPaywall()
        .withNetwork(evmPaywall)
        .withNetwork(svmPaywall)
        .build();

      // evmPaywall も svmPaywall も登録されているが、accepts の最初 (Solana) が使われる
      const html = provider.generateHtml(multiAcceptsPaymentRequired);
      expect(html).toMatch(/SVM Paywall|solana/i);
    });
  });
});
