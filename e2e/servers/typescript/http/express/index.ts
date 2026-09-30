import express from "express";
import { paymentMiddleware, setSettlementOverrides } from "@x402/express";
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

  const app = express();
  const facilitatorClients = createFacilitatorClients(facilitatorUrl);
  const server = new x402ResourceServer(facilitatorClients);
  await configureResourceServer(server, cfg);

  console.log(
    `Facilitator account: ${facilitatorUrl ? facilitatorUrl.substring(0, 10) + "..." : "not configured"}`,
  );
  console.log(`Using remote facilitator at: ${facilitatorUrl}`);

  app.use((req, res, next) => {
    const err = getUnconfiguredResponseForPath(req.path, cfg);
    if (err) {
      return res.status(501).json(err);
    }
    next();
  });

  app.use(paymentMiddleware(buildPaymentRoutes(cfg), server));

  for (const route of E2E_GET_ROUTES) {
    app.get(route.path, (req, res) => {
      if (route.settlementOverride) {
        setSettlementOverrides(res, route.settlementOverride);
      }
      res.json(route.response());
    });
  }

  app.get(HEALTH_PATH, (_req, res) => {
    res.json(buildHealthResponse(cfg));
  });

  app.post(CLOSE_PATH, (_req, res) => {
    res.json(buildCloseResponse());
    console.log("Received shutdown request");
    setTimeout(() => process.exit(0), 100);
  });

  app.listen(parseInt(PORT), () => {
    console.log(
      formatStartupBanner(cfg, {
        title: "x402 Express E2E Test Server",
        address: `http://localhost:${PORT}`,
      }),
    );
  });
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
