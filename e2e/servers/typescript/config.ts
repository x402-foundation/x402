import { ExactAvmScheme } from "@x402/avm/exact/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { UptoSvmScheme } from "@x402/svm/upto/server";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { ExactAptosScheme } from "@x402/aptos/exact/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { ExactKeetaScheme } from "@x402/keeta/exact/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { ExactTvmScheme } from "@x402/tvm/exact/server";
import { ExactNearScheme } from "@x402/near/exact/server";
import { ExactXrplScheme } from "@x402/xrpl/exact/server";
import { ExactConcordiumScheme } from "@x402/concordium/exact/server";
import { ExactCardanoScheme } from "@x402/cardano/exact/server";
import {
  buildSignedTerms,
  computeTermsDigest,
  InMemoryMasumiTermsStorage,
  issueMasumiRequirements,
  toMasumiSellerSigner,
} from "@x402/cardano";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  declareEip2612GasSponsoringExtension,
  declareErc20ApprovalGasSponsoringExtension,
} from "@x402/extensions";
import { HTTPFacilitatorClient, type RoutesConfig, type x402ResourceServer } from "@x402/core/server";
import { decodePaymentSignatureHeader, type HTTPRequestContext } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { privateKeyToAccount } from "viem/accounts";
import type { Caip2Network, ServerEnvConfig } from "../../src/server-env";
import {
  getServerAddress,
  isFamilyConfigured,
} from "../../src/server-env";
import {
  PROTOCOL_FAMILIES,
  type ProtocolFamily,
} from "../../src/networks/networks";
import { resolvedRoutes, type ResolvedRoute } from "./catalog";
import {
  networkCaip2Pattern,
  routeDiscoveryOutput,
  mcpToolName,
  type RouteTransport,
} from "../../src/mechanisms";

export type { Caip2Network, ServerEnvConfig } from "../../src/server-env";
export { loadServerEnv } from "../../src/server-env";

/**
 * Cardano settles on ~20-second blocks, so its `settle()` cannot finish inside
 * the 30s facilitator-client default. Fast chains still return as soon as done.
 */
const FACILITATOR_TIMEOUT_MS = 180_000;

/**
 * Builds facilitator clients from FACILITATOR_URL (+ optional MOCK_FACILITATOR_URL).
 */
export function createFacilitatorClients(facilitatorUrl: string): HTTPFacilitatorClient[] {
  const facilitatorClients = [
    new HTTPFacilitatorClient({ url: facilitatorUrl, timeoutMs: FACILITATOR_TIMEOUT_MS }),
  ];
  const mockFacilitatorUrl = process.env.MOCK_FACILITATOR_URL;
  if (mockFacilitatorUrl) {
    facilitatorClients.push(
      new HTTPFacilitatorClient({ url: mockFacilitatorUrl, timeoutMs: FACILITATOR_TIMEOUT_MS }),
    );
  }
  return facilitatorClients;
}

