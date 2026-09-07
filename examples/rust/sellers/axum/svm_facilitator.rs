//! Example x402 seller for the SVM (Solana) `exact` scheme on devnet.
//!
//! Mirrors `x402_facilitator.rs` (EVM) but registers an SVM scheme using
//! `SchemeServer::new(...)` directly. There is no `SchemeServer::new_solana_default`
//! helper today, so we wire the V2 fields explicitly. The `extra.feePayer`
//! field is required by the SVM scheme: the buyer reads it to build the
//! partially-signed transaction that the facilitator co-signs at settlement.
//!
//! Required deps in your Cargo.toml:
//!   x402 = { ..., features = ["axum", "svm"] }
//!   axum = "0.8"
//!   tokio = { version = "1", features = ["full"] }
//!   serde = { version = "1", features = ["derive"] }
//!   serde_json = "1"
//!
//! Required environment:
//!   SVM_FEE_PAYER     base58 pubkey of the facilitator account that will
//!                     pay Solana fees and co-sign the SPL transfer
//!   SVM_PAY_TO        base58 pubkey of the recipient (your wallet)
//!
//! Optional environment (defaults shown):
//!   SVM_FACILITATOR_URL  https://x402.org/facilitator
//!   SVM_USDC_MINT        USDC devnet mint
//!   SVM_AMOUNT           "10000" (= 0.01 USDC at 6 decimals)
//!   SVM_NETWORK          solana-devnet

use axum::routing::post;
use axum::{Json, Router};
use serde::Serialize;
use serde_json::json;
use std::env;
use tokio::net::TcpListener;
use x402::facilitator::default_http_facilitator;
use x402::frameworks::axum_integration::{X402Config, X402ConfigBuilder, x402_middleware};
use x402::schemes::svm::USDC_DEVNET;
use x402::server::SchemeServer;
use x402::types::{AssetAmount, Network, Price};

fn get_x402_config() -> X402Config {
    let fee_payer = env::var("SVM_FEE_PAYER").expect("SVM_FEE_PAYER must be set");
    let pay_to = env::var("SVM_PAY_TO").expect("SVM_PAY_TO must be set");
    let mint = env::var("SVM_USDC_MINT").unwrap_or_else(|_| USDC_DEVNET.to_string());
    let amount = env::var("SVM_AMOUNT").unwrap_or_else(|_| "10000".to_string());
    let network = env::var("SVM_NETWORK").unwrap_or_else(|_| "solana-devnet".to_string());
    let facilitator_url =
        env::var("SVM_FACILITATOR_URL").unwrap_or_else(|_| "https://x402.org/facilitator".into());

    // SVM scheme server. Unlike `SchemeServer::new_default()` (EVM, USDC on
    // base-sepolia), SVM has no helper today so we build it from the
    // primitives. The `extra.feePayer` is mandatory for the SVM scheme.
    let scheme_server = std::sync::Arc::new(SchemeServer::new(
        2,
        Some("exact"),
        Some(json!({ "feePayer": fee_payer })),
        Network::from(network),
        None,
    ));

    let price = Price::AssetAmount(AssetAmount::new(&mint, &amount, None));
    let resource_config = scheme_server.build_resource_config(&pay_to, price, None);

    let facilitator = default_http_facilitator(&facilitator_url);
    let mut x402_config_builder = X402ConfigBuilder::new("https://api.example.com", facilitator);
    x402_config_builder
        .register_scheme(scheme_server.network(), scheme_server)
        .register_resource(
            resource_config,
            "/api/premium",
            Some("A premium resource paid in USDC on Solana devnet"),
            None,
        );
    x402_config_builder.build()
}

#[derive(Serialize)]
struct Recipe {
    title: String,
    ingredients: Vec<String>,
    instructions: Vec<String>,
}

async fn premium_resource_endpoint() -> Json<Recipe> {
    Json(Recipe {
        title: "Krabby Patty Recipe".into(),
        ingredients: vec![
            "1 sesame seed bun".into(),
            "1 all-beef patty".into(),
            "Secret sauce (recipe unknown)".into(),
        ],
        instructions: vec![
            "Toast the bun".into(),
            "Grill the patty".into(),
            "Apply the sauce. Serve hot.".into(),
        ],
    })
}

#[tokio::main]
async fn main() {
    let x402_config = get_x402_config();

    let app = Router::new()
        .route("/api/premium", post(premium_resource_endpoint))
        .layer(axum::middleware::from_fn_with_state(
            x402_config,
            x402_middleware,
        ));

    let listener = TcpListener::bind("0.0.0.0:3000")
        .await
        .expect("Can not bind to 0.0.0.0:3000");
    println!("Server listening on {:?}", listener.local_addr().unwrap());

    axum::serve(listener, app)
        .await
        .expect("Can not run server");
}
