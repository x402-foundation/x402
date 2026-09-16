use axum::{
    body::Body,
    extract::State,
    http::{Request, Response, StatusCode},
    middleware::Next,
    response::IntoResponse,
};
use std::collections::HashMap;

use crate::errors::X402Error;
use crate::facilitator::FacilitatorClient;
use crate::server::{InMemoryResourceServer, ResourceConfig, ResourceServer, SchemeNetworkServer};
use crate::types::{
    Network, PaymentPayload, PaymentRequired, PaymentRequirements, Resource, ResourceV2, X402Header,
};
use std::sync::Arc;

#[derive(Clone)]
pub struct RouteMeta {
    pub base_url: String,
    pub resource_path: String,
    pub description: Option<String>,
    pub mime_type: Option<String>,
    pub resource_config: ResourceConfig,
}

impl RouteMeta {
    pub fn resource_url(&self) -> String {
        let base = self.base_url.trim_end_matches('/');
        let path = self.resource_path.trim_start_matches('/');
        format!("{}/{}", base, path)
    }
}

#[derive(Clone)]
pub struct X402Config {
    pub facilitator: Arc<dyn FacilitatorClient>,
    pub resource_server: Arc<InMemoryResourceServer>,
    pub routes: Arc<HashMap<String, RouteMeta>>,
}

pub struct X402ConfigBuilder {
    facilitator: Arc<dyn FacilitatorClient>,
    resource_server: InMemoryResourceServer,
    routes: HashMap<String, RouteMeta>,
    base_url: String,
}

impl X402ConfigBuilder {
    pub fn new(server_base_url: &str, facilitator: Arc<dyn FacilitatorClient>) -> Self {
        Self {
            facilitator,
            resource_server: InMemoryResourceServer::new(),
            routes: HashMap::new(),
            base_url: server_base_url.to_owned(),
        }
    }

    pub fn register_scheme(
        &mut self,
        network: Network,
        server: Arc<dyn SchemeNetworkServer>,
    ) -> &mut Self {
        self.resource_server.register_scheme(network, server);
        self
    }

    pub fn register_resource(
        &mut self,
        resource_config: ResourceConfig,
        resource_path: &str,
        description: Option<&str>,
        mime_type: Option<&str>,
    ) -> &mut Self {
        let meta = RouteMeta {
            base_url: self.base_url.clone(),
            resource_path: resource_path.to_owned(),
            description: description.map(|s| s.to_owned()),
            mime_type: mime_type.map(|s| s.to_owned()),
            resource_config,
        };
        self.routes.insert(resource_path.to_owned(), meta);
        self
    }

    pub fn build(self) -> X402Config {
        X402Config {
            facilitator: self.facilitator,
            resource_server: Arc::new(self.resource_server),
            routes: Arc::new(self.routes),
        }
    }
}