/** Register schemes for one configured family. */
async function registerFamilySchemes(
  server: x402ResourceServer,
  family: ProtocolFamily,
  cfg: ServerEnvConfig,
): Promise<void> {
  const pattern = networkCaip2Pattern(family);

  switch (family) {
    case "avm":
      server.register(pattern, new ExactAvmScheme());
      return;
    case "ccd":
      server.register(pattern, new ExactConcordiumScheme());
      return;
    case "cardano":
      server.register(pattern, new ExactCardanoScheme({ masumiStorage: cardanoMasumiStorage }));
      return;
    case "evm": {
      server.register(pattern, new ExactEvmScheme());
      server.register(pattern, new UptoEvmScheme());
      const receiverAuthorizerPrivateKey = process.env.SERVER_EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY as
        | `0x${string}`
        | undefined;
      const receiverAuthorizerSigner = receiverAuthorizerPrivateKey
        ? privateKeyToAccount(receiverAuthorizerPrivateKey)
        : undefined;
      const payTo = getServerAddress(cfg, "evm") as `0x${string}`;
      server.register(
        pattern,
        new BatchSettlementEvmScheme(payTo, {
          ...(receiverAuthorizerSigner ? { receiverAuthorizerSigner } : {}),
        }),
      );
      return;
    }
    case "svm": {
      server.register(pattern, new ExactSvmScheme());
      const receiverAuthorizerPrivateKey = process.env.SERVER_SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY;
      if (receiverAuthorizerPrivateKey) {
        const receiverAuthorizerSigner = await createKeyPairSignerFromBytes(
          base58.decode(receiverAuthorizerPrivateKey),
        );
        console.info(`SVM receiver authorizer: ${receiverAuthorizerSigner.address}`);
        server.register(
          pattern,
          new UptoSvmScheme({
            receiverAuthorizerSigner,
            rpcUrl: process.env.SVM_RPC_URL,
          }),
        );
      }
      return;
    }
    case "aptos":
      server.register(pattern, new ExactAptosScheme());
      return;
    case "hedera":
      server.register(pattern, new ExactHederaScheme());
      return;
    case "keeta":
      server.register(pattern, new ExactKeetaScheme());
      return;
    case "stellar":
      server.register(pattern, new ExactStellarScheme());
      return;
    case "tvm":
      server.register(pattern, new ExactTvmScheme());
      return;
    case "near":
      server.register(pattern, new ExactNearScheme());
      return;
    case "xrpl":
      server.register(pattern, new ExactXrplScheme());
      return;
  }
}

/**
 * Registers e2e schemes + bazaar extension for every family with a payee address
 * configured (catalog-driven via {@link isFamilyConfigured}).
 */
export async function configureResourceServer(server: x402ResourceServer, cfg: ServerEnvConfig): Promise<void> {
  for (const family of PROTOCOL_FAMILIES) {
    if (isFamilyConfigured(cfg, family)) {
      await registerFamilySchemes(server, family, cfg);
    }
  }

  server.registerExtension(bazaarResourceServerExtension);
}

/**
 * Maps a catalog extension id to the SDK call that declares it on a route.
 * Declaration comes from mechanisms JSON `extensions` per route; process-level
 * registration (e.g. {@link configureResourceServer}'s bazaar handler) is
 * separate and enables enriching/honoring those declarations.
 */
function declareExtension(
  id: string,
  route: ResolvedRoute,
  transport: RouteTransport = "http",
): Record<string, unknown> {
  switch (id) {
    case "bazaar":
      return transport === "mcp"
        ? declareDiscoveryExtension({
          toolName: mcpToolName(route.path),
          transport: "sse",
          inputSchema: { type: "object", properties: {} },
          output: routeDiscoveryOutput(),
        })
        : declareDiscoveryExtension({ output: routeDiscoveryOutput() });
    case "eip2612GasSponsoring":
      return declareEip2612GasSponsoringExtension();
    case "erc20ApprovalGasSponsoring":
      return declareErc20ApprovalGasSponsoringExtension();
    default:
      throw new Error(`Route ${route.path} declares unknown extension "${id}"`);
  }
}

// How long a Cardano Masumi payment stays valid. The client anchors the tx TTL to
// pay_by_time and the facilitator refuses a TTL further ahead than maxTimeoutSeconds.
const CARDANO_MASUMI_MAX_TIMEOUT_SECONDS = 600;
// Settle on the facilitator's own broadcast acceptance (-1). Waiting for block
// inclusion would hold the HTTP response open for a whole ~20s Cardano block;
// the harness still waits for real inclusion between scenarios, so the payment
// is on chain before the next one reuses the payer wallet.
const CARDANO_MASUMI_CONFIRMATION_POLICY = { l1Confirmations: -1 };
// The seller signs the Masumi terms with its selling wallet; the escrow pays that
// address. A real deployment MUST set SERVER_CARDANO_SELLER_MNEMONIC — the
// well-known test phrase only keeps the e2e self-contained. It needs no funds.
const CARDANO_TEST_SELLER_MNEMONIC = "test test test test test test test test test test test junk";

