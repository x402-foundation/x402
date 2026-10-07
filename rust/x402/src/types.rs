use crate::errors::{X402Error, X402Result};
#[cfg(feature = "evm")]
use crate::schemes::evm::network_to_chain_id;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fmt::Display;
use std::str::FromStr;

/// Supported payment requirement versions.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PaymentRequirements {
    V1(PaymentRequirementsV1),
    V2(PaymentRequirementsV2),
}

/// Version 2 of payment requirements.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentRequirementsV2 {
    /// Payment scheme (e.g., "exact").
    pub scheme: String,
    /// Network identifier.
    pub network: String,
    /// Recipient address.
    pub pay_to: String,
    /// Amount to pay.
    pub amount: String,
    /// Optional asset identifier.
    pub asset: Option<String>,
    /// Optional data payload.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    /// Optional extra information.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra: Option<Value>,
    /// Maximum time allowed for payment.
    pub max_timeout_seconds: u64,
}

impl PaymentRequirementsV2 {
    /// Converts network string to numeric chain ID if applicable.
    pub fn u64_network(&self) -> X402Result<u64> {
        network_to_chain_id(self.network.as_str())
    }
}

/// Represents a 402 Payment Required response.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PaymentRequired {
    /// X402 protocol version.
    #[serde(rename = "x402Version")]
    pub x402_version: u32,
    /// The resource being paid for.
    pub resource: Resource,
    /// List of accepted payment methods.
    pub accepts: Vec<PaymentRequirements>,
    /// Optional human-readable description.
    pub description: Option<String>,
    /// Optional extensions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<Value>,
}

/// Supported payment payload versions.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PaymentPayload {
    V1(PaymentPayloadV1),
    V2(PaymentPayloadV2),
}

/// Version 2 of the payment payload.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PaymentPayloadV2 {
    /// X402 protocol version.
    #[serde(rename = "x402Version")]
    pub x402_version: u32,
    /// The resource being paid for.
    pub resource: Resource,
    /// The payment requirement that was met.
    pub accepted: PaymentRequirements,
    /// The actual payment proof/payload.
    pub payload: Value,
    /// Optional extensions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<Value>,
}

/// Represents a resource (URL or structured object).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Resource {
    V1(String),
    V2(ResourceV2),
}

/// Structured resource information.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResourceV2 {
    /// URL of the resource.
    pub url: String,
    /// Human-readable description.
    pub description: String,
    /// MIME type of the resource.
    #[serde(rename = "mimeType")]
    pub mime_type: String,
}

/// Request to verify a payment.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyRequest {
    pub x402_version: u32,
    pub payment_payload: PaymentPayload,
    pub payment_requirements: PaymentRequirements,
}

/// Request to settle a payment.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettleRequest {
    pub payment_payload: PaymentPayload,
    pub payment_requirements: PaymentRequirements,
}

/// Response from a payment verification.
#[derive(Debug, Serialize, Deserialize)]
pub struct VerifyResponse {
    /// Whether the payment is valid.
    #[serde(rename = "isValid")]
    pub is_valid: bool,
    /// Reason for invalidity, if any.
    #[serde(rename = "invalidReason")]
    pub invalid_reason: Option<String>,
    /// Identifier of the payer.
    pub payer: Option<String>,
}

/// Response from a payment settlement.
#[derive(Debug, Serialize, Deserialize)]
pub struct SettleResponse {
    /// Whether the settlement was successful.
    pub success: bool,
    /// Error reason, if any.
    #[serde(rename = "errorReason")]
    pub error_reason: Option<String>,
    /// Identifier of the payer.
    pub payer: Option<String>,
    /// Transaction identifier.
    pub transaction: Option<String>,
    /// Network identifier.
    pub network: String,
}

/// Response listing supported payment methods.
#[derive(Debug, Serialize, Deserialize)]
pub struct SupportedResponse {
    pub kinds: Vec<SupportedKind>,
}

