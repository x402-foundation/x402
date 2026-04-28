const paymentRequired = {
  x402Version: 2,
  error: "Payment required",
  resource: {
    url: "https://x402.org/api/x402/demo",
    description: "x402 demo endpoint",
    mimeType: "application/json",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      maxTimeoutSeconds: 300,
      extra: {
        name: "USDC",
        version: "2",
      },
    },
  ],
};

const encodedPaymentRequired = Buffer.from(JSON.stringify(paymentRequired)).toString("base64");

/**
 * Demo endpoint returning HTTP 402 with x402 payment requirements for scanner discoverability.
 *
 * @returns 402 response with PAYMENT-REQUIRED header
 */
export function GET() {
  return new Response(JSON.stringify({}), {
    status: 402,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": encodedPaymentRequired,
    },
  });
}
