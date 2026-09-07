pub mod cdp_request_hook;
mod http;
mod x402_facilitator;

pub use http::HttpFacilitator;
pub use http::HttpFacilitator as Facilitator;
pub use x402_facilitator::FacilitatorClient;

// Optional helper for a default HTTP facilitator wrapped in Arc<dyn FacilitatorClient>

use std::sync::Arc;

pub fn default_http_facilitator(base_url: &str) -> Arc<dyn FacilitatorClient> {
    Arc::new(HttpFacilitator::new(base_url))
}
