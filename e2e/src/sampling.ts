import { TestScenario, endpointAssetTransferMethod, endpointPaymentScheme } from './types';
import { log, verboseLog } from './logger';

/**
 * Coverage tracker for minimizing test runs
 * 
 * Tracks which components (client, server, facilitator) have been tested
 * with which protocol families and versions to skip redundant tests.
 */
export class CoverageTracker {
  private clientsCovered = new Set<string>();
  private serversCovered = new Set<string>();
  private facilitatorsCovered = new Set<string>();
  private endpointsCovered = new Set<string>();

  /**
   * Generate a coverage key for a component
   * Format: "component-name-protocolFamily-vVersion"
   * 
   * Args:
   *   componentName: Name of the component
   *   protocolFamily: Protocol family (e.g., 'evm', 'svm')
   *   version: x402 version number
   * 
   * Returns:
   *   Coverage key string
   */
  private getCoverageKey(componentName: string, protocolFamily: string, version: number): string {
    return `${componentName}-${protocolFamily}-v${version}`;
  }

  /**
   * Generate a coverage key for an endpoint
   * Format: "server-name-endpoint-path-protocolFamily-scheme-assetMethod-vVersion"
   *
   * This ensures each unique endpoint on a server is tested separately,
   * including different EVM schemes and asset transfer methods.
   */
  private getEndpointCoverageKey(
    serverName: string,
    endpointPath: string,
    protocolFamily: string,
    version: number,
    scenario: TestScenario,
  ): string {
    const method =
      protocolFamily === 'evm'
        ? `${endpointPaymentScheme(scenario.endpoint) ?? 'exact'}-${endpointAssetTransferMethod(scenario.endpoint) ?? 'eip3009'}`
        : '';
    return `${serverName}-${endpointPath}-${protocolFamily}${method ? `-${method}` : ''}-v${version}`;
  }

  /**
   * Check if a scenario provides new coverage
   * 
   * A scenario provides new coverage if ANY of its components haven't been
   * tested with this protocol family and version combination.
   * 
   * Args:
   *   scenario: Test scenario to evaluate
   * 
   * Returns:
   *   true if scenario provides new coverage, false if all components already covered
   */
  isNewCoverage(scenario: TestScenario): boolean {
    const version = scenario.server.config.x402Version ?? 1;
    const protocolFamily = scenario.protocolFamily;

    const clientKey = this.getCoverageKey(
      scenario.client.name,
      protocolFamily,
      version
    );
    const serverKey = this.getCoverageKey(
      scenario.server.name,
      protocolFamily,
      version
    );
    const facilitatorKey = this.getCoverageKey(
      scenario.facilitator?.name || 'default',
      protocolFamily,
      version
    );
    const endpointKey = this.getEndpointCoverageKey(
      scenario.server.name,
      scenario.endpoint.path,
      protocolFamily,
      version,
      scenario,
    );

    // Check if ANY component hasn't been covered yet
    const clientNew = !this.clientsCovered.has(clientKey);
    const serverNew = !this.serversCovered.has(serverKey);
    const facilitatorNew = !this.facilitatorsCovered.has(facilitatorKey);
    const endpointNew = !this.endpointsCovered.has(endpointKey);

    const isNew = clientNew || serverNew || facilitatorNew || endpointNew;

    if (isNew) {
      verboseLog(`  📊 New coverage: ${clientNew ? `client(${clientKey})` : ''} ${serverNew ? `server(${serverKey})` : ''} ${facilitatorNew ? `facilitator(${facilitatorKey})` : ''} ${endpointNew ? `endpoint(${endpointKey})` : ''}`);
    }

    return isNew;
  }

  /**
   * Mark a scenario's components as covered
   * 
   * Args:
   *   scenario: Test scenario to mark as covered
   */
  markCovered(scenario: TestScenario): void {
    const version = scenario.server.config.x402Version ?? 1;
    const protocolFamily = scenario.protocolFamily;

    const clientKey = this.getCoverageKey(
      scenario.client.name,
      protocolFamily,
      version
    );
    const serverKey = this.getCoverageKey(
      scenario.server.name,
      protocolFamily,
      version
    );
    const facilitatorKey = this.getCoverageKey(
      scenario.facilitator?.name || 'default',
      protocolFamily,
      version
    );
    const endpointKey = this.getEndpointCoverageKey(
      scenario.server.name,
      scenario.endpoint.path,
      protocolFamily,
      version,
      scenario,
    );

    this.clientsCovered.add(clientKey);
    this.serversCovered.add(serverKey);
    this.facilitatorsCovered.add(facilitatorKey);
    this.endpointsCovered.add(endpointKey);
  }

  /**
   * Get coverage statistics
   * 
   * Returns:
   *   Object containing coverage counts for each component type
   */
  getStats(): { clients: number; servers: number; facilitators: number; endpoints: number } {
    return {
      clients: this.clientsCovered.size,
      servers: this.serversCovered.size,
      facilitators: this.facilitatorsCovered.size,
      endpoints: this.endpointsCovered.size,
    };
  }
}

/**
 * Filter scenarios based on coverage to minimize test runs
 * 
 * Only includes scenarios that provide new coverage (i.e., test a component
 * with a protocol family and version combination that hasn't been tested yet).
 * 
 * Args:
 *   scenarios: All test scenarios to filter
 * 
 * Returns:
 *   Filtered list of scenarios that provide new coverage
 */
export function minimizeScenarios(scenarios: TestScenario[]): TestScenario[] {
  const tracker = new CoverageTracker();
  const minimized: TestScenario[] = [];

  for (const scenario of scenarios) {
    if (tracker.isNewCoverage(scenario)) {
      minimized.push(scenario);
      tracker.markCovered(scenario);
    } else {
      verboseLog(`  ⏭️  Skipping (covered): ${scenario.client.name} → ${scenario.server.name} → ${scenario.endpoint.path} [${scenario.facilitator?.name || 'default'}] (${scenario.protocolFamily}-v${scenario.server.config.x402Version})`);
    }
  }

  const stats = tracker.getStats();
  const reductionPercent = ((1 - minimized.length / scenarios.length) * 100).toFixed(1);

  log('');
  log('📊 Coverage-Based Minimization');
  log('==============================');
  log(`Total scenarios: ${scenarios.length}`);
  log(`Selected scenarios: ${minimized.length} (${reductionPercent}% reduction)`);
  log(`Skipped scenarios: ${scenarios.length - minimized.length}`);
  log('');
  log('Coverage achieved:');
  log(`  • Clients: ${stats.clients} unique combinations`);
  log(`  • Servers: ${stats.servers} unique combinations`);
  log(`  • Facilitators: ${stats.facilitators} unique combinations`);
  log(`  • Endpoints: ${stats.endpoints} unique combinations`);
  log('');

  return minimized;
}

