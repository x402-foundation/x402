import { ExactAvmScheme } from "@x402/avm/exact/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/server";
import { AuthCaptureEvmScheme } from "@x402/evm/auth-capture/server";
import { BatchSvmScheme as BatchSettlementSvmScheme } from "@x402/svm/batch-settlement/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { UptoSvmScheme } from "@x402/svm/upto/server";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { ExactAptosScheme } from "@x402/aptos/exact/server";
import { ExactCasperScheme } from "@x402/casper/exact/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { ExactKeetaScheme } from "@x402/keeta/exact/server";
import type { LightningReceiver } from "@x402/lnbtc";
import {
  ExactLnbtcScheme,
  httpTransportBinding,
  mcpTransportBinding,
} from "@x402/lnbtc/exact/server";
import { NWCClient } from "@getalby/sdk";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { ExactTvmScheme } from "@x402/tvm/exact/server";
import { ExactNearScheme } from "@x402/near/exact/server";
import { ExactXrplScheme } from "@x402/xrpl/exact/server";
import { ExactConcordiumScheme } from "@x402/concordium/exact/server";
import { ExactCardanoScheme } from "@x402/cardano/exact/server";
import { toMasumiSellerSigner } from "@x402/cardano";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  declareEip2612GasSponsoringExtension,
  declareErc20ApprovalGasSponsoringExtension,
} from "@x402/extensions";
import {
  HTTPFacilitatorClient,
  type RoutesConfig,
  type x402ResourceServer,
} from "@x402/core/server";
import {
  createAuthCaptureLifecycleManager,
  setAuthCaptureLifecycleManager,
} from "./auth-capture-e2e";
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
  schemesForSdkNetwork,
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

/**
 * Origin e2e clients use to reach this server. The harness hands every client
 * `http://localhost:${port}` (`serverUrl` in test.ts); lnbtc binds each invoice
 * to the request URL under this origin, so it must be exactly that.
 */
export function e2eServerOrigin(cfg: ServerEnvConfig): string {
  return `http://localhost:${cfg.PORT}`;
}

/** SSE endpoint of the MCP server; the e2e MCP client connects to `${origin}/sse`. */
export const MCP_SSE_PATH = "/sse";

/** The URI the e2e MCP client connects to: lnbtc's `mcp:1` server identity. */
export function e2eMcpServerUri(cfg: ServerEnvConfig): string {
  return `${e2eServerOrigin(cfg)}${MCP_SSE_PATH}`;
}

/**
 * Lightning receiver over Nostr Wallet Connect (`make_invoice` with the request
 * hash as the description hash). The wallet must be the node whose public key is
 * SERVER_LNBTC_ADDRESS, and nothing else may create invoices on it: anyone who
 * can could pay their own invoice and present its preimage.
 *
 * @param nostrWalletConnectUrl - NWC connection URI with the make_invoice permission
 * @returns Receiver adapter for the lnbtc server scheme
 */
function nwcLightningReceiver(nostrWalletConnectUrl: string): LightningReceiver {
  const nwc = new NWCClient({ nostrWalletConnectUrl });
  return {
    async createInvoice({ amountMsat, descriptionHash, expirySeconds }) {
      // NIP-47 carries msat as a JSON number.
      if (amountMsat > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`lnbtc amount ${amountMsat} msat is too large for NWC make_invoice`);
      }
      const { invoice } = await nwc.makeInvoice({
        amount: Number(amountMsat),
        description_hash: descriptionHash,
        expiry: expirySeconds,
      });
      return invoice;
    },
  };
}

