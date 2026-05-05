import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { GenericServerProxy } from './servers/generic-server';
import { GenericClientProxy } from './clients/generic-client';
import { GenericFacilitatorProxy } from './facilitators/generic-facilitator';
import { log, verboseLog, errorLog } from './logger';
import {
  TestConfig,
  DiscoveredServer,
  DiscoveredClient,
  DiscoveredFacilitator,
  TestScenario,
  ProtocolFamily,
  endpointAssetTransferMethod,
} from './types';

export class TestDiscovery {
  private baseDir: string;
  private includeLegacy: boolean;

  constructor(baseDir: string = '.', includeLegacy: boolean = false) {
    this.baseDir = baseDir;
    this.includeLegacy = includeLegacy;
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

    // Discover servers from legacy directory if flag is set
    if (this.includeLegacy) {
      const legacyServersDir = join(this.baseDir, 'legacy', 'servers');
      if (existsSync(legacyServersDir)) {
        this.discoverServersInDirectory(legacyServersDir, servers, 'legacy-');
      }
    }

    return servers;
  }

  /**
   * Helper method to discover servers in a specific directory
   */
  private discoverServersInDirectory(serversDir: string, servers: DiscoveredServer[], namePrefix: string = ''): void {
    let serverDirs = readdirSync(serversDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    for (const serverName of serverDirs) {
      const serverDir = join(serversDir, serverName);
      const configPath = join(serverDir, 'test.config.json');

      if (existsSync(configPath)) {
        try {
          const configContent = readFileSync(configPath, 'utf-8');
          const config: TestConfig = JSON.parse(configContent);

          if (config.type === 'server') {
            servers.push({
              name: namePrefix + serverName,
              directory: serverDir,
              config,
              proxy: new GenericServerProxy(serverDir)
            });
          }
        } catch (error) {
          errorLog(`Failed to load config for server ${namePrefix}${serverName}: ${error}`);
        }
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

    // Discover clients from legacy directory if flag is set
    if (this.includeLegacy) {
      const legacyClientsDir = join(this.baseDir, 'legacy', 'clients');
      if (existsSync(legacyClientsDir)) {
        this.discoverClientsInDirectory(legacyClientsDir, clients, 'legacy-');
      }
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

    // Discover facilitators from legacy directory if flag is set
    if (this.includeLegacy) {
      const legacyFacilitatorsDir = join(this.baseDir, 'legacy', 'facilitators');
      if (existsSync(legacyFacilitatorsDir)) {
        this.discoverFacilitatorsInDirectory(legacyFacilitatorsDir, facilitators, 'legacy-');
      }
    }

    return facilitators;
  }

  /**
   * Helper method to discover facilitators in a specific directory
   */
  private discoverFacilitatorsInDirectory(facilitatorsDir: string, facilitators: DiscoveredFacilitator[], namePrefix: string = '', isExternal: boolean = false): void {
    let facilitatorDirs = readdirSync(facilitatorsDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
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

      const configPath = join(facilitatorDir, 'test.config.json');

      if (existsSync(configPath)) {
        try {
          const configContent = readFileSync(configPath, 'utf-8');
          const config: TestConfig = JSON.parse(configContent);

          if (config.type === 'facilitator') {
            facilitators.push({
              name: namePrefix + facilitatorName,
              directory: facilitatorDir,
              config,
              proxy: new GenericFacilitatorProxy(facilitatorDir),
              isExternal
            });
          }
        } catch (error) {
          errorLog(`Failed to load config for facilitator ${namePrefix}${facilitatorName}: ${error}`);
        }
      }
    }
  }

  /**
   * Helper method to discover clients in a specific directory
   */
  private discoverClientsInDirectory(clientsDir: string, clients: DiscoveredClient[], namePrefix: string = ''): void {
    let clientDirs = readdirSync(clientsDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    for (const clientName of clientDirs) {
      const clientDir = join(clientsDir, clientName);
      const configPath = join(clientDir, 'test.config.json');

      if (existsSync(configPath)) {
        try {
          const configContent = readFileSync(configPath, 'utf-8');
          const config: TestConfig = JSON.parse(configContent);

          if (config.type === 'client') {
            clients.push({
              name: namePrefix + clientName,
              directory: clientDir,
              config,
              proxy: new GenericClientProxy(clientDir)
            });
          }
        } catch (error) {
          errorLog(`Failed to load config for client ${namePrefix}${clientName}: ${error}`);
        }
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

          // Only create scenarios where client supports endpoint's protocol family
          if (!clientProtocolFamilies.includes(endpointProtocolFamily)) {
            continue;
          }

          // For EVM endpoints, check transfer method compatibility with client
          if (endpointProtocolFamily === 'evm') {
            const endpointAtm = endpointAssetTransferMethod(endpoint)!;
            const clientAssetMethods = client.config.evm?.assetTransferMethods || ['eip3009'];
            if (!clientAssetMethods.includes(endpointAtm)) {
              verboseLog(`  ⚠️  Skipping ${client.name} ↔ ${server.name} ${endpoint.path}: Asset transfer method mismatch (client supports [${clientAssetMethods.join(', ')}], endpoint requires ${endpointAtm})`);
              continue;
            }
          }

          // Find facilitators that support this protocol family and version
          const matchingFacilitators = facilitators.filter(f => {
            const supportsProtocol = f.config.protocolFamilies?.includes(endpointProtocolFamily);
            const supportsVersion = f.config.x402Versions?.includes(serverVersion);
            // For EVM, also check transfer method support
            if (endpointProtocolFamily === 'evm') {
              const endpointAtm = endpointAssetTransferMethod(endpoint)!;
              const facilAssetMethods = f.config.evm?.assetTransferMethods || ['eip3009'];
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
    if (this.includeLegacy) {
      verboseLog('🔄 Legacy mode enabled - including legacy implementations');
    }
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
