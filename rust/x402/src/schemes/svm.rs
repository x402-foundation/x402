use crate::errors::{X402Error, X402Result};
use crate::types::PaymentRequirements;
use serde::{Deserialize, Serialize};
use solana_sdk::compute_budget::ComputeBudgetInstruction;
use solana_sdk::hash::Hash;
use solana_sdk::message::Message;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::Transaction;
use spl_associated_token_account::get_associated_token_address_with_program_id;
use spl_token::instruction::transfer_checked;
use base64::Engine;
use std::str::FromStr;

/// The SVM payment payload — a base64-encoded partially-signed Solana transaction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExactSvmPayload {
    pub transaction: String,
}

// ──────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────

/// SPL Token Program address.
pub const TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/// SPL Token-2022 Program address.
pub const TOKEN_2022_PROGRAM_ID: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/// Default compute unit limit for x402 SVM transactions.
pub const DEFAULT_COMPUTE_UNIT_LIMIT: u32 = 6500;
/// Default compute unit price in microlamports.
pub const DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS: u64 = 1;
/// Maximum allowed compute unit price in microlamports.
pub const MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS: u64 = 5_000_000;

/// Solana Mainnet CAIP-2 identifier.
pub const SOLANA_MAINNET_CAIP2: &str = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
/// Solana Devnet CAIP-2 identifier.
pub const SOLANA_DEVNET_CAIP2: &str = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
/// Solana Testnet CAIP-2 identifier.
pub const SOLANA_TESTNET_CAIP2: &str = "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z";

/// USDC Mint on Solana Mainnet.
pub const USDC_MAINNET: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/// USDC Mint on Solana Devnet.
pub const USDC_DEVNET: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

// ──────────────────────────────────────────────────
// Network helpers
// ──────────────────────────────────────────────────

/// Convert a network string to its canonical CAIP-2 form.
pub fn normalize_network(network: &str) -> X402Result<&'static str> {
    if network.contains(':') {
        match network {
            n if n == SOLANA_MAINNET_CAIP2 => Ok(SOLANA_MAINNET_CAIP2),
            n if n == SOLANA_DEVNET_CAIP2 => Ok(SOLANA_DEVNET_CAIP2),
            n if n == SOLANA_TESTNET_CAIP2 => Ok(SOLANA_TESTNET_CAIP2),
            _ => Err(X402Error::ConfigError(format!(
                "unsupported SVM network '{network}'"
            ))),
        }
    } else {
        match network {
            "solana" => Ok(SOLANA_MAINNET_CAIP2),
            "solana-devnet" => Ok(SOLANA_DEVNET_CAIP2),
            "solana-testnet" => Ok(SOLANA_TESTNET_CAIP2),
            other => Err(X402Error::ConfigError(format!(
                "unsupported SVM network '{other}', try using CAIP-2 naming convention"
            ))),
        }
    }
}

// ──────────────────────────────────────────────────
// Transaction construction
// ──────────────────────────────────────────────────

