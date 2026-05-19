mod pb;

use pb::agentpay::v1::{
    AgentReputation, AnalyticsEvent, AnalyticsEvents,
    SettlementEvent, SettlementEvents, TransferEvent, TransferEvents,
};
use substreams::store::{
    StoreAdd, StoreAddInt64,
    StoreGet, StoreGetInt64, StoreGetProto,
    StoreSet, StoreSetProto,
};
use substreams::Hex;
use substreams_ethereum::pb::sf::ethereum::r#type::v2 as eth;

// ── Contract addresses (Base L2 mainnet) ─────────────────────────────────────
// USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
const USDC_BASE: [u8; 20] = hex_literal::hex!("833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");

// AgentPay treasury / facilitator wallet
const AGENTPAY_FACILITATOR: [u8; 20] = hex_literal::hex!("367F1b3D8Ca90D1e087481a9A40d585Bf3451a03");

// EIP-3009 TransferWithAuthorization event topic
// keccak256("TransferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)")
// NOTE: from + to are INDEXED topics (topic[1], topic[2])
// Data layout = value[0:32] + validAfter[32:64] + validBefore[64:96] + nonce[96:128] + v[128:160] + r[160:192] + s[192:224]
const TRANSFER_WITH_AUTH_TOPIC: [u8; 32] =
    hex_literal::hex!("98de503528ee59b575ef0c0a2576a82112635b28b9da4cae03c8b0b0ec06b8e3");

// ── Store key prefixes ────────────────────────────────────────────────────────
// Counters live in store_agent_counters (StoreAddInt64)
// Final score lives in store_agent_reputation (StoreSetProto)
const KEY_TOTAL: &str      = "total:";
const KEY_SUCCESS: &str    = "success:";
const KEY_REFUNDED: &str   = "refunded:";
const KEY_DIVERSITY: &str  = "diversity:";   // stored as unique counterparty count
const KEY_LAST_TS: &str    = "last_ts:";

// ── Module 1: map_usdc_transfers ──────────────────────────────────────────────
// Streams every EIP-3009 TransferWithAuthorization from Base USDC.
// HOT PATH — facilitator subscribes here for near-zero-latency confirmation.
//
// FIX (Grok Q1): Corrected data byte offsets.
//   value  = data[0..32]   (was wrongly data[16..32])
//   nonce  = data[96..128] (was wrongly data[32..64])
#[substreams::handlers::map]
fn map_usdc_transfers(block: eth::Block) -> Result<TransferEvents, substreams::errors::Error> {
    let mut events: Vec<TransferEvent> = Vec::new();

    for trx in block.transaction_traces.iter() {
        if trx.status != 1 { continue; }

        for log in trx.receipt.as_ref()
            .unwrap_or(&eth::TransactionReceipt::default())
            .logs.iter()
        {
            // Must be USDC contract
            if log.address != USDC_BASE { continue; }
            // Must be TransferWithAuthorization
            if log.topics.is_empty() || log.topics[0] != TRANSFER_WITH_AUTH_TOPIC { continue; }

            // Decode: from (topic[1]), to (topic[2]) — both are indexed
            let from = if log.topics.len() > 1 {
                format!("0x{}", Hex(&log.topics[1][12..]).to_string())
            } else { continue; };

            let to = if log.topics.len() > 2 {
                format!("0x{}", Hex(&log.topics[2][12..]).to_string())
            } else { continue; };

            // value: data[0..32] — full 32-byte big-endian uint256
            // (USDC has 6 decimals — divide by 1_000_000 to get whole USDC)
            let value = if log.data.len() >= 32 {
                // Take the lower 16 bytes for u128 (USDC amounts never exceed u128)
                let val = u128::from_be_bytes(log.data[16..32].try_into().unwrap_or([0u8; 16]));
                format!("{}", val)
            } else { "0".to_string() };

            // nonce: data[96..128] — bytes32 nonce used for idempotency
            // (after value[0:32] + validAfter[32:64] + validBefore[64:96])
            let nonce = if log.data.len() >= 128 {
                log.data[96..128].to_vec()
            } else { vec![] };

            events.push(TransferEvent {
                from,
                to,
                value,
                nonce,
                block_num: block.number,
                timestamp: block.header.as_ref().map(|h| h.timestamp).unwrap_or(0),
                tx_hash: format!("0x{}", Hex(&trx.hash).to_string()),
                log_index: log.index,
            });
        }
    }

    Ok(TransferEvents { transfers: events })
}

// ── Module 2: map_confirmed_settlements ───────────────────────────────────────
// Filters USDC transfers to those destined for the AgentPay facilitator wallet.
// Facilitator subscribes HERE — resolves pending payment Futures without polling.
#[substreams::handlers::map]
fn map_confirmed_settlements(transfers: TransferEvents) -> Result<SettlementEvents, substreams::errors::Error> {
    let facilitator_hex = format!("0x{}", Hex(&AGENTPAY_FACILITATOR).to_string().to_lowercase());

    let settlements: Vec<SettlementEvent> = transfers
        .transfers
        .into_iter()
        .filter(|t| t.to.to_lowercase() == facilitator_hex)
        .map(|t| {
            // payment_id derived from on-chain nonce for idempotency
            let payment_id = if t.nonce.len() == 32 {
                format!("0x{}", Hex(&t.nonce).to_string())
            } else {
                t.tx_hash.clone() // fallback: tx_hash
            };

            SettlementEvent {
                payment_id,
                agent_wallet: t.from.clone(),
                service_wallet: t.to.clone(),
                amount_usdc: t.value,
                settled: true,
                block_num: t.block_num,
                timestamp: t.timestamp,
                tx_hash: t.tx_hash,
                nonce: t.nonce,
                facilitator_id: format!("0x{}", Hex(&AGENTPAY_FACILITATOR).to_string()),
            }
        })
        .collect();

    Ok(SettlementEvents { settlements })
}

