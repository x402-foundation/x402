/**
 * Returns the API catalog in application/linkset+json format per RFC 9727.
 *
 * @returns API catalog response with linkset entries for x402 services
 */
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
        anchor: "https://x402.org/protected",
        links: [
          {
            rel: "payment-required",
            href: "https://x402.org/protected",
          },
          {
            rel: "service-desc",
            href: "https://github.com/coinbase/x402",
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
