import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import express from "express";
import {
  paymentMiddlewareFromHTTPServer,
  x402ResourceServer,
  x402HTTPResourceServer,
} from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
config();

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
if (!evmAddress) {
  console.error("Missing required environment variables");
  process.exit(1);
}

const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("❌ FACILITATOR_URL environment variable is required");
  process.exit(1);
}
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

const app = express();
app.use(express.json());

// Routes are registered at runtime, so the HTTP server starts with only the
// routes known up front (none in this example).
const httpServer = new x402HTTPResourceServer(
  new x402ResourceServer(facilitatorClient).register("eip155:84532", new ExactEvmScheme()),
  {},
);

app.use(paymentMiddlewareFromHTTPServer(httpServer));

interface Order {
  quantity: number;
  price: string;
  status: "awaiting-payment" | "paid";
}

const orders = new Map<string, Order>();

// Step 1: Create an order. The price depends on the request (quantity), and the
// payment URL for the order does not exist until this handler runs — neither
// can be expressed in a static routes map at startup.
app.post("/orders", (req, res) => {
  const quantity = Math.max(1, Number(req.body?.quantity ?? 1));
  const price = `$${(quantity * 0.001).toFixed(3)}`;
  const orderId = randomUUID();

  orders.set(orderId, { quantity, price, status: "awaiting-payment" });

  // Protect the order's payment URL the moment the order exists.
  // No verb prefix: Express serves HEAD requests through GET handlers, so a
  // verb-agnostic pattern keeps HEAD from bypassing the payment middleware.
  httpServer.registerRoute(`/orders/${orderId}/receipt`, {
    accepts: {
      scheme: "exact",
      price,
      // Base Sepolia testnet — the default network used across these examples;
      // any network registered on the resource server works here
      network: "eip155:84532",
      payTo: evmAddress,
    },
    description: `Order ${orderId} (${quantity} item(s))`,
    mimeType: "application/json",
  });

  res.json({ orderId, quantity, price, payUrl: `/orders/${orderId}/receipt` });
});

// Step 2: Paying the order's URL completes it. The middleware enforces the
// order-specific price registered above; this handler only runs after the
// payment has been verified.
app.get("/orders/:id/receipt", (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) {
    res.status(404).send({ error: "Order not found" });
    return;
  }

  order.status = "paid";

  // One-shot payment: release the route so subsequent requests to this URL
  // are no longer intercepted by the payment middleware (replay protection).
  httpServer.unregisterRoute(`/orders/${req.params.id}/receipt`);

  res.send({
    orderId: req.params.id,
    status: order.status,
    quantity: order.quantity,
    paid: order.price,
  });
});

// Order status is free to check at any time
app.get("/orders/:id", (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) {
    res.status(404).send({ error: "Order not found" });
    return;
  }
  res.send({ orderId: req.params.id, ...order });
});

app.listen(4021, () => {
  console.log(`Server listening at http://localhost:${4021}`);
  console.log(
    `Create an order:  curl -X POST http://localhost:4021/orders -H 'Content-Type: application/json' -d '{"quantity": 3}'`,
  );
});
