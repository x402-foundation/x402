use crate::errors::X402Result;
use crate::types::{
    PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse,
};

#[async_trait::async_trait]
pub trait FacilitatorClient: Send + Sync {
    async fn verify(
        &self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ) -> X402Result<VerifyResponse>;

    async fn settle(
        &self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ) -> X402Result<SettleResponse>;

    async fn supported(&self) -> X402Result<SupportedResponse>;
}
