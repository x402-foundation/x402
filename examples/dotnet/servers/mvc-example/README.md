# MVC example

This example protects controller actions with the `RequireX402Payment` attribute.

## What it demonstrates

- `builder.Services.AddControllers()` with x402 registration in the same app.
- `IX402ResourceServer.RegisterSchemeVerifier(...)` for `evm-exact`.
- Controller-level protection applied once and inherited by multiple actions.
- Reading the payer value from `HttpContext.Items` inside controller actions.

## Run

```bash
dotnet run
```

This project also defaults to local `ProjectReference` items. You can replace them with the commented package references in [mvc-example.csproj](mvc-example.csproj) when the packages are available.

## Try the protected route

```bash
curl -i http://localhost:5000/premium/data
```

Expected result:

- HTTP status `402 Payment Required`
- A `PAYMENT-REQUIRED` header containing the advertised payment requirements

After generating a signed payment with a client, retry the request:

```bash
curl -i http://localhost:5000/premium/data \
  -H 'PAYMENT-SIGNATURE: <signed-base64-payment-payload>'
```

The controller responds with JSON that includes the verified payer:

```json
{
  "route": "/premium/data",
  "report": "daily",
  "paidBy": "0x...",
  "protection": "mvc-attribute"
}
```

## Why this style

Use this pattern when your application already uses controllers and you want the payment contract to follow the same annotation style as authorization or validation filters.