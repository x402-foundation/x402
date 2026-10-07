use crate::client::x402_client::X402Client;
use crate::errors::{X402Error, X402Result};
use crate::schemes::evm::sign_transfer_with_authorization;
use crate::types::{
    AuthorizationV1, PayloadExactV1, PaymentPayload, PaymentPayloadV1, PaymentPayloadV2,
    PaymentRequired, PaymentRequirements, X402Header,
};
use alloy::signers::Signer;
use http::StatusCode;
use reqwest::{Client, RequestBuilder, Response};
use serde_json::json;

/// A client for handling X402 payment-required HTTP requests.
///
/// It wraps a `reqwest::Client` and provides methods to automatically handle
/// 402 Payment Required challenges by using a challenge handler or a signer.
pub struct X402HttpClient<C> {
    /// The underlying HTTP client.
    pub client: Client,
    pub core: C,
}

impl<C> X402HttpClient<C>
where
    C: X402Client,
{
    pub async fn create_payment_payload(
        &self,
        required: &PaymentRequired,
    ) -> X402Result<PaymentPayload> {
        self.core.create_payment_payload(required).await
    }

    // plus your execute(...) helper that:
    // - detects 402
    // - decodes PaymentRequired
    // - calls self.core.create_payment_payload(...)
    // - retries with PAYMENT-SIGNATURE header
}

impl<C> X402HttpClient<C>
where
    C: X402Client,
{
    /// Creates a new `X402Client` with a default `reqwest::Client`.
    pub fn new(core: C) -> Self {
        Self {
            client: Client::new(),
            core,
        }
    }

    /// Creates a new `X402Client` using the provided `reqwest::Client`.
    pub fn with_client(client: Client, core: C) -> Self {
        Self { client, core }
    }

    /// Executes an HTTP request and handles potential X402 challenges.
    ///
    /// If the server responds with 402 Payment Required, this method calls the
    /// `challenge_handler` to solve the challenge and then retries the request.
    ///
    /// # Example
    /// ```ignore
    /// # use x402::client::X402Client;
    /// # use x402::types::PaymentPayload;
    /// # async fn doc() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = X402Client::new();
    /// let res = client.execute(
    ///     || client.client.get("https://api.example.com/premium"),
    ///     |challenge| async move {
    ///         // Solve the challenge and return PaymentPayload
    ///         // See examples/buyers for reference
    ///     }
    /// ).await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn execute<B, H, FutH>(
        &self,
        mut build_req: B,
        challenge_handler: H,
    ) -> X402Result<Response>
    where
        B: FnMut() -> RequestBuilder,
        H: Fn(PaymentRequired) -> FutH,
        FutH: Future<Output = X402Result<PaymentPayload>>,
    {
        // Make the first attempt with no payment
        let response = build_req().send().await?;

        // Handle x402 challenge
        if response.status() == StatusCode::PAYMENT_REQUIRED
            && let Some(header) = response.headers().get("PAYMENT-REQUIRED")
        {
            let header_str = header
                .to_str()
                .map_err(|e| X402Error::InvalidHeader(e.to_string()))?;
            let challenge = PaymentRequired::from_header(header_str)?;

            // Use signer to solve the challenge
            let payload = challenge_handler(challenge).await?;
            let signature_header = payload.to_header()?;

            // Retry with payment
            return Ok(build_req()
                .header("PAYMENT-SIGNATURE", signature_header)
                .send()
                .await?);
        }
        Ok(response)
    }

    /// Executes an HTTP request and handles EVM-based X402 challenges automatically.
    ///
    /// This is a convenience method that uses a `Signer` to solve challenges
    /// for EVM-compatible networks. It supports both V1 and V2 protocol versions.
    ///
    /// # Example
    /// ```no_run
    /// # use x402::client::X402Client;
    /// # use alloy::signers::local::PrivateKeySigner;
    /// # use x402::client::evm::exact::EvmExactClient;
    /// # async fn doc() -> Result<(), Box<dyn std::error::Error>> {
    /// let signer = PrivateKeySigner::random();
    /// let evm_client = EvmExactClient::new(signer.clone());
    /// let x402_client = X402Client::new(evm_client);
    /// let res = x402_client.execute_with_evm_exact(
    ///     || x402_client.client.get("https://api.example.com/premium"),
    ///     signer
    /// ).await.unwrap();
    /// # Ok(())
    /// # }
    /// ```
    pub async fn execute_with_evm_exact<B, S>(
        &self,
        build_req: B,
        signer: S,
    ) -> X402Result<Response>
    where
        B: FnMut() -> RequestBuilder,
        S: Signer + Send + Sync + Clone,
    {
        let challenge_handler = move |challenge: PaymentRequired| {
            let wallet_signer = signer.clone();
            async move { evm_exact_build_payload(&wallet_signer, &challenge).await }
        };
        self.execute(build_req, challenge_handler).await
    }
}

/// Helper function to build a `PaymentPayload` for EVM exact payment requirements.
pub async fn evm_exact_build_payload<S>(
    signer: &S,
    challenge: &PaymentRequired,
) -> X402Result<PaymentPayload>
where
    S: Signer + Send + Sync,
{
    let wallet_address = signer.address();

    let accepted = challenge.accepts.first().cloned().ok_or_else(|| {
        X402Error::ConfigError("no V1 or V2 payment requirements found in challenge".into())
    })?;

    match &accepted {
        PaymentRequirements::V2(payment_requirements) => {
            let (signature_hex, auth) = sign_transfer_with_authorization(
                signer,
                &wallet_address.to_string(),
                &accepted,
                payment_requirements.u64_network()?,
                None,
            )
            .await
            .expect("sign_transfer_with_authorization failed");

            let authorization_json = json!({
               "from": wallet_address,
               "to": payment_requirements.pay_to,
               "value": payment_requirements.amount,
               "validAfter": auth.validAfter.to_string(),
               "validBefore": auth.validBefore.to_string(),
               "nonce": format!("0x{}", hex::encode(auth.nonce.as_slice())),
            });

            let evm_payload = json!({
                "signature": signature_hex,
                "authorization": authorization_json,
            });

            let payload = PaymentPayloadV2 {
                x402_version: challenge.x402_version,
                resource: challenge.resource.clone(),
                accepted: PaymentRequirements::V2(payment_requirements.clone()),
                payload: evm_payload,
                extensions: challenge.extensions.clone(),
            };
            Ok(PaymentPayload::V2(payload))
        }
        PaymentRequirements::V1(payment_requirements) => {
            let (signature_hex, auth) = sign_transfer_with_authorization(
                signer,
                &wallet_address.to_string(),
                &accepted,
                payment_requirements.u64_network()?,
                None,
            )
            .await
            .expect("sign_transfer_with_authorization failed");

            let exact_payment_payload = PayloadExactV1 {
                signature: signature_hex,
                authorization: AuthorizationV1 {
                    from: wallet_address.to_string(),
                    to: payment_requirements.pay_to.clone(),
                    value: payment_requirements.max_amount_required.to_string(),
                    valid_after: auth.validAfter.to_string(),
                    valid_before: auth.validBefore.to_string(),
                    nonce: format!("0x{}", hex::encode(auth.nonce.as_slice())),
                },
            };
            let payload = PaymentPayloadV1 {
                x402_version: 1,
                scheme: payment_requirements.scheme.clone(),
                network: payment_requirements.network.clone(),
                payload: exact_payment_payload,
            };

            Ok(PaymentPayload::V1(payload))
        }
    }
}