/// A specific supported payment kind.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportedKind {
    pub x402_version: u32,
    pub scheme: String,
    pub network: Network,
    pub extra: Option<Value>,
}

/// Represents an amount of money as either a number or string.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Money {
    Number(f64),
    Text(String),
}

impl Display for Money {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Money::Number(n) => write!(f, "{}", n),
            Money::Text(s) => write!(f, "{}", s),
        }
    }
}

impl FromStr for Money {
    type Err = X402Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        if let Ok(n) = s.parse::<f64>() {
            return Ok(Money::Number(n));
        }
        Ok(Money::Text(s.to_string()))
    }
}

impl Money {
    /// Splits money into amount string and optional asset.
    pub fn to_amount_asset(&self) -> (String, Option<String>) {
        match self {
            Money::Number(n) => (n.to_string(), None),
            Money::Text(s) => (s.clone(), None),
        }
    }
}

// Convenience conversions so callers don't need to construct Money manually.
impl From<f64> for Money {
    fn from(n: f64) -> Self {
        Money::Number(n)
    }
}

impl From<String> for Money {
    fn from(s: String) -> Self {
        // We reuse from_str so "1000" becomes Number(1000.0), "abc" becomes Text("abc")
        Money::from_str(&s).expect("Money::from_str should not fail")
    }
}

impl From<&str> for Money {
    fn from(s: &str) -> Self {
        Money::from_str(s).expect("Money::from_str should not fail")
    }
}

/// Represents an amount of a specific asset.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetAmount {
    asset: String,
    amount: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    extra: Option<HashMap<String, Value>>,
}

impl AssetAmount {
    /// Creates a new AssetAmount.
    pub fn new(asset: &str, amount: &str, extra: Option<HashMap<String, Value>>) -> Self {
        AssetAmount {
            asset: asset.to_string(),
            amount: amount.to_string(),
            extra,
        }
    }
}

/// Represents a price as either Money or AssetAmount.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Price {
    Money(Money),
    AssetAmount(AssetAmount),
}

impl Price {
    /// Converts price to amount string and optional asset string.
    pub fn to_asset_amount(&self) -> (String, Option<String>) {
        match self {
            Price::AssetAmount(aa) => (aa.amount.clone(), Some(aa.asset.clone())),
            Price::Money(m) => m.to_amount_asset(),
        }
    }
    /// Helper method to create money from something that converts into Money
    pub fn money<M: Into<Money>>(&self, m: M) -> Self {
        Price::Money(m.into())
    }
}

impl From<Money> for Price {
    fn from(m: Money) -> Self {
        Price::Money(m)
    }
}

impl From<f64> for Price {
    fn from(n: f64) -> Self {
        Price::Money(Money::Number(n))
    }
}

impl From<String> for Price {
    fn from(s: String) -> Self {
        Price::Money(Money::from(s))
    }
}

impl From<&str> for Price {
    fn from(s: &str) -> Self {
        Price::Money(Money::from(s))
    }
}

/// Represents a network, either via CAIP identifier or plain string.
#[derive(Debug, Clone, Serialize, Deserialize, Hash, Eq, PartialEq)]
#[serde(untagged)]
pub enum Network {
    CAIPNetwork(CAIPNetwork),
    String(String),
}

/// Converts network to its string representation.
impl Display for Network {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Network::CAIPNetwork(n) => write!(f, "{}", n),
            Network::String(s) => write!(f, "{}", s),
        }
    }
}

impl Default for Network {
    fn default() -> Self {
        Network::CAIPNetwork(CAIPNetwork::default())
    }
}

impl From<CAIPNetwork> for Network {
    fn from(caip_network: CAIPNetwork) -> Self {
        Network::CAIPNetwork(caip_network)
    }
}

impl From<String> for Network {
    fn from(s: String) -> Self {
        Network::String(s)
    }
}