/** Catalog paths of the Cardano routes, one per `assetTransferMethod`. */
const CARDANO_DEFAULT_ROUTE = "/exact/cardano/default";
const CARDANO_MASUMI_ROUTE = "/exact/cardano/masumi";
const CARDANO_SCRIPT_ROUTE = "/exact/cardano/script";
/**
 * Always-succeeds Plutus V3 validator and the enterprise script address it
 * hashes to (see the cardano package's scriptAddress tests for the derivation).
 */
const CARDANO_SCRIPT_CODE = "4d01000033222220051200120011";
const CARDANO_SCRIPT_ADDRESS = "addr_test1wp8l7eylksmjas7ypzm0q35dwnjdxxvsfn0z0lflqzgs55stpd682";
/**
 * Scheme-specific `extra` per Cardano route. These are Cardano payload
 * semantics rather than catalog data, so they live with the scheme
 * registration instead of widening the shared mechanisms catalog.
 */
const CARDANO_ROUTE_EXTRA: Record<string, Record<string, unknown>> = {
  [CARDANO_DEFAULT_ROUTE]: { confirmationPolicy: CARDANO_MASUMI_CONFIRMATION_POLICY },
  [CARDANO_SCRIPT_ROUTE]: {
    assetTransferMethod: "script",
    confirmationPolicy: CARDANO_MASUMI_CONFIRMATION_POLICY,
    script: { type: "plutusV3", code: CARDANO_SCRIPT_CODE },
    // Optional inline datum (CBOR hex) attached to the payTo output; the
    // always-succeeds validator ignores it. `d8799f182aff` = Constr 0 [42].
    datum: "d8799f182aff",
  },
};

/**
 * Quote store shared by the Cardano scheme and the Masumi route below.
 *
 * `ExactCardanoScheme` persists every Masumi 402 it serves here, keyed by
 * `termsDigest`, and refuses a paid retry that does not present that exact
 * quote. The route reads the same store so a buyer's retry is answered with the
 * offer it was issued, even when another buyer was quoted in between.
 */
const cardanoMasumiStorage = new InMemoryMasumiTermsStorage();

const cardanoMasumiSellers = new Map<string, ReturnType<typeof toMasumiSellerSigner>>();

/** The seller signer for one Cardano network, created once per process. */
function cardanoMasumiSeller(network: string): ReturnType<typeof toMasumiSellerSigner> {
  let seller = cardanoMasumiSellers.get(network);
  if (!seller) {
    seller = toMasumiSellerSigner({
      mnemonic: process.env.SERVER_CARDANO_SELLER_MNEMONIC || CARDANO_TEST_SELLER_MNEMONIC,
      network,
    });
    cardanoMasumiSellers.set(network, seller);
  }
  return seller;
}

/** The quote a paid request presents, when this server still remembers issuing it. */
async function quotedMasumiOffer(paymentHeader: string): Promise<PaymentRequirements | undefined> {
  try {
    const accepted = decodePaymentSignatureHeader(paymentHeader).accepted as PaymentRequirements;
    const digest = computeTermsDigest(
      buildSignedTerms(accepted.extra as never, accepted),
    );
    return (await cardanoMasumiStorage.get(digest))?.requirements;
  } catch {
    return undefined;
  }
}

/**
 * Route `accepts` for the Cardano Masumi escrow route.
 *
 * A spec-conformant Masumi 402 carries a request commitment and a seller
 * signature over `termsDigest`, so it must be issued rather than hand-written,
 * and every unpaid request gets a fresh one. A paid retry is answered with the
 * quote the scheme recorded for it, so concurrent buyers never swap offers.
 */