/// Build a partially-signed SPL token transfer transaction for x402 payment.
///
/// The transaction contains exactly 3 instructions:
/// 1. `SetComputeUnitLimit`
/// 2. `SetComputeUnitPrice`
/// 3. `TransferChecked` (SPL Token or Token-2022)
///
/// The token owner signs; the fee_payer signature slot is left empty
/// for the facilitator to fill in at settlement.
pub fn create_transfer_transaction<S: Signer>(
    signer: &S,
    requirement: &PaymentRequirements,
    token_program_id: &Pubkey,
    token_decimals: u8,
    recent_blockhash: Hash,
) -> X402Result<ExactSvmPayload> {
    let (pay_to, amount_str, asset_str, extra) = match requirement {
        PaymentRequirements::V1(req) => (
            req.pay_to.as_str(),
            req.max_amount_required.as_str(),
            Some(req.asset.as_str()),
            &req.extra,
        ),
        PaymentRequirements::V2(req) => (
            req.pay_to.as_str(),
            req.amount.as_str(),
            req.asset.as_deref(),
            &req.extra,
        ),
    };

    let owner = signer.pubkey();

    let mint = Pubkey::from_str(asset_str.ok_or_else(|| {
        X402Error::ConfigError("asset (token mint) is required for SVM".into())
    })?)
    .map_err(|e| X402Error::Internal(format!("invalid mint address: {e}")))?;

    let destination_owner = Pubkey::from_str(pay_to)
        .map_err(|e| X402Error::Internal(format!("invalid payTo address: {e}")))?;

    let fee_payer_str = extra
        .as_ref()
        .and_then(|e| e["feePayer"].as_str())
        .ok_or_else(|| X402Error::ConfigError("extra.feePayer required for SVM".into()))?;
    let fee_payer = Pubkey::from_str(fee_payer_str)
        .map_err(|e| X402Error::Internal(format!("invalid feePayer address: {e}")))?;

    let amount: u64 = amount_str
        .parse()
        .map_err(|e| X402Error::Internal(format!("invalid amount: {e}")))?;

    // Derive Associated Token Accounts
    let source_ata =
        get_associated_token_address_with_program_id(&owner, &mint, token_program_id);
    let dest_ata =
        get_associated_token_address_with_program_id(&destination_owner, &mint, token_program_id);

    // Build instructions
    let compute_limit_ix =
        ComputeBudgetInstruction::set_compute_unit_limit(DEFAULT_COMPUTE_UNIT_LIMIT);
    let compute_price_ix =
        ComputeBudgetInstruction::set_compute_unit_price(DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS);
    let transfer_ix = transfer_checked(
        token_program_id,
        &source_ata,
        &mint,
        &dest_ata,
        &owner,
        &[], // no multisig signers
        amount,
        token_decimals,
    )
    .map_err(|e| X402Error::Internal(format!("failed to build transfer instruction: {e}")))?;

    // Build transaction with facilitator as fee payer
    let message = Message::new_with_blockhash(
        &[compute_limit_ix, compute_price_ix, transfer_ix],
        Some(&fee_payer),
        &recent_blockhash,
    );

    let mut tx = Transaction::new_unsigned(message);
    // Partially sign — only the token owner signs now; facilitator signs later
    tx.partial_sign(&[signer], recent_blockhash);

    // Serialize to base64
    let serialized = bincode::serialize(&tx)
        .map_err(|e| X402Error::Internal(format!("transaction serialization failed: {e}")))?;
    let transaction_b64 = base64::engine::general_purpose::STANDARD.encode(&serialized);

    Ok(ExactSvmPayload {
        transaction: transaction_b64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::PaymentRequirementsV2;
    use solana_sdk::signature::Keypair;

    fn make_svm_requirement(
        fee_payer: &str,
        pay_to: &str,
        amount: &str,
        mint: &str,
    ) -> PaymentRequirements {
        let mut extra = serde_json::Map::new();
        extra.insert(
            "feePayer".to_string(),
            serde_json::Value::String(fee_payer.to_string()),
        );
        PaymentRequirements::V2(PaymentRequirementsV2 {
            scheme: "exact".to_string(),
            network: SOLANA_DEVNET_CAIP2.to_string(),
            pay_to: pay_to.to_string(),
            amount: amount.to_string(),
            asset: Some(mint.to_string()),
            data: None,
            extra: Some(serde_json::Value::Object(extra)),
            max_timeout_seconds: 300,
        })
    }

    #[test]
    fn test_normalize_network_caip2() {
        assert_eq!(
            normalize_network(SOLANA_MAINNET_CAIP2).unwrap(),
            SOLANA_MAINNET_CAIP2
        );
        assert_eq!(
            normalize_network(SOLANA_DEVNET_CAIP2).unwrap(),
            SOLANA_DEVNET_CAIP2
        );
    }

    #[test]
    fn test_normalize_network_legacy() {
        assert_eq!(normalize_network("solana").unwrap(), SOLANA_MAINNET_CAIP2);
        assert_eq!(
            normalize_network("solana-devnet").unwrap(),
            SOLANA_DEVNET_CAIP2
        );
    }

    #[test]
    fn test_normalize_network_unsupported() {
        assert!(normalize_network("ethereum").is_err());
        assert!(normalize_network("solana:invalid_hash").is_err());
    }

    #[test]
    fn test_create_transfer_transaction() {
        let owner = Keypair::new();
        let fee_payer = Keypair::new();
        let recipient = Keypair::new();
        let token_program = Pubkey::from_str(TOKEN_PROGRAM_ID).unwrap();

        let requirement = make_svm_requirement(
            &fee_payer.pubkey().to_string(),
            &recipient.pubkey().to_string(),
            "1000000",
            USDC_DEVNET,
        );

        let result = create_transfer_transaction(
            &owner,
            &requirement,
            &token_program,
            6,
            Hash::default(),
        );

        assert!(result.is_ok());
        let payload = result.unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&payload.transaction)
            .unwrap();
        let tx: Transaction = bincode::deserialize(&decoded).unwrap();
        assert_eq!(tx.message.instructions.len(), 3);
        assert_eq!(tx.message.account_keys[0], fee_payer.pubkey());
    }

    #[test]
    fn test_create_transfer_missing_fee_payer() {
        let owner = Keypair::new();
        let token_program = Pubkey::from_str(TOKEN_PROGRAM_ID).unwrap();

        let requirement = PaymentRequirements::V2(PaymentRequirementsV2 {
            scheme: "exact".to_string(),
            network: SOLANA_DEVNET_CAIP2.to_string(),
            pay_to: Pubkey::new_unique().to_string(),
            amount: "1000000".to_string(),
            asset: Some(USDC_DEVNET.to_string()),
            data: None,
            extra: None,
            max_timeout_seconds: 300,
        });

        let result = create_transfer_transaction(
            &owner,
            &requirement,
            &token_program,
            6,
            Hash::default(),
        );

        assert!(result.is_err());
    }

    #[test]
    fn test_create_transfer_missing_asset() {
        let owner = Keypair::new();
        let fee_payer = Keypair::new();
        let token_program = Pubkey::from_str(TOKEN_PROGRAM_ID).unwrap();

        let mut extra = serde_json::Map::new();
        extra.insert(
            "feePayer".to_string(),
            serde_json::Value::String(fee_payer.pubkey().to_string()),
        );

        let requirement = PaymentRequirements::V2(PaymentRequirementsV2 {
            scheme: "exact".to_string(),
            network: SOLANA_DEVNET_CAIP2.to_string(),
            pay_to: Pubkey::new_unique().to_string(),
            amount: "1000000".to_string(),
            asset: None,
            data: None,
            extra: Some(serde_json::Value::Object(extra)),
            max_timeout_seconds: 300,
        });

        let result = create_transfer_transaction(
            &owner,
            &requirement,
            &token_program,
            6,
            Hash::default(),
        );

        assert!(result.is_err());
    }

    #[test]
    fn test_exact_svm_payload_serde_roundtrip() {
        let payload = ExactSvmPayload {
            transaction: "dGVzdA==".to_string(),
        };
        let json = serde_json::to_value(&payload).unwrap();
        let deserialized: ExactSvmPayload = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.transaction, payload.transaction);
    }
}
