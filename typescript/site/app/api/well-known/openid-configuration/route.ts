export function GET() {
  const config = {
    issuer: "https://x402.org",
    authorization_endpoint: "https://x402.org/oauth/authorize",
    token_endpoint: "https://x402.org/oauth/token",
    jwks_uri: "https://x402.org/.well-known/jwks.json",
    grant_types_supported: ["authorization_code", "client_credentials"],
    response_types_supported: ["code"],
    scopes_supported: ["facilitator:verify", "facilitator:settle", "facilitator:supported"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
  };

  return Response.json(config);
}
