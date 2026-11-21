---
"@x402/express": patch
---

Do not settle a payment when the route handler sets an error status with `res.writeHead()`. The buffered `writeHead` call now updates `res.statusCode`, so the `>= 400` check skips settlement as it does for `res.status()`.
