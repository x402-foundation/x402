export function GET() {
  const catalog = {
    linkset: [
      {
        anchor: "https://x402.org/facilitator",
        links: [
          {
            rel: "service-desc",
            href: "https://github.com/coinbase/x402",
          },
          {
            rel: "service-doc",
            href: "https://x402.org/writing/x402-v2-launch",
          },
        ],
      },
      {
        anchor: "https://x402.org/api/x402/demo",
        links: [
          {
            rel: "payment-required",
            href: "https://x402.org/api/x402/demo",
          },
          {
            rel: "service-desc",
            href: "https://github.com/coinbase/x402",
          },
        ],
      },
      {
        anchor: "https://x402.org/protected",
        links: [
          {
            rel: "payment-required",
            href: "https://x402.org/protected",
          },
        ],
      },
    ],
  };

  return new Response(JSON.stringify(catalog), {
    headers: {
      "Content-Type": "application/linkset+json",
    },
  });
}
