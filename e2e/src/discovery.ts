import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { GenericServerProxy } from './servers/generic-server';
import { GenericClientProxy } from './clients/generic-client';
import { GenericFacilitatorProxy } from './facilitators/generic-facilitator';
import { discoverComponentLocations, loadComponentConfig } from './component';
import { schemesForSdkNetwork } from './mechanisms';
import { verboseLog, errorLog } from './logger';
import {
  TestConfig,
  DiscoveredServer,
  DiscoveredClient,
  DiscoveredFacilitator,
  TestScenario,
  ProtocolFamily,
  endpointAssetTransferMethod,
  endpointPaymentScheme,
} from './types';

export class TestDiscovery {
  private baseDir: string;

  constructor(baseDir: string = '.') {
    this.baseDir = baseDir;
  }

  /**
   * Discover all servers in the servers directory
   */
  discoverServers(): DiscoveredServer[] {
    const servers: DiscoveredServer[] = [];

    // Discover servers from main servers directory
    const serversDir = join(this.baseDir, 'servers');
    if (existsSync(serversDir)) {
      this.discoverServersInDirectory(serversDir, servers);
    }

    const legacyServersDir = join(this.baseDir, 'legacy', 'servers');
    if (existsSync(legacyServersDir)) {
      this.discoverServersInDirectory(legacyServersDir, servers, 'legacy/');
    }

    return servers;
  }

  /**
   * Helper method to discover servers in a specific directory
   */
  private discoverServersInDirectory(serversDir: string, servers: DiscoveredServer[], namePrefix: string = ''): void {
    for (const loc of discoverComponentLocations(serversDir)) {
      try {
        const name = namePrefix + loc.name;
        const config = loadComponentConfig(loc.directory, name) as TestConfig | null;
        if (config && config.type === 'server' && config.enabled !== false) {
          servers.push({
            name,
            directory: loc.directory,
            config,
            proxy: new GenericServerProxy(loc.directory),
          });
        }
      } catch (error) {
        errorLog(`Failed to load config for server ${namePrefix}${loc.name}: ${error}`);
      }
    }
  }

  /**
   * Discover all clients in the clients directory
   */
  discoverClients(): DiscoveredClient[] {
    const clients: DiscoveredClient[] = [];

    // Discover clients from main clients directory
    const clientsDir = join(this.baseDir, 'clients');
    if (existsSync(clientsDir)) {
      this.discoverClientsInDirectory(clientsDir, clients);
    }

    const legacyClientsDir = join(this.baseDir, 'legacy', 'clients');
    if (existsSync(legacyClientsDir)) {
      this.discoverClientsInDirectory(legacyClientsDir, clients, 'legacy/');
    }

    return clients;
  }

  /**
   * Discover all facilitators in the facilitators directory
   */
  discoverFacilitators(): DiscoveredFacilitator[] {
    const facilitators: DiscoveredFacilitator[] = [];

    // Discover facilitators from main facilitators directory
    const facilitatorsDir = join(this.baseDir, 'facilitators');
    if (existsSync(facilitatorsDir)) {
      this.discoverFacilitatorsInDirectory(facilitatorsDir, facilitators);
    }

    const legacyFacilitatorsDir = join(this.baseDir, 'legacy', 'facilitators');
    if (existsSync(legacyFacilitatorsDir)) {
      this.discoverFacilitatorsInDirectory(legacyFacilitatorsDir, facilitators, 'legacy-');
    }

    return facilitators;
  }

  /**
   * Helper method to discover facilitators in a specific directory
   */
  private discoverFacilitatorsInDirectory(facilitatorsDir: string, facilitators: DiscoveredFacilitator[], namePrefix: string = '', isExternal: boolean = false): void {
    const facilitatorDirs = readdirSync(facilitatorsDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory() && dirent.name !== 'node_modules' && dirent.name !== 'shared')
      .map(dirent => dirent.name);

    for (const facilitatorName of facilitatorDirs) {
      const facilitatorDir = join(facilitatorsDir, facilitatorName);

      // Special case: external-proxies is a nested directory of more facilitators
      if (facilitatorName === 'external-proxies') {
        verboseLog(`  🔍 Found external-proxies directory, discovering nested facilitators...`);
        this.discoverFacilitatorsInDirectory(facilitatorDir, facilitators, '', true);
        continue;
      }

      // Special case: local is a nested directory of more facilitators (inherits isExternal from parent)
      if (facilitatorName === 'local') {
        verboseLog(`  🔍 Found local directory, discovering nested facilitators...`);
        this.discoverFacilitatorsInDirectory(facilitatorDir, facilitators, '', isExternal);
        continue;
      }

      try {
        const config = loadComponentConfig(facilitatorDir) as TestConfig | null;
        if (config && config.type === 'facilitator' && config.enabled !== false) {
          facilitators.push({
            name: namePrefix + facilitatorName,
            directory: facilitatorDir,
            config,
            proxy: new GenericFacilitatorProxy(facilitatorDir),
            isExternal,
          });
        }
      } catch (error) {
        errorLog(`Failed to load config for facilitator ${namePrefix}${facilitatorName}: ${error}`);
      }
    }
  }