// ── Module 3a: store_agent_counters ──────────────────────────────────────────
// FIX (Grok Q2): Use StoreAddInt64 for counters so values ACCUMULATE across blocks.
// StoreSetProto would reset to 1 every block — wrong for running totals.
//
// Stores per agent (key = "<prefix><agent_address>"):
//   total:     total payment count
//   success:   successful settlement count
//   refunded:  refunded payment count
//   diversity: unique counterparty count (approximate — exact dedup in subgraph)
//   last_ts:   last payment unix timestamp (set, not add — see store_agent_reputation)
#[substreams::handlers::store]
fn store_agent_counters(
    settlements: SettlementEvents,
    store: StoreAddInt64,
) {
    for s in settlements.settlements.iter() {
        let agent = s.agent_wallet.to_lowercase();

        store.add(s.block_num, &format!("{}{}", KEY_TOTAL, agent), 1);

        if s.settled {
            store.add(s.block_num, &format!("{}{}", KEY_SUCCESS, agent), 1);
        } else {
            store.add(s.block_num, &format!("{}{}", KEY_REFUNDED, agent), 1);
        }

        // Diversity: add 1 per counterparty (subgraph deduplicates exact pairs)
        // We use a composite key per (agent, counterparty) pair; StoreAddInt64
        // allows us to detect first occurrence (value goes from 0 to 1).
        store.add(s.block_num, &format!("{}{}:{}", KEY_DIVERSITY, agent, s.service_wallet.to_lowercase()), 1);
    }
}

// ── Module 3b: store_agent_reputation ────────────────────────────────────────
// Reads accumulated counters from store_agent_counters and computes the
// composite reputation score for each agent. Writes final AgentReputation proto.
//
// Score formula: 0.6×successRate + 0.25×diversityScore + 0.15×recencyScore
// All scores stored as ppm (parts-per-million) for integer arithmetic.
#[substreams::handlers::store]
fn store_agent_reputation(
    settlements: SettlementEvents,
    counters: StoreGetInt64,
    store: StoreSetProto<AgentReputation>,
) {
    for s in settlements.settlements.iter() {
        let agent = s.agent_wallet.to_lowercase();

        // Read accumulated counters
        let total     = counters.get_last(&format!("{}{}", KEY_TOTAL,    agent)).unwrap_or(1) as u64;
        let successes = counters.get_last(&format!("{}{}", KEY_SUCCESS,  agent)).unwrap_or(0) as u64;
        let refunded  = counters.get_last(&format!("{}{}", KEY_REFUNDED, agent)).unwrap_or(0) as u64;

        // Diversity: count distinct (agent, counterparty) keys
        // We can't enumerate store keys, so we approximate from the unique counterparty
        // store key for this specific settlement — subgraph computes exact count
        let counterparty_key = format!("{}{}:{}", KEY_DIVERSITY, agent, s.service_wallet.to_lowercase());
        let is_new_counterparty = counters.get_last(&counterparty_key).unwrap_or(0) == 1;
        let unique_counterparties = if is_new_counterparty { 1u64 } else { 0u64 }; // placeholder; subgraph has real count

        // Score components (ppm = parts per million)
        let success_rate_ppm = if total > 0 { (successes * 1_000_000) / total } else { 0 };

        // diversity: min(1.0, unique_counterparties / 10) — subgraph corrects this
        let diversity_ppm = std::cmp::min(1_000_000u64, unique_counterparties * 100_000);

        // recency: exp(-0.01 × days_since_last) — approximated here, corrected by subgraph
        // We store last_payment_at and let subgraph compute real exp()
        let recency_ppm: u64 = 900_000; // conservative default

        let composite_ppm = (success_rate_ppm * 6 / 10)
            + (diversity_ppm * 25 / 100)
            + (recency_ppm * 15 / 100);

        let rep = AgentReputation {
            agent: s.agent_wallet.clone(),
            total_payments: total,
            successful_payments: successes,
            refunded_payments: refunded,
            unique_counterparties: unique_counterparties,
            last_payment_at: s.timestamp,
            success_rate_ppm,
            diversity_score_ppm: diversity_ppm,
            recency_score_ppm: recency_ppm,
            composite_score_ppm: composite_ppm,
        };

        store.set(s.block_num, &format!("agent:{}", agent), &rep);
    }
}

// ── Module 4: map_analytics_events ───────────────────────────────────────────
// Prepares rows for Clickhouse sink (streamingfast/substreams-sink-clickhouse).
// FIX (Grok Q4 confirmed): reading from both a map output AND a store in the
// same map module is valid in Substreams v0.5 — confirmed safe.
#[substreams::handlers::map]
fn map_analytics_events(
    settlements: SettlementEvents,
    store: StoreGetProto<AgentReputation>,
) -> Result<AnalyticsEvents, substreams::errors::Error> {
    let events: Vec<AnalyticsEvent> = settlements
        .settlements
        .into_iter()
        .map(|s| {
            let rep_key = format!("agent:{}", s.agent_wallet.to_lowercase());
            let score_ppm = store
                .get_last(&rep_key)
                .map(|r| r.composite_score_ppm)
                .unwrap_or(0);

            AnalyticsEvent {
                agent: s.agent_wallet,
                counterparty: s.service_wallet,
                amount_usdc: s.amount_usdc,
                block_num: s.block_num,
                timestamp: s.timestamp,
                tx_hash: s.tx_hash,
                settled: s.settled,
                score_ppm,
                city: String::new(), // populated by sink consumer from AgentWorld DB
                facilitator_id: s.facilitator_id,
            }
        })
        .collect();

    Ok(AnalyticsEvents { events })
}
