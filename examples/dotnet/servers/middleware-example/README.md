# Middleware example

This example protects multiple path prefixes with one middleware registration.

## What it demonstrates

- `app.UseX402Payment(...)` with two protected route prefixes.
- Different payment requirements for basic and premium content.
- An unprotected route living beside protected routes in the same app.
- Default and per-route facilitator URL metadata in middleware options.

## Run

```bash
dotnet run
```

The project uses local `ProjectReference` entries by default. Replace them with the commented package references in [middleware-example.csproj](middleware-example.csproj) when you want to consume published packages instead.

## Try the routes

Public route:

```bash
curl -i http://localhost:5000/unprotected
```

Protected route without payment:

```bash
curl -i http://localhost:5000/api/basic
```

Expected result:

- `/unprotected` returns `200 OK`
- `/api/basic` and `/api/premium` return `402 Payment Required` until a valid `PAYMENT-SIGNATURE` header is supplied

Retry a protected route with a signed payment payload:

```bash
curl -i http://localhost:5000/api/premium \
  -H 'PAYMENT-SIGNATURE: <signed-base64-payment-payload>'
```

## Why this style

Use middleware when you want one central protection policy for many endpoints or when path-prefix matching is a better fit than annotating each route individually.