  /**
   * Helper method to discover clients in a specific directory
   */
  private discoverClientsInDirectory(clientsDir: string, clients: DiscoveredClient[], namePrefix: string = ''): void {
    for (const loc of discoverComponentLocations(clientsDir)) {
      try {
        const name = namePrefix + loc.name;
        const config = loadComponentConfig(loc.directory, name) as TestConfig | null;
        if (config && config.type === 'client' && config.enabled !== false) {
          clients.push({
            name,
            directory: loc.directory,
            config,
            proxy: new GenericClientProxy(loc.directory),
          });
        }
      } catch (error) {
        errorLog(`Failed to load config for client ${namePrefix}${loc.name}: ${error}`);
      }
    }
  }

  /**
   * Generate all possible test scenarios
   * 
   * Creates scenarios by matching:
   * - Clients with servers that have compatible x402 versions
   * - Endpoints with clients that support the endpoint's protocol family
   * - Facilitators that support both the protocol family and x402 version
   */
  generateTestScenarios(): TestScenario[] {
    const servers = this.discoverServers();
    const clients = this.discoverClients();
    const facilitators = this.discoverFacilitators();

    const scenarios: TestScenario[] = [];

    for (const client of clients) {
      // Default to EVM if no protocol families specified for backward compatibility
      const clientProtocolFamilies = client.config.protocolFamilies || ['evm'];

      // Get client's supported x402 versions
      const clientVersions = client.config.x402Versions;
      if (!clientVersions) {
        errorLog(`  ⚠️  Skipping ${client.name}: No x402 versions specified`);
        continue;
      }

      for (const server of servers) {
        // Get server's x402 version
        const serverVersion = server.config.x402Version;
        if (!serverVersion) {
          errorLog(`  ⚠️  Skipping ${server.name}: No x402 version specified`);
          continue;
        }

        // Check transport compatibility (default to 'http' if not specified)
        const clientTransport = client.config.transport || 'http';
        const serverTransport = server.config.transport || 'http';
        if (clientTransport !== serverTransport) {
          verboseLog(`  ⚠️  Skipping ${client.name} ↔ ${server.name}: Transport mismatch (client=${clientTransport}, server=${serverTransport})`);
          continue;
        }

        // Check if client and server have compatible versions
        if (!clientVersions.includes(serverVersion)) {
          verboseLog(`  ⚠️  Skipping ${client.name} ↔ ${server.name}: Version mismatch (client supports [${clientVersions.join(', ')}], server implements ${serverVersion})`);
          continue;
        }

        // Only test endpoints that require payment
        const testableEndpoints = server.config.endpoints?.filter(endpoint => {
          return endpoint.requiresPayment;
        }) || [];

        for (const endpoint of testableEndpoints) {
          const endpointProtocolFamily = endpoint.protocolFamily || 'evm';
          const endpointScheme = endpointPaymentScheme(endpoint);

          // Only create scenarios where client supports endpoint's protocol family
          if (!clientProtocolFamilies.includes(endpointProtocolFamily)) {
            continue;
          }

          // Scheme support is per network: Python may implement EVM upto but not SVM upto.
          const clientLanguage = client.config.language;
          if (!clientLanguage) {
            verboseLog(`  ⚠️  Skipping ${client.name}: No language specified`);
            continue;
          }
          const clientSchemesForFamily = schemesForSdkNetwork(clientLanguage, endpointProtocolFamily);
          if (!clientSchemesForFamily.includes(endpointScheme)) {
            verboseLog(`  ⚠️  Skipping ${client.name} ↔ ${server.name} ${endpoint.path}: Payment scheme mismatch (client supports [${clientSchemesForFamily.join(', ')}] on ${endpointProtocolFamily}, endpoint requires ${endpointScheme})`);
            continue;
          }

          // For EVM endpoints, also check asset transfer method.
          if (endpointProtocolFamily === 'evm') {
            const endpointAtm = endpointAssetTransferMethod(endpoint)!;
            const clientAssetMethods = client.config.evm?.assetTransferMethods ?? [];
            if (!clientAssetMethods.includes(endpointAtm)) {
              verboseLog(`  ⚠️  Skipping ${client.name} ↔ ${server.name} ${endpoint.path}: Asset transfer method mismatch (client supports [${clientAssetMethods.join(', ')}], endpoint requires ${endpointAtm})`);
              continue;
            }
          }

          // Find facilitators that support this protocol family, version,
          // payment scheme, and (for EVM) asset transfer method. Facilitators
          // must declare `schemes` and `evm.assetTransferMethods` explicitly.
          const matchingFacilitators = facilitators.filter(f => {
            const supportsProtocol = f.config.protocolFamilies?.includes(endpointProtocolFamily);
            const supportsVersion = f.config.x402Versions?.includes(serverVersion);
            const facilLanguage = f.config.language;
            if (!facilLanguage) return false;
            const clientFacilitators = client.config.facilitators;
            if (clientFacilitators && !clientFacilitators.includes(f.name)) {
              return false;
            }
            const facilSchemesForFamily = schemesForSdkNetwork(facilLanguage, endpointProtocolFamily);
            if (!facilSchemesForFamily.includes(endpointScheme)) return false;
            if (endpointProtocolFamily === 'evm') {
              const endpointAtm = endpointAssetTransferMethod(endpoint)!;
              const facilAssetMethods = f.config.evm?.assetTransferMethods ?? [];
              if (!facilAssetMethods.includes(endpointAtm)) return false;
            }
            return supportsProtocol && supportsVersion;
          });

          for (const facilitator of matchingFacilitators) {
            scenarios.push({
              client,
              server,
              facilitator,
              endpoint,
              protocolFamily: endpointProtocolFamily,
            });
          }
        }
      }
    }

    return scenarios;
  }

