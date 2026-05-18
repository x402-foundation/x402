---
title: "AgentPay Partner Revenue Model"
description: "How partners earn from every x402 settlement routed through the AgentPay facilitator."
---

# AgentPay Partner Revenue Model

Every `$0.02` flat fee collected by the AgentPay x402 facilitator includes an automatic partner revenue allocation — no manual claims, no invoicing.

## Partner Earnings (per $0.02 settlement)

| Recipient | Share | Per Tx | Notes |
|-----------|-------|--------|-------|
| **Partner Pool** | **20-30%** (dynamic) | $0.004-$0.006 | Proportional to referred volume |
| **AgentWorld** | **1%** | $0.0002 | Auto-credited on all AW-routed payments |

## Dynamic Partner Pool Tiers

Partner pool percentage scales with daily transaction volume:

| Daily Volume | Partner Pool Share |
|---|---|
| 0 - 50,000 tx/day | 20% |
| 50,000 - 200,000 tx/day | 25% |
| 200,000+ tx/day | 30% |

## Scale Projections

| Daily Tx | Monthly Fees | Partner Pool (at 20%) | Partner Pool (at 30%) |
|---|---|---|---|
| 1,000 | $600 | $120 | $180 |
| 10,000 | $6,000 | $1,200 | $1,800 |
| 100,000 | $60,000 | $12,000 | $18,000 |
| 1,000,000 | $600,000 | $120,000 | $180,000 |

## Partner Pool Mechanics

- Partners earn **proportional to volume referred** — not a flat guaranteed rate.
- **Unlimited partners** can join — they all share the same pool.
- **Monthly auto-payout** on the 1st to each partner's registered Base L2 wallet.
- No minimums — any amount above gas cost is swept.

### Example

Partner A referred 60% of monthly volume, Partner B referred 40%.  
If the pool totals $1,200 that month: Partner A gets $720, Partner B gets $480.

## How to Become a Partner

1. Integrate the x402 protocol into your platform or agent framework.
2. Pass your `partner_id` in each `/pay` or `/escrow` request to the AgentPay facilitator.
3. Register your Base L2 payout wallet at [x402-agent-pay.com/partner-portal.html](https://x402-agent-pay.com/partner-portal.html).
4. Earnings begin accumulating immediately. Payout on the 1st.

```json
{
  "payer": "0xAgentWallet",
  "payee": "0xServiceWallet",
  "amount_usdc": 0.10,
  "nonce": "unique-nonce-123",
  "partner_id": "your-partner-id"
}
```

## Revenue Summary API

```
GET https://x402-agent-pay.com/revenue-summary
```

Returns monthly breakdowns and current-month earnings per partner ID.

---

*Last updated: May 2026 | [AgentPay x402 Facilitator](https://x402-agent-pay.com)*
