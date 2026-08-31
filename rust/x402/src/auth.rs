use base64::Engine;
use bon::bon;
use cdp_sdk::error::CdpError;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use reqwest::{Request, Response};
use reqwest_middleware::{Middleware, Next};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Claims {
    sub: String,
    iss: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    aud: Vec<String>,
    exp: u64,
    iat: u64,
    nbf: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    uris: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WalletClaims {
    iat: u64,
    nbf: u64,
    jti: String,
    uris: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "reqHash")]
    req_hash: Option<String>,
}

/// Configuration options for the CDP Wallet Auth client
#[derive(Debug, Clone, Default)]
pub struct WalletAuth {
    /// The API key ID
    pub api_key_id: String,
    /// The API key secret
    pub api_key_secret: String,
    /// The wallet secret
    pub wallet_secret: Option<String>,
    /// Whether to enable debugging
    pub debug: bool,
    /// The source identifier for requests
    pub source: String,
    /// The version of the source making requests
    pub source_version: Option<String>,
    /// JWT expiration time in seconds
    pub expires_in: u64,
}

#[bon]
impl WalletAuth {
    #[builder]
    pub fn new(
        /// The API key ID
        api_key_id: Option<String>,
        /// The API key secret
        api_key_secret: Option<String>,
        /// The wallet secret
        wallet_secret: Option<String>,
        /// Whether to enable debugging
        debug: Option<bool>,
        /// The source identifier for requests
        source: Option<String>,
        /// The version of the source making requests
        source_version: Option<String>,
        /// JWT expiration time in seconds
        expires_in: Option<u64>,
    ) -> Result<Self, CdpError> {
        use std::env;

        // Get configuration from options or environment variables
        let api_key_id = api_key_id
            .or_else(|| env::var("CDP_API_KEY_ID").ok())
            .ok_or_else(|| {
                CdpError::Config(
                    "Missing required CDP API Key ID configuration.\n\n\
                        You can set them as environment variables:\n\
                        CDP_API_KEY_ID=your-api-key-id\n\
                        CDP_API_KEY_SECRET=your-api-key-secret\n\n\
                        Or pass them directly to the CdpClientOptions."
                        .to_string(),
                )
            })?;

        let api_key_secret = api_key_secret
            .or_else(|| env::var("CDP_API_KEY_SECRET").ok())
            .ok_or_else(|| {
                CdpError::Config(
                    "Missing required CDP API Key Secret configuration.\n\n\
                        You can set them as environment variables:\n\
                        CDP_API_KEY_ID=your-api-key-id\n\
                        CDP_API_KEY_SECRET=your-api-key-secret\n\n\
                        Or pass them directly to the CdpClientOptions."
                        .to_string(),
                )
            })?;

        let wallet_secret = wallet_secret.or_else(|| env::var("CDP_WALLET_SECRET").ok());

        let debug = debug.unwrap_or(false);
        let expires_in = expires_in.unwrap_or(120);
        let source = source.unwrap_or("sdk-auth".to_string());

        Ok(WalletAuth {
            api_key_id,
            api_key_secret,
            wallet_secret,
            debug,
            source,
            source_version,
            expires_in,
        })
    }

    pub fn generate_jwt(
        &self,
        method: &str,
        host: &str,
        path: &str,
        expires_in: u64,
    ) -> Result<String, CdpError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let claims = Claims {
            sub: self.api_key_id.clone(),
            iss: "cdp".to_string(),
            aud: vec![],
            exp: now + expires_in,
            iat: now,
            nbf: now,
            uris: Some(vec![format!("{} {}{}", method, host, path)]),
        };

