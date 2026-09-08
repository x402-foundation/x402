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
import { masumiEscrowAddress, toMasumiSellerSigner } from "@x402/cardano";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  declareEip2612GasSponsoringExtension,
  declareErc20ApprovalGasSponsoringExtension,
} from "@x402/extensions";
import { HTTPFacilitatorClient, type RoutesConfig, type x402ResourceServer } from "@x402/core/server";
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
 * Builds facilitator clients from FACILITATOR_URL (+ optional MOCK_FACILITATOR_URL).
 */
export function createFacilitatorClients(facilitatorUrl: string): HTTPFacilitatorClient[] {
  const facilitatorClients = [new HTTPFacilitatorClient({ url: facilitatorUrl })];
  const mockFacilitatorUrl = process.env.MOCK_FACILITATOR_URL;
  if (mockFacilitatorUrl) {
    facilitatorClients.push(new HTTPFacilitatorClient({ url: mockFacilitatorUrl }));
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
      // The scheme issues Masumi quotes itself: the route only declares the
      // method and the escrow address, and the seller signs per request.
      server.register(
        pattern,
        new ExactCardanoScheme({ masumi: { seller: network => cardanoMasumiSeller(network) } }),
      );
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
 * Confirmation policy for every Cardano route. Unset, the routes carry no
 * policy and get the spec default (one confirmation past inclusion) — what a
 * real deployment gets out of the box, at ~40s per payment on preprod. Set
 * `CARDANO_L1_CONFIRMATIONS` (an integer from -1 to 20; `-1` settles on the
 * facilitator's own broadcast acceptance, and the facilitator only accepts it
 * when the same variable is set) to trade evidence for speed.
 */
function cardanoConfirmationPolicy(): { confirmationPolicy: { l1Confirmations: number } } | undefined {
  const raw = process.env.CARDANO_L1_CONFIRMATIONS?.trim();
  if (!raw) return undefined;
  // Strict decimal form only, so the facilitator's own read of this variable
  // (`=== "-1"` for acceptMempool) agrees with the policy served here.
  if (!/^-?(0|[1-9]\d?)$/.test(raw)) {
    throw new Error(`CARDANO_L1_CONFIRMATIONS must be a plain integer from -1 to 20, got "${raw}"`);
  }
  const l1Confirmations = Number(raw);
  if (l1Confirmations < -1 || l1Confirmations > 20) {
    throw new Error(`CARDANO_L1_CONFIRMATIONS must be an integer from -1 to 20, got "${raw}"`);
  }
  return { confirmationPolicy: { l1Confirmations } };
}

/**
 * Scheme-specific `extra` per Cardano route. These are Cardano payload
 * semantics rather than catalog data, so they live with the scheme
 * registration instead of widening the shared mechanisms catalog. The Masumi
 * route is a *template*: `ExactCardanoScheme` issues the seller-signed quote per
 * 402 and answers the paid retry with the quote it issued.
 */
function cardanoRouteExtra(path: string): Record<string, unknown> | undefined {
  const policy = cardanoConfirmationPolicy();
  switch (path) {
    case CARDANO_DEFAULT_ROUTE:
      return policy;
    case CARDANO_MASUMI_ROUTE:
      return { assetTransferMethod: "masumi", ...policy };
    case CARDANO_SCRIPT_ROUTE:
      return {
        assetTransferMethod: "script",
        ...policy,
        script: { type: "plutusV3", code: CARDANO_SCRIPT_CODE },
        // Optional inline datum (CBOR hex) attached to the payTo output; the
        // always-succeeds validator ignores it. `d8799f182aff` = Constr 0 [42].
        datum: "d8799f182aff",
      };
    default:
      return undefined;
  }
}

/**
 * Where a Cardano route pays. The script method pays the script address the
 * facilitator reconstructs from the descriptor, and the Masumi method pays the
 * escrow the scheme derives for the network — the seller signs it into the
 * quote, so it cannot come from the catalog payee.
 */
function cardanoRoutePayTo(route: ResolvedRoute): string {
  switch (route.path) {
    case CARDANO_SCRIPT_ROUTE:
      return CARDANO_SCRIPT_ADDRESS;
    case CARDANO_MASUMI_ROUTE:
      return masumiEscrowAddress(route.network);
    default:
      return route.payTo;
  }
}

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

/** Single-route payment config shared by HTTP frameworks, the Next e2e server, and MCP tools. */
export function buildResolvedRouteConfig(
  route: ResolvedRoute,
  transport: RouteTransport = "http",
): Record<string, unknown> {
  const extensions = Object.assign({}, ...route.extensions.map(id => declareExtension(id, route, transport)));

  const cardanoExtra = cardanoRouteExtra(route.path);
  const accepts = {
    payTo: cardanoRoutePayTo(route),
    scheme: route.scheme,
    network: route.network as Caip2Network,
    price: route.price,
    ...(route.path === CARDANO_MASUMI_ROUTE
      ? { maxTimeoutSeconds: CARDANO_MASUMI_MAX_TIMEOUT_SECONDS }
      : {}),
    ...(route.extra || cardanoExtra ? { extra: { ...route.extra, ...cardanoExtra } } : {}),
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
