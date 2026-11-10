import { NextRequest, NextResponse } from "next/server";
import { getServer } from "@/server";
import { createWithX402GetHandler, isKnownCatalogPath } from "@/lib/setup";

export const runtime = "nodejs";

const handlers = new Map<string, ReturnType<typeof createWithX402GetHandler>>();

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ segments: string[] }> },
) {
  const segments = (await context.params).segments ?? [];

  if (segments.length > 1 && segments[segments.length - 1] === "withx402") {
    const catalogPath = `/${segments.slice(0, -1).join("/")}`;
    if (!isKnownCatalogPath(catalogPath)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const server = await getServer();
    let handler = handlers.get(catalogPath);
    if (!handler) {
      handler = createWithX402GetHandler(catalogPath, server);
      handlers.set(catalogPath, handler);
    }
    return handler(req);
  }

  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
