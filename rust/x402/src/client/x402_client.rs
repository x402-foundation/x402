use crate::errors::X402Result;
use crate::types::{PaymentPayload, PaymentRequired};
use async_trait::async_trait;

#[async_trait]
pub trait X402Client: Send + Sync {
    /// Given a PaymentRequired challenge, build a matching PaymentPayload.
    async fn create_payment_payload(
        &self,
        required: &PaymentRequired,
    ) -> X402Result<PaymentPayload>;
}
