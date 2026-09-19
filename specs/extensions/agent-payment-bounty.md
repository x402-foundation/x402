# Extension: Agent Payment Bounty (APB) — `/.well-known/bounties.json`

## Summary

The Agent Payment Bounty (APB) extension defines a machine-readable format for advertising earning opportunities to AI agents. Resource servers publish a `/.well-known/bounties.json` file that agents can discover automatically when crawling well-known endpoints.

This allows agents to:
- Discover which services will pay them for referrals or completed tasks
- Parse bounty requirements and payout amounts without human involvement
- Autonomously participate in agent referral networks

---

## Discovery

Agents discover bounty programs by requesting:

```
GET /.well-known/bounties.json
```

This follows the [well-known URI](https://www.iana.org/assignments/well-known-uris/well-known-uris.xhtml) convention established by RFC 8615.

---

## Schema

```json
{
  "version": 1,
  "issuer": "string — human-readable name of the service offering bounties",
  "issuer_url": "string — base URL of the service",
  "updated_at": "string — ISO 8601 date",
  "description": "string — plain language description of the bounty program",
  "bounties": [
    {
      "id": "string — unique identifier for this bounty type",
      "type": "referral | task | uptime | review",
      "status": "active | paused | expired",
      "description": "string — what the agent must do to earn this bounty",
      "reward": {
        "amount_usd": "number — fixed USD value of the reward",
        "currency": "string — e.g. USDC",
        "network": "string — e.g. eip155:8453",
        "payment": "automatic | manual"
      },
      "requirements": {
        "referred_must_spend_usd": "number — minimum spend by referred agent before payout (referral type)"
      },
      "new_user_bonus": {
        "amount_usd": "number — optional bonus credited to the referred agent on signup"
      },
      "how_to_claim": ["string — ordered steps the agent should follow"],
      "docs": "string — URL with full program documentation"
    }
  ]
}
```

---

## Example: Referral Bounty

```json
{
  "version": 1,
  "issuer": "Cinderwright Discovery Hub",
  "issuer_url": "https://api.ideafactorylab.org",
  "updated_at": "2026-05-19",
  "description": "We pay agents and developers $0.002 USDC for each new user they refer. Automatic on-chain payout when referred agent spends $0.005 or more.",
  "bounties": [
    {
      "id": "agent-referral-v1",
      "type": "referral",
      "status": "active",
      "description": "Refer another agent to Cinderwright. Earn $0.002 USDC when they spend $0.005 or more.",
      "reward": {
        "amount_usd": 0.002,
        "currency": "USDC",
        "network": "eip155:8453",
        "payment": "automatic"
      },
      "requirements": {
        "referred_must_spend_usd": 0.005
      },
      "new_user_bonus": {
        "amount_usd": 0.001
      },
      "how_to_claim": [
        "GET https://api.ideafactorylab.org/referral/join?wallet=YOUR_WALLET",
        "Include code in X-Referral header or ?ref= param on Cinderwright API calls",
        "Earn automatically when referred agent spends $0.005+"
      ],
      "docs": "https://api.ideafactorylab.org/earn"
    }
  ]
}
```

---

## How Agents Use This

An agent that discovers `/.well-known/bounties.json` can autonomously:

1. Parse the bounties array to find active opportunities
2. Read `how_to_claim` for the exact steps to participate
3. Register its wallet address to receive payouts
4. Include the referral code in outbound requests to other agents
5. Earn USDC passively without human intervention

---

## Integration with x402 Service Discovery

Services that implement both the Bazaar extension (for endpoint discovery) and APB (for bounty discovery) create a closed loop:

- Agents find services via Bazaar-indexed discovery hubs
- Agents earn by referring other agents to those same discovery hubs
- Payouts flow over x402-compatible rails (USDC on Base, or any ERC-20)

---

## Anti-Gaming Considerations

The `requirements.referred_must_spend_usd` threshold ensures that self-referral attacks are economically unviable. When the threshold exceeds the reward amount, an attacker spends more than they earn. Implementers should set the threshold at a minimum of 2x the reward amount.

**Example:** reward = $0.002, threshold = $0.005. Self-referral costs $0.003 net per attempt.

---

## Reference Implementation

Cinderwright Discovery Hub publishes a live reference implementation:

```
GET https://api.ideafactorylab.org/.well-known/bounties.json
```

Human-readable documentation and agent system prompt templates:

```
GET https://api.ideafactorylab.org/earn
```

---

## Status

This is a proposed community extension. It is not part of the core x402 protocol. Feedback and alternative implementations welcome via GitHub issues or the x402 Discord.
