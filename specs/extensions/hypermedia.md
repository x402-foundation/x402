# Extension: `hypermedia` — Declarative HTTP 402 Interactions for Hypermedia & Zero-Script Web Clients

> **Document Status**: Normative Working Group Strawman Proposal  
> **Target Working Group**: x402 Core Protocol Working Group (`x402-foundation/x402`)  
> **Authors**: Walter Hawkins (`@whawk46`), Corrente Labs, Inc. (`contact@correntelabs.com`)  
> **Reference Implementation**: `htmx-ext-x402@1.0.0` / `@correntelabs/htmx-x402@1.0.0` (npm)  
> **Live Production Testbed**: `https://10x402.blue/algorand` (Surface D)  
> **Standards Alignment**: RFC 9110 (HTTP Semantics), RFC 8785 (JCS), RFC 8615 (Well-Known URIs), FINOS CALM Threat Model  

---

## 1. Summary

The `hypermedia` extension defines how standard HTML user agents and declarative hypermedia engines (such as [HTMX], [Hotwire/Turbo], [Datastar], and native HTML `<form>` / `<a>` navigation) negotiate `402 Payment Required` challenges natively via declarative markup and standard HTTP headers.

Existing x402 implementations assume an imperative programmatic client—typically a Python or TypeScript agent executing in a headless runtime or a heavy Web3 Single-Page Application (SPA) bundling 500 KB to 2.5 MB of client-side signing dependencies (e.g. Viem, Ethers, Web3Modal). 

This extension bridges the x402 protocol to the broader **Hypermedia Web**:
1. **Featherweight Client Footprint**: Replaces monolithic client SDKs with a sub-2KB (<1.8 KB gzipped) zero-dependency browser extension.
2. **Declarative Markup Binding**: Enables developers to monetize any HTML element using standard attributes (`hx-ext="x402"`).
3. **Dual Execution Modes**: Supports both sub-second zero-friction micro-allowances (Fast Path) and user-prompted interactive wallet hooks (Interactive Path).
4. **Server-Driven State Mutation**: Keeps all business logic, payment verification, and HTML rendering on the server, completely eliminating client-side DOM manipulation scripts and associated XSS attack surfaces.

---

## 2. Motivation & Threat Model

### 2.1 The Client-Fatigue Problem in Web3 Micropayments
Historically, web monetization protocols failed because they forced ordinary web pages to behave like distributed transaction orchestrators. In a typical Web3 implementation:
- The browser must download, parse, and execute megabytes of cryptographic and RPC client code.
- Every micropayment (\$0.001–\$0.05) risks triggering repetitive browser wallet extension popups, breaking user experience and reading flow.
- Non-technical web developers, content creators, and publishers are excluded due to the complexity of integrating imperative blockchain SDKs into traditional content management systems (CMS) and static site generators.

