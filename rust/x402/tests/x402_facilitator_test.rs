use alloy::signers::local::PrivateKeySigner;
use axum::{Router, body::Body, http::Request, routing::get};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use reqwest::Client;
use serde_json::Value;
use serde_json::json;
use std::env;
use std::str::FromStr;
use std::sync::Arc;
use tower::ServiceExt;
use x402::facilitator::default_http_facilitator;
use x402::frameworks::axum_integration::{X402ConfigBuilder, x402_middleware};
use x402::schemes::evm::sign_transfer_with_authorization;
use x402::server::{SchemeServer, V1ResourceInfo};
use x402::types::{
    AssetAmount, AuthorizationV1, Network, PayloadExactV1, PaymentPayloadV1, PaymentPayloadV2,
    PaymentRequirements, Price, ResourceV2, X402Header,
};
use x402::types::{PaymentPayload, PaymentRequired, Resource};

#[tokio::test]
#[ignore = "Requires PRIVATE_KEY, and network access"]
async fn test_x402_v2_axum_facilitator_integration() {
    let private_key =
        env::var("PRIVATE_KEY").expect("PRIVATE_KEY environment variable must be set");
    let signer = PrivateKeySigner::from_str(&private_key).expect("Invalid PRIVATE_KEY");

    let wallet_address = signer.address();

    let facilitator_url = "https://x402.org/facilitator";
    let facilitator = default_http_facilitator(facilitator_url);

    let to_address = "0xB013a7f5F82bEA73c682fe6BFFB23715bb58e656".to_lowercase();
    let usdc_address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e".to_lowercase();
    let price = Price::AssetAmount(AssetAmount::new(&usdc_address, "1000", None));

    let scheme_server = SchemeServer::new_default();
    let resource_config = scheme_server.build_resource_config(&to_address, price, None);

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

    // 1. First request: no PAYMENT-SIGNATURE -> should return 402 with PAYMENT-REQUIRED
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

    println!("Response Status (Missing Header): {}", response.status());
    assert_eq!(response.status(), axum::http::StatusCode::PAYMENT_REQUIRED);

    if let Some(header) = response.headers().get("PAYMENT-REQUIRED") {
        println!("PAYMENT-REQUIRED Header (raw): {:?}", header);

        // Decode PAYMENT-REQUIRED into PaymentRequired
        let header_str = header.to_str().expect("header to be valid UTF-8");
        let decoded = URL_SAFE_NO_PAD
            .decode(header_str)
            .expect("base64url decode PAYMENT-REQUIRED");
        let json_str = String::from_utf8(decoded).expect("PAYMENT-REQUIRED to be valid UTF-8");
        let payment_required: PaymentRequired =
            serde_json::from_str(&json_str).expect("decode PaymentRequired JSON");

        println!("Decoded PAYMENT-REQUIRED: {}", json_str);

        // 2. Build a PaymentPayload that matches the server's `accepts`
        let accepted: PaymentRequirements = payment_required
            .accepts
            .first()
            .expect("at least one accepted requirement")
            .clone();

        let resource = Resource::V2(ResourceV2 {
            url: if let Resource::V2(ref res_v2) = payment_required.resource {
                res_v2.url.clone()
            } else {
                panic!("Expected ResourceV2, got V1")
            },
            description: payment_required
                .description
                .clone()
                .unwrap_or_else(|| "Test Resource".to_string()),
            mime_type: "application/json".to_string(),
        });

        let chain_id = 84532u64; // from "eip155:84532"
        let (signature_hex, auth) = sign_transfer_with_authorization(
            &signer,
            &wallet_address.to_string(),
            &accepted,
            chain_id,
            None,
        )
        .await
        .expect("sign_transfer_with_authorization failed");

        let accepted_v2 = match &accepted {
            PaymentRequirements::V2(req) => req,
            other => panic!("expected V2 requirements, got: {:?}", other),
        };

        let authorization_json = json!({
        "from": wallet_address,
        "to": accepted_v2.pay_to,
        "value": accepted_v2.amount,
        "validAfter": auth.validAfter.to_string(),
        "validBefore": auth.validBefore.to_string(),
        "nonce": format!("0x{}", hex::encode(auth.nonce.as_slice())),
         });

        let evm_like_payload = json!({
            "signature": signature_hex,
            "authorization": authorization_json,
        });

        let payment_payload = PaymentPayloadV2 {
            x402_version: payment_required.x402_version,
            resource,
            accepted: accepted.clone(),
            payload: evm_like_payload,
            extensions: None,
        };

        let payment_signature_header = PaymentPayload::V2(payment_payload)
            .to_header()
            .expect("encode PaymentPayload to PAYMENT-SIGNATURE header");

        // 4. Second request WITH PAYMENT-SIGNATURE:
        //    - Axum middleware should accept it (matches `accepts`)
        //    - Facilitator is called and returns a verification failure
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
        let body_bytes = axum::body::to_bytes(response_with_sig.into_body(), 1024)
            .await
            .unwrap();
        let body_str = String::from_utf8_lossy(&body_bytes);

        println!("Response Status: {}", status);
        println!("Response Body: {}", body_str);

        // 5. Assertions:
        //    - We should not see 402 here (that would mean we never left the Axum middleware)
        assert_ne!(
            status,
            axum::http::StatusCode::PAYMENT_REQUIRED,
            "Second request should not fail at the Axum middleware with 402"
        );

        //    - Middleware should surface a verification failure error from the facilitator
        assert_eq!(status, axum::http::StatusCode::OK);
    }
}

