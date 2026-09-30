# PROJECT-IDEAS.md

> **📌** Not all of the third‑party APIs listed below natively support x402 today—and that’s totally fine.
> Wrap any API or scraper you need behind a thin x402 server (a dozen lines of code), then let agents pay through the protocol.
> Have questions? Open a grant or reach out to @murrlincoln on X or GitHub.

---

## How to Contribute

1. **Pick or build your own project.** 
2. **Stand up a wrapper.** Build a small HTTP service (and/or MCP Server) that calls the required API and exposes a paid endpoint.
3. **Show, don’t tell.** Record a ≤ 2‑minute video of an agent or human using your service and tag @coinbaseDev on X.

Impact-based micro‑grants up to **\$3k** are available for projects that unlock new demand or supply and are live on mainnet.

---

### Unstoppable Agent

* **What it does:** An unstoppable agent that provisions inference or tooling via x402.
* **Payment moment:** Each API invocation.
* **Suggested APIs:** Any model of your choice, decentralized hosting provider.
* You can put it in a sandbox with other agents and have them create a x402-enabled society together. All sorts of interesting experiments to run.

---

## Financial Agents

### Wealth‑Manager Trading Bot

* Executes algorithmic trades and reports performance ("Yesterday I earned x %").
* **Payment moments:** Per‑data fetch and per‑trade fee (streamed).
* **Suggested APIs:** Messari, token price data, web search, web scraping like Firecrawl.

### Prediction‑Market Oracle

* Agent resolves any prediction market by fetching consensus facts online.
* **Payment moment:** Resolution fee on settlement.
* **Suggested APIs:** Web search and web scrape.

### Rapid KYC/AML Checker

* Pay \$0.25 to screen a wallet address against sanctions lists or heuristics.
* **Payment moment:** Flat per‑check fee.
* **Suggested APIs:** Chainalysis, TRM, or your own heuristics.

---

## Commerce Agents

### Purchase‑With‑Crypto Shopper

* Agent fills a cart and checks out via Coinbase Commerce or Crossmint.
* **Payment moment:** Single checkout; optional per‑lookup scraping fee.
* **Suggested APIs:** Firecrawl scraping, Crossmint / Flxpoint commerce API, browser automation for long‑tail sites.

### Agentic Commerce Proof‑of‑Concept

* End‑to‑end merchant checkout driven by an agent paying through x402.
---

## Knowledge & Services

### Bounty‑Hunter Agent

* Scans for open bounties, completes tasks, claims reward.
* **Payment moments:** Entry fee; streaming pay‑as‑you‑work compute.
* **Suggested APIs:** Bountycaster, basic web‑scrape, image gen, code sandbox.

### One‑Off Code Review Marketplace

* Any dev can highlight code and pay \$5 for expert review.
* **Payment moment:** Flat fee when review bundle is delivered.

### Consultant Agent

* Finds an expert, books a call, pays automatically.
* **Payment moment:** Up‑front booking fee.
* **Suggested APIs:** Cal.com., Twilio, XTMP messaging, LinkedIn search.

### Dynamic Endpoint Shopper

* Agent discovers an MCP registry, pays for its service, chains results.
* **Payment moments:** Pay‑per‑call to each discovered endpoint.
* **Suggested APIs:** Toolbox MCP registry + target MCP.

### Real‑Time Fact Checker

* Journalists highlight a claim; agent finds supporting sources and pays per page.
* **Payment moment:** Per‑page retrieval.
* **Suggested APIs:** Exa Search, snapshots via Browserbase.

### Pay‑As‑You‑Learn Tutor

* Every executed command explanation costs 1 cent; itemized bill at session end.

### Weather‑Triggered Donations

* When temp drops below a threshold or a tornado warning hits, agent donates to a local org.

### Facebook‑Marketplace Buyer

* Agent negotiates and buys local items.
* **Payment moments:** Deposit on agreement; final payment on pickup.
* **Suggested APIs:** Web‑scrape, Browserbase / Stagehand chat, reverse‑image search.

### Bounty Poster

* Agent outsources tasks it can’t finish, posts bounties automatically.
* **Payment moment:** Listing fee per bounty.
* **Suggested APIs:** Craigslist API or Bountycaster.

---

## Need Something Else?

Have an idea that doesn’t fit? **We’re flexible.** Pitch it in an issue, outline the APIs you’ll wrap, and we’ll help you scope it.
