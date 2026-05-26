type PriceRequest = {
  symbol: string;
};

/**
 * Handles price requests for different cryptocurrency symbols
 *
 * @param req - The incoming request containing the cryptocurrency symbol
 * @returns A JSON response with the price of the requested cryptocurrency, or -1 if not found
 */
export async function POST(req: Request) {
  const body: PriceRequest = await req.json();

  if (body.symbol.toLowerCase() === "btc") {
    return Response.json({ price: 90000 });
  }

  if (body.symbol.toLowerCase() === "eth") {
    return Response.json({ price: 3000 });
  }

  if (body.symbol.toLowerCase() === "sol") {
    return Response.json({ price: 125 });
  }

  return Response.json({ price: -1 });
}