impl From<&str> for Network {
    fn from(s: &str) -> Self {
        Network::String(s.to_string())
    }
}

/// CAIP-compliant network identifier (namespace:reference).
#[derive(Debug, Clone, Serialize, Deserialize, Hash, Eq, PartialEq)]
pub struct CAIPNetwork {
    namespace: String,
    reference: String,
}
/// Returns the "namespace:reference" string.
impl Display for CAIPNetwork {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}", self.namespace, self.reference)
    }
}

impl CAIPNetwork {
    /// Creates a new CAIPNetwork.
    pub fn new(namespace: &str, reference: &str) -> CAIPNetwork {
        CAIPNetwork {
            namespace: namespace.to_string(),
            reference: reference.to_string(),
        }
    }
}

/// Defaults to eip155:84532 (base-sepolia)
impl Default for CAIPNetwork {
    fn default() -> Self {
        CAIPNetwork {
            namespace: String::from("eip155"),
            reference: String::from("84532"),
        }
    }
}

/// Version 1 request to verify a payment.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyRequestV1 {
    pub x402_version: u32,
    pub payment_payload: PaymentPayloadV1,
    pub payment_requirements: PaymentRequirementsV1,
}

/// Version 1 payment payload.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentPayloadV1 {
    pub x402_version: u32,
    pub scheme: String,
    pub network: String,
    pub payload: PayloadExactV1,
}

/// Exact payment payload for V1.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadExactV1 {
    pub signature: String,
    pub authorization: AuthorizationV1,
}

/// V1 payment authorization details.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationV1 {
    pub from: String,
    pub to: String,
    pub value: String,
    pub valid_after: String,
    pub valid_before: String,
    pub nonce: String,
}

/// Version 1 payment requirements.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentRequirementsV1 {
    pub scheme: String,
    pub network: String,
    pub max_amount_required: String,
    pub resource: String,
    pub description: String,
    pub mime_type: String,
    pub pay_to: String,
    pub max_timeout_seconds: u64,
    pub asset: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
    pub extra: Option<Value>,
}

impl PaymentRequirementsV1 {
    /// Converts network string to numeric chain ID if applicable.
    #[cfg(feature = "evm")]
    pub fn u64_network(&self) -> X402Result<u64> {
        network_to_chain_id(self.network.as_str())
    }
}

/// Helper trait to handle the Base64 encoding/decoding for headers
pub trait X402Header: Serialize + for<'de> Deserialize<'de> {
    /// Encodes the object as a URL-safe Base64 JSON string.
    fn to_header(&self) -> X402Result<String> {
        let json = serde_json::to_string(self)?;
        Ok(URL_SAFE_NO_PAD.encode(json))
    }

    /// Decodes the object from a URL-safe Base64 JSON string.
    fn from_header(header: &str) -> X402Result<Self> {
        let decoded = URL_SAFE_NO_PAD.decode(header)?;
        let header: Self = serde_json::from_str(&String::from_utf8(decoded)?)?;
        Ok(header)
    }
}

impl X402Header for PaymentPayload {}
impl X402Header for PaymentRequired {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn get_resource_v2() -> Resource {
        Resource::V2(ResourceV2 {
            url: "/test".to_string(),
            description: "Test".to_string(),
            mime_type: "text/plain".to_string(),
        })
    }

    #[test]
    fn test_payment_requirements_serialization() {
        let req = PaymentRequirementsV2 {
            scheme: "exact".to_string(),
            network: "evm".to_string(),
            pay_to: "0x1234567890abcdef".to_string(),
            amount: "1000000".to_string(),
            max_timeout_seconds: 60,
            asset: Some("USDC".to_string()),
            data: Some(json!({"key": "value"})),
            extra: None,
        };

        let json_str = serde_json::to_string(&req).unwrap();
        let deserialized: PaymentRequirementsV2 = serde_json::from_str(&json_str).unwrap();

        assert_eq!(req.scheme, deserialized.scheme);
        assert_eq!(req.network, deserialized.network);
        assert_eq!(req.pay_to, deserialized.pay_to);
        assert_eq!(req.amount, deserialized.amount);
        assert_eq!(req.asset, deserialized.asset);
        assert_eq!(req.max_timeout_seconds, deserialized.max_timeout_seconds);
    }