### 2.2 The Hypermedia Architecture (HATEOAS)
Hypermedia architecture ([RFC 9110], Roy Fielding's REST principles) dictates that application state is transferred from the server to the client in the form of hypermedia (HTML fragments), not raw JSON data manipulated by client scripts. 

By handling the HTTP 402 challenge-response flow declaratively at the hypermedia layer:
- The client remains a standard, lightweight HTML user agent.
- Financial state transitions are validated on the server or attested gateway.
- Upon successful payment settlement, the server returns the unlocked content as a sanitized HTML fragment that is automatically swapped into the document object model (DOM).

### 2.3 Threat Model (FINOS CALM Alignment)
As codified in the FINOS Common Architecture Language Model (CALM) reference note (`FINOS-CALM-NOTE-2026-02`), heavy client-side Web3 SPAs present severe security vulnerabilities in financial environments:
- **DOM Script Injection (XSS)**: Malicious third-party scripts or compromised npm dependencies can intercept client memory, hijack in-browser private keys, or tamper with transaction parameters before signing.
- **Client State Forgery**: Client-side JavaScript paywalls that toggle CSS `display: block` or swap local content upon receiving JSON responses are trivial to bypass.
- **Hypermedia Defense**: The `hypermedia` extension guarantees that paywalled content is **never sent to the client** prior to settlement confirmation. The client receives only a standard HTTP 402 challenge header, and state mutation occurs exclusively server-side.

---

## 3. Declarative Markup Specification

A conformant hypermedia user agent binds x402 capabilities via standard HTML attributes.

### 3.1 Basic Usage
Any element requesting a paywalled resource specifies the `x402` extension:

```html
<button 
  hx-get="/api/premium/market-intelligence" 
  hx-ext="x402" 
  hx-target="#intelligence-panel" 
  hx-swap="innerHTML">
  Unlock Real-Time Intelligence (0.01 ALGO)
</button>
```

### 3.2 Declarative Configuration Attributes

Conformant clients MAY provide fine-grained payment controls via standard `data-x402-*` attributes:

| Attribute | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `data-x402-mode` | `string` | `"auto"` | Execution strategy: `"allowance"`, `"interactive"`, or `"auto"`. |
| `data-x402-allowance-max` | `number` | `none` | Maximum atomic payment amount permitted without interactive prompt. |
| `data-x402-asset` | `string` | `none` | Preferred payment asset (e.g. `"ALGO"`, `"USDC"`, `"FCUSD"`). |
| `data-x402-network` | `string` | `none` | Preferred CAIP-2 network identifier (e.g. `"algorand:mainnet"`, `"eip155:8453"`). |
| `data-x402-indicator` | `string` | `none` | CSS selector for visual payment progress indicator. |

---

## 4. Normative Wire Protocol & Lifecycle

```
Client (User Agent)               Resource Server                  Facilitator / L1
       │                                 │                                 │
       │ 1. GET /resource (hx-ext="x402")│                                 │
       ├────────────────────────────────►│                                 │
       │                                 │                                 │
       │ 2. HTTP 402 Payment Required    │                                 │
       │    WWW-Authenticate: x402 ...   │                                 │
       │◄────────────────────────────────┤                                 │
       │                                 │                                 │
       │ [Interception & Auth Resolution]│                                 │
       │ - Fast Path (Micro-Allowance)   │                                 │
       │   OR Interactive Wallet Hook    │                                 │
       │                                 │                                 │
       │ 3. GET /resource                │                                 │
       │    Authorization: x402 <token>  │                                 │
       ├────────────────────────────────►│                                 │
       │                                 │ 4. Verify & Settle              │
       │                                 ├────────────────────────────────►│
       │                                 │◄────────────────────────────────┤
       │                                 │    (On-chain settlement / SCITT)│
       │                                 │                                 │
       │ 5. HTTP 200 OK (HTML Fragment)  │                                 │
       │    X-x402-Receipt: <digest>     │                                 │
       │◄────────────────────────────────┤                                 │
       │                                 │                                 │
       │ 6. Declarative DOM Swap         │                                 │
       │    (Target element updated)     │                                 │
```

### 4.1 Step 1: Initial Request
The client issues a standard HTTP request triggered by user interaction (click, submit, reveal). The request MUST include standard hypermedia headers:
```http
GET /api/premium/market-intelligence HTTP/1.1
Host: api.example.com
Accept: text/html, application/xhtml+xml
```

### 4.2 Step 2: The 402 Challenge
If the resource requires payment and no valid authorization is present, the server MUST return:
- **HTTP Status Code**: `402 Payment Required`
- **Challenge Header**: `WWW-Authenticate: x402 ...` per RFC 9110 §11.6.1 and core x402 specification.

Example response:
```http
HTTP/1.1 402 Payment Required
Content-Type: text/html; charset=utf-8
WWW-Authenticate: x402 version="2", network="algorand:mainnet", amount="10000", asset="ALGO", payTo="7Z3P3V4G6M...", nonce="9f8a2b..."
Cache-Control: no-store

<div class="x402-paywall-notice">
  <h3>Micro-Payment Required</h3>
  <p>Access requires 0.01 ALGO. Authorize via fast-path allowance or connected wallet.</p>
</div>
```

### 4.3 Step 3: Client Interception & Dual-Mode Execution
The hypermedia extension intercepts the 402 response prior to DOM swap. It parses the `WWW-Authenticate: x402` parameters and selects the execution path:

#### Mode A: Fast-Path Micro-Allowance
If the client user agent holds an active, operator-approved micro-allowance matching the requested `network`, `asset`, and `amount`:
1. The extension retrieves or signs an ephemeral authorization token locally without interrupting the user.
2. The extension automatically resends the original HTTP request with the authorization credential:
   ```http
   GET /api/premium/market-intelligence HTTP/1.1
   Host: api.example.com
   Authorization: x402 token="eyJhbGciOi...", nonce="9f8a2b..."
   ```

#### Mode B: Interactive Wallet Hook
If no pre-authorized allowance exists or the requested amount exceeds `data-x402-allowance-max`:
1. The extension dispatches a standard DOM CustomEvent:
   ```javascript
   document.dispatchEvent(new CustomEvent('x402:challenge', {
     detail: {
       network: "algorand:mainnet",
       amount: "10000",
       asset: "ALGO",
       payTo: "7Z3P3V4G6M...",
       retry: (authHeader) => { /* re-dispatches with header */ }
     }
   }));
   ```
2. Any listening wallet provider, browser extension, or modal UI handles user approval.
3. Upon approval, the `retry(authHeader)` callback re-issues the request with the signed credentials.

### 4.4 Step 4: Settlement & HTML Fragment Delivery
The resource server verifies the authorization with its configured settlement facilitator. Upon successful settlement or receipt confirmation, the server returns:
- **HTTP Status Code**: `200 OK`
- **Receipt Header**: `X-x402-Receipt: <txHash_or_digest>`
- **Response Body**: The requested HTML fragment.

```http
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
X-x402-Receipt: 5J9v...
Vary: Authorization

<div class="market-intelligence-report">
  <h4>Executive Telemetry Confirmed</h4>
  <p>Consensus latency: 2.8s | Dynamic Lambda active | Round: 43,892,185</p>
</div>
```

### 4.5 Step 5: Declarative DOM Replacement
The client hypermedia engine receives the `200 OK` and smoothly swaps the HTML fragment into the specified target element (`hx-target`). The user experiences seamless, in-place content reveal with zero page reloads and zero client-side financial computation.

---

## 5. Security & Invariant Guarantees

1. **Zero Client Financial Logic**: The client user agent never calculates fees, verifies state machines, or modifies transaction parameters. All accounting is server-verified.
2. **Replay & Idempotency Defense**: Conformant servers MUST enforce challenge nonce uniqueness (`nonce`). Replayed authorizations MUST be handled idempotently per §5.3.5.
3. **DOM Sanitization**: In accordance with modern hypermedia practices, servers MUST sanitize all rendered HTML fragments before transmission to prevent stored XSS attacks.
4. **Universal Rail Neutrality**: Challenge parameters adhere strictly to CAIP-2 (`network`) and CAIP-10 (`payTo`), ensuring complete architectural neutrality across all supported blockchains (EVM, Algorand, Solana, XRPL, etc.).

---

## 6. Reference Implementation

An official, zero-dependency reference implementation is maintained under the MIT license by Corrente Labs:

- **npm Distribution**:
  - Institutional: [`@correntelabs/htmx-x402`](https://www.npmjs.com/package/@correntelabs/htmx-x402)
  - Unscoped: [`htmx-x402`](https://www.npmjs.com/package/htmx-x402)
  - Community Convention: [`htmx-ext-x402`](https://www.npmjs.com/package/htmx-ext-x402)
- **CDN Script Delivery (< 1.8 KB gzipped)**:
  ```html
  <script src="https://cdn.jsdelivr.net/npm/htmx-ext-x402@1.0.0/dist/htmx-x402.min.js"></script>
  ```
- **Live Global Testbed**:
  Surface D of the Algorand Sovereign Hub demonstrates live closed-loop HTTP 402 challenge negotiation, Fast-Path micro-allowance deduction, and real-time DOM swapping:
  [https://10x402.blue/algorand](https://10x402.blue/algorand)
