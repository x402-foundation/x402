---
title: "Welcome to x402"
description: >-
  This guide will help you understand x402, the open payment standard, and help
  you get started building or integrating services with x402.
---

x402 is the open payment standard that enables services to charge for access to their APIs and content directly over HTTP. It is built around the HTTP `402 Payment Required` status code and allows clients to programmatically pay for resources without accounts, sessions, or credential management.

With x402, any web service can require payment before serving a response, using crypto-native payments for speed, privacy, and efficiency.

**Want to contribute to our docs?** [The GitBook repo is open to PRs! ](https://github.com/x402-foundation/x402) Our only ask is that you keep these docs as a neutral resource, with no branded content other than linking out to other resources where appropriate.

**Note about the docs:** These docs are the credibly neutral source of truth for x402, as x402 is a completely open standard under the Apache-2.0 license. Coinbase Developer Platform is currently sponsoring [AI-powered docs for users here](https://docs.cdp.coinbase.com/x402/welcome), as we migrate to our own AI-powered solution on the main x402.org domain.

### Why Use x402?

x402 offers:

- **No fees and minimal friction** x402 as a standard has 0 fees built in.
- **Native support for machine-to-machine payments**, enabling seamless use by AI agents
- **Built-in micropayment support**, making it easy to monetize usage-based services

### Who is x402 for?

- **Sellers:** Service providers who want to monetize their APIs or content. x402 enables direct, programmatic payments from clients with minimal setup.
- **Buyers:** Human developers and AI agents seeking to access paid services without accounts or manual payment flows.

Both sellers and buyers interact directly through HTTP requests, with payment handled transparently through the protocol.

### What Can You Build?

x402 enables a range of use cases, including:

- API services paid per request
- AI agents that autonomously pay for API access
- [Paywalls](https://x.com/MurrLincoln/status/1935406976881803601) for digital content
- Microservices and tooling monetized via microtransactions
- Proxy services that aggregate and resell API capabilities

### How Does It Work?

At a high level, the flow is simple:

1. A buyer requests a resource from a server.
2. If payment is required, the server responds with `402 Payment Required`, including payment instructions.
3. The buyer prepares and submits a payment payload.
4. The server verifies and settles the payment independently, or by leveraging an x402 facilitator's /verify and /settle endpoints.
5. If payment is valid, the server provides the requested resource.

For more detail, see:

- [Client / Server](/core-concepts/client-server)
- [Facilitator](/core-concepts/facilitator)
- [HTTP 402](/core-concepts/http-402)

The goal is to make programmatic commerce accessible, permissionless, and developer-friendly.

### Get Started

Ready to build? Start here:

- [Quickstart for Sellers](/getting-started/quickstart-for-sellers)
- [Quickstart for Buyers](/getting-started/quickstart-for-buyers)
- [Explore Core Concepts](/core-concepts/http-402)
- [Join our community on Discord](https://discord.gg/invite/cdp)
