import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { NextRequest, NextResponse } from "next/server";

/**
 * Generate a session token for Coinbase Onramp and Offramp using Secure Init
 *
 * This endpoint creates a server-side session token that can be used
 * instead of passing appId and addresses directly in onramp/offramp URLs.
 *
 * Setup:
 * 1. Set CDP_API_KEY_ID and CDP_API_KEY_SECRET environment variables
 * 2. Copy this file to: app/api/x402/session-token/route.ts
 *
 * @param request - The NextRequest containing the session token request
 * @returns Promise<NextResponse> - The response containing the session token or error
 */
export async function POST(request: NextRequest) {
  try {
    // Get CDP API credentials from environment variables
    const apiKeyId = process.env.CDP_API_KEY_ID;
    const apiKeySecret = process.env.CDP_API_KEY_SECRET;

    if (!apiKeyId || !apiKeySecret) {
      console.error("Missing CDP API credentials");
      return NextResponse.json(
        { error: "Server configuration error: Missing CDP API credentials" },
        { status: 500 },
      );
    }

    // Parse request body
    const body = (await request.json()) as {
      addresses?: Array<{ address: string; blockchains?: string[] }>;
      assets?: string[];
    };
    const { addresses, assets } = body;

    if (!addresses || !Array.isArray(addresses) || addresses.length === 0) {
      return NextResponse.json(
        { error: "addresses is required and must be a non-empty array" },
        { status: 400 },
      );
    }

    // Generate JWT for authentication
    const jwt = await generateJwt({
      apiKeyId,
      apiKeySecret,
      requestMethod: "POST",
      requestHost: "api.developer.coinbase.com",
      requestPath: "/onramp/v1/token",
    });

    // Create session token request payload
    const tokenRequestPayload = {
      addresses: addresses.map((addr: { address: string; blockchains?: string[] }) => ({
        address: addr.address,
        blockchains: addr.blockchains || ["base"],
      })),
      ...(assets && { assets }),
    };

    // Call Coinbase API to generate session token
    const response = await fetch("https://api.developer.coinbase.com/onramp/v1/token", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(tokenRequestPayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Failed to generate session token:", response.status, errorText);
      return NextResponse.json(
        { error: "Failed to generate session token" },
        { status: response.status },
      );
    }

    const data = await response.json();

    return NextResponse.json(data);
  } catch (error) {
    console.error("Error generating session token:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
