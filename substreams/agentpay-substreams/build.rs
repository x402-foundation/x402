fn main() {
    prost_build::compile_protos(
        &["proto/agentpay/v1/agentpay.proto"],
        &["proto/"],
    ).unwrap_or_else(|e| panic!("Failed to compile protos: {}", e));
}