    #[test]
    fn test_payment_required_full_serialization() {
        let payment_req = PaymentRequirements::V2(PaymentRequirementsV2 {
            scheme: "exact".to_string(),
            network: "evm".to_string(),
            pay_to: "0x1234567890abcdef".to_string(),
            amount: "1000000".to_string(),
            max_timeout_seconds: 60,
            asset: Some("USDC".to_string()),
            data: None,
            extra: None,
        });

        let required = PaymentRequired {
            x402_version: 1,
            resource: get_resource_v2(),
            accepts: vec![payment_req],
            description: Some("Weather data access".to_string()),
            extensions: Some(json!({"custom": "field"})),
        };

        let json_str = serde_json::to_string(&required).unwrap();
        let deserialized: PaymentRequired = serde_json::from_str(&json_str).unwrap();

        assert_eq!(required.x402_version, deserialized.x402_version);
        assert_eq!(required.accepts.len(), deserialized.accepts.len());
        assert_eq!(required.description, deserialized.description);
        match (required.resource, deserialized.resource) {
            (Resource::V2(resource), Resource::V2(deserialized_resource)) => {
                assert_eq!(resource.url, deserialized_resource.url);
                assert_eq!(resource.description, deserialized_resource.description);
            }
            _ => panic!("Unexpected resource type(s)"),
        }
    }

    #[test]
    fn test_payment_required_minimal_serialization() {
        let payment_req = PaymentRequirements::V2(PaymentRequirementsV2 {
            scheme: "exact".to_string(),
            network: "solana".to_string(),
            pay_to: "So11111111111111111111111111111111111111112".to_string(),
            amount: "500000".to_string(),
            max_timeout_seconds: 60,
            asset: None,
            data: None,
            extra: None,
        });

        let required = PaymentRequired {
            x402_version: 1,
            resource: get_resource_v2(),
            accepts: vec![payment_req],
            description: None,
            extensions: None,
        };

        let json_str = serde_json::to_string(&required).unwrap();
        let deserialized: PaymentRequired = serde_json::from_str(&json_str).unwrap();

        assert_eq!(required.x402_version, deserialized.x402_version);
        assert!(deserialized.description.is_none());
        assert!(deserialized.extensions.is_none());
        match (required.resource, deserialized.resource) {
            (Resource::V2(resource), Resource::V2(deserialized_resource)) => {
                assert_eq!(resource.url, deserialized_resource.url);
                assert_eq!(resource.description, deserialized_resource.description);
            }
            _ => panic!("Unexpected resource type(s)"),
        }
    }