/** Register schemes for one configured family. */
async function registerFamilySchemes(
  server: x402ResourceServer,
  family: ProtocolFamily,
  cfg: ServerEnvConfig,
  transport: RouteTransport,
  primaryFacilitator?: HTTPFacilitatorClient,
): Promise<void> {
  const pattern = networkCaip2Pattern(family);

  switch (family) {
    case "avm":
      server.register(pattern, new ExactAvmScheme());
      return;
    case "ccd":
      server.register(pattern, new ExactConcordiumScheme());
      return;
    case "cardano": {
      const sellerMnemonic = process.env.SERVER_CARDANO_SELLER_MNEMONIC;
      if (!sellerMnemonic) break;
      server.register(
        pattern,
        new ExactCardanoScheme({
          masumi: {
            seller: network => toMasumiSellerSigner({ mnemonic: sellerMnemonic, network }),
          },
        }),
      );
      return;
    }
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
      if (schemesForSdkNetwork("typescript", "evm").includes("auth-capture")) {
        const authCaptureScheme = new AuthCaptureEvmScheme(
          receiverAuthorizerSigner
            ? { receiverAuthorizerSigner }
            : { collectOnlyRoutes: true },
        );
        if (receiverAuthorizerSigner) {
          console.info(`Auth-capture receiver authorizer (self-managed): ${receiverAuthorizerSigner.address}`);
        } else {
          console.info("Auth-capture receiver authorizer: facilitator-delegated (collect-only routes enabled)");
        }
        server.register(pattern, authCaptureScheme);
        if (primaryFacilitator) {
          setAuthCaptureLifecycleManager(
            createAuthCaptureLifecycleManager(authCaptureScheme, primaryFacilitator),
          );
        }
      }
      return;
    }
    case "svm": {
      server.register(pattern, new ExactSvmScheme());
      const receiverAuthorizerPrivateKey = process.env.SERVER_SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY;
      const receiverAuthorizerSigner = receiverAuthorizerPrivateKey
        ? await createKeyPairSignerFromBytes(base58.decode(receiverAuthorizerPrivateKey))
        : undefined;
      if (!receiverAuthorizerSigner) return;
      console.info(`SVM receiver authorizer: ${receiverAuthorizerSigner.address}`);
      server.register(
        pattern,
        new UptoSvmScheme({
          receiverAuthorizerSigner,
          rpcUrl: process.env.SVM_RPC_URL,
        }),
      );
      const operatorPrivateKey = process.env.SERVER_SVM_OPERATOR_PRIVATE_KEY;
      const operatorSigner = operatorPrivateKey
        ? await createKeyPairSignerFromBytes(base58.decode(operatorPrivateKey))
        : undefined;
      if (operatorSigner) {
        console.info(`SVM batch-settlement operator: ${operatorSigner.address}`);
      }
      server.register(
        pattern,
        new BatchSettlementSvmScheme({
          receiverAuthorizer: receiverAuthorizerSigner,
          ...(operatorSigner ? { operator: operatorSigner } : {}),
        }),
      );
      return;
    }
    case "aptos":
      server.register(pattern, new ExactAptosScheme());
      return;
    case "casper":
      server.register(pattern, new ExactCasperScheme());
      return;
    case "hedera":
      server.register(pattern, new ExactHederaScheme());
      return;
    case "keeta":
      server.register(pattern, new ExactKeetaScheme());
      return;
    case "lnbtc": {
      const nwcUrl = process.env.SERVER_LNBTC_NWC_URL;
      if (!nwcUrl) {
        throw new Error(
          "SERVER_LNBTC_NWC_URL is required to issue invoices for SERVER_LNBTC_ADDRESS",
        );
      }
      server.register(
        pattern,
        new ExactLnbtcScheme({
          receiver: nwcLightningReceiver(nwcUrl),
          // Each invoice commits to the request the client is making: the URL under the
          // origin clients use (HTTP), or the tool call on the endpoint they connect to (MCP).
          requestBinding:
            transport === "mcp"
              ? mcpTransportBinding({ server: e2eMcpServerUri(cfg) })
              : httpTransportBinding({ publicOrigin: e2eServerOrigin(cfg) }),
        }),
      );
      return;
    }
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
 * configured (catalog-driven via {@link isFamilyConfigured}). `primaryFacilitator` is passed to
 * schemes that need a facilitator client of their own; `transport` is the surface this server
 * exposes routes over, for schemes that bind the request.
 */
export async function configureResourceServer(
  server: x402ResourceServer,
  cfg: ServerEnvConfig,
  primaryFacilitator?: HTTPFacilitatorClient,
  transport: RouteTransport = "http",
): Promise<void> {
  for (const family of PROTOCOL_FAMILIES) {
    if (isFamilyConfigured(cfg, family)) {
      await registerFamilySchemes(server, family, cfg, transport, primaryFacilitator);
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

/** Single-route payment config shared by HTTP frameworks, the Next e2e server, and MCP tools. */
export function buildResolvedRouteConfig(
  route: ResolvedRoute,
  transport: RouteTransport = "http",
): Record<string, unknown> {
  const extensions = Object.assign({}, ...route.extensions.map(id => declareExtension(id, route, transport)));

  return {
    accepts: {
      payTo: route.payTo,
      scheme: route.scheme,
      network: route.network as Caip2Network,
      price: route.price,
      ...(route.maxTimeoutSeconds ? { maxTimeoutSeconds: route.maxTimeoutSeconds } : {}),
      ...(route.extra ? { extra: route.extra } : {}),
    },
    ...(route.extensions.length > 0 ? { extensions } : {}),
  };
}

/**
 * Route-config `resource` for a route served at `httpPath`, when its scheme binds
 * the request URL. lnbtc requires `PaymentRequired.resource.url` to equal the bound
 * URL (public origin + path), so it is pinned rather than taken from the Host header.
 */
export function httpRouteResource(
  route: ResolvedRoute,
  cfg: ServerEnvConfig,
  httpPath: string,
): { resource: string } | Record<string, never> {
  return route.networkId === "lnbtc" ? { resource: `${e2eServerOrigin(cfg)}${httpPath}` } : {};
}

/**
 * Payment-middleware route map for the express/hono/fastify e2e servers, derived
 * from config/mechanisms.json. Routes whose network has no payee address
 * configured are omitted by the resolver.
 */
export function buildPaymentRoutes(cfg: ServerEnvConfig): RoutesConfig {
  const routes: Record<string, unknown> = {};

  for (const route of resolvedRoutes(cfg)) {
    routes[`GET ${route.path}`] = {
      ...buildResolvedRouteConfig(route),
      ...httpRouteResource(route, cfg, route.path),
    };
  }

  return routes as RoutesConfig;
}
