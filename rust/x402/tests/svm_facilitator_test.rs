//! Integration tests for the SVM (Solana) `exact` payment scheme.
//!
//! These mirror the `coinbase_facilitator_test` pattern: they are
//! `#[ignore]` by default and exercise the full end-to-end flow against
//! a real x402 facilitator on Solana devnet. To run them:
//!
//! ```text
//! SVM_PRIVATE_KEY="<base58 secret key>" \
//! SVM_FEE_PAYER_PUBKEY="<base58 pubkey>" \
//! SVM_FACILITATOR_URL="https://your-svm-facilitator/v2/x402" \
//! SVM_RPC_URL="https://api.devnet.solana.com" \
//! cargo test --features svm --test svm_facilitator_test -- --ignored --nocapture
//! ```
//!
//! Optional overrides (defaults shown):
//!   SVM_USDC_MINT  = USDC devnet mint
//!   SVM_PAY_TO     = recipient pubkey (defaults to a fresh ephemeral keypair)
//!   SVM_AMOUNT     = "1000" (= 0.001 USDC at 6 decimals)

#![cfg(feature = "svm")]

use axum::Router;
use axum::body::Body;
use axum::routing::get;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use http::Request;
use serde_json::json;
use solana_sdk::hash::Hash;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use std::env;
use std::str::FromStr;
use std::sync::Arc;
use tower::ServiceExt;
use x402::client::svm::exact::svm_exact_build_payload;
use x402::facilitator::{Facilitator, FacilitatorClient};
use x402::frameworks::axum_integration::{X402ConfigBuilder, x402_middleware};
use x402::schemes::svm::{SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ID, USDC_DEVNET};
use x402::server::SchemeServer;
use x402::types::{AssetAmount, Network, PaymentPayload, PaymentRequired, Price, X402Header};

// ──────────────────────────────────────────────────
// Test helpers
// ──────────────────────────────────────────────────

fn keypair_from_env(var: &str) -> Keypair {
    let secret = env::var(var).unwrap_or_else(|_| panic!("{var} must be set"));
    Keypair::from_base58_string(&secret)
}

fn pubkey_from_env(var: &str) -> Pubkey {
    let value = env::var(var).unwrap_or_else(|_| panic!("{var} must be set"));
    Pubkey::from_str(&value).unwrap_or_else(|e| panic!("invalid {var}: {e}"))
}

async fn fetch_recent_blockhash(rpc_url: &str) -> Hash {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getLatestBlockhash",
        "params": [{"commitment": "finalized"}],
    });
    let response: serde_json::Value = reqwest::Client::new()
        .post(rpc_url)
        .json(&body)
        .send()
        .await
        .expect("RPC request failed")
        .json()
        .await
        .expect("RPC response parse failed");
    let hash_str = response["result"]["value"]["blockhash"]
        .as_str()
        .expect("blockhash field missing");
    Hash::from_str(hash_str).expect("invalid blockhash")
}

fn build_facilitator(url: &str) -> Arc<Facilitator> {
    let client = reqwest::Client::builder()
        .user_agent("x402-rust-integration-tests/0.1 (svm)")
        .build()
        .expect("Failed to build reqwest client");
    Arc::new(Facilitator::builder(url).with_client(client).build())
}

// ──────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────

/// Smoke test: the SVM facilitator responds to /supported.
#[tokio::test]
#[ignore = "Requires SVM_FACILITATOR_URL and network access"]
async fn test_svm_facilitator_supported() {
    let facilitator_url = env::var("SVM_FACILITATOR_URL").expect("SVM_FACILITATOR_URL must be set");
    let facilitator = build_facilitator(&facilitator_url);
    let response = facilitator.supported().await;
    assert!(response.is_ok(), "facilitator.supported() failed: {response:?}");
    println!("{:#?}", response.unwrap());
}

