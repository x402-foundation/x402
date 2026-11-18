import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { getEvmPaywallHtml } from "./evm/paywall";
import { getSvmPaywallHtml } from "./svm/paywall";
import { getAvmPaywallHtml } from "./avm/paywall";
import { getEvmTemplate } from "./evm/template-loader";
import { getSvmTemplate } from "./svm/template-loader";
import { getAvmTemplate } from "./avm/template-loader";
import { EVM_PAYWALL_TEMPLATE } from "./evm/gen/template";
import { SVM_PAYWALL_TEMPLATE } from "./svm/gen/template";
import { AVM_PAYWALL_TEMPLATE } from "./avm/gen/template";
import { ALGORAND_NETWORK_REFS, SOLANA_NETWORK_REFS } from "./paywallUtils";

type PaywallOptions = Parameters<typeof getSvmPaywallHtml>[0];

const baseOptions: PaywallOptions = {
  amount: 0.1,
  testnet: false,
  currentUrl: "https://example.com/premium/content",
  paymentRequired: {
    x402Version: 2,
    resource: {
      url: "https://example.com/premium/content",
      description: "Premium content",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        amount: "100000",
        payTo: "0x1111111111111111111111111111111111111111",
        maxTimeoutSeconds: 60,
      },
    ],
  },
};

const inputCases: {
  name: string;
  options: (baseOptions: PaywallOptions, value: string) => PaywallOptions;
}[] = [
  {
    name: "paymentRequired.resource.url",
    options: (baseOptions, value) => ({
      ...baseOptions,
      paymentRequired: {
        ...baseOptions.paymentRequired,
        resource: { url: `https://example.com/premium/content?test=${value}` },
      },
    }),
  },
  {
    name: "paymentRequired.resource.description",
    options: (baseOptions, value) => ({
      ...baseOptions,
      paymentRequired: {
        ...baseOptions.paymentRequired,
        resource: { url: baseOptions.currentUrl, description: value },
      },
    }),
  },
  {
    name: "currentUrl",
    options: (baseOptions, value) => ({ ...baseOptions, currentUrl: value }),
  },
  {
    name: "appName",
    options: (baseOptions, value) => ({ ...baseOptions, appName: value }),
  },
  {
    name: "appLogo",
    options: (baseOptions, value) => ({ ...baseOptions, appLogo: value }),
  },
  {
    name: "faucetUrls value",
    options: (baseOptions, value) => ({
      ...baseOptions,
      faucetUrls: { [baseOptions.paymentRequired.accepts[0].network]: value },
    }),
  },
  {
    name: "faucetUrls key",
    options: (baseOptions, value) => ({
      ...baseOptions,
      faucetUrls: { [value]: "https://faucet.circle.com/" },
    }),
  },
];

// The shared test setup supplies an HTML template with no scripts of its own.
// Inspect the HTML boundary before evaluating JavaScript: evaluating the entire
// config directly would miss a closing script tag inside a JavaScript string.
function readConfig(html: string, template?: string): PaywallOptions {
  if (template) {
    const insertionOffset = template.indexOf("</head>");
    expect(insertionOffset).toBeGreaterThanOrEqual(0);
    const suffix = template.slice(insertionOffset);
    expect(html.startsWith(template.slice(0, insertionOffset))).toBe(true);
    expect(html.endsWith(suffix)).toBe(true);
    // Exclude the shipped wallet application; only execute the inserted config.
    html = html.slice(insertionOffset, html.length - suffix.length);
  }

  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script\s*>/gi)];
  expect(scripts).toHaveLength(1);
  expect(html.match(/<\/script\s*>/gi)).toHaveLength(1);

  const context: { window: { x402?: PaywallOptions } } = { window: {} };
  runInNewContext(scripts[0][1], context, { timeout: 1000 });
  expect(context.window.x402).toBeDefined();
  return context.window.x402!;
}