#[tokio::test]
#[ignore = "Requires PRIVATE_KEY, and network access"]
async fn test_x402_v1_axum_facilitator_integration() {
    let private_key =
        env::var("PRIVATE_KEY").expect("PRIVATE_KEY environment variable must be set");
    let signer = PrivateKeySigner::from_str(&private_key).expect("Invalid PRIVATE_KEY");

    let wallet_address = signer.address();

    let facilitator_url = "https://x402.org/facilitator";
    let facilitator = default_http_facilitator(facilitator_url);

    let to_address = "0xB013a7f5F82bEA73c682fe6BFFB23715bb58e656".to_lowercase();
    let usdc_address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e".to_lowercase();
    let price = Price::AssetAmount(AssetAmount::new(&usdc_address, "1000", None));
    let protected_route = "/api/premium";

    let v1_resource_info =
        V1ResourceInfo::new(protected_route, "Premium Access", "application/json", None);

    let scheme_server = Arc::new(SchemeServer::new(
        1,
        Some("exact"),
        Some(json!({
            "name": "USDC",
            "version": "2"
        })),
        Network::from("base-sepolia"),
        Some(v1_resource_info),
    ));
    let resource_config = scheme_server.build_resource_config(&to_address, price, None);

    let mut builder = X402ConfigBuilder::new("https://api.example.com", facilitator);
    builder
        .register_scheme(scheme_server.network(), scheme_server)
        .register_resource(resource_config, protected_route, Some("Test"), None);
    let config = builder.build();

    let app = Router::new()
        .route(protected_route, get(|| async { "Success" }))
        .layer(axum::middleware::from_fn_with_state(
            config,
            x402_middleware,
        ));

    // 1. First request: no PAYMENT-SIGNATURE -> should return 402 with PAYMENT-REQUIRED
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

    println!("Response Status (Missing Header): {}", response.status());
    assert_eq!(response.status(), axum::http::StatusCode::PAYMENT_REQUIRED);

    if let Some(header) = response.headers().get("PAYMENT-REQUIRED") {
        println!("PAYMENT-REQUIRED Header (raw): {:?}", header);

        // Decode PAYMENT-REQUIRED into PaymentRequired
        let header_str = header.to_str().expect("header to be valid UTF-8");
        let decoded = URL_SAFE_NO_PAD
            .decode(header_str)
            .expect("base64url decode PAYMENT-REQUIRED");
        let json_str = String::from_utf8(decoded).expect("PAYMENT-REQUIRED to be valid UTF-8");
        let payment_required: PaymentRequired =
            serde_json::from_str(&json_str).expect("decode PaymentRequired JSON");

        println!("Decoded PAYMENT-REQUIRED: {}", json_str);

        // 2. Build a PaymentPayload that matches the server's `accepts`
        let accepted: PaymentRequirements = payment_required
            .accepts
            .first()
            .expect("at least one accepted requirement")
            .clone();

        let chain_id = 84532u64; // from "eip155:84532"
        let (signature_hex, auth) = sign_transfer_with_authorization(
            &signer,
            &wallet_address.to_string(),
            &accepted,
            chain_id,
            None,
        )
        .await
        .expect("sign_transfer_with_authorization failed");

        let accepted_v1 = match &accepted {
            PaymentRequirements::V1(req) => req,
            other => panic!("expected V1 requirements, got: {:?}", other),
        };

        let exact_payment_payload = PayloadExactV1 {
            signature: signature_hex,
            authorization: AuthorizationV1 {
                from: wallet_address.to_string(),
                to: accepted_v1.pay_to.clone(),
                value: accepted_v1.max_amount_required.to_string(),
                valid_after: auth.validAfter.to_string(),
                valid_before: auth.validBefore.to_string(),
                nonce: format!("0x{}", hex::encode(auth.nonce.as_slice())),
            },
        };

        let payment_payload = PaymentPayloadV1 {
            x402_version: 1,
            scheme: accepted_v1.scheme.clone(),
            network: accepted_v1.network.clone(),
            payload: exact_payment_payload,
        };

        let payment_signature_header = PaymentPayload::V1(payment_payload)
            .to_header()
            .expect("encode PaymentPayload to PAYMENT-SIGNATURE header");

        // 4. Second request WITH PAYMENT-SIGNATURE:
        //    - Axum middleware should accept it (matches `accepts`)
        //    - Facilitator is called and returns a verification failure
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
        let body_bytes = axum::body::to_bytes(response_with_sig.into_body(), 1024)
            .await
            .unwrap();
        let body_str = String::from_utf8_lossy(&body_bytes);

        println!("Response Status: {}", status);
        println!("Response Body: {}", body_str);

        // 5. Assertions:
        //    - We should not see 402 here (that would mean we never left the Axum middleware)
        assert_ne!(
            status,
            axum::http::StatusCode::PAYMENT_REQUIRED,
            "Second request should not fail at the Axum middleware with 402"
        );

        //    - Middleware should surface a verification failure error from the facilitator
        assert_eq!(status, axum::http::StatusCode::OK);
    }
}

#[tokio::test]
#[ignore = "Requires network access"]
async fn test_supported_schemes() {
    let facilitator_url = "https://x402.org/facilitator/supported";
    let client = Client::new();
    let res = client
        .get(facilitator_url)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    dbg!(&res);
}

/*

{
  payload: {
    x402Version: 2,
    payload: { signature: 'test_signature', from: 'test_sender' },
    accepted: {
      scheme: 'test-scheme',
      network: 'test:network',
      amount: '1000000',
      asset: 'TEST_ASSET',
      payTo: 'test_recipient',
      maxTimeoutSeconds: 300,
      extra: {}
    },
    resource: {
      url: 'https://example.com/resource',
      description: 'Test resource',
      mimeType: 'application/json'
    }
  },
  requirements: {
    scheme: 'exact',
    network: 'eip155:8453',
    amount: '1000000',
    asset: 'TEST_ASSET',
    payTo: 'test_recipient',
    maxTimeoutSeconds: 300,
    extra: {}
  },
  result
*/
