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
import { ExactCantonScheme } from "@x402/canton/exact/server";
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
    case "canton":
      server.register(pattern, new ExactCantonScheme());
      return;
    case "ccd":
      server.register(pattern, new ExactConcordiumScheme());
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
      ...(route.extra ? { extra: route.extra } : {}),
    },
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
