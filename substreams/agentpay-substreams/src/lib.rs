mod pb;

use pb::agentpay::v1::{
    AgentReputation, AnalyticsEvent, AnalyticsEvents,
    SettlementEvent, SettlementEvents, TransferEvent, TransferEvents,
};
use substreams::store::{StoreGet, StoreGetProto, StoreSet, StoreSetProto};
use substreams::Hex;
use substreams_ethereum::pb::sf::ethereum::r#type::v2 as eth;

// ── Contract addresses (Base L2 mainnet) ─────────────────────────────────────
// USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
const USDC_BASE: [u8; 20] = hex_literal::hex!("833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");

// AgentPay facilitator wallet (receives USDC from agents)
// Update this when switching facilitators or adding multi-facilitator support
const AGENTPAY_FACILITATOR: [u8; 20] = hex_literal::hex!("367F1b3D8Ca90D1e087481a9A40d585Bf3451a03");

// EIP-3009 TransferWithAuthorization topic
// keccak256("TransferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)")
const TRANSFER_WITH_AUTH_TOPIC: [u8; 32] =
    hex_literal::hex!("98de503528ee59b575ef0c0a2576a82112635b28b9da4cae03c8b0b0ec06b8e3");

// ── Module 1: map_usdc_transfers ──────────────────────────────────────────────
// Streams every EIP-3009 TransferWithAuthorization from the USDC contract.
// HOT PATH — facilitator subscribes to this for near-zero-latency confirmation.
#[substreams::handlers::map]
fn map_usdc_transfers(block: eth::Block) -> Result<TransferEvents, substreams::errors::Error> {
    let mut events: Vec<TransferEvent> = Vec::new();

    for trx in block.transaction_traces.iter() {
        // Skip failed transactions
        if trx.status != 1 {
            continue;
        }

        for log in trx.receipt.as_ref().unwrap_or(&eth::TransactionReceipt::default()).logs.iter() {
            // Filter: must be USDC contract
            if log.address != USDC_BASE {
                continue;
            }
            // Filter: must be TransferWithAuthorization topic
            if log.topics.is_empty() || log.topics[0] != TRANSFER_WITH_AUTH_TOPIC {
                continue;
            }

            // Decode: from (topic[1]), to (topic[2]), nonce from data
            let from = if log.topics.len() > 1 {
                format!("0x{}", Hex(&log.topics[1][12..]).to_string())
            } else {
                continue;
            };

            let to = if log.topics.len() > 2 {
                format!("0x{}", Hex(&log.topics[2][12..]).to_string())
            } else {
                continue;
            };

            // Value: first 32 bytes of data
            let value = if log.data.len() >= 32 {
                let val = u128::from_be_bytes(log.data[16..32].try_into().unwrap_or([0u8; 16]));
                format!("{}", val) // raw 6-decimal USDC units
            } else {
                "0".to_string()
            };

            // Nonce: bytes 32-64 of data (EIP-3009)
            let nonce = if log.data.len() >= 64 {
                log.data[32..64].to_vec()
            } else {
                vec![]
            };

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
// Filters raw USDC transfers to only those destined for the AgentPay facilitator.
// Constructs a SettlementEvent per confirmed payment — includes idempotency nonce.
// Facilitator subscribes HERE to release service without polling RPC.
#[substreams::handlers::map]
fn map_confirmed_settlements(transfers: TransferEvents) -> Result<SettlementEvents, substreams::errors::Error> {
    let facilitator_hex = format!("0x{}", Hex(&AGENTPAY_FACILITATOR).to_string().to_lowercase());

    let settlements: Vec<SettlementEvent> = transfers
        .transfers
        .into_iter()
        .filter(|t| t.to.to_lowercase() == facilitator_hex)
        .map(|t| {
            // Derive payment_id from nonce — same derivation used in facilitator Python code
            // nonce is the keccak256 of payment_id UUID bytes, stored on-chain for idempotency
            let payment_id = if t.nonce.len() == 32 {
                format!("0x{}", Hex(&t.nonce).to_string())
            } else {
                // Fallback: use tx_hash as payment identifier
                t.tx_hash.clone()
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

// ── Module 3: store_agent_reputation ─────────────────────────────────────────
// Maintains running reputation per agent using Substreams store (persistent KV).
// Score formula: 0.6×successRate + 0.25×diversity + 0.15×recency
// This store feeds the subgraph sink for queryable GraphQL reputation state.
#[substreams::handlers::store]
fn store_agent_reputation(
    settlements: SettlementEvents,
    store: StoreSetProto<AgentReputation>,
) {
    for s in settlements.settlements.iter() {
        let key = format!("agent:{}", s.agent_wallet.to_lowercase());

        // Get existing or create new reputation record
        // Note: In production, use StoreGetProto to read existing before updating
        let mut rep = AgentReputation {
            agent: s.agent_wallet.clone(),
            total_payments: 1,
            successful_payments: if s.settled { 1 } else { 0 },
            refunded_payments: if !s.settled { 1 } else { 0 },
            unique_counterparties: 1,
            last_payment_at: s.timestamp,
            ..Default::default()
        };

        // Compute score components (as parts-per-million for integer math)
        let success_rate = if rep.total_payments > 0 {
            (rep.successful_payments * 1_000_000) / rep.total_payments
        } else {
            0
        };

        let diversity = std::cmp::min(
            1_000_000u64,
            rep.unique_counterparties * 100_000, // min(1.0, counterparties/10)
        );

        // Recency: exp(-0.01 × days) approximated as linear for Wasm
        // Full exp() computed off-chain in subgraph mapping
        let recency: u64 = 900_000; // Default high — updated by subgraph with real exp()

        rep.success_rate_ppm = success_rate;
        rep.diversity_score_ppm = diversity;
        rep.recency_score_ppm = recency;
        rep.composite_score_ppm = (success_rate * 6 / 10)
            + (diversity * 25 / 100)
            + (recency * 15 / 100);

        store.set(s.block_num, &key, &rep);
    }
}

// ── Module 4: map_analytics_events ───────────────────────────────────────────
// Prepares rows for Clickhouse sink (streamingfast/substreams-sink-clickhouse).
// Schema matches what James's team built for the Uniswap pipeline.
// Fields: agent, counterparty, amount, block, timestamp, tx, settled, score, city.
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
