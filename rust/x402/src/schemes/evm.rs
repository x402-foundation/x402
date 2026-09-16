use crate::errors::{X402Error, X402Result};
use crate::types::PaymentRequirements;
use crate::types::PaymentRequirements::{V1, V2};
use alloy::primitives::{Address, B256, U256};
use alloy::signers::{Signature, Signer};
use alloy::sol;
use alloy::sol_types::Eip712Domain;
use rand::RngCore;
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

// EIP-712 structure for the Exact scheme
sol! {
    #[derive(Debug)]
    struct TransferWithAuthorization {
        address from;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
    }
}

/// Creates x402 EIP-712 Domain
pub fn create_exact_eip3009_domain(
    requirements: &PaymentRequirements,
    chain_id: u64,
) -> Eip712Domain {
    match requirements {
        V1(requirements) => {
            // extra must contain { name, version }
            let extra = requirements
                .extra
                .as_ref()
                .expect("requirements.extra must be present for EIP-712 domain");
            let name = extra["name"].as_str().expect("extra.name must be a string");
            let version = extra["version"]
                .as_str()
                .expect("extra.version must be a string");

            let verifying_contract: Address = requirements
                .asset
                .parse()
                .expect("asset must be a valid 0x address");

            Eip712Domain {
                name: Some(name.to_string().into()),
                version: Some(version.to_string().into()),
                chain_id: Some(U256::from(chain_id)),
                verifying_contract: Some(verifying_contract),
                salt: None,
            }
        }
        V2(requirements) => {
            // extra must contain { name, version }
            let extra = requirements
                .extra
                .as_ref()
                .expect("requirements.extra must be present for EIP-712 domain");
            let name = extra["name"].as_str().expect("extra.name must be a string");
            let version = extra["version"]
                .as_str()
                .expect("extra.version must be a string");

            let verifying_contract: Address = requirements
                .asset
                .as_ref()
                .expect("asset (token contract) must be present")
                .parse()
                .expect("asset must be a valid 0x address");

            Eip712Domain {
                name: Some(name.to_string().into()),
                version: Some(version.to_string().into()),
                chain_id: Some(U256::from(chain_id)),
                verifying_contract: Some(verifying_contract),
                salt: None,
            }
        }
    }
}

async fn sign_transfer<S>(
    signer: &S,
    from: Address,
    to: Address,
    value: U256,
    requirement: &PaymentRequirements,
    chain_id: u64,
    valid_for: Option<u64>, // Time in seconds
) -> X402Result<(String, TransferWithAuthorization)>
where
    S: Signer<Signature> + Send + Sync,
{
    // Time window
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let valid_after = U256::from(now.saturating_sub(60)); // 1 minute before
    let valid_before = U256::from(now + valid_for.unwrap_or(300)); // 5 minutes after (or valid_for)

    //  Nonce
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let nonce = B256::from(bytes);

    let auth = TransferWithAuthorization {
        from,
        to,
        value,
        validAfter: valid_after,
        validBefore: valid_before,
        nonce,
    };

    // 5. Domain from requirements
    let domain = create_exact_eip3009_domain(requirement, chain_id);

    // 6. Sign typed data
    let signature = signer
        .sign_typed_data(&auth, &domain)
        .await
        .map_err(|e| crate::errors::X402Error::Internal(e.to_string()))?;

    let signature_hex = format!("0x{}", hex::encode(signature.as_bytes()));

    Ok((signature_hex, auth))
}

pub async fn sign_transfer_with_authorization<S>(
    signer: &S,
    wallet_address: &str,
    requirement: &PaymentRequirements,
    chain_id: u64,
    valid_for: Option<u64>, // Time in seconds
) -> X402Result<(String, TransferWithAuthorization)>
where
    S: Signer<Signature> + Send + Sync,
{
    match requirement {
        V1(req) => {
            // Addresses
            let from: Address = wallet_address.parse().map_err(|e| {
                crate::errors::X402Error::Internal(format!("Invalid from address: {e}"))
            })?;
            let to: Address = req.pay_to.parse().map_err(|e| {
                crate::errors::X402Error::Internal(format!("Invalid to address: {e}"))
            })?;

            // Value (atomic units as decimal string)
            let value = U256::from_str(&req.max_amount_required)
                .map_err(|e| crate::errors::X402Error::Internal(format!("Invalid amount: {e}")))?;

            sign_transfer(signer, from, to, value, requirement, chain_id, valid_for).await
        }
        V2(req) => {
            // Addresses
            let from: Address = wallet_address
                .parse()
                .map_err(|e| X402Error::Internal(format!("Invalid from address: {e}")))?;
            let to: Address = req
                .pay_to
                .parse()
                .map_err(|e| X402Error::Internal(format!("Invalid to address: {e}")))?;

            // Value (atomic units as decimal string)
            let value = U256::from_str(&req.amount)
                .map_err(|e| X402Error::Internal(format!("Invalid amount: {e}")))?;

            sign_transfer(signer, from, to, value, requirement, chain_id, valid_for).await
        }
    }
}

