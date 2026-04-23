/**
 * Returns OAuth Protected Resource Metadata per RFC 9728.
 *
 * @returns JSON response with resource identifier and authorization servers
 */
export function GET() {
  const metadata = {
    resource: "https://x402.org",
    authorization_servers: ["https://x402.org"],
    scopes_supported: ["facilitator:verify", "facilitator:settle", "facilitator:supported"],
  };

  return Response.json(metadata);
}