        // Determine key format and algorithm
        let (algorithm, encoding_key) = if is_ec_pem_key(&self.api_key_secret) {
            // PEM format EC key - use ES256
            let key = EncodingKey::from_ec_pem(self.api_key_secret.as_bytes())
                .map_err(|e| CdpError::Auth(format!("Failed to parse EC PEM key: {}", e)))?;
            (Algorithm::ES256, key)
        } else if is_ed25519_key(&self.api_key_secret) {
            // Base64 Ed25519 key - use EdDSA
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(&self.api_key_secret)
                .map_err(|e| CdpError::Auth(format!("Failed to decode Ed25519 key: {}", e)))?;

            if decoded.len() != 64 {
                return Err(CdpError::Auth(
                    "Invalid Ed25519 key length, expected 64 bytes".to_string(),
                ));
            }

            // For Ed25519 keys, we need to create a proper PKCS#8 DER format
            // Extract the seed (first 32 bytes)
            let seed = &decoded[0..32];

            // Create PKCS#8 DER format for Ed25519 private key
            let mut pkcs8_der = Vec::new();
            // PKCS#8 header for Ed25519
            let header = hex::decode("302e020100300506032b657004220420").unwrap();
            pkcs8_der.extend_from_slice(&header);
            pkcs8_der.extend_from_slice(seed);

            // Convert to PEM format
            let pem_content = base64::engine::general_purpose::STANDARD.encode(&pkcs8_der);
            let pem_formatted = format!(
                "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----",
                pem_content
                    .chars()
                    .collect::<Vec<_>>()
                    .chunks(64)
                    .map(|chunk| chunk.iter().collect::<String>())
                    .collect::<Vec<_>>()
                    .join("\n")
            );

            let key = EncodingKey::from_ed_pem(pem_formatted.as_bytes())
                .map_err(|e| CdpError::Auth(format!("Failed to parse Ed25519 key: {}", e)))?;
            (Algorithm::EdDSA, key)
        } else {
            return Err(CdpError::Auth(
                "Invalid key format - must be either PEM EC key or base64 Ed25519 key".to_string(),
            ));
        };

        let mut header = Header::new(algorithm);
        header.kid = Some(self.api_key_id.clone());

        encode(&header, &claims, &encoding_key)
            .map_err(|e| CdpError::Auth(format!("Failed to encode JWT: {}", e)))
    }

    pub fn generate_wallet_jwt(
        &self,
        method: &str,
        host: &str,
        path: &str,
        body: &[u8],
    ) -> Result<String, CdpError> {
        let wallet_secret = self.wallet_secret.as_ref().ok_or_else(|| {
            CdpError::Auth("Wallet secret required for this operation".to_string())
        })?;

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let uri = format!("{} {}{}", method, host, path);
        let jti = format!("{:x}", Uuid::new_v4().simple()); // Use hex format like JavaScript

        // Calculate reqHash only if body is not empty, using hex format like JavaScript
        let req_hash = if !body.is_empty() {
            // Parse body as JSON and sort keys
            let body_str = std::str::from_utf8(body)
                .map_err(|e| CdpError::Auth(format!("Invalid UTF-8 in request body: {}", e)))?;

            if !body_str.trim().is_empty() {
                let parsed: Value = serde_json::from_str(body_str)
                    .map_err(|e| CdpError::Auth(format!("Failed to parse JSON body: {}", e)))?;

                let sorted = sort_keys(parsed);
                let sorted_json = serde_json::to_string(&sorted).map_err(|e| {
                    CdpError::Auth(format!("Failed to serialize sorted JSON: {}", e))
                })?;

                let mut hasher = Sha256::new();
                hasher.update(sorted_json.as_bytes());
                Some(format!("{:x}", hasher.finalize()))
            } else {
                None
            }
        } else {
            None
        };

        let claims = WalletClaims {
            iat: now,
            nbf: now, // Add nbf like JavaScript
            jti,
            uris: vec![uri],
            req_hash,
        };

        let header = Header::new(Algorithm::ES256);

        // Decode the base64 wallet secret
        let der_bytes = base64::engine::general_purpose::STANDARD
            .decode(wallet_secret)
            .map_err(|e| CdpError::Auth(format!("Failed to decode wallet secret: {}", e)))?;

        let encoding_key = EncodingKey::from_ec_der(&der_bytes);

        encode(&header, &claims, &encoding_key)
            .map_err(|e| CdpError::Auth(format!("Failed to encode wallet JWT: {}", e)))
    }

    fn requires_wallet_auth(&self, method: &str, path: &str) -> bool {
        (path.contains("/accounts") || path.contains("/spend-permissions"))
            && (method == "POST" || method == "DELETE" || method == "PUT")
    }

    fn get_correlation_data(&self) -> String {
        let mut data = HashMap::new();

        data.insert("sdk_version".to_string(), VERSION.to_string());
        data.insert("sdk_language".to_string(), "rust".to_string());
        data.insert("source".to_string(), self.source.clone());

        if let Some(ref source_version) = self.source_version {
            data.insert("source_version".to_string(), source_version.clone());
        }

        data.into_iter()
            .map(|(k, v)| format!("{}={}", k, urlencoding::encode(&v)))
            .collect::<Vec<_>>()
            .join(",")
    }
}

