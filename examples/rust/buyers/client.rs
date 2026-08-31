use alloy::signers::local::PrivateKeySigner;
use serde_json::Value;
use std::env;
use std::str::FromStr;
use x402::client::X402Client;
use x402::client::evm::exact::EvmExactClient;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let private_key = env::var("PRIVATE_KEY").expect("PRIVATE_KEY environment variable must be set");
    let signer = PrivateKeySigner::from_str(&private_key)
        .expect("Invalid PRIVATE_KEY");

    let wallet_address = signer.address();
    println!("Wallet address: {wallet_address}");

    // Core x402 client that knows how to build EVM exact payloads
    let evm_client = EvmExactClient::new(signer.clone());

    // Underlying HTTP client + x402 core client
    let x402_client = X402Client::new(evm_client);

    let url = "http://0.0.0.0:3000/api/premium".to_string();

    // This closure matches `B: FnMut() -> RequestBuilder`
    let res = x402_client
        .execute_with_evm_exact(
            || x402_client.client.post(&url),
            signer, // still passed because your current helper expects it
        )
        .await?;

    println!("Status: {}", res.status());
    println!("Headers: {:#?}", res.headers());

    let val = res.json::<Value>().await?;
    println!("{:#?}", val);

    Ok(())
}
