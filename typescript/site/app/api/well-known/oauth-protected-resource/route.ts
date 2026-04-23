export function GET() {
  const metadata = {
    resource: "https://x402.org",
    authorization_servers: ["https://x402.org"],
    scopes_supported: ["facilitator:verify", "facilitator:settle", "facilitator:supported"],
  };

  return Response.json(metadata);
}
