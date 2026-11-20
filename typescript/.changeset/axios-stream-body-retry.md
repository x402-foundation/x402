---
"@x402/axios": patch
---

Buffered Node stream request bodies, such as `fs.createReadStream` or `form-data`, before the first send so the paid retry sends the same body. The first request consumed the stream, so the paid retry went out with an empty body or never finished.
