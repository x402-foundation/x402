use alloy::signers::local::PrivateKeySigner;
use http::StatusCode;
use reqwest::Client;
use serde_json::json;
use x402::client::X402Client;
use x402::client::evm::exact::EvmExactClient;

mod common;
use crate::common::build_and_serve_test_app;
use x402::types::{
    PaymentPayload, PaymentPayloadV2, PaymentRequired, PaymentRequirements, X402Header,
};
// your helper that returns axum::Router

#[tokio::test]
async fn test_x402_client_against_axum_server_happy_path() {
    // Build and serve app
    let addr = build_and_serve_test_app().await;

    // Create a test signer.
    let signer = PrivateKeySigner::random();

    // Build the EVM/x402 clients
    let evm_client = EvmExactClient::new(signer.clone());
    let x402_client = X402Client::new(evm_client);

    let url = format!("http://{}/api/premium", addr);

    //  Use the *real* high-level client API to exercise the whole flow:
    //    - initial request
    //    - 402 + PAYMENT-REQUIRED
    //    - sign & build PAYMENT-SIGNATURE
    //    - retry with payment
    let res = x402_client
        .execute_with_evm_exact(|| x402_client.client.post(&url), signer)
        .await
        .expect("x402 client flow should succeed");

    let status = res.status();
    let text = res.text().await.expect("read response body");
    dbg!(&status, &text);

    assert!(status.is_success());
}

#[tokio::test]
async fn test_single_call_against_server_returns_402_response() {
    let addr = build_and_serve_test_app().await;

    let url = format!("http://{}/api/premium", addr);
    let client = Client::new();
    let request = client.post(url);

    let response = request.send().await.unwrap();
    assert_eq!(response.status(), 402);
}

#[tokio::test]
async fn test_invalid_payment_signature_malformed() {
    let addr = build_and_serve_test_app().await;
    let client = Client::new();
    let bad_signature_header = "not-base64-or-json";

    let res = client
        .post(format!("http://{addr}/api/premium"))
        .header("PAYMENT-SIGNATURE", bad_signature_header)
        .send()
        .await
        .expect("second request failed");

    let err_reason = res.text().await.expect("failed to read response text");
    assert!(
        err_reason.contains("Invalid payment header format"),
        "Expected error message to contain 'Invalid payment header format', but got: {err_reason}"
    );
}

#[tokio::test]
async fn test_invalid_payment_signature_bad_payload() {
    let addr = build_and_serve_test_app().await;
    let client = Client::new();
    let call_for_info = client
        .post(format!("http://{addr}/api/premium"))
        .send()
        .await
        .expect("request failed");

    let status = call_for_info.status();
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
    let req_header = call_for_info
        .headers()
        .get("PAYMENT-REQUIRED")
        .unwrap()
        .to_str()
        .unwrap();
    let info = PaymentRequired::from_header(req_header).unwrap();

    let accepted: PaymentRequirements = info
        .accepts
        .first()
        .cloned()
        .expect("expected at least one accepted requirement");

    let bad_payload: PaymentPayloadV2 = PaymentPayloadV2 {
        x402_version: info.x402_version,
        resource: info.resource.clone(),
        accepted,
        payload: json!({ "this": "is-not-a-valid-payload" }),
        extensions: None,
    };

    let wrapped_payload_header = PaymentPayload::V2(bad_payload);
    let payload_header = wrapped_payload_header.to_header().unwrap();

    let res = client
        .post(format!("http://{addr}/api/premium"))
        .header("PAYMENT-SIGNATURE", payload_header)
        .send()
        .await
        .expect("second request failed");

    assert_eq!(res.status(), 400);
    let res_text = res.text().await.expect("failed to read response body");
    assert!(res_text.contains("missing or invalid signature"));
}
