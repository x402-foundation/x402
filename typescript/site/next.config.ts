import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @aptos-labs/ts-sdk uses native crypto and other Node.js APIs that conflict with Next.js bundling
  // Its transitive dependencies (got, keyv, cacheable-request) also need to be externalized
  serverExternalPackages: [
    "@aptos-labs/ts-sdk",
    "@aptos-labs/aptos-client",
    "got",
    "keyv",
    "cacheable-request",
  ],
  images: {
    formats: ["image/avif", "image/webp"],
  },
  async headers() {
    return [
      {
        source: "/api/stats",
        headers: [
          {
            key: "Cache-Control",
            value: "s-maxage=300, stale-while-revalidate=600",
          },
        ],
      },
      {
        source: "/",
        headers: [
          {
            key: "Link",
            value:
              '</.well-known/api-catalog>; rel="api-catalog", </writing/x402-v2-launch>; rel="service-doc", </protected>; rel="payment-required"',
          },
          {
            key: "X-X402-Supported",
            value: "true",
          },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/build",
        destination: "/build-with-us",
      },
      {
        source: "/.well-known/api-catalog",
        destination: "/api/well-known/api-catalog",
      },
    ];
  },
  async redirects() {
    return [
      {
        source: "/protocol",
        destination: "/",
        permanent: false,
      },
      {
        source: "/foundation",
        destination: "/",
        permanent: false,
      },
      {
        source: "/build",
        destination: "/",
        permanent: false,
      },
      {
        source: "/build-with-us",
        destination: "/",
        permanent: false,
      },
    ];
  },
  turbopack: {
    rules: {
      "*.svg": {
        loaders: ["@svgr/webpack"],
        as: "*.js",
      },
    },
  },
  webpack(config) {
    config.module.rules.push({
      test: /\.svg$/,
      use: ["@svgr/webpack"],
    });

    return config;
  },
};

export default nextConfig;
