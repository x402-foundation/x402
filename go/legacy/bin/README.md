# Demo Proxy

This is a universal proxy for demo purposes. **It is not meant for production** It makes any website or API payable via x402.

To run

```
go run proxy_demo.go <config.json>
```

Example of all possible keys can be found in `example_config.json`. The Minimal set of keys are:

```json
{
  "targetURL": "https://httpbin.org",
  "amount": 0.01,
  "payTo": "0x<your address>"
}
```