/// Full V2 round-trip: middleware issues a 402 PAYMENT-REQUIRED, the buyer
/// signs an SVM `exact` payload, and the second request reaches the
/// facilitator. We assert the request leaves the middleware (status != 402).
/// A real settlement on devnet will return 200 if the source account is funded.
#[tokio::test]
#[ignore = "Requires SVM_PRIVATE_KEY, SVM_FEE_PAYER_PUBKEY, SVM_FACILITATOR_URL, SVM_RPC_URL and network access"]
async fn test_svm_facilitator_integration_v2() {
    // Inputs from environment.
    let signer = keypair_from_env("SVM_PRIVATE_KEY");
    let fee_payer = pubkey_from_env("SVM_FEE_PAYER_PUBKEY");
    let facilitator_url = env::var("SVM_FACILITATOR_URL").expect("SVM_FACILITATOR_URL must be set");
    let rpc_url = env::var("SVM_RPC_URL").expect("SVM_RPC_URL must be set");
    let mint = env::var("SVM_USDC_MINT").unwrap_or_else(|_| USDC_DEVNET.to_string());
    let pay_to = env::var("SVM_PAY_TO").unwrap_or_else(|_| Keypair::new().pubkey().to_string());
    let amount = env::var("SVM_AMOUNT").unwrap_or_else(|_| "1000".to_string());

    // Server side: register an SVM scheme on solana-devnet. The `feePayer`
    // in `extra` is what the buyer reads to build the partially-signed tx.
    let scheme_server = Arc::new(SchemeServer::new(
        2,
        Some("exact"),
        Some(json!({ "feePayer": fee_payer.to_string() })),
        Network::from(SOLANA_DEVNET_CAIP2),
        None,
    ));
    let price = Price::AssetAmount(AssetAmount::new(&mint, &amount, None));
    let resource_config = scheme_server.build_resource_config(&pay_to, price, None);

    let facilitator = build_facilitator(&facilitator_url);
    let mut builder = X402ConfigBuilder::new("https://api.example.com", facilitator);
    builder
        .register_scheme(scheme_server.network(), scheme_server)
        .register_resource(resource_config, "/api/premium", Some("Test Resource"), None);
    let config = builder.build();

    let app = Router::new()
        .route("/api/premium", get(|| async { "Success" }))
        .layer(axum::middleware::from_fn_with_state(
            config,
            x402_middleware,
        ));

    // 1. First request without PAYMENT-SIGNATURE -> 402 with PAYMENT-REQUIRED.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/premium")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), http::StatusCode::PAYMENT_REQUIRED);

    let header = response
        .headers()
        .get("PAYMENT-REQUIRED")
        .expect("PAYMENT-REQUIRED header missing");
    let decoded = URL_SAFE_NO_PAD
        .decode(header.to_str().expect("header utf8"))
        .expect("base64url decode");
    let payment_required: PaymentRequired =
        serde_json::from_slice(&decoded).expect("PaymentRequired JSON");

    // 2. Buyer side: build an SVM exact payload. The SDK does not pull in a
    // Solana RPC client, so we fetch the recent blockhash directly.
    let recent_blockhash = fetch_recent_blockhash(&rpc_url).await;
    let token_program = Pubkey::from_str(TOKEN_PROGRAM_ID).expect("token program id");

    let payment_payload = svm_exact_build_payload(
        &signer,
        &payment_required,
        &token_program,
        6,
        recent_blockhash,
    )
    .expect("svm_exact_build_payload failed");

    let payment_signature_header = match &payment_payload {
        PaymentPayload::V2(_) => payment_payload
            .to_header()
            .expect("encode PaymentPayload to PAYMENT-SIGNATURE"),
        PaymentPayload::V1(_) => panic!("expected V2 payload for SVM"),
    };

    // 3. Second request with PAYMENT-SIGNATURE.
    let response_with_sig = app
        .oneshot(
            Request::builder()
                .uri("/api/premium")
                .header("PAYMENT-SIGNATURE", payment_signature_header)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response_with_sig.status();

    // The payload is well-formed and matches `accepts`, so the middleware
    // should hand off to the facilitator instead of short-circuiting.
    assert_ne!(
        status,
        http::StatusCode::PAYMENT_REQUIRED,
        "second request should not be rejected at the middleware",
    );
    println!("Final status: {status}");
}
