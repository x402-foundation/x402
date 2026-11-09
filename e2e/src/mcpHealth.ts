import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

/**
 * Probes an MCP server's readiness by performing a real SSE connection and
 * MCP `initialize` handshake, then immediately disconnecting.
 *
 * A plain `GET /health` check only proves the HTTP listener is up — it says
 * nothing about whether the SSE transport / session machinery (which some
 * MCP server implementations initialize lazily) is actually able to
 * correlate a request with its response yet. Probing the real protocol
 * catches that class of startup race before the harness fires the first
 * timed test request against a freshly booted server.
 *
 * @param baseUrl - The server's base URL (e.g. `http://localhost:4051`).
 * @param timeoutMs - Max time to wait for the handshake to complete.
 * @returns True if a full connect + initialize handshake succeeded.
 */
export async function probeMcpReady(baseUrl: string, timeoutMs: number = 5000): Promise<boolean> {
  const client = new Client({ name: 'x402-e2e-readiness-probe', version: '1.0.0' });

  try {
    const transport = new SSEClientTransport(new URL(`${baseUrl}/sse`));
    await client.connect(transport, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  } finally {
    try {
      await client.close();
    } catch {
      // Best-effort cleanup; a failed close shouldn't fail the probe result.
    }
  }
}