  /**
   * Print discovery summary
   */
  printDiscoverySummary(): void {
    const servers = this.discoverServers();
    const clients = this.discoverClients();
    const facilitators = this.discoverFacilitators();
    const scenarios = this.generateTestScenarios();

    verboseLog('🔍 Test Discovery Summary');
    verboseLog('========================');
    verboseLog(`📡 Servers found: ${servers.length}`);
    servers.forEach(server => {
      const paidEndpoints = server.config.endpoints?.filter(e => e.requiresPayment).length || 0;
      const protocolFamilies = new Set(
        server.config.endpoints?.filter(e => e.requiresPayment).map(e => e.protocolFamily || 'evm') || ['evm']
      );
      const version = server.config.x402Version || 1;
      const transport = server.config.transport || 'http';
      verboseLog(`   - ${server.name} (${server.config.language}) [${transport}] v${version} - ${paidEndpoints} x402 endpoints [${Array.from(protocolFamilies).join(', ')}]`);
    });

    verboseLog(`📱 Clients found: ${clients.length}`);
    clients.forEach(client => {
      const protocolFamilies = client.config.protocolFamilies || ['evm'];
      const versions = client.config.x402Versions || [1];
      const transport = client.config.transport || 'http';
      const evmAssetMethods = client.config.evm?.assetTransferMethods || ['eip3009'];
      const evmInfo = protocolFamilies.includes('evm') ? ` evm:${evmAssetMethods.join(',')}` : '';
      const extInfo = client.config.extensions ? ` {${client.config.extensions.join(', ')}}` : '';
      verboseLog(`   - ${client.name} (${client.config.language}) [${transport}] v[${versions.join(', ')}] [${protocolFamilies.join(', ')}]${evmInfo}${extInfo}`);
    });

    verboseLog(`🏛️ Facilitators found: ${facilitators.length}`);

    const regularFacilitators = facilitators.filter(f => !f.isExternal);
    const externalFacilitators = facilitators.filter(f => f.isExternal);

    regularFacilitators.forEach(facilitator => {
      const protocolFamilies = facilitator.config.protocolFamilies || ['evm'];
      const versions = facilitator.config.x402Versions || [2];
      const evmAssetMethods = facilitator.config.evm?.assetTransferMethods || ['eip3009'];
      const evmInfo = protocolFamilies.includes('evm') ? ` evm:${evmAssetMethods.join(',')}` : '';
      verboseLog(`   - ${facilitator.name} (${facilitator.config.language}) v[${versions.join(', ')}] [${protocolFamilies.join(', ')}]${evmInfo}`);
    });

    if (externalFacilitators.length > 0) {
      verboseLog(`   External:`);
      externalFacilitators.forEach(facilitator => {
        const protocolFamilies = facilitator.config.protocolFamilies || ['evm'];
        const versions = facilitator.config.x402Versions || [2];
        const evmAssetMethods = facilitator.config.evm?.assetTransferMethods || ['eip3009'];
        const evmInfo = protocolFamilies.includes('evm') ? ` evm:${evmAssetMethods.join(',')}` : '';
        verboseLog(`     - ${facilitator.name} (${facilitator.config.language}) v[${versions.join(', ')}] [${protocolFamilies.join(', ')}]${evmInfo}`);
      });
    }

    // Show protocol family breakdown
    const protocolBreakdown = scenarios.reduce((acc, scenario) => {
      acc[scenario.protocolFamily] = (acc[scenario.protocolFamily] || 0) + 1;
      return acc;
    }, {} as Record<ProtocolFamily, number>);

    verboseLog(`📊 Test scenarios: ${scenarios.length}`);
    Object.entries(protocolBreakdown).forEach(([protocol, count]) => {
      verboseLog(`   - ${protocol.toUpperCase()}: ${count} scenarios`);
    });
    verboseLog('');
  }
}
