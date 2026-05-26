import { TestScenario, endpointPaymentScheme } from '../types';

/** x402 payment scheme for filtering (non-EVM counts as exact). */
export type PaymentSchemeKind = 'exact' | 'upto' | 'batch-settlement';

/**
 * Classify a scenario's payment scheme for filtering (`endpoint.scheme`, default `exact` on EVM).
 */
export function getScenarioPaymentScheme(scenario: TestScenario): PaymentSchemeKind {
  if (scenario.protocolFamily !== 'evm') {
    return 'exact';
  }
  return endpointPaymentScheme(scenario.endpoint) ?? 'exact';
}

export function getUniquePaymentSchemes(scenarios: TestScenario[]): PaymentSchemeKind[] {
  const set = new Set<PaymentSchemeKind>();
  scenarios.forEach(s => set.add(getScenarioPaymentScheme(s)));
  return Array.from(set).sort();
}

export interface TestFilters {
  transports?: string[];
  facilitators?: string[];
  servers?: string[];
  clients?: string[];
  extensions?: string[];       // For test output control (doesn't filter scenarios)
  versions?: number[];
  protocolFamilies?: string[];
  schemes?: string[];
  endpoints?: string[];        // Regex patterns to filter by endpoint path
}

/**
 * Filter scenarios based on user selections
 * NOTE: Extensions are NOT used for filtering - they only control test output
 */
export function filterScenarios(
  scenarios: TestScenario[],
  filters: TestFilters
): TestScenario[] {
  return scenarios.filter(scenario => {
    // Transport filter
    if (filters.transports && filters.transports.length > 0) {
      const serverTransport = scenario.server.config.transport || 'http';
      if (!filters.transports.includes(serverTransport)) {
        return false;
      }
    }

    // Facilitator filter
    if (filters.facilitators && filters.facilitators.length > 0) {
      const facilitatorName = scenario.facilitator?.name;
      if (!facilitatorName || !filters.facilitators.includes(facilitatorName)) {
        return false;
      }
    }

    // Server filter
    if (filters.servers && filters.servers.length > 0) {
      if (!filters.servers.includes(scenario.server.name)) {
        return false;
      }
    }

    // Client filter
    if (filters.clients && filters.clients.length > 0) {
      if (!filters.clients.includes(scenario.client.name)) {
        return false;
      }
    }

    // Version filter
    if (filters.versions && filters.versions.length > 0) {
      const serverVersion = scenario.server.config.x402Version;
      if (!serverVersion || !filters.versions.includes(serverVersion)) {
        return false;
      }
    }

    // Protocol family filter
    if (filters.protocolFamilies && filters.protocolFamilies.length > 0) {
      if (!filters.protocolFamilies.includes(scenario.protocolFamily)) {
        return false;
      }
    }

    // Payment scheme filter
    if (filters.schemes && filters.schemes.length > 0) {
      const normalized = filters.schemes.map(s => s.trim().toLowerCase());
      const kind = getScenarioPaymentScheme(scenario);
      if (!normalized.includes(kind)) {
        return false;
      }
    }

    // Endpoint filter — each entry is treated as a regex pattern.
    // Patterns are auto-anchored (^...$) so that "/protected" matches only
    // that exact path. To match a prefix, use "/protected.*"; for a substring
    // anywhere, use ".*permit2.*" or omit anchors explicitly via ^ / $.
    if (filters.endpoints && filters.endpoints.length > 0) {
      const endpointPath = scenario.endpoint.path;
      const matched = filters.endpoints.some(rawPattern => {
        // Ensure patterns that look like paths start with /
        const pattern = (!rawPattern.startsWith('/') && !rawPattern.startsWith('^'))
          ? `/${rawPattern}`
          : rawPattern;
        try {
          const anchored = (pattern.startsWith('^') || pattern.endsWith('$'))
            ? pattern
            : `^${pattern}$`;
          return new RegExp(anchored).test(endpointPath);
        } catch {
          // Fall back to exact match if pattern is not valid regex
          return endpointPath === pattern;
        }
      });
      if (!matched) return false;
    }

    // NOTE: Extensions filter NOT applied - it only controls test output visibility
    // Extensions are stored separately and passed to test execution logic

    return true;
  });
}

/**
 * Check if extension-related test output should be shown
 */
export function shouldShowExtensionOutput(
  extensionName: string,
  selectedExtensions?: string[]
): boolean {
  // If no extensions selected, don't show extension output
  if (!selectedExtensions || selectedExtensions.length === 0) {
    return false;
  }

  return selectedExtensions.includes(extensionName);
}

/**
 * Extract unique versions from scenarios
 */
export function getUniqueVersions(scenarios: TestScenario[]): number[] {
  const versions = new Set<number>();
  scenarios.forEach(s => {
    if (s.server.config.x402Version) {
      versions.add(s.server.config.x402Version);
    }
  });
  return Array.from(versions).sort();
}

/**
 * Extract unique protocol families from scenarios
 */
export function getUniqueProtocolFamilies(scenarios: TestScenario[]): string[] {
  const families = new Set<string>();
  scenarios.forEach(s => families.add(s.protocolFamily));
  return Array.from(families).sort();
}

