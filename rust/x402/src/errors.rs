use cdp_sdk::error::CdpError;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum X402Error {
    #[error("Payment Required")]
    PaymentRequired,

    #[error("Invalid x402 header: {0}")]
    InvalidHeader(String),

    #[error("Verification failed: {0}")]
    VerificationFailed(String),

    #[error("Config error: {0}")]
    ConfigError(String),

    #[error("Facilitator error: {0}")]
    FacilitatorError(#[from] reqwest::Error),

    #[error("Facilitator Rejection: {0}: {1}")]
    FacilitatorRejection(u16, String),

    #[error("Serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),

    #[error("Base64 error: {0}")]
    Base64Error(#[from] base64::DecodeError),

    #[error("UTF8 error: {0}")]
    Utf8Error(#[from] std::string::FromUtf8Error),

    #[error("Internal error: {0}")]
    Internal(String),

    #[error("CDP error: {0}")]
    CdpError(#[from] CdpError),
}

/// x402 specific Result type for x402 operations. Returns a result with a x402 error
pub type X402Result<T> = Result<T, X402Error>;
