//! Example x402 buyer for the SVM (Solana) `exact` scheme.
//!
//! Mirrors `client.rs` (EVM) but uses `svm_exact_build_payload` and fetches
//! a recent Solana blockhash via JSON-RPC, since the SDK intentionally does
//! not pull in a Solana RPC client.
//!
//! Required deps in your Cargo.toml:
//!   x402 = { ..., features = ["svm"] }
//!   solana-sdk = "2"
//!   reqwest = { version = "0.12", features = ["json"] }
//!   serde_json = "1"
//!   tokio = { version = "1", features = ["full"] }
//!   http = "1"
//!
//! Required environment:
//!   PRIVATE_KEY      base58 secret key (Solana keypair, exported with `solana-keygen`)
//!   SELLER_URL       http(s) URL of the protected resource (e.g. http://0.0.0.0:3000/api/premium)
//!
//! Optional environment (defaults shown):
//!   SVM_RPC_URL      https://api.devnet.solana.com
//!   TOKEN_DECIMALS   6 (matches USDC)

use http::StatusCode;
use serde_json::{Value, json};
use solana_sdk::hash::Hash;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use std::env;
use std::str::FromStr;
use x402::client::svm::exact::svm_exact_build_payload;
use x402::schemes::svm::TOKEN_PROGRAM_ID;
use x402::types::{PaymentRequired, X402Header};

async fn fetch_recent_blockhash(rpc_url: &str) -> Result<Hash, Box<dyn std::error::Error>> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getLatestBlockhash",
        "params": [{ "commitment": "finalized" }],
    });
    let response: Value = reqwest::Client::new()
        .post(rpc_url)
        .json(&body)
        .send()
        .await?
        .json()
        .await?;
    let hash_str = response["result"]["value"]["blockhash"]
        .as_str()
        .ok_or("blockhash field missing in RPC response")?;
    Ok(Hash::from_str(hash_str)?)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Load buyer secret + seller URL from the environment.
    let private_key = env::var("PRIVATE_KEY").expect("PRIVATE_KEY must be set");
    let signer = Keypair::from_base58_string(&private_key);
    println!("Wallet pubkey: {}", signer.pubkey());

    let url = env::var("SELLER_URL").expect("SELLER_URL must be set");
    let rpc_url =
        env::var("SVM_RPC_URL").unwrap_or_else(|_| "https://api.devnet.solana.com".to_string());
    let token_decimals: u8 = env::var("TOKEN_DECIMALS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(6);

    let token_program = Pubkey::from_str(TOKEN_PROGRAM_ID)?;

    // First request: no PAYMENT-SIGNATURE. We expect a 402 with PAYMENT-REQUIRED.
    let http = reqwest::Client::new();
    let first = http.post(&url).send().await?;
    if first.status() != StatusCode::PAYMENT_REQUIRED {
        println!("Unexpected first response: {}", first.status());
        return Ok(());
    }
    let header_str = first
        .headers()
        .get("PAYMENT-REQUIRED")
        .ok_or("missing PAYMENT-REQUIRED header")?
        .to_str()?
        .to_string();
    let challenge = PaymentRequired::from_header(&header_str)?;

    // Build the SVM `exact` payload. We refresh the blockhash here so it is
    // tied to the moment we sign, not to client startup. For a long-running
    // client, prefer `SvmExactClient` and call `set_recent_blockhash` before
    // each new payment instead of rebuilding the helper call.
    let recent_blockhash = fetch_recent_blockhash(&rpc_url).await?;
    let payload = svm_exact_build_payload(
        &signer,
        &challenge,
        &token_program,
        token_decimals,
        recent_blockhash,
    )?;
    let signature_header = payload.to_header()?;

    let final_resp = http
        .post(&url)
        .header("PAYMENT-SIGNATURE", signature_header)
        .send()
        .await?;

    println!("Status: {}", final_resp.status());
    println!("Headers: {:#?}", final_resp.headers());

    if let Ok(value) = final_resp.json::<Value>().await {
        println!("{value:#?}");
    }
    Ok(())
}
