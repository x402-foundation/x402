fn main() {
    // Compile protobuf definitions at build time
    prost_build::Config::new()
        .out_dir("src/pb")
        .compile_protos(
            &["proto/agentpay/v1/agentpay.proto"],
            &["proto/"],
        )
        .unwrap_or_else(|e| panic!("Failed to compile protos: {}", e));
}
