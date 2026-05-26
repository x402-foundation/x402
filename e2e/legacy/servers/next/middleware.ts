import { Address } from "viem";
import { paymentMiddleware, Network, Resource } from "x402-next";

const payTo = process.env.EVM_PAYEE_ADDRESS as Address;
const network = process.env.EVM_NETWORK as Network;
const facilitatorUrl = process.env.FACILITATOR_URL;

// Create facilitator config if URL is provided
const facilitatorConfig: { url: Resource } | undefined = facilitatorUrl
  ? { url: facilitatorUrl as Resource }
  : undefined;

if (facilitatorUrl) {
  console.log(`Using remote facilitator at: ${facilitatorUrl}`);
} else {
  console.log(`Using default facilitator`);
}

export const middleware = paymentMiddleware(
  payTo,
  {
    "/api/protected": {
      price: "$0.001",
      network,
      config: {
        description: "Protected API endpoint",
      },
    },
  },
  facilitatorConfig,
  {
    appName: "Next x402 E2E Test",
    appLogo: "/x402-icon-blue.png",
  },
);

// Configure which paths the middleware should run on
export const config = {
  matcher: ["/api/protected"],
  runtime: 'nodejs', // TEMPORARY: Only needed until Edge runtime support is added
};

