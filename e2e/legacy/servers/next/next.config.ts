import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    nodeMiddleware: true, // TEMPORARY: Only needed until Edge runtime support is added
  } as NextConfig["experimental"],
  env: {
    EVM_PAYEE_ADDRESS: process.env.EVM_PAYEE_ADDRESS,
    EVM_NETWORK: process.env.EVM_NETWORK,
    FACILITATOR_URL: process.env.FACILITATOR_URL,
    PORT: process.env.PORT,
  },
  webpack(config) {
    config.module.rules.push({
      test: /\.svg$/,
      use: ["@svgr/webpack"],
    });

    // Handle Node.js modules that might not be compatible with Edge Runtime
    config.resolve.fallback = {
      ...config.resolve.fallback,
      crypto: require.resolve("crypto-browserify"),
      stream: require.resolve("stream-browserify"),
      buffer: require.resolve("buffer"),
    };

    return config;
  },
};

export default nextConfig;
