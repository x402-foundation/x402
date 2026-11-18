import { config } from "dotenv";
import express, { Request, Response, NextFunction } from "express";
import { x402ResourceServer, HTTPFacilitatorClient, ResourceConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { PaymentRequirements } from "@x402/core/types";

config();

/**
 * Custom x402 Server Implementation
 *
 * This example demonstrates how to implement x402 payment handling manually
 * without using the pre-built middleware packages like @x402/express.
 *
 * It shows you how the payment flow works under the hood:
 * 1. Check for payment in request headers
 * 2. If no payment, return 402 with payment requirements
 * 3. If payment provided, verify with facilitator
 * 4. Execute handler
 * 5. Settle payment and add settlement headers to response
 *
 * Use this approach when you need:
 * - Complete control over the payment flow
 * - Integration with unsupported frameworks
 * - Custom error handling or logging
 * - Understanding of how x402 works internally
 */

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
const facilitatorUrl = process.env.FACILITATOR_URL;

if (!evmAddress) {
  console.error("❌ EVM_ADDRESS environment variable is required");
  process.exit(1);
}

if (!facilitatorUrl) {
  console.error("❌ FACILITATOR_URL environment variable is required");
  process.exit(1);
}

console.log("\n🔧 Custom x402 Server Implementation");
console.log("This example demonstrates manual payment handling without middleware.\n");
console.log(`✅ Payment address: ${evmAddress}`);
console.log(`✅ Facilitator: ${facilitatorUrl}\n`);

// Create facilitator client and resource server
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
const resourceServer = new x402ResourceServer(facilitatorClient).register(
  "eip155:84532",
  new ExactEvmScheme(),
);

// Define route configurations (will be converted to PaymentRequirements at runtime)
interface RoutePaymentConfig extends ResourceConfig {
  description: string;
  mimeType: string;
}

const routeConfigs: Record<string, RoutePaymentConfig> = {
  "GET /weather": {
    scheme: "exact",
    price: "$0.001",
    network: "eip155:84532",
    payTo: evmAddress,
    description: "Weather data",
    mimeType: "application/json",
  },
};

// Cache for built payment requirements
const routeRequirements: Record<string, PaymentRequirements> = {};

/**
 * Custom payment middleware implementation
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 * @returns Promise that resolves when middleware completes
 */
async function customPaymentMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const routeKey = `${req.method} ${req.path}`;
  const routeConfig = routeConfigs[routeKey];

  // If route doesn't require payment, continue
  if (!routeConfig) {
    return next();
  }

  console.log(`📥 Request received: ${routeKey}`);

  // Build PaymentRequirements from config (cached for efficiency)
  if (!routeRequirements[routeKey]) {
    const builtRequirements = await resourceServer.buildPaymentRequirements(routeConfig);
    if (builtRequirements.length === 0) {
      console.error("❌ Failed to build payment requirements");
      res.status(500).json({ error: "Server configuration error" });
      return;
    }
    routeRequirements[routeKey] = builtRequirements[0];
  }
  const requirements = routeRequirements[routeKey];

  // Step 1: Check for payment in headers (v2: PAYMENT-SIGNATURE, v1: X-PAYMENT)
  const paymentHeader = (req.headers["payment-signature"] || req.headers["x-payment"]) as
    | string
    | undefined;

  if (!paymentHeader) {
    console.log("💳 No payment provided, returning 402 Payment Required");

    // Step 2: Return 402 with payment requirements
    const paymentRequired = resourceServer.createPaymentRequiredResponse([requirements], {
      url: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
      description: routeConfig.description,
      mimeType: routeConfig.mimeType,
    });
    // Use base64 encoding for the PAYMENT-REQUIRED header (v2 protocol)
    const requirementsHeader = Buffer.from(JSON.stringify(paymentRequired)).toString("base64");

    res.status(402);
    res.set("PAYMENT-REQUIRED", requirementsHeader);
    res.json({
      error: "Payment Required",
      message: "This endpoint requires payment",
    });
    return;
  }

  try {
    // Step 3: Verify payment
    console.log("🔐 Payment provided, verifying with facilitator...");

    const paymentPayload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
    const verifyResult = await resourceServer.verifyPayment(paymentPayload, requirements);

    if (!verifyResult.isValid) {
      console.log(`❌ Payment verification failed: ${verifyResult.invalidReason}`);
      res.status(402).json({
        error: "Invalid Payment",
        reason: verifyResult.invalidReason,
      });
      return;
    }

    console.log("✅ Payment verified successfully");

    // Store original response method
    const originalJson = res.json.bind(res);
    let settlementDone = false;

    // Step 4: Intercept response to add settlement
    const settleAndRespond = async (): Promise<void> => {
      if (settlementDone) return;
      settlementDone = true;

      console.log("💰 Settling payment on-chain...");

      try {
        const settleResult = await resourceServer.settlePayment(paymentPayload, requirements);

        console.log(`✅ Payment settled: ${settleResult.transaction}`);

        // Step 5: Add settlement headers (v2 protocol uses PAYMENT-RESPONSE)
        const settlementHeader = Buffer.from(JSON.stringify(settleResult)).toString("base64");
        res.set("PAYMENT-RESPONSE", settlementHeader);
      } catch (error) {
        console.error(`❌ Settlement failed: ${error}`);
        // Continue with response even if settlement fails
      }
    };

    // Override json method to add settlement before responding
    res.json = function (this: Response, body: unknown): Response {
      void settleAndRespond().then(() => originalJson(body));
      return this;
    };

    // Continue to handler
    next();
  } catch (error) {
    console.error(`❌ Payment processing error: ${error}`);
    res.status(500).json({
      error: "Payment Processing Error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

// Create Express app
const app = express();

// Apply custom payment middleware
app.use(customPaymentMiddleware);

// Protected endpoint
app.get("/weather", (req, res) => {
  console.log("🌤️  Executing weather endpoint handler");

  const city = (req.query.city as string) || "San Francisco";

  const weatherData: Record<string, { weather: string; temperature: number }> = {
    "San Francisco": { weather: "foggy", temperature: 60 },
    "New York": { weather: "cloudy", temperature: 55 },
    London: { weather: "rainy", temperature: 50 },
    Tokyo: { weather: "clear", temperature: 65 },
  };

  const data = weatherData[city] || { weather: "sunny", temperature: 70 };

  res.json({
    city,
    weather: data.weather,
    temperature: data.temperature,
    timestamp: new Date().toISOString(),
  });
});

// Health check endpoint (no payment required)
app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "2.0.0" });
});

// Start server
const PORT = 4021;

// Initialize the resource server (sync with facilitator) before starting
resourceServer.initialize().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Custom server listening at http://localhost:${PORT}\n`);
    console.log("Key implementation steps:");
    console.log("  1. ✅ Check for payment headers in requests");
    console.log("  2. ✅ Return 402 with requirements if no payment");
    console.log("  3. ✅ Verify payments with facilitator");
    console.log("  4. ✅ Execute handler on successful verification");
    console.log("  5. ✅ Settle payment and add response headers\n");
    console.log("Test with: curl http://localhost:4021/weather");
    console.log("Or use a client from: ../../clients/\n");
  });
});
