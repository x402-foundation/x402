use crate::client::http::evm_exact_build_payload;
use crate::client::x402_client::X402Client;
use crate::errors::X402Result;
use crate::types::{PaymentPayload, PaymentRequired};
use alloy::signers::Signer;

pub struct EvmExactClient<S> {
    signer: S,
}

impl<S> EvmExactClient<S> {
    pub fn new(signer: S) -> Self {
        Self { signer }
    }
}

#[async_trait::async_trait]
impl<S> X402Client for EvmExactClient<S>
where
    S: Signer + Send + Sync,
{
    async fn create_payment_payload(
        &self,
        required: &PaymentRequired,
    ) -> X402Result<PaymentPayload> {
        evm_exact_build_payload(&self.signer, required).await
    }
}
