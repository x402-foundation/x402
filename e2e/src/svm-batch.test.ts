import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { TestDiscovery } from './discovery';
import { GenericClientProxy } from './clients/generic-client';
import { getNetworkSet } from './networks/networks';
import { filterScenarios } from './cli/filters';
import type { DiscoveredFacilitator } from './types';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Python SVM batch scenarios', () => {
  function scenarios(schemes: DiscoveredFacilitator['config']['schemes'], isExternal = true) {
    vi.stubEnv('SERVER_SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY', 'configured');
    vi.stubEnv('SERVER_SVM_OPERATOR_PRIVATE_KEY', 'configured');
    const discovery = new TestDiscovery(process.cwd());
    vi.spyOn(discovery, 'discoverFacilitators').mockReturnValue([{
      name: 'external-fixture',
      directory: '/unused',
      isExternal,
      config: {
        name: 'external-fixture', type: 'facilitator', language: 'external',
        x402Versions: [2], protocolFamilies: ['svm'], schemes,
        environment: { required: [], optional: [] },
      },
      proxy: { start: vi.fn(), stop: vi.fn(), getUrl: () => 'http://localhost:4022' },
    }]);
    return discovery.generateTestScenarios().filter(scenario =>
      scenario.client.name.startsWith('python/http/') &&
      scenario.server.name.startsWith('python/http/') &&
      scenario.endpoint.scheme === 'batch-settlement',
    );
  }

  it('pairs both voucher modes across Python HTTP clients and servers with an external service', () => {
    const selected = scenarios(['batch-settlement']);
    expect(selected).toHaveLength(8);
    expect(new Set(selected.map(s => s.endpoint.path))).toEqual(new Set([
      '/batch-settlement/svm', '/batch-settlement-server-signed/svm',
    ]));
    expect(selected.every(s => s.protocolFamily === 'svm')).toBe(true);
    expect(selected.every(s => s.facilitator!.config.environment.required.length === 0)).toBe(true);
  });

  it('does not infer batch support for an external service that did not declare it', () => {
    expect(scenarios(['exact'])).toEqual([]);
    expect(scenarios(undefined)).toEqual([]);
  });

  it('still rejects unknown internal SDK implementations', () => {
    expect(scenarios(['batch-settlement'], false)).toEqual([]);
  });

  it('requires explicit external facilitator selection before running discovered scenarios', () => {
    const external = scenarios(['batch-settlement']);
    const internal = external.map(scenario => ({
      ...scenario,
      facilitator: { ...scenario.facilitator!, name: 'python', isExternal: false },
    }));
    const discovered = [...internal, ...external];
    for (const filters of [{}, { facilitators: [] }, { protocolFamilies: ['svm'] }]) {
      expect(filterScenarios(discovered, filters)).toEqual(internal);
    }
    expect(filterScenarios(discovered, { facilitators: ['external-fixture'] })).toEqual(external);
    expect(filterScenarios(discovered, { facilitators: ['different-proxy'] })).toEqual([]);
  });
});

it('keeps an exit-zero client payment failure visible to the runner', async () => {
  const client = new GenericClientProxy(join(process.cwd(), 'clients/python/http/httpx'));
  vi.spyOn(client as any, 'runOneShotProcess').mockResolvedValue({
    success: true,
    exitCode: 0,
    data: { success: false, status_code: 500, error: 'Settlement failed', data: { phase: 'full' } },
  });
  const result = await client.call({
    serverUrl: 'http://localhost:4021',
    endpointPath: '/batch-settlement/svm',
    networks: getNetworkSet('testnet'),
  });
  expect(result).toMatchObject({
    success: false, status_code: 500, error: 'Settlement failed', data: { phase: 'full' }, exitCode: 0,
  });
});