function cardanoMasumiAccepts(route: ResolvedRoute): Record<string, unknown> {
  if (typeof route.price === "string") {
    throw new Error(`Route ${route.path}: Masumi requires an amount/asset price`);
  }
  const { amount, asset } = route.price;

  const issue = (): Promise<PaymentRequirements> => {
    const seller = cardanoMasumiSeller(route.network);
    const payByMs = Date.now() + CARDANO_MASUMI_MAX_TIMEOUT_SECONDS * 1000;
    return issueMasumiRequirements({
      network: route.network,
      asset,
      amount,
      maxTimeoutSeconds: CARDANO_MASUMI_MAX_TIMEOUT_SECONDS,
      sellerAddress: seller.sellerAddress,
      signTerms: seller.signTerms,
      commitment: [
        {
          name: "parameters",
          canonicalization: "jcs",
          mediaType: "application/json",
          content: { endpoint: route.path },
        },
      ],
      // Each deadline clears its spec minimum by 5 minutes rather than landing
      // exactly on it (pay_by + 5min <= submit_result, +15min <= unlock, +15min <= dispute).
      payByTime: payByMs.toString(),
      submitResultTime: (payByMs + 10 * 60_000).toString(),
      unlockTime: (payByMs + 30 * 60_000).toString(),
      externalDisputeUnlockTime: (payByMs + 50 * 60_000).toString(),
      settlementPolicy: "l1",
      confirmationPolicy: CARDANO_MASUMI_CONFIRMATION_POLICY,
    });
  };

  // payTo and price resolve from the same request context object, so the first
  // resolver decides the offer for that request and the second reuses it.
  const perRequest = new WeakMap<object, Promise<PaymentRequirements>>();
  const current = (context?: HTTPRequestContext): Promise<PaymentRequirements> => {
    const resolve = async (): Promise<PaymentRequirements> =>
      (context?.paymentHeader ? await quotedMasumiOffer(context.paymentHeader) : undefined) ??
      (await issue());
    if (typeof context !== "object" || context === null) {
      return resolve();
    }
    let offer = perRequest.get(context);
    if (!offer) {
      offer = resolve();
      perRequest.set(context, offer);
    }
    return offer;
  };

  return {
    scheme: route.scheme,
    network: route.network as Caip2Network,
    maxTimeoutSeconds: CARDANO_MASUMI_MAX_TIMEOUT_SECONDS,
    payTo: async (context?: HTTPRequestContext) => (await current(context)).payTo,
    price: async (context?: HTTPRequestContext) => {
      const issued = await current(context);
      return { amount: issued.amount, asset: issued.asset, extra: issued.extra };
    },
  };
}

/** Single-route payment config shared by HTTP frameworks, the Next e2e server, and MCP tools. */
export function buildResolvedRouteConfig(
  route: ResolvedRoute,
  transport: RouteTransport = "http",
): Record<string, unknown> {
  const extensions = Object.assign({}, ...route.extensions.map(id => declareExtension(id, route, transport)));

  const cardanoExtra = CARDANO_ROUTE_EXTRA[route.path];
  const accepts =
    route.path === CARDANO_MASUMI_ROUTE
      ? cardanoMasumiAccepts(route)
      : {
          // The script method pays the script address the facilitator
          // reconstructs from the descriptor below, not the server wallet.
          payTo: route.path === CARDANO_SCRIPT_ROUTE ? CARDANO_SCRIPT_ADDRESS : route.payTo,
          scheme: route.scheme,
          network: route.network as Caip2Network,
          price: route.price,
          ...(route.extra || cardanoExtra
            ? { extra: { ...route.extra, ...cardanoExtra } }
            : {}),
        };

  return {
    accepts,
    ...(route.extensions.length > 0 ? { extensions } : {}),
  };
}

/**
 * Payment-middleware route map for the express/hono/fastify e2e servers, derived
 * from config/mechanisms.json. Routes whose network has no payee address
 * configured are omitted by the resolver.
 */
export function buildPaymentRoutes(cfg: ServerEnvConfig): RoutesConfig {
  const routes: Record<string, unknown> = {};

  for (const route of resolvedRoutes(cfg)) {
    routes[`GET ${route.path}`] = buildResolvedRouteConfig(route);
  }

  return routes as RoutesConfig;
}
