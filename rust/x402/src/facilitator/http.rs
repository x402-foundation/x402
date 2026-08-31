use crate::errors::{X402Error, X402Result};
use crate::facilitator::FacilitatorClient;
use crate::types::{
    PaymentPayload, PaymentPayloadV1, PaymentRequirements, PaymentRequirementsV1, SettleResponse,
    SupportedResponse, VerifyRequest, VerifyRequestV1, VerifyResponse,
};
use http::HeaderMap;
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::sync::Arc;

pub struct HttpFacilitator {
    pub base_url: String,
    verify_path: String,
    settle_path: String,
    supported_path: String,
    client: reqwest::Client,
    headers: HeaderMap,
    request_hook: Option<Arc<dyn RequestHook>>,
}

/// Builder for HttpFacilitator
pub struct HttpFacilitatorBuilder {
    base_url: String,
    verify_path: Option<String>,
    settle_path: Option<String>,
    supported_path: Option<String>,
    headers: HeaderMap,
    client: Option<reqwest::Client>,
    request_hook: Option<Arc<dyn RequestHook>>,
}

#[async_trait::async_trait]
pub trait RequestHook: Send + Sync {
    async fn on_request(
        &self,
        method: http::Method,
        url: &reqwest::Url,
        builder: reqwest::RequestBuilder,
    ) -> reqwest::RequestBuilder;
}

impl HttpFacilitatorBuilder {
    /// Override the verify endpoint path (e.g. "/verify").
    pub fn with_verify_path(mut self, path: impl Into<String>) -> Self {
        self.verify_path = Some(path.into());
        self
    }

    /// Override the settle endpoint path (e.g. "/settle").
    pub fn with_settle_path(mut self, path: impl Into<String>) -> Self {
        self.settle_path = Some(path.into());
        self
    }

    /// Override the supported endpoint path (e.g. "/supported").
    pub fn with_supported_path(mut self, path: impl Into<String>) -> Self {
        self.supported_path = Some(path.into());
        self
    }

    /// Set headers used for all requests (e.g. auth).
    pub fn with_headers(mut self, headers: HeaderMap) -> Self {
        self.headers = headers;
        self
    }

    /// Override the underlying reqwest client (optional).
    pub fn with_client(mut self, client: reqwest::Client) -> Self {
        self.client = Some(client);
        self
    }

    pub fn with_request_hook(mut self, request_hook: Arc<dyn RequestHook>) -> Self {
        self.request_hook = Some(request_hook);
        self
    }

    pub fn build(self) -> HttpFacilitator {
        HttpFacilitator {
            base_url: self.base_url,
            verify_path: self.verify_path.unwrap_or_else(|| "/verify".to_string()),
            settle_path: self.settle_path.unwrap_or_else(|| "/settle".to_string()),
            supported_path: self
                .supported_path
                .unwrap_or_else(|| "/supported".to_string()),
            client: self.client.unwrap_or_default(),
            headers: self.headers,
            request_hook: self.request_hook,
        }
    }
}

impl HttpFacilitator {
    pub fn builder(base_url: impl Into<String>) -> HttpFacilitatorBuilder {
        HttpFacilitatorBuilder {
            base_url: base_url.into(),
            verify_path: Some("/verify".to_string()),
            settle_path: Some("/settle".to_string()),
            supported_path: Some("/supported".to_string()),
            headers: HeaderMap::new(),
            client: None,
            request_hook: None,
        }
    }

    fn join_url(base: &str, path: &str) -> String {
        let base = base.trim_end_matches('/');
        let path = path.trim_start_matches('/');
        format!("{}/{}", base, path)
    }

    pub fn new(base_url: &str) -> Self {
        Self::builder(base_url).build()
    }

    fn verify_url(&self) -> String {
        Self::join_url(&self.base_url, &self.verify_path)
    }

    fn settle_url(&self) -> String {
        Self::join_url(&self.base_url, &self.settle_path)
    }

    fn supported_url(&self) -> String {
        Self::join_url(&self.base_url, &self.supported_path)
    }

    /// Generalized post-method to reuse common route logic across 'verify' and 'settle'
    async fn post_json<Req, Res>(&self, url: String, req: &Req) -> X402Result<Res>
    where
        Req: Serialize + ?Sized,
        Res: DeserializeOwned,
    {
        let method = http::Method::POST;
        let full_url = reqwest::Url::parse(&url)
            .map_err(|e| X402Error::ConfigError(format!("Invalid facilitator URL: {e}")))?;

        let mut builder = self
            .client
            .post(full_url.clone())
            .headers(self.headers.clone())
            .json(req);

        if let Some(hook) = &self.request_hook {
            builder = hook.on_request(method.clone(), &full_url, builder).await;
        }

        let response = builder.send().await?;

        let status = response.status();
        if !status.is_success() {
            let err_text = response
                .text()
                .await
                .unwrap_or_else(|e| format!("Unknown Error: {}", e));
            return Err(X402Error::FacilitatorRejection(status.as_u16(), err_text));
        }

        Ok(response.json::<Res>().await?)
    }
}

