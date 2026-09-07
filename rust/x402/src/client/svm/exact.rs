use crate::client::x402_client::X402Client;
use crate::errors::{X402Error, X402Result};
use crate::schemes::svm::{create_transfer_transaction, normalize_network};
use crate::types::{PaymentPayload, PaymentPayloadV2, PaymentRequired, PaymentRequirements};
use solana_sdk::hash::Hash;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signer::Signer;

/// Client that builds an `exact` SVM (Solana) payment payload for an x402 challenge.
///
/// The client wraps a Solana `Signer` together with the token-program context and a
/// recent blockhash. It only handles `PaymentRequirements::V2` entries whose network
/// resolves to a supported Solana CAIP-2 identifier via [`normalize_network`].
///
/// The recent blockhash is provided by the caller (see [`set_recent_blockhash`]) —
/// the SDK intentionally does not pull in a Solana RPC client. Blockhashes expire,
/// so callers should refresh it before building each payment payload in a long-lived
/// client.
///
/// [`set_recent_blockhash`]: SvmExactClient::set_recent_blockhash
pub struct SvmExactClient<S> {
    signer: S,
    token_program_id: Pubkey,
    token_decimals: u8,
    recent_blockhash: Hash,
}

impl<S> SvmExactClient<S> {
    pub fn new(
        signer: S,
        token_program_id: Pubkey,
        token_decimals: u8,
        recent_blockhash: Hash,
    ) -> Self {
        Self {
            signer,
            token_program_id,
            token_decimals,
            recent_blockhash,
        }
    }

    /// Replace the recent blockhash used for the next payment payload.
    ///
    /// Solana blockhashes are only valid for ~150 slots, so callers should fetch a
    /// fresh one (e.g. via `RpcClient::get_latest_blockhash`) before each payment in
    /// long-running clients.
    pub fn set_recent_blockhash(&mut self, hash: Hash) {
        self.recent_blockhash = hash;
    }
}

#[async_trait::async_trait]
impl<S> X402Client for SvmExactClient<S>
where
    S: Signer + Send + Sync,
{
    async fn create_payment_payload(
        &self,
        required: &PaymentRequired,
    ) -> X402Result<PaymentPayload> {
        svm_exact_build_payload(
            &self.signer,
            required,
            &self.token_program_id,
            self.token_decimals,
            self.recent_blockhash,
        )
    }
}