#[async_trait::async_trait]
impl Middleware for WalletAuth {
    async fn handle(
        &self,
        mut req: Request,
        extensions: &mut http::Extensions,
        next: Next<'_>,
    ) -> reqwest_middleware::Result<Response> {
        let method = req.method().as_str().to_uppercase();
        let url = req.url().clone();
        let host = url.host_str().unwrap_or("api.cdp.coinbase.com");
        let path = url.path();

        // Get request body for wallet auth
        let body = if let Some(body) = req.body() {
            body.as_bytes().unwrap_or_default().to_vec()
        } else {
            Vec::new()
        };

        let expires_in = self.expires_in;

        // Generate main JWT
        let jwt = self
            .generate_jwt(&method, host, path, expires_in)
            .map_err(reqwest_middleware::Error::middleware)?;

        // Add authorization header
        req.headers_mut()
            .insert("Authorization", format!("Bearer {}", jwt).parse().unwrap());

        // Add content type
        req.headers_mut()
            .insert("Content-Type", "application/json".parse().unwrap());

        // Add wallet auth if needed, and not already provided or if empty
        if self.requires_wallet_auth(&method, path)
            && (!req.headers().contains_key("X-Wallet-Auth")
                || req
                    .headers()
                    .get("X-Wallet-Auth")
                    .is_none_or(|v| v.is_empty()))
        {
            let wallet_jwt = self
                .generate_wallet_jwt(&method, host, path, &body)
                .map_err(reqwest_middleware::Error::middleware)?;

            req.headers_mut()
                .insert("X-Wallet-Auth", wallet_jwt.parse().unwrap());
        }

        // Add correlation data
        req.headers_mut().insert(
            "Correlation-Context",
            self.get_correlation_data().parse().unwrap(),
        );

        if self.debug {
            println!("Request: {} {}", method, url);
            println!("Headers: {:?}", req.headers());
        }

        let response = next.run(req, extensions).await;

        if self.debug
            && let Ok(ref resp) = response
        {
            println!(
                "Response: {} {}",
                resp.status(),
                resp.status().canonical_reason().unwrap_or("")
            );
        }

        response
    }
}

fn sort_keys(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut sorted_map = serde_json::Map::new();
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            for key in keys {
                if let Some(val) = map.get(key) {
                    sorted_map.insert(key.clone(), sort_keys(val.clone()));
                }
            }
            Value::Object(sorted_map)
        }
        Value::Array(arr) => Value::Array(arr.into_iter().map(sort_keys).collect()),
        _ => value,
    }
}

fn is_ed25519_key(key: &str) -> bool {
    // Try to decode as base64 and check if it's 64 bytes (Ed25519 format)
    if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(key) {
        decoded.len() == 64
    } else {
        false
    }
}