#[async_trait::async_trait]
impl FacilitatorClient for HttpFacilitator {
    async fn verify(
        &self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ) -> X402Result<VerifyResponse> {
        match (payload, requirements) {
            (PaymentPayload::V1(payload), PaymentRequirements::V1(requirements)) => {
                let payment_payload = PaymentPayloadV1 {
                    x402_version: payload.x402_version,
                    scheme: payload.scheme.clone(),
                    network: payload.network.clone(),
                    payload: payload.payload,
                };
                let payment_requirements = PaymentRequirementsV1 {
                    scheme: payload.scheme,
                    network: payload.network,
                    max_amount_required: requirements.max_amount_required,
                    resource: requirements.resource,
                    description: requirements.description,
                    mime_type: requirements.mime_type,
                    pay_to: requirements.pay_to,
                    max_timeout_seconds: requirements.max_timeout_seconds,
                    asset: requirements.asset,
                    output_schema: requirements.output_schema,
                    extra: requirements.extra,
                };

                let request = VerifyRequest {
                    x402_version: payload.x402_version,
                    payment_payload: PaymentPayload::V1(payment_payload),
                    payment_requirements: PaymentRequirements::V1(payment_requirements),
                };
                self.post_json(self.verify_url(), &request).await
            }
            (PaymentPayload::V2(payload), PaymentRequirements::V2(requirements)) => {
                let request = VerifyRequest {
                    x402_version: payload.x402_version,
                    payment_payload: PaymentPayload::V2(payload),
                    payment_requirements: PaymentRequirements::V2(requirements),
                };
                self.post_json(self.verify_url(), &request).await
            }
            _ => Err(X402Error::ConfigError(
                "Payload and requirements version mismatch".to_string(),
            )),
        }
    }

    async fn settle(
        &self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ) -> X402Result<SettleResponse> {
        match (payload, requirements) {
            (PaymentPayload::V1(payload), PaymentRequirements::V1(requirements)) => {
                let request = VerifyRequestV1 {
                    x402_version: payload.x402_version,
                    payment_payload: PaymentPayloadV1 {
                        x402_version: payload.x402_version,
                        scheme: payload.scheme.clone(),
                        network: payload.network.clone(),
                        payload: payload.payload,
                    },
                    payment_requirements: PaymentRequirementsV1 {
                        scheme: payload.scheme,
                        network: payload.network,
                        max_amount_required: requirements.max_amount_required,
                        resource: requirements.resource,
                        description: requirements.description,
                        mime_type: requirements.mime_type,
                        pay_to: requirements.pay_to,
                        max_timeout_seconds: requirements.max_timeout_seconds,
                        asset: requirements.asset,
                        output_schema: requirements.output_schema,
                        extra: requirements.extra,
                    },
                };
                self.post_json(self.settle_url(), &request).await
            }
            (PaymentPayload::V2(payload), PaymentRequirements::V2(requirements)) => {
                let request = VerifyRequest {
                    x402_version: payload.x402_version,
                    payment_payload: PaymentPayload::V2(payload),
                    payment_requirements: PaymentRequirements::V2(requirements),
                };
                self.post_json(self.settle_url(), &request).await
            }
            _ => Err(X402Error::ConfigError(
                "Payload and requirements version mismatch".to_string(),
            )),
        }
    }

    async fn supported(&self) -> X402Result<SupportedResponse> {
        let method = http::Method::GET;
        let full_url = reqwest::Url::parse(self.supported_url().as_str())
            .map_err(|e| X402Error::ConfigError(format!("Invalid facilitator URL: {e}")))?;

        let mut builder = self
            .client
            .get(full_url.clone())
            .headers(self.headers.clone());

        if let Some(hook) = &self.request_hook {
            builder = hook.on_request(method.clone(), &full_url, builder).await;
        }

        let response = builder.send().await?;
        let status = response.status();
        if !status.is_success() {
            let err_text = response
                .text()
                .await
                .unwrap_or_else(|e| format!("Unknown Error: {}", e));
            return Err(X402Error::FacilitatorRejection(status.as_u16(), err_text));
        }

        Ok(response.json::<SupportedResponse>().await?)
    }
}