/// Build a `PaymentPayload` for SVM exact payment requirements.
///
/// Picks the first `PaymentRequirements::V2` entry from the challenge whose network
/// resolves to a supported Solana CAIP-2 identifier, serializes the resulting
/// `ExactSvmPayload` and wraps it in a `PaymentPayloadV2`.
pub fn svm_exact_build_payload<S>(
    signer: &S,
    challenge: &PaymentRequired,
    token_program_id: &Pubkey,
    token_decimals: u8,
    recent_blockhash: Hash,
) -> X402Result<PaymentPayload>
where
    S: Signer,
{
    let accepted = challenge
        .accepts
        .iter()
        .find(|req| match req {
            PaymentRequirements::V2(r) => normalize_network(&r.network).is_ok(),
            _ => false,
        })
        .cloned()
        .ok_or_else(|| {
            X402Error::ConfigError(
                "no V2 SVM-compatible payment requirement found in challenge".into(),
            )
        })?;

    let svm_payload = create_transfer_transaction(
        signer,
        &accepted,
        token_program_id,
        token_decimals,
        recent_blockhash,
    )?;

    let payload_json = serde_json::to_value(&svm_payload)
        .map_err(|e| X402Error::Internal(format!("failed to serialize SVM payload: {e}")))?;

    let payload = PaymentPayloadV2 {
        x402_version: challenge.x402_version,
        resource: challenge.resource.clone(),
        accepted,
        payload: payload_json,
        extensions: challenge.extensions.clone(),
    };
    Ok(PaymentPayload::V2(payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schemes::svm::{SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ID, USDC_DEVNET};
    use crate::types::{PaymentRequirementsV2, Resource};
    use solana_sdk::signature::Keypair;
    use std::str::FromStr;

    fn svm_requirement(fee_payer: &str, pay_to: &str) -> PaymentRequirements {
        let mut extra = serde_json::Map::new();
        extra.insert(
            "feePayer".to_string(),
            serde_json::Value::String(fee_payer.to_string()),
        );
        PaymentRequirements::V2(PaymentRequirementsV2 {
            scheme: "exact".to_string(),
            network: SOLANA_DEVNET_CAIP2.to_string(),
            pay_to: pay_to.to_string(),
            amount: "1000000".to_string(),
            asset: Some(USDC_DEVNET.to_string()),
            data: None,
            extra: Some(serde_json::Value::Object(extra)),
            max_timeout_seconds: 300,
        })
    }

    fn challenge_with(requirements: Vec<PaymentRequirements>) -> PaymentRequired {
        PaymentRequired {
            x402_version: 2,
            resource: Resource::V1("https://example.test/resource".to_string()),
            accepts: requirements,
            description: None,
            extensions: None,
        }
    }

    #[test]
    fn test_svm_exact_build_payload_happy_path() {
        let owner = Keypair::new();
        let fee_payer = Keypair::new();
        let recipient = Keypair::new();
        let token_program = Pubkey::from_str(TOKEN_PROGRAM_ID).unwrap();

        let challenge = challenge_with(vec![svm_requirement(
            &fee_payer.pubkey().to_string(),
            &recipient.pubkey().to_string(),
        )]);

        let result = svm_exact_build_payload(
            &owner,
            &challenge,
            &token_program,
            6,
            Hash::default(),
        );

        let payload = result.expect("build_payload failed");
        match payload {
            PaymentPayload::V2(v2) => {
                assert_eq!(v2.x402_version, 2);
                assert!(v2.payload.get("transaction").is_some());
            }
            PaymentPayload::V1(_) => panic!("expected V2 payload"),
        }
    }

    #[test]
    fn test_svm_exact_build_payload_rejects_non_svm_challenge() {
        // Challenge only contains a non-SVM V2 entry — should fail with ConfigError.
        let non_svm = PaymentRequirements::V2(PaymentRequirementsV2 {
            scheme: "exact".to_string(),
            network: "ethereum".to_string(),
            pay_to: "0x0000000000000000000000000000000000000000".to_string(),
            amount: "1000000".to_string(),
            asset: None,
            data: None,
            extra: None,
            max_timeout_seconds: 300,
        });
        let challenge = challenge_with(vec![non_svm]);

        let owner = Keypair::new();
        let token_program = Pubkey::from_str(TOKEN_PROGRAM_ID).unwrap();

        let result =
            svm_exact_build_payload(&owner, &challenge, &token_program, 6, Hash::default());

        assert!(matches!(result, Err(X402Error::ConfigError(_))));
    }

    #[test]
    fn test_svm_exact_build_payload_picks_svm_among_mixed() {
        // A mixed challenge with an EVM-style entry first and an SVM entry second
        // should still resolve to the SVM entry.
        let evm_style = PaymentRequirements::V2(PaymentRequirementsV2 {
            scheme: "exact".to_string(),
            network: "ethereum".to_string(),
            pay_to: "0x0000000000000000000000000000000000000000".to_string(),
            amount: "1000000".to_string(),
            asset: None,
            data: None,
            extra: None,
            max_timeout_seconds: 300,
        });
        let fee_payer = Keypair::new();
        let recipient = Keypair::new();
        let svm = svm_requirement(
            &fee_payer.pubkey().to_string(),
            &recipient.pubkey().to_string(),
        );
        let challenge = challenge_with(vec![evm_style, svm]);

        let owner = Keypair::new();
        let token_program = Pubkey::from_str(TOKEN_PROGRAM_ID).unwrap();

        let payload = svm_exact_build_payload(
            &owner,
            &challenge,
            &token_program,
            6,
            Hash::default(),
        )
        .expect("build_payload failed");

        match payload {
            PaymentPayload::V2(v2) => match v2.accepted {
                PaymentRequirements::V2(r) => assert_eq!(r.network, SOLANA_DEVNET_CAIP2),
                PaymentRequirements::V1(_) => panic!("expected V2 requirement"),
            },
            PaymentPayload::V1(_) => panic!("expected V2 payload"),
        }
    }
}
