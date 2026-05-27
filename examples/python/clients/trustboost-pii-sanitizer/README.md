# TrustBoost PII Sanitizer — x402 Client Example

This example demonstrates how an autonomous agent sanitizes PII
from text using **TrustBoost** before completing an x402 payment
on Solana — no human intervention required.

## The Privacy Gap in x402 Pipelines

When agents make x402 payments, the payment metadata and payloads
can contain PII — emails, national IDs, API keys, financial data.
TrustBoost sanitizes that payload before it reaches LLMs or
external services, with every paid sanitization anchored on Solana.

## Setup

```bash
cp .env-local .env
uv sync
```

## Usage

```bash
# Trial mode (50 free sanitizations, no wallet needed)
uv run python main.py

# Paid mode (149 USDC on Solana, with on-chain proof)
TRUSTBOOST_TX_HASH=your_solana_tx_hash uv run python main.py
```

## How It Works

1. Agent calls POST /sanitize without tx_hash
2. Receives HTTP 402 with x402 payment instructions
3. Pays 149 USDC on Solana mainnet autonomously
4. Retries with tx_hash → receives sanitized text + on-chain proof
5. Verifies proof at GET /verify/{anchor_tx}

## Supported PII Types

- EN: SSN, API keys, credit cards, passwords, emails
- ES-LATAM: RFC (Mexico), CUIT (Argentina), CURP, DNI
- PT-BR: CPF, CNPJ (Brazil)
- DE: Personalausweis, IBAN DE
- JA: マイナンバー, 運転免許証
- FR: NIR, SIRET, Carte Vitale
- IT: Codice Fiscale, Partita IVA
- KO: 주민등록번호 (RRN)

## Context Modes

Set TRUSTBOOST_CONTEXT to: general, legal, financial, medical, code

## Resources

- GitHub: https://github.com/teodorofodocrispin-cmyk/TrustBoost-PII-Sanitizer
- Agent Card: https://api.trustboost.dev/.well-known/agent-card.json
- Health: https://api.trustboost.dev/health
- Verify: https://api.trustboost.dev/verify/{anchor_tx}
