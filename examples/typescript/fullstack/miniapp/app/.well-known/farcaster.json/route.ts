import { NextResponse } from "next/server";
import { minikitConfig } from "../../../minikit.config";

/**
 * GET handler for the Farcaster manifest endpoint.
 * Serves the minikit configuration at /.well-known/farcaster.json
 *
 * @returns {Promise<NextResponse>} JSON response containing the minikit configuration
 */
export async function GET() {
  // Return the manifest configuration
  // The manifest is served at /.well-known/farcaster.json
  return NextResponse.json(minikitConfig);
}
