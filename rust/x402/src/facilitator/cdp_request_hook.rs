use crate::auth::WalletAuth;
use crate::errors::{X402Error, X402Result};
use crate::facilitator::http::RequestHook;
use http::header::{ACCEPT, AUTHORIZATION};
use std::sync::Arc;

pub struct CoinbaseRequestHook {
    pub wallet_auth: WalletAuth,
}

impl CoinbaseRequestHook {
    pub fn new(
        api_key_id: &str,
        api_secret: &str,
        app_name: Option<&str>,
        source_version: Option<&str>,
        debug: Option<bool>,
    ) -> X402Result<Arc<Self>> {
        // Build the wallet auth for the hook to build a JWT against
        let wallet_auth_result = WalletAuth::builder()
            .api_key_id(api_key_id.to_owned())
            .api_key_secret(api_secret.to_owned())
            .debug(debug.unwrap_or(false))
            .source(app_name.unwrap_or("my-app").to_string())
            .source_version(source_version.unwrap_or("1.0.0").to_string())
            .build();
        match wallet_auth_result {
            Ok(auth) => Ok(Arc::new(CoinbaseRequestHook { wallet_auth: auth })),
            Err(e) => Err(X402Error::CdpError(e)),
        }
    }
}

#[async_trait::async_trait]
impl RequestHook for CoinbaseRequestHook {
    async fn on_request(
        &self,
        method: http::Method,
        url: &reqwest::Url,
        builder: reqwest::RequestBuilder,
    ) -> reqwest::RequestBuilder {
        // Coinbase JWT is bound to "METHOD host path"
        let method_str = method.as_str();
        let host = url.host_str().unwrap_or("api.cdp.coinbase.com");
        let path = url.path();

        let jwt = self
            .wallet_auth
            .generate_jwt(method_str, host, path, 120)
            .expect("Generating JWT failed");

        builder
            .header(AUTHORIZATION, format!("Bearer {}", jwt))
            .header(ACCEPT, "application/json")
    }
}
