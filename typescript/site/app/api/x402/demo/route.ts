const paymentRequired = {
  x402Version: 2,
  error: "Payment required",
  resource: {
    url: "https://x402.org/api/x402/demo",
    description: "x402 demo endpoint — pay with stablecoins to access",
    mimeType: "application/json",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      asset: "USDC",
      amount: "10000",
      payTo: "0x209693Bc6afc0C8328a063eB80e0AC6E82E41eC1",
      maxTimeoutSeconds: 300,
      extra: {},
    },
  ],
};

const encodedPaymentRequired = Buffer.from(JSON.stringify(paymentRequired)).toString("base64");

export function GET() {
  return new Response(JSON.stringify({}), {
    status: 402,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": encodedPaymentRequired,
    },
  });
}
