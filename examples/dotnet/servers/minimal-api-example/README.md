# Minimal API example

This example protects a single route at the point where the route is declared.

## What it demonstrates

- `builder.Services.AddX402()` for core role registration.
- `IX402ResourceServer.RegisterSchemeVerifier(...)` with the local `evm-exact` verifier.
- `.RequireX402Payment(...)` on one minimal API endpoint.
- Reading the verified payer from `HttpContext.Items`.

## Run

```bash
dotnet run
```

By default this project builds against the local source tree. If you want to consume published packages instead, swap the `ProjectReference` items in [minimal-api-example.csproj](minimal-api-example.csproj) for the commented `PackageReference` block.

## Try the protected route

Request the route without payment:

```bash
curl -i http://localhost:5000/weather
```

Expected result:

- HTTP status `402 Payment Required`
- A `PAYMENT-REQUIRED` header containing the Base64-encoded payment requirements

Once you have a signed payment payload from an x402 client, retry the request with the `PAYMENT-SIGNATURE` header:

```bash
curl -i http://localhost:5000/weather \
  -H 'PAYMENT-SIGNATURE: <signed-base64-payment-payload>'
```

Expected success result:

```json
{
  "city": "Lagos",
  "forecast": "clear",
  "temperatureC": 29,
  "paidBy": "0x...",
  "protection": "minimal-api"
}
```

## Why this style

Use this pattern when payment requirements belong to one endpoint and you want the policy declared beside the handler instead of in a central middleware block.