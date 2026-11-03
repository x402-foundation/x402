import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enrichConfigFromMechanisms, sdkRoutesFor, sdkRouteToEndpoint } from './mechanisms';

const managed = (role: 'client' | 'server' | 'facilitator') =>
  sdkRoutesFor('python', role).filter(route => route.schemeOptions?.facilitatorManaged);

test('Python managed eligibility includes buyer and HTTP server, with Go facilitator only', () => {
  assert.equal(managed('client').length, 4);
  assert.equal(managed('server').length, 4);
  assert.equal(managed('facilitator').length, 0);
  for (const route of managed('server')) {
    const endpoint = sdkRouteToEndpoint(route);
    assert.ok(endpoint.sdks?.includes('go'));
    assert.ok(!endpoint.sdks?.includes('python'));
    assert.ok(endpoint.clientSdks?.includes('python'));
    assert.ok(endpoint.serverSdks?.includes('python'));
  }
});

test('component configuration adds managed HTTP endpoints but excludes Python MCP', () => {
  for (const transport of ['http', 'mcp']) {
    const config = enrichConfigFromMechanisms(
      { language: 'python', type: 'server', transport },
      {},
    );
    const endpoints = config.endpoints as Array<{ schemeOptions?: { facilitatorManaged?: boolean } }>;
    const count = endpoints.filter(endpoint => endpoint.schemeOptions?.facilitatorManaged).length;
    assert.equal(count, transport === 'http' ? 4 : 0);
  }
});