/// Helper util to convert chains string literals to their u64 counterparts.
pub fn network_to_chain_id(network: &str) -> X402Result<u64> {
    // CAIP-2
    if let Some(stripped) = network.strip_prefix("eip155:") {
        let chain_id = stripped.parse::<u64>().map_err(|e| {
            X402Error::ConfigError(format!("invalid eip155 network '{}': {}", network, e))
        })?;
        return Ok(chain_id);
    }
    // Legacy human-readable alias
    match network {
        "base-sepolia" => Ok(84532),
        "base" => Ok(8453),
        "avalanche-fuji" => Ok(43113),
        "avalanche" => Ok(43114),
        other => Err(X402Error::ConfigError(format!(
            "unsupported network '{}', try using CAIP-2 naming convention",
            other
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::PaymentRequirementsV2;
    use alloy::signers::local::PrivateKeySigner;
    use alloy::sol_types::SolStruct;

    #[test]
    fn test_create_exact_eip3009_domain() {
        let chain_id = 1u64;
        let mut extra = serde_json::Map::new();
        extra.insert(
            "name".to_string(),
            serde_json::Value::String("USD Coin".to_string()),
        );
        extra.insert(
            "version".to_string(),
            serde_json::Value::String("2".to_string()),
        );

        let requirements = V2(PaymentRequirementsV2 {
            scheme: "exact".to_string(),
            network: "ethereum".to_string(),
            pay_to: "0x1234567890123456789012345678901234567890".to_string(),
            amount: "1000000".to_string(),
            asset: Some("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".to_string()),
            data: None,
            extra: Some(serde_json::Value::Object(extra)),
            max_timeout_seconds: 60,
        });

        let domain = create_exact_eip3009_domain(&requirements, chain_id);

        assert_eq!(domain.name.as_deref(), Some("USD Coin"));
        assert_eq!(domain.version.as_deref(), Some("2"));
        assert_eq!(domain.chain_id, Some(U256::from(chain_id)));
        assert_eq!(
            domain.verifying_contract,
            Some(
                "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
                    .parse()
                    .unwrap()
            )
        );
        assert_eq!(domain.salt, None);
    }

    #[test]
    fn test_transfer_with_authorization_structure() {
        let from = Address::repeat_byte(1);
        let to = Address::repeat_byte(2);
        let value = U256::from(100);
        let valid_after = U256::from(0);
        let valid_before = U256::from(1000);
        let nonce = B256::repeat_byte(3);

        let auth = TransferWithAuthorization {
            from,
            to,
            value,
            validAfter: valid_after,
            validBefore: valid_before,
            nonce,
        };

        assert_eq!(auth.from, from);
        assert_eq!(auth.to, to);
        assert_eq!(auth.value, value);
        assert_eq!(auth.validAfter, valid_after);
        assert_eq!(auth.validBefore, valid_before);
        assert_eq!(auth.nonce, nonce);
    }

    #[tokio::test]
    async fn test_sign_transfer_with_authorization() {
        let signer = PrivateKeySigner::random();
        let wallet_address = format!("{:?}", signer.address());
        let chain_id = 1;

        let mut extra = serde_json::Map::new();
        extra.insert(
            "name".to_string(),
            serde_json::Value::String("USD Coin".to_string()),
        );
        extra.insert(
            "version".to_string(),
            serde_json::Value::String("2".to_string()),
        );

        let requirement = V2(PaymentRequirementsV2 {
            scheme: "exact".to_string(),
            network: "ethereum".to_string(),
            pay_to: "0x1234567890123456789012345678901234567890".to_string(),
            amount: "1000000000000000000".to_string(),
            asset: Some("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".to_string()),
            data: None,
            extra: Some(serde_json::Value::Object(extra)),
            max_timeout_seconds: 60,
        });

        let result = sign_transfer_with_authorization(
            &signer,
            &wallet_address,
            &requirement,
            chain_id,
            Some(600),
        )
        .await;

        assert!(result.is_ok());
        let (signature_hex, auth) = result.unwrap();
        assert!(signature_hex.starts_with("0x"));
        // Signature is 65 bytes -> 130 hex chars + 2 for "0x" = 132
        assert_eq!(signature_hex.len(), 132);

        match requirement {
            V1(_) => {
                panic!("Expected V2 requirement")
            }
            V2(req) => {
                assert_eq!(auth.value, U256::from_str(&req.amount).unwrap());
            }
        }
    }

    #[tokio::test]
    async fn test_eip712_signature_recovers_expected_address() {
        // This test proves:
        // 1. The TransferWithAuthorization struct is correct
        // 2. The Eip712Domain derived from PaymentRequirements is correct
        // 3. The signature is a valid ECDSA signature over (domain, auth)
        // 4. The recovered address matches the expected address

        let signer = PrivateKeySigner::random();
        let expected_address: Address = signer.address();
        let wallet_address_str = expected_address.to_string();
        let chain_id = 84532u64;

        let mut extra = serde_json::Map::new();
        extra.insert(
            "name".to_string(),
            serde_json::Value::String("x402".to_string()),
        );
        extra.insert(
            "version".to_string(),
            serde_json::Value::String("1".to_string()),
        );

        let requirement = PaymentRequirements::V2(PaymentRequirementsV2 {
            scheme: "exact".to_string(),
            network: "eip155:84532".to_string(),
            pay_to: "0x1234567890123456789012345678901234567890".to_string(),
            amount: "1000".to_string(),
            asset: Some("0x036CbD53842c5426634e7929541eC2318f3dCF7e".to_string()),
            data: None,
            extra: Some(serde_json::Value::Object(extra)),
            max_timeout_seconds: 60,
        });

        let (signature_hex, auth) = sign_transfer_with_authorization(
            &signer,
            &wallet_address_str,
            &requirement,
            chain_id,
            None,
        )
        .await
        .expect("sign_transfer_with_authorization failed");

        let domain = create_exact_eip3009_domain(&requirement, chain_id);

        // sol!-generated helper: compute EIP-712 digest for this struct + domain
        let digest: B256 = auth.eip712_signing_hash(&domain);

        let sig_bytes = hex::decode(signature_hex.trim_start_matches("0x")).unwrap();
        let signature = Signature::try_from(sig_bytes.as_slice()).unwrap();

        let recovered = signature
            .recover_address_from_prehash(&digest)
            .expect("recover_address failed");

        assert_eq!(recovered, expected_address, "Recovered address mismatch");
    }
}