    #[test]
    fn test_payment_payload_serialization() {
        let accepted = PaymentRequirements::V2(PaymentRequirementsV2 {
            scheme: "exact".to_string(),
            network: "evm".to_string(),
            pay_to: "0xabcdef1234567890".to_string(),
            amount: "2000000".to_string(),
            max_timeout_seconds: 60,
            asset: Some("DAI".to_string()),
            data: Some(json!({"nonce": 123})),
            extra: None,
        });

        let payload = PaymentPayloadV2 {
            x402_version: 1,
            resource: get_resource_v2(),
            accepted,
            payload: json!({"signature": "<SIG_PLACEHOLDER>"}),
            extensions: Some(json!({"metadata": "test"})),
        };

        let json_str = serde_json::to_string(&payload).unwrap();
        let deserialized: PaymentPayload = serde_json::from_str(&json_str).unwrap();

        match deserialized {
            PaymentPayload::V2(deserialized_payload) => {
                assert_eq!(payload.x402_version, deserialized_payload.x402_version);
                assert_eq!(payload.payload, deserialized_payload.payload);
                match (payload.resource, deserialized_payload.resource) {
                    (Resource::V2(resource), Resource::V2(deserialized_resource)) => {
                        assert_eq!(resource.url, deserialized_resource.url);
                    }
                    _ => panic!("Unexpected resource type(s)"),
                }

                // Compare inner requirement structs via pattern matching
                match (&payload.accepted, &deserialized_payload.accepted) {
                    (PaymentRequirements::V2(a), PaymentRequirements::V2(b)) => {
                        assert_eq!(a.scheme, b.scheme);
                        assert_eq!(a.network, b.network);
                        assert_eq!(a.pay_to, b.pay_to);
                        assert_eq!(a.amount, b.amount);
                        assert_eq!(a.asset, b.asset);
                        assert_eq!(a.data, b.data);
                        assert_eq!(a.extra, b.extra);
                    }
                    other => panic!("Expected V2 requirements on both sides, got: {:?}", other),
                }
            }
            _ => panic!(
                "Expected V2 requirements on both sides, got: {:?}",
                deserialized
            ),
        }
    }

    #[test]
    fn test_payment_required_header_encoding() {
        let payment_req = PaymentRequirements::V2(PaymentRequirementsV2 {
            scheme: "exact".to_string(),
            network: "evm".to_string(),
            pay_to: "0x1234".to_string(),
            amount: "1000".to_string(),
            max_timeout_seconds: 60,
            asset: None,
            data: None,
            extra: None,
        });

        let required = PaymentRequired {
            x402_version: 1,
            resource: get_resource_v2(),
            accepts: vec![payment_req],
            description: Some("Test".to_string()),
            extensions: None,
        };

        let header = required.to_header().unwrap();
        assert!(!header.is_empty());
        assert!(!header.contains('='));
        assert!(!header.contains('+'));
        assert!(!header.contains('/'));

        let decoded = PaymentRequired::from_header(&header).unwrap();
        assert_eq!(required.x402_version, decoded.x402_version);
        assert_eq!(required.description, decoded.description);
        match (required.resource, decoded.resource) {
            (Resource::V2(resource), Resource::V2(deserialized_resource)) => {
                assert_eq!(resource.url, deserialized_resource.url);
                assert_eq!(resource.description, deserialized_resource.description);
            }
            _ => panic!("Unexpected resource type(s)"),
        }
    }

    #[test]
    fn test_payment_payload_header_encoding() {
        let accepted = PaymentRequirements::V2(PaymentRequirementsV2 {
            scheme: "exact".to_string(),
            network: "solana".to_string(),
            pay_to: "0xtest".to_string(),
            amount: "5000".to_string(),
            max_timeout_seconds: 60,
            asset: None,
            data: None,
            extra: None,
        });

        let payload = PaymentPayloadV2 {
            x402_version: 1,
            resource: get_resource_v2(),
            accepted,
            payload: json!({"signature": "<SIG_PLACEHOLDER>"}),
            extensions: None,
        };

        let header = PaymentPayload::V2(payload.clone()).to_header().unwrap();
        assert!(!header.is_empty());

        let decoded = PaymentPayload::from_header(&header).unwrap();
        match decoded {
            PaymentPayload::V2(decoded_payload) => {
                assert_eq!(payload.x402_version, decoded_payload.x402_version);
                assert_eq!(payload.payload, decoded_payload.payload);
                match (payload.resource, decoded_payload.resource) {
                    (Resource::V2(resource), Resource::V2(deserialized_resource)) => {
                        assert_eq!(resource.url, deserialized_resource.url);
                        assert_eq!(resource.description, deserialized_resource.description);
                    }
                    _ => panic!("Unexpected resource type(s)"),
                }
            }
            _ => panic!("Expected V2 payload on both sides, got: {:?}", decoded),
        }
    }