fn is_ec_pem_key(key: &str) -> bool {
    // Check if the key looks like a PEM format EC key
    key.contains("-----BEGIN")
        && key.contains("-----END")
        && (key.contains("EC PRIVATE KEY") || key.contains("PRIVATE KEY"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wallet_auth_builder_with_all_fields() {
        let auth = WalletAuth::builder()
            .api_key_id("test_key_id".to_string())
            .api_key_secret("test_key_secret".to_string())
            .wallet_secret("test_wallet_secret".to_string())
            .debug(true)
            .source("test_source".to_string())
            .source_version("1.0.0".to_string())
            .expires_in(300)
            .build()
            .unwrap();

        assert_eq!(auth.api_key_id, "test_key_id");
        assert_eq!(auth.api_key_secret, "test_key_secret");
        assert_eq!(auth.wallet_secret, Some("test_wallet_secret".to_string()));
        assert!(auth.debug);
        assert_eq!(auth.source, "test_source");
        assert_eq!(auth.source_version, Some("1.0.0".to_string()));
        assert_eq!(auth.expires_in, 300);
    }

    #[test]
    fn test_wallet_auth_builder_with_required_fields_only() {
        let auth = WalletAuth::builder()
            .api_key_id("test_key_id".to_string())
            .api_key_secret("test_key_secret".to_string())
            .build()
            .unwrap();

        assert_eq!(auth.api_key_id, "test_key_id");
        assert_eq!(auth.api_key_secret, "test_key_secret");
        assert_eq!(auth.wallet_secret, None);
        assert!(!auth.debug);
        assert_eq!(auth.source, "sdk-auth");
        assert_eq!(auth.source_version, None);
        assert_eq!(auth.expires_in, 120);
    }

    #[test]
    fn test_wallet_auth_builder_with_optional_fields() {
        let auth = WalletAuth::builder()
            .api_key_id("test_key_id".to_string())
            .api_key_secret("test_key_secret".to_string())
            .debug(true)
            .expires_in(600)
            .build()
            .unwrap();

        assert_eq!(auth.api_key_id, "test_key_id");
        assert_eq!(auth.api_key_secret, "test_key_secret");
        assert!(auth.debug);
        assert_eq!(auth.expires_in, 600);
        assert_eq!(auth.source, "sdk-auth"); // default value
    }

    #[test]
    fn test_wallet_auth_builder_missing_api_key_id() {
        let result = WalletAuth::builder()
            .api_key_secret("test_key_secret".to_string())
            .build();

        assert!(result.is_err());
        if let Err(CdpError::Config(msg)) = result {
            assert!(msg.contains("Missing required CDP API Key ID configuration"));
        } else {
            panic!("Expected Config error for missing api_key_id");
        }
    }

    #[test]
    fn test_wallet_auth_builder_missing_api_key_secret() {
        let result = WalletAuth::builder()
            .api_key_id("test_key_id".to_string())
            .build();

        assert!(result.is_err());
        if let Err(CdpError::Config(msg)) = result {
            assert!(msg.contains("Missing required CDP API Key Secret configuration"));
        } else {
            panic!("Expected Config error for missing api_key_secret");
        }
    }

    #[test]
    fn test_wallet_auth_builder_custom_source() {
        let auth = WalletAuth::builder()
            .api_key_id("test_key_id".to_string())
            .api_key_secret("test_key_secret".to_string())
            .source("my-custom-app".to_string())
            .source_version("2.1.0".to_string())
            .build()
            .unwrap();

        assert_eq!(auth.source, "my-custom-app");
        assert_eq!(auth.source_version, Some("2.1.0".to_string()));
    }

    #[test]
    fn test_requires_wallet_auth() {
        let auth = WalletAuth::builder()
            .api_key_id("test_key_id".to_string())
            .api_key_secret("test_key_secret".to_string())
            .build()
            .unwrap();

        // Should require wallet auth for POST to accounts
        assert!(auth.requires_wallet_auth("POST", "/v2/evm/accounts"));

        // Should require wallet auth for PUT to accounts
        assert!(auth.requires_wallet_auth("PUT", "/v2/evm/accounts/0x123"));

        // Should require wallet auth for DELETE to accounts
        assert!(auth.requires_wallet_auth("DELETE", "/v2/evm/accounts/0x123"));

        // Should require wallet auth for spend-permissions
        assert!(auth.requires_wallet_auth("POST", "/v2/spend-permissions"));

        // Should NOT require wallet auth for GET requests
        assert!(!auth.requires_wallet_auth("GET", "/v2/evm/accounts"));

        // Should NOT require wallet auth for non-account endpoints
        assert!(!auth.requires_wallet_auth("POST", "/v2/other/endpoint"));
    }

    #[test]
    fn test_is_ed25519_key() {
        // Valid base64 encoded 64-byte key
        let valid_ed25519 = base64::engine::general_purpose::STANDARD.encode([0u8; 64]);
        assert!(is_ed25519_key(&valid_ed25519));

        // Invalid key (wrong length)
        let invalid_key = base64::engine::general_purpose::STANDARD.encode([0u8; 32]);
        assert!(!is_ed25519_key(&invalid_key));

        // Not base64
        assert!(!is_ed25519_key("not-base64"));
    }

    #[test]
    fn test_is_ec_pem_key() {
        let pem_key = "-----BEGIN EC PRIVATE KEY-----\ntest\n-----END EC PRIVATE KEY-----";
        assert!(is_ec_pem_key(pem_key));

        let generic_pem_key = "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----";
        assert!(is_ec_pem_key(generic_pem_key));

        let not_pem_key = "just-a-string";
        assert!(!is_ec_pem_key(not_pem_key));
    }
}
