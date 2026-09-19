# ASP.NET Core x402 examples

These examples mirror the role-based layout used by the other SDKs and focus on the three ASP.NET Core protection styles currently supported by the .NET SDK.

## Servers

- `servers/minimal-api-example` shows per-endpoint protection with `.RequireX402Payment(...)`.
- `servers/mvc-example` shows controller-level protection with `[RequireX402Payment(...)]`.
- `servers/middleware-example` shows path-prefix protection with `app.UseX402Payment(...)`.

All three examples default to local `ProjectReference` entries so they build against the source tree in this repository. Each `.csproj` also includes commented `PackageReference` lines you can enable once the packages are published.

## Common flow

1. Start one of the example servers with `dotnet run` from its directory.
2. Request the protected endpoint without payment and inspect the `PAYMENT-REQUIRED` response header.
3. Generate a signed x402 payment with a client implementation.
4. Retry the same request with the `PAYMENT-SIGNATURE` header set to the signed payload.

The examples intentionally stop at the resource-server boundary. They register the local off-chain `evm-exact` verifier and leave payment creation to a client implementation.

## Example choice

- Use the minimal API example if you want protection declared next to the route handler.
- Use the MVC example if your app already uses controllers and filters.
- Use the middleware example if you want one central place to protect multiple path prefixes.

## Build

From any example directory:

```bash
dotnet build
dotnet run
```

## Notes

- The sample token metadata uses Base Sepolia USDC-style values for illustration.
- The recipient wallet addresses are placeholders. Replace them before using the examples in a real integration.
- If you want end-to-end payment generation in this repo, the next addition should be a `.NET` client example under `examples/dotnet/clients`.