    #[test]
    fn test_header_encoding_with_special_characters() {
        let payment_req = PaymentRequirements::V2(PaymentRequirementsV2 {
            scheme: "exact".to_string(),
            network: "evm".to_string(),
            pay_to: "0x1234".to_string(),
            amount: "1000".to_string(),
            max_timeout_seconds: 60,
            asset: None,
            data: Some(json!({"test": "value+with/special=chars"})),
            extra: None,
        });

        let required = PaymentRequired {
            x402_version: 1,
            resource: get_resource_v2(),
            accepts: vec![payment_req],
            description: Some("Test with special chars: +/=".to_string()),
            extensions: None,
        };

        let header = required.to_header().unwrap();
        let decoded = PaymentRequired::from_header(&header).unwrap();

        assert_eq!(required.description, decoded.description);
        match (required.resource, decoded.resource) {
            (Resource::V2(resource), Resource::V2(deserialized_resource)) => {
                assert_eq!(resource.url, deserialized_resource.url);
                assert_eq!(resource.description, deserialized_resource.description);
            }
            _ => panic!("Unexpected resource type(s)"),
        }
    }

    #[test]
    fn test_invalid_base64_decoding() {
        let result = PaymentRequired::from_header("not-valid-base64!!!");
        assert!(result.is_err());
    }

    #[test]
    fn test_invalid_json_deserialization() {
        let invalid_json_base64 = URL_SAFE_NO_PAD.encode("not valid json");
        let result = PaymentRequired::from_header(&invalid_json_base64);
        assert!(result.is_err());
    }

    #[test]
    fn test_caip_network_to_string() {
        let caip = CAIPNetwork::new("eip155", "1");
        assert_eq!(caip.to_string(), "eip155:1");
    }

    #[test]
    fn test_caip_network_default() {
        let caip = CAIPNetwork::default();
        assert_eq!(caip.to_string(), "eip155:84532");
    }

    #[test]
    fn test_network_to_string() {
        let n1 = Network::String("solana:mainnet".to_string());
        assert_eq!(n1.to_string(), "solana:mainnet");

        let n2 = Network::CAIPNetwork(CAIPNetwork::new("eip155", "1"));
        assert_eq!(n2.to_string(), "eip155:1");
    }

    #[test]
    fn test_network_default() {
        let n = Network::default();
        assert_eq!(n.to_string(), "eip155:84532");
    }

    #[test]
    fn test_network_conversions() {
        let caip = CAIPNetwork::new("eip155", "1");
        let n: Network = caip.into();
        assert_eq!(n.to_string(), "eip155:1");

        let n2: Network = Network::from("solana:mainnet");
        assert_eq!(n2.to_string(), "solana:mainnet");
    }

    #[test]
    fn test_network_serialization() {
        let n = Network::from("solana:mainnet");
        let json = serde_json::to_string(&n).unwrap();
        // Network is now untagged, so it should serialize as a plain string
        assert_eq!(json, "\"solana:mainnet\"");

        let n2: Network = serde_json::from_str(&json).unwrap();
        match n2 {
            Network::String(s) => assert_eq!(s, "solana:mainnet"),
            _ => panic!("Expected Network::String"),
        }

        let n3 = Network::CAIPNetwork(CAIPNetwork::new("eip155", "1"));
        let json2 = serde_json::to_string(&n3).unwrap();
        // CAIPNetwork is a struct, so it serializes as an object
        assert_eq!(json2, "{\"namespace\":\"eip155\",\"reference\":\"1\"}");

        let n4: Network = serde_json::from_str(&json2).unwrap();
        match n4 {
            Network::CAIPNetwork(caip) => {
                assert_eq!(caip.namespace, "eip155");
                assert_eq!(caip.reference, "1");
            }
            _ => panic!("Expected Network::CAIPNetwork"),
        }
    }
}
