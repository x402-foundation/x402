mod pb;

use pb::agentpay::v1::{
    AgentReputation, AnalyticsEvent, AnalyticsEvents,
    SettlementEvent, SettlementEvents, TransferEvent, TransferEvents,
};
use substreams::store::{
    StoreAdd, StoreAddInt64,
    StoreGet, StoreGetInt64, StoreGetProto,
    StoreNew, StoreSet, StoreSetProto,
};
use substreams::Hex;
use substreams_ethereum::pb::sf::ethereum::r#type::v2 as eth;

const USDC_BASE: [u8; 20] = hex_literal::hex!("833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const AGENTPAY_FACILITATOR: [u8; 20] = hex_literal::hex!("367F1b3D8Ca90D1e087481a9A40d585Bf3451a03");
const TRANSFER_WITH_AUTH_TOPIC: [u8; 32] =
    hex_literal::hex!("98de503528ee59b575ef0c0a2576a82112635b28b9da4cae03c8b0b0ec06b8e3");

const KEY_TOTAL: &str     = "total:";
const KEY_SUCCESS: &str   = "success:";
const KEY_REFUNDED: &str  = "refunded:";
const KEY_DIVERSITY: &str = "diversity:";

// ── Module 1: map_usdc_transfers ─────────────────────────────────────────────
#[substreams::handlers::map]
fn map_usdc_transfers(block: eth::Block) -> Result<TransferEvents, substreams::errors::Error> {
    let mut events: Vec<TransferEvent> = Vec::new();

    // FIX: timestamp is a prost_types::Timestamp, extract seconds
    let block_ts = block.header.as_ref()
        .and_then(|h| h.timestamp.as_ref())
        .map(|t| t.seconds as u64)
        .unwrap_or(0);

    for trx in block.transaction_traces.iter() {
        if trx.status != 1 { continue; }
        for log in trx.receipt.as_ref()
            .unwrap_or(&eth::TransactionReceipt::default())
            .logs.iter()
        {
            if log.address != USDC_BASE { continue; }
            if log.topics.is_empty() || log.topics[0] != TRANSFER_WITH_AUTH_TOPIC { continue; }

            let from = if log.topics.len() > 1 {
                format!("0x{}", Hex(&log.topics[1][12..]).to_string())
            } else { continue; };

            let to = if log.topics.len() > 2 {
                format!("0x{}", Hex(&log.topics[2][12..]).to_string())
            } else { continue; };

            // FIXED (Grok Q1): value at data[0..32], nonce at data[96..128]
            let value = if log.data.len() >= 32 {
                let val = u128::from_be_bytes(log.data[16..32].try_into().unwrap_or([0u8; 16]));
                format!("{}", val)
            } else { "0".to_string() };

            let nonce = if log.data.len() >= 128 {
                log.data[96..128].to_vec()
            } else { vec![] };

            events.push(TransferEvent {
                from,
                to,
                value,
                nonce,
                block_num: block.number,
                timestamp: block_ts,
                tx_hash: format!("0x{}", Hex(&trx.hash).to_string()),
                log_index: log.index,
            });
        }
    }

    Ok(TransferEvents { transfers: events })
}

// ── Module 2: map_confirmed_settlements ──────────────────────────────────────
#[substreams::handlers::map]
fn map_confirmed_settlements(transfers: TransferEvents) -> Result<SettlementEvents, substreams::errors::Error> {
    let facilitator_hex = format!("0x{}", Hex(&AGENTPAY_FACILITATOR).to_string().to_lowercase());

    let settlements: Vec<SettlementEvent> = transfers
        .transfers
        .into_iter()
        .filter(|t| t.to.to_lowercase() == facilitator_hex)
        .map(|t| {
            let payment_id = if t.nonce.len() == 32 {
                format!("0x{}", Hex(&t.nonce).to_string())
            } else { t.tx_hash.clone() };

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

// ── Module 3a: store_agent_counters (add policy — accumulates) ────────────────
// FIXED (Grok Q2): StoreAddInt64 with StoreNew in scope
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
        store.add(s.block_num, &format!("{}{}:{}", KEY_DIVERSITY, agent, s.service_wallet.to_lowercase()), 1);
    }
}

// ── Module 3b: store_agent_reputation (set policy — final score) ──────────────
#[substreams::handlers::store]
fn store_agent_reputation(
    settlements: SettlementEvents,
    counters: StoreGetInt64,
    store: StoreSetProto<AgentReputation>,
) {
    for s in settlements.settlements.iter() {
        let agent = s.agent_wallet.to_lowercase();

        let total     = counters.get_last(&format!("{}{}", KEY_TOTAL,    agent)).unwrap_or(1).max(1) as u64;
        let successes = counters.get_last(&format!("{}{}", KEY_SUCCESS,  agent)).unwrap_or(0) as u64;
        let refunded  = counters.get_last(&format!("{}{}", KEY_REFUNDED, agent)).unwrap_or(0) as u64;

        let success_rate_ppm = (successes * 1_000_000) / total;
        let recency_ppm: u64 = 900_000;
        let composite_ppm = (success_rate_ppm * 6 / 10) + (135_000u64) + (recency_ppm * 15 / 100);

        let rep = AgentReputation {
            agent: s.agent_wallet.clone(),
            total_payments: total,
            successful_payments: successes,
            refunded_payments: refunded,
            unique_counterparties: 1,
            last_payment_at: s.timestamp,
            success_rate_ppm,
            diversity_score_ppm: 100_000,
            recency_score_ppm: recency_ppm,
            composite_score_ppm: composite_ppm,
        };

        store.set(s.block_num, &format!("agent:{}", agent), &rep);
    }
}

// ── Module 4: map_analytics_events ───────────────────────────────────────────
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
            let score_ppm = store.get_last(&rep_key).map(|r| r.composite_score_ppm).unwrap_or(0);
            AnalyticsEvent {
                agent: s.agent_wallet,
                counterparty: s.service_wallet,
                amount_usdc: s.amount_usdc,
                block_num: s.block_num,
                timestamp: s.timestamp,
                tx_hash: s.tx_hash,
                settled: s.settled,
                score_ppm,
                city: String::new(),
                facilitator_id: s.facilitator_id,
            }
        })
        .collect();

    Ok(AnalyticsEvents { events })
}
