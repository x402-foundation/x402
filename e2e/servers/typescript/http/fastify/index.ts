import Fastify from "fastify";
import { paymentMiddleware, setSettlementOverrides } from "@x402/fastify";
import { x402ResourceServer } from "@x402/core/server";
import {
  loadServerEnv,
  createFacilitatorClients,
  configureResourceServer,
  buildPaymentRoutes,
  E2E_GET_ROUTES,
  HEALTH_PATH,
  CLOSE_PATH,
  getUnconfiguredResponseForPath,
  buildHealthResponse,
  buildCloseResponse,
  formatStartupBanner,
} from "../../index.ts";

async function main(): Promise<void> {
  const cfg = loadServerEnv();
  const { PORT, facilitatorUrl } = cfg;

  const app = Fastify();
  const facilitatorClients = createFacilitatorClients(facilitatorUrl);
  const server = new x402ResourceServer(facilitatorClients);
  await configureResourceServer(server, cfg);

  console.log(
    `Facilitator account: ${facilitatorUrl ? facilitatorUrl.substring(0, 10) + "..." : "not configured"}`,
  );
  console.log(`Using remote facilitator at: ${facilitatorUrl}`);

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0];
    const err = getUnconfiguredResponseForPath(path, cfg);
    if (err) {
      return reply.status(501).send(err);
    }
  });

  paymentMiddleware(app, buildPaymentRoutes(cfg), server);

  for (const route of E2E_GET_ROUTES) {
    app.get(route.path, async (_request, reply) => {
      if (route.settlementOverride) {
        setSettlementOverrides(reply, route.settlementOverride);
      }
      return route.response();
    });
  }

  app.get(HEALTH_PATH, async () => buildHealthResponse(cfg));

  app.post(CLOSE_PATH, async (_request, reply) => {
    reply.send(buildCloseResponse());
    console.log("Received shutdown request");
    setTimeout(() => process.exit(0), 100);
  });

  app.listen({ port: parseInt(PORT) }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(
      formatStartupBanner(cfg, {
        title: "x402 Fastify E2E Test Server",
        address,
      }),
    );
  });
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