pub async fn x402_middleware(
    State(config): State<X402Config>,
    req: Request<Body>,
    next: Next,
) -> Response<Body> {
    // Configuration
    let path = req.uri().path();

    let route = match config.routes.get(path) {
        Some(route) => route,
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Route not registered: {}. Please register this resource in the X402Config before passing it to the middleware layer.", path),
            ).into_response();
        }
    };

    // Build the payment requirements we have registered in the resource server
    let accepts = match config
        .resource_server
        .build_payment_requirements(&route.resource_config)
    {
        Ok(payment_required) => payment_required,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!(
                    "Failed to build payment requirements for route {}: {}",
                    path, e
                ),
            )
                .into_response();
        }
    };

    let signature_header = req
        .headers()
        .get("PAYMENT-SIGNATURE")
        .and_then(|value| value.to_str().ok());

    match signature_header {
        Some(header_value) => {
            // Decode Payload
            let payload = match PaymentPayload::from_header(header_value) {
                Ok(p) => p,
                Err(e) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        format!("Invalid payment header format: {}", e),
                    )
                        .into_response();
                }
            };

            // Ensure the client-chosen requirement matches one of our 'accepts'.
            let matched_req = accepts.iter().find(|server_req| match server_req {
                PaymentRequirements::V1(server) => match &payload {
                    PaymentPayload::V1(client) => {
                        server.scheme == client.scheme
                            && server.network == client.network
                            && server.pay_to == client.payload.authorization.to
                            && server.max_amount_required == client.payload.authorization.value
                    }
                    _ => false,
                },
                PaymentRequirements::V2(server) => match &payload {
                    PaymentPayload::V2(client_payload) => match &client_payload.accepted {
                        PaymentRequirements::V2(client_accepted) => {
                            server.scheme == client_accepted.scheme
                                && server.network == client_accepted.network
                                && server.pay_to == client_accepted.pay_to
                                && server.amount == client_accepted.amount
                                && server.asset == client_accepted.asset
                                && match &client_payload.resource {
                                    Resource::V2(client_resource) => {
                                        route.resource_url() == client_resource.url
                                    }
                                    _ => false,
                                }
                        }
                        _ => false,
                    },
                    _ => false,
                },
            });

            // Verify with facilitator
            let accepted_requirement = match matched_req.cloned() {
                Some(requirement) => requirement,
                None => {
                    return (
                        StatusCode::UNAUTHORIZED,
                        format!("Client-chosen requirement does not match any of the accepted requirements for route: {}", path),
                    ).into_response();
                }
            };

            match config
                .facilitator
                .verify(payload.clone(), accepted_requirement.clone())
                .await
            {
                Ok(verify_result) if verify_result.is_valid => {
                    // Run the route handler
                    let response = next.run(req).await;

                    if response.status().is_success() {
                        match config
                            .facilitator
                            .settle(payload, accepted_requirement)
                            .await
                        {
                            Ok(settle_response) => {
                                if settle_response.success {
                                    response
                                } else {
                                    let err_msg = format!(
                                        "Failed to settle payment: {}",
                                        settle_response
                                            .error_reason
                                            .unwrap_or("Unknown Reason".to_owned())
                                    );
                                    (StatusCode::NOT_ACCEPTABLE, err_msg).into_response()
                                }
                            }
                            Err(e) => {
                                dbg!("Failed to settle payment: {:?}", e);
                                (
                                    StatusCode::INTERNAL_SERVER_ERROR,
                                    "Failed to settle payment",
                                )
                                    .into_response()
                            }
                        }
                    } else {
                        response
                    }
                }
                Ok(verify_result) => {
                    let reason = verify_result
                        .invalid_reason
                        .unwrap_or_else(|| "Unknown verification error".to_string());
                    if reason.to_ascii_lowercase().contains("unauthorized") {
                        return (
                            StatusCode::UNAUTHORIZED,
                            format!("Payment verification failed: {}", reason),
                        )
                            .into_response();
                    }
                    (
                        StatusCode::BAD_REQUEST,
                        format!("Payment verification failed: {}", reason),
                    )
                        .into_response()
                }
                Err(X402Error::FacilitatorRejection(code, msg)) => {
                    // Facilitator explicitly said 'No'
                    (
                        StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_REQUEST),
                        msg,
                    )
                        .into_response()
                }
                Err(e) => {
                    // Failed to verify signature
                    (
                        StatusCode::SERVICE_UNAVAILABLE,
                        format!("Facilitator error: {}", e),
                    )
                        .into_response()
                }
            }
        }
        None => {
            //  No signature provided: Return 402 with the required payment info
            // Does this need to change?
            let payment_required = PaymentRequired {
                x402_version: 2,
                resource: Resource::V2(ResourceV2 {
                    url: route.resource_url(),
                    description: route.description.clone().unwrap_or_default(),
                    mime_type: "application/json".to_string(),
                }),
                accepts,
                description: route.description.clone(),
                extensions: None,
            };

            match payment_required.to_header() {
                Ok(header_val) => Response::builder()
                    .status(StatusCode::PAYMENT_REQUIRED)
                    .header("PAYMENT-REQUIRED", header_val)
                    .body(Body::from("Payment Required"))
                    .unwrap(),
                Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::X402Result;
    use crate::facilitator::HttpFacilitator;
    use crate::types::CAIPNetwork;
    use crate::types::{
        PaymentPayloadV2, PaymentRequirements, PaymentRequirementsV2, Resource, SettleResponse,
        VerifyResponse,
    };
    use axum::{Router, routing::get};
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use serde_json::json;
    use tower::ServiceExt; // for oneshot
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    struct MockSchemeServer;

    impl SchemeNetworkServer for MockSchemeServer {
        fn scheme(&self) -> &str {
            "exact"
        }

        fn x402_version(&self) -> u32 {
            2
        }

        fn build_requirements(
            &self,
            resource_config: &ResourceConfig,
        ) -> X402Result<PaymentRequirements> {
            let (amount, asset) = resource_config.price.to_asset_amount();
            Ok(PaymentRequirements::V2(PaymentRequirementsV2 {
                scheme: self.scheme().to_owned(),
                network: resource_config.network.to_string(),
                pay_to: resource_config.pay_to.clone(),
                amount,
                asset,
                data: None,
                extra: None,
                max_timeout_seconds: resource_config.max_timeout_in_seconds.unwrap_or(60),
            }))
        }
    }

    fn get_resource_v2() -> Resource {
        Resource::V2(ResourceV2 {
            url: "/test".to_string(),
            description: "Test".to_string(),
            mime_type: "text/plain".to_string(),
        })
    }

    async fn setup_test_app(facilitator_url: &str) -> Router {
        let facilitator: Arc<dyn FacilitatorClient> =
            Arc::new(HttpFacilitator::new(facilitator_url));

        let network = Network::from(CAIPNetwork::new("ethereum", "1"));
        let resource_config =
            ResourceConfig::new("exact", "0x123", "100".into(), network.clone(), None);

        // Create a config builder
        let mut builder = X402ConfigBuilder::new("", facilitator);

        builder
            // Register a scheme to our config
            .register_scheme(network, Arc::new(MockSchemeServer))
            // register a resource (a route)
            .register_resource(resource_config, "/test", None, None);
        // finalize the config
        let config = builder.build();

        Router::new()
            .route("/test", get(|| async { "Success" }))
            .layer(axum::middleware::from_fn_with_state(
                config,
                x402_middleware,
            ))
    }

    #[tokio::test]
    async fn test_middleware_accepts_proper_payment_header() {
        let mock_server = MockServer::start().await;

        // Mock a 200 OK from the facilitator
        let mock_verify_response = VerifyResponse {
            is_valid: true,
            invalid_reason: None,
            payer: Some("0xabc".to_string()),
        };

        Mock::given(method("POST"))
            .and(path("/verify"))
            .respond_with(ResponseTemplate::new(200).set_body_json(mock_verify_response))
            .mount(&mock_server)
            .await;

        // Mock a 200 OK from the facilitator /settle
        let mock_settle_response = SettleResponse {
            success: true,
            error_reason: None,
            payer: Some("0xabc".to_string()),
            transaction: Some("0xdeadbeef".to_string()),
            network: "ethereum:1".to_string(),
        };

        Mock::given(method("POST"))
            .and(path("/settle"))
            .respond_with(ResponseTemplate::new(200).set_body_json(mock_settle_response))
            .mount(&mock_server)
            .await;

        let app = setup_test_app(&mock_server.uri()).await;

        // Create a fake valid-looking header
        let payload = PaymentPayload::V2(PaymentPayloadV2 {
            x402_version: 1,
            resource: get_resource_v2(),
            accepted: PaymentRequirements::V2(PaymentRequirementsV2 {
                scheme: "exact".to_string(),
                network: "ethereum:1".to_string(),
                pay_to: "0x123".to_string(),
                amount: "100".to_string(),
                max_timeout_seconds: 60,
                asset: None,
                data: None,
                extra: None,
            }),
            payload: json!({"signature": "<SIG_PLACEHOLDER>"}),
            extensions: None,
        });
        let header_val = payload.to_header().unwrap();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/test")
                    .header("PAYMENT-SIGNATURE", header_val)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(body, "Success");
    }

    #[tokio::test]
    async fn test_middleware_returns_402_when_header_missing() {
        let app = setup_test_app("http://localhost:1234").await;

        let response = app
            .oneshot(Request::builder().uri("/test").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::PAYMENT_REQUIRED);
        assert!(response.headers().contains_key("PAYMENT-REQUIRED"));
    }

    #[tokio::test]
    async fn test_middleware_handles_facilitator_rejection() {
        let mock_server = MockServer::start().await;

        // Mock a 403 Forbidden from the facilitator
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(403).set_body_string("Insufficient Balance"))
            .mount(&mock_server)
            .await;

        let app = setup_test_app(&mock_server.uri()).await;

        // Create a fake valid-looking header
        let payload = PaymentPayload::V2(PaymentPayloadV2 {
            x402_version: 1,
            resource: get_resource_v2(),
            accepted: PaymentRequirements::V2(PaymentRequirementsV2 {
                scheme: "exact".to_string(),
                network: "ethereum:1".to_string(),
                pay_to: "0x123".to_string(),
                amount: "100".to_string(),
                max_timeout_seconds: 60,
                asset: None,
                data: None,
                extra: None,
            }),
            payload: json!({"signature": "<SIG_PLACEHOLDER>"}),
            extensions: None,
        });
        let header_val = payload.to_header().unwrap();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/test")
                    .header("PAYMENT-SIGNATURE", header_val)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(body, "Insufficient Balance");
    }

    #[tokio::test]
    async fn test_middleware_handles_facilitator_not_available() {
        // Point to a port that is definitely not listening
        let app = setup_test_app("http://127.0.0.1:1").await;

        // Create a fake valid-looking header
        let payload = PaymentPayload::V2(PaymentPayloadV2 {
            x402_version: 1,
            resource: get_resource_v2(),
            accepted: PaymentRequirements::V2(PaymentRequirementsV2 {
                scheme: "exact".to_string(),
                network: "ethereum:1".to_string(),
                pay_to: "0x123".to_string(),
                amount: "100".to_string(),
                max_timeout_seconds: 60,
                asset: None,
                data: None,
                extra: None,
            }),
            payload: json!({"signature": "<SIG_PLACEHOLDER>"}),
            extensions: None,
        });
        let header_val = payload.to_header().unwrap();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/test")
                    .header("PAYMENT-SIGNATURE", header_val)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body_bytes = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        let body_str = String::from_utf8_lossy(&body_bytes);
        // This will contain the reqwest error message
        assert!(body_str.contains("Facilitator error"));
    }
}
