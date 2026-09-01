import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const app = new Hono();
const evmAddressPattern = /^0x[a-fA-F0-9]{40}$/;

let x402Middleware: ReturnType<typeof paymentMiddleware> | undefined;
/**
 * Get or lazily create the payment middleware for this isolate.
 *
 * @returns The payment middleware, reused across requests in this isolate
 */
function getPaymentMiddleware(): ReturnType<typeof paymentMiddleware> {
  if (!evmAddressPattern.test(env.EVM_ADDRESS)) {
    throw new Error("EVM_ADDRESS must be a 20-byte hexadecimal address");
  }

  x402Middleware ??= paymentMiddleware(
    {
      "GET /weather": {
        accepts: {
          scheme: "exact",
          price: "$0.001",
          network: "eip155:84532",
          payTo: env.EVM_ADDRESS,
        },
        description: "Weather data",
        mimeType: "application/json",
      },
    },
    new x402ResourceServer(new HTTPFacilitatorClient({ url: env.FACILITATOR_URL })).register(
      "eip155:84532",
      new ExactEvmScheme(),
    ),
  );

  return x402Middleware;
}

// Creating the middleware starts facilitator I/O, so defer it until a request
// provides an I/O context. Subsequent requests reuse the initialized instance.
app.use((c, next) => getPaymentMiddleware()(c, next));

app.get("/weather", c => c.json({ weather: "sunny", temperature: 70 }));

// No server to start: a Worker's fetch handler *is* the deployable unit.
export default app;