const paywallCases = [
  {
    name: "EVM",
    generateHtml: getEvmPaywallHtml,
    getTemplate: getEvmTemplate,
    template: EVM_PAYWALL_TEMPLATE,
    requirement: baseOptions.paymentRequired.accepts[0],
  },
  {
    name: "SVM",
    generateHtml: getSvmPaywallHtml,
    getTemplate: getSvmTemplate,
    template: SVM_PAYWALL_TEMPLATE,
    requirement: {
      ...baseOptions.paymentRequired.accepts[0],
      network: `solana:${SOLANA_NETWORK_REFS.MAINNET}`,
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      payTo: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHEBg4",
    },
  },
  {
    name: "AVM",
    generateHtml: getAvmPaywallHtml,
    getTemplate: getAvmTemplate,
    template: AVM_PAYWALL_TEMPLATE,
    requirement: {
      ...baseOptions.paymentRequired.accepts[0],
      network: `algorand:${ALGORAND_NETWORK_REFS.TESTNET}`,
      asset: "0",
      payTo: "TESTNETADDRESS",
    },
  },
];

describe.each(paywallCases)(
  "$name paywall inline script safety",
  ({ generateHtml, getTemplate, template, requirement }) => {
    const networkOptions: PaywallOptions = {
      ...baseOptions,
      paymentRequired: { ...baseOptions.paymentRequired, accepts: [requirement] },
    };

    describe.each(inputCases)("$name", ({ options }) => {
      it.each(["</script>", "</ScRiPt >"])(
        "keeps a %s breakout payload inside configuration data",
        closingTag => {
          const payload = `${closingTag}<script>window.__x402Injected = true</script>`;
          const input = options(networkOptions, payload);
          const html = generateHtml(input);

          expect(readConfig(html)).toMatchObject(input);
        },
      );

      it("preserves quotes, backslashes, whitespace, Unicode, and angle brackets", () => {
        const input = options(
          networkOptions,
          "App \"name\" 'quoted' \\ path\n\r\t日本語 <logo> & logo",
        );

        expect(readConfig(generateHtml(input))).toMatchObject(input);
      });

      it.each(["$'", "$$", "$&", "$`"])("preserves literal %s with the shipped template", token => {
        const input = options(networkOptions, `Store ${token} Specials`);
        vi.mocked(getTemplate).mockReturnValueOnce(template);

        expect(readConfig(generateHtml(input), template)).toMatchObject(input);
      });
    });

    it("initializes configuration with the shipped template", () => {
      vi.mocked(getTemplate).mockReturnValueOnce(template);

      expect(readConfig(generateHtml(networkOptions), template)).toMatchObject(networkOptions);
    });

    it("keeps omitted faucet URLs undefined and optional metadata empty", () => {
      const config = readConfig(generateHtml(networkOptions));

      expect(config.faucetUrls).toBeUndefined();
      expect(config.appName).toBe("");
      expect(config.appLogo).toBe("");
    });
  },
);

describe("SVM paywall RPC URL script safety", () => {
  const svmOptions: PaywallOptions = {
    ...baseOptions,
    paymentRequired: {
      ...baseOptions.paymentRequired,
      accepts: [paywallCases[1].requirement],
    },
  };

  it.each(["</script>", "</ScRiPt >"])(
    "keeps a %s breakout payload in RPC URL keys and values inside configuration data",
    closingTag => {
      const payload = `${closingTag}<script>window.__x402Injected = true</script>`;
      const input: PaywallOptions = {
        ...svmOptions,
        rpcUrls: { [payload]: payload, [svmOptions.paymentRequired.accepts[0].network]: payload },
      };

      expect(readConfig(getSvmPaywallHtml(input))).toMatchObject(input);
    },
  );

  it("preserves quotes, backslashes, whitespace, Unicode, and angle brackets in RPC URLs", () => {
    const input: PaywallOptions = {
      ...svmOptions,
      rpcUrls: {
        [svmOptions.paymentRequired.accepts[0].network]:
          'https://rpc.example/?key="quoted"&path=\\\n\r\t日本語<rpc>',
      },
    };

    expect(readConfig(getSvmPaywallHtml(input))).toMatchObject(input);
  });

  it("keeps omitted RPC URLs undefined", () => {
    expect(readConfig(getSvmPaywallHtml(svmOptions)).rpcUrls).toBeUndefined();
  });
});
