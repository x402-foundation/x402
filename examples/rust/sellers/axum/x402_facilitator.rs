use alloy::primitives::utils::parse_units;
use axum::routing::post;
use axum::{Json, Router};
use serde::Serialize;
use tokio::net::TcpListener;
use x402::facilitator::default_http_facilitator;
use x402::frameworks::axum_integration::{x402_middleware, X402Config, X402ConfigBuilder};
use x402::server::SchemeServer;
use x402::types::{AssetAmount, Price};


fn get_x402_config() -> X402Config {
    // Our facilitator requires a server to generate the scheme for the buyer to match.
    // The default helper server SchemeServer can be used to create a default server utilizing USDC on base-sepolia
    // It must be under an Atomic Reference Counter
    let scheme_server = SchemeServer::new_default();

    // Some configration variables to build our config from
    // The address that will receive the payment
    let receiving_address = "0xD49603C9D70A772361b1B396E4b4fe181426d925";
    // The address of the asset to pay with, in this case USDC on base-sepolia
    let usdc_address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    // $0.01 converted to USDC units
    let price_usdc = parse_units("0.01", 6)
        .expect("Failed to parse price units")
        .to_string();
    // Properly formated Price enum for the address and the amount
    let price = Price::AssetAmount(
        AssetAmount::new(
            usdc_address,
            &price_usdc,
            None
        )
    );

    // The scheme server allows us to create a config from using the remaining components passed into the build function
    let resource_config = scheme_server.build_resource_config(
        receiving_address,
        price,
        None,
    );

    // We pass our data through our server to a facilitator to validate and settle payments
    let facilitator_url = "https://x402.org/facilitator";
    let facilitator = default_http_facilitator(facilitator_url);

    // We build our x402 config to pass to the middleware by registering schemes and resources the server can use to relay back to buyers
    let mut x402_config_builder = X402ConfigBuilder::new(
        "https://api.example.com", // The base url for our example server
        facilitator,
    );

    // Build in our defined resources and schemes.
    x402_config_builder
        // The scheme is the shape of the payment object available to the buyer
        .register_scheme(scheme_server.network(), scheme_server)
        // A resource is a protected route with who and how much should be paid
        .register_resource(
            resource_config,
            "/api/premium",
            Some("A premium resource behind a protected route"),
            None,
        );

    // When we are done defining the schemes and resources available for our server, we build the configuration
    x402_config_builder.build()
}

#[derive(Serialize)]
struct Recipe {
    title: String,
    ingredients: Vec<String>,
    instructions: Vec<String>,
}
async fn premium_resource_endpoint() -> Json<Recipe> {
    let recipie = Recipe {
        title: "Krabby Patty Recipe".to_string(),
        ingredients: vec![
            "1 sesame seed bun".to_string(),
            "1 all-beef patty".to_string(),
            "2 slices of cheese".to_string(),
            "Lettuce".to_string(),
            "Tomato".to_string(),
            "Onions".to_string(),
            "Pickles".to_string(),
            "Ketchup".to_string(),
            "Mustard".to_string(),
            "Secret sauce (recipe unknown)".to_string(),
        ],
        instructions: vec![
            "Toast the sesame seed bun until golden brown".to_string(),
            "Grill the all-beef patty to perfection".to_string(),
            "Place patty on bottom bun".to_string(),
            "Add 2 slices of cheese on top of patty".to_string(),
            "Layer lettuce, tomato, onions, and pickles".to_string(),
            "Apply ketchup and mustard".to_string(),
            "Drizzle with secret sauce".to_string(),
            "Top with crown of bun".to_string(),
            "Serve hot and enjoy!".to_string(),
        ],
    };
    Json(recipie)
}

#[tokio::main]
async fn main() {
    // First, get our x402 configuration to pass to the axum middleware
    let x402_config = get_x402_config();

    // Define our axum application
    let app = Router::new()
        .route("/api/premium", post(premium_resource_endpoint))
        .layer(axum::middleware::from_fn_with_state(x402_config, x402_middleware));

    // Bind to an address and port
    let listener = TcpListener::bind("0.0.0.0:3000").await.expect("Can not bind to 0.0.0.0:3000");
    println!("Server listening on {:?}", listener.local_addr().unwrap());

    // Run the server
    axum::serve(listener, app).await.expect("Can not run server");
}