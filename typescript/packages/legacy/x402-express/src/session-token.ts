import { generateJwt } from "@coinbase/cdp-sdk/auth";
import type { Request, Response } from "express";

/**
 * Generate a session token for Coinbase Onramp and Offramp using Secure Init
 *
 * This endpoint creates a server-side session token that can be used
 * instead of passing appId and addresses directly in onramp/offramp URLs.
 *
 * Setup:
 * 1. Set CDP_API_KEY_ID and CDP_API_KEY_SECRET environment variables
 * 2. Add this to your Express app: app.post("/api/x402/session-token", POST);
 *
 * @param req - The Express Request containing the session token request
 * @param res - The Express Response object
 * @returns Promise<void> - The response containing the session token or error
 */
export async function POST(req: Request, res: Response) {
  try {
    // Get CDP API credentials from environment variables
    const apiKeyId = process.env.CDP_API_KEY_ID;
    const apiKeySecret = process.env.CDP_API_KEY_SECRET;

    if (!apiKeyId || !apiKeySecret) {
      console.error("Missing CDP API credentials");
      return res.status(500).json({
        error: "Server configuration error: Missing CDP API credentials",
      });
    }

    // Parse request body
    const body = req.body as {
      addresses?: Array<{ address: string; blockchains?: string[] }>;
      assets?: string[];
    };
    const { addresses, assets } = body;

    if (!addresses || !Array.isArray(addresses) || addresses.length === 0) {
      return res.status(400).json({
        error: "addresses is required and must be a non-empty array",
      });
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
      return res.status(response.status).json({
        error: "Failed to generate session token",
      });
    }

    const data = await response.json();

    return res.json(data);
  } catch (error) {
    console.error("Error generating session token:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
