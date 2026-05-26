import prompts from 'prompts';
import { DiscoveredClient, DiscoveredServer, DiscoveredFacilitator, TestScenario } from '../types';
import {
  TestFilters,
  filterScenarios,
  getUniqueVersions,
  getUniqueProtocolFamilies,
  getUniquePaymentSchemes,
  getScenarioPaymentScheme,
  PaymentSchemeKind,
} from './filters';
import { log } from '../logger';
import { NetworkMode, getNetworkModeDescription } from '../networks/networks';

export interface InteractiveSelections extends TestFilters {
  networkMode: NetworkMode;
}

/**
 * Run interactive mode to select test scenarios
 * 
 * @param allClients - All discovered clients
 * @param allServers - All discovered servers
 * @param allFacilitators - All discovered facilitators
 * @param allScenarios - All test scenarios
 * @param minimize - If true (--min flag), default all items selected. If false, default none selected.
 * @param preselectedNetworkMode - If provided, skip network selection prompt
 */
export async function runInteractiveMode(
  allClients: DiscoveredClient[],
  allServers: DiscoveredServer[],
  allFacilitators: DiscoveredFacilitator[],
  allScenarios: TestScenario[],
  minimize: boolean = false,
  preselectedNetworkMode?: NetworkMode
): Promise<InteractiveSelections | null> {

  // Question 1: Select facilitators (multi-select)
  // Sort facilitators: regular ones first, external ones at the bottom
  const regularFacilitators = allFacilitators.filter(f => !f.isExternal);
  const externalFacilitators = allFacilitators.filter(f => f.isExternal);

  const facilitatorChoices: any[] = [];

  // Add regular facilitators
  regularFacilitators.forEach(f => {
    facilitatorChoices.push({
      title: `${f.name} (${formatVersions(f.config.x402Versions)}) [${f.config.protocolFamilies?.join(', ') || ''}]${f.config.extensions ? ' {' + f.config.extensions.join(', ') + '}' : ''}`,
      value: f.name,
      selected: minimize // With --min: all selected. Without --min: none selected
    });
  });

  // Add external facilitators section if any exist
  if (externalFacilitators.length > 0) {
    // Add separator/header for external facilitators
    facilitatorChoices.push({
      title: '────────── External ──────────',
      value: '__external_separator__',
      disabled: true
    });

    externalFacilitators.forEach(f => {
      facilitatorChoices.push({
        title: `${f.name} (${formatVersions(f.config.x402Versions)}) [${f.config.protocolFamilies?.join(', ') || ''}]${f.config.extensions ? ' {' + f.config.extensions.join(', ') + '}' : ''}`,
        value: f.name,
        selected: false // External facilitators are never selected by default
      });
    });
  }

  const facilitatorsResponse = await prompts({
    type: 'multiselect',
    name: 'facilitators',
    message: 'Select facilitators',
    choices: facilitatorChoices,
    min: 1,
    hint: 'Space to select, Enter to confirm',
    instructions: false
  });

  if (!facilitatorsResponse.facilitators || facilitatorsResponse.facilitators.length === 0) {
    return null; // User cancelled
  }

  // Question 2: Select transports (multi-select)
  const availableTransports = getAvailableTransports(allServers, allClients);
  let selectedTransports: string[] | undefined;

  if (availableTransports.length > 1) {
    const transportChoices = availableTransports.map(t => ({
      title: t.toUpperCase(),
      value: t,
      selected: t === 'http' // only HTTP selected by default
    }));

    const transportResponse = await prompts({
      type: 'multiselect',
      name: 'transports',
      message: 'Select transports',
      choices: transportChoices,
      min: 1,
      hint: 'Space to select, Enter to confirm',
      instructions: false
    });

    if (!transportResponse.transports || transportResponse.transports.length === 0) {
      return null;
    }

    selectedTransports = transportResponse.transports;
  } else {
    selectedTransports = availableTransports;
  }

  // Filter servers and clients by selected transport
  const transportFilteredServers = allServers.filter(s =>
    selectedTransports?.includes(s.config.transport || 'http')
  );
  const transportFilteredClients = allClients.filter(c =>
    selectedTransports?.includes(c.config.transport || 'http')
  );

  // Question 3: Select servers (multi-select)
  const serverChoices = transportFilteredServers.map(s => {
    const families = Array.from(new Set(s.config.endpoints?.map(e => e.protocolFamily).filter(Boolean))) || [];
    const extInfo = s.config.extensions ? ' {' + s.config.extensions.join(', ') + '}' : '';
    return {
      title: `${s.name} (v${s.config.x402Version}) [${families.join(', ')}]${extInfo}`,
      value: s.name,
      selected: minimize // With --min: all selected. Without --min: none selected
    };
  });

  const serversResponse = await prompts({
    type: 'multiselect',
    name: 'servers',
    message: 'Select servers',
    choices: serverChoices,
    min: 1,
    hint: 'Space to select, Enter to confirm',
    instructions: false
  });

  if (!serversResponse.servers || serversResponse.servers.length === 0) {
    return null;
  }

  // Question 4: Select clients (multi-select)
  const clientChoices = transportFilteredClients.map(c => {
    const extInfo = c.config.extensions ? ' {' + c.config.extensions.join(', ') + '}' : '';
    return {
      title: `${c.name} (${formatVersions(c.config.x402Versions)}) [${c.config.protocolFamilies?.join(', ') || ''}]${extInfo}`,
      value: c.name,
      selected: minimize // With --min: all selected. Without --min: none selected
    };
  });

  const clientsResponse = await prompts({
    type: 'multiselect',
    name: 'clients',
    message: 'Select clients',
    choices: clientChoices,
    min: 1,
    hint: 'Space to select, Enter to confirm',
    instructions: false
  });

  if (!clientsResponse.clients || clientsResponse.clients.length === 0) {
    return null;
  }

  // Question 5: Select extensions (ALWAYS shown if any available, determines test output visibility)
  log('\n🔍 Detecting available extensions from selections...\n');

  const availableExtensions = getAvailableExtensions(
    facilitatorsResponse.facilitators,
    serversResponse.servers,
    clientsResponse.clients,
    allFacilitators,
    allServers,
    allClients,
  );

  let selectedExtensions: string[] | undefined;

  if (availableExtensions.length > 0) {
    const extensionChoices = availableExtensions.map(ext => ({
      title: `${ext.name} (${ext.description})`,
      value: ext.name,
      selected: true // Default all selected
    }));

    const extensionsResponse = await prompts({
      type: 'multiselect',
      name: 'extensions',
      message: 'Select extensions (controls test output visibility)',
      choices: extensionChoices,
      hint: 'Space to select, Enter to confirm or skip',
      instructions: false
    });

    selectedExtensions = extensionsResponse.extensions;

    if (selectedExtensions && selectedExtensions.length > 0) {
      log(`ℹ️  Extensions enabled: ${selectedExtensions.join(', ')}`);
      log('   (Extension validation output will be shown)\n');
    }
  }

  // Now analyze what scenarios would be generated from these selections
  log('🔍 Analyzing remaining scenarios...\n');

  const preliminaryScenarios = filterScenariosBySelections(
    allScenarios,
    {
      facilitators: facilitatorsResponse.facilitators,
      servers: serversResponse.servers,
      clients: clientsResponse.clients
    }
  );

  // Question 6 (CONDITIONAL): Select versions IF multiple versions exist in remaining scenarios
  const availableVersions = getUniqueVersions(preliminaryScenarios);
  let selectedVersions: number[] | undefined;

  if (availableVersions.length > 1) {
    const versionChoices = availableVersions.map(v => {
      const count = preliminaryScenarios.filter(s => s.server.config.x402Version === v).length;
      return {
        title: `v${v} (${count} scenarios)`,
        value: v,
        selected: true
      };
    });

    const versionsResponse = await prompts({
      type: 'multiselect',
      name: 'versions',
      message: 'Select x402 versions',
      choices: versionChoices,
      min: 1,
      hint: 'Space to select, Enter to confirm',
      instructions: false
    });

    if (!versionsResponse.versions || versionsResponse.versions.length === 0) {
      return null;
    }

    selectedVersions = versionsResponse.versions;
  } else if (availableVersions.length === 1) {
    // Auto-select if only one version
    selectedVersions = availableVersions;
  }

  // Question 7 (CONDITIONAL): Select protocol families IF multiple families exist
  const availableFamilies = getUniqueProtocolFamilies(preliminaryScenarios);
  let selectedFamilies: string[] | undefined;

  if (availableFamilies.length > 1) {
    const familyChoices = availableFamilies.map(f => {
      const count = preliminaryScenarios.filter(s => s.protocolFamily === f).length;
      return {
        title: `${f.toUpperCase()} (${count} scenarios)`,
        value: f,
        selected: true
      };
    });

    const familiesResponse = await prompts({
      type: 'multiselect',
      name: 'families',
      message: 'Select protocol families',
      choices: familyChoices,
      min: 1,
      hint: 'Space to select, Enter to confirm',
      instructions: false
    });

    if (!familiesResponse.families || familiesResponse.families.length === 0) {
      return null;
    }

    selectedFamilies = familiesResponse.families;
  } else if (availableFamilies.length === 1) {
    // Auto-select if only one family
    selectedFamilies = availableFamilies;
  }

  // Question 8 (CONDITIONAL): Payment scheme — exact vs upto vs batch-settlement (EVM transfer semantics)
  const scenariosForScheme = filterScenarios(preliminaryScenarios, {
    versions: selectedVersions,
    protocolFamilies: selectedFamilies,
  });
  const availableSchemes = getUniquePaymentSchemes(scenariosForScheme);
  let selectedSchemes: string[] | undefined;

  if (availableSchemes.length > 1) {
    const schemeChoices = availableSchemes.map((k: PaymentSchemeKind) => {
      const count = scenariosForScheme.filter(s => getScenarioPaymentScheme(s) === k).length;
      return {
        title: `${k} (${count} scenarios)`,
        value: k,
        selected: true,
      };
    });

    const schemesResponse = await prompts({
      type: 'multiselect',
      name: 'schemes',
      message: 'Select payment schemes',
      choices: schemeChoices,
      min: 1,
      hint: 'exact = eip3009/permit2-style; upto = usage-based; batch-settlement = voucher channel',
      instructions: false,
    });

    if (!schemesResponse.schemes || schemesResponse.schemes.length === 0) {
      return null;
    }

    selectedSchemes = schemesResponse.schemes;
  } else if (availableSchemes.length === 1) {
    selectedSchemes = availableSchemes;
  }

  // Question 9: Endpoint filter (optional free-text, comma-separated regex patterns)
  const endpointsResponse = await prompts({
    type: 'text',
    name: 'endpoints',
    message: 'Filter endpoints (comma-separated patterns, blank = all)',
    initial: '',
    hint: 'e.g. /protected, permit2.* — supports regex',
  });

  // null means Ctrl-C; empty string means "all"
  if (endpointsResponse.endpoints === undefined) {
    return null;
  }
  const selectedEndpoints: string[] | undefined = endpointsResponse.endpoints
    ? (endpointsResponse.endpoints as string).split(',').map((p: string) => p.trim()).filter((p: string) => p.length > 0)
    : undefined;

  // Question 10: Select network mode (testnet/mainnet) - LAST question
  // Skip if preselected via CLI flag
  let networkMode: NetworkMode;

  if (preselectedNetworkMode) {
    networkMode = preselectedNetworkMode;
    log(`🌐 Network mode: ${networkMode} (${getNetworkModeDescription(networkMode)})\n`);
  } else {
    const networkChoices = [
      {
        title: `Testnet (${getNetworkModeDescription('testnet')})`,
        value: 'testnet' as NetworkMode,
        selected: true
      },
      {
        title: `Mainnet (${getNetworkModeDescription('mainnet')}) ⚠️  Real funds required!`,
        value: 'mainnet' as NetworkMode,
      }
    ];

    const networkResponse = await prompts({
      type: 'select',
      name: 'networkMode',
      message: 'Select network mode',
      choices: networkChoices,
      initial: 0,
      hint: 'Mainnet requires funded wallets'
    });

    if (!networkResponse.networkMode) {
      return null;
    }

    networkMode = networkResponse.networkMode;

    if (networkMode === 'mainnet') {
      log('\n⚠️  WARNING: Mainnet selected - tests will use real funds!');
      log('   Make sure your wallets are funded on Base and Solana mainnet.\n');
    }
  }

  return {
    transports: selectedTransports,
    facilitators: facilitatorsResponse.facilitators,
    servers: serversResponse.servers,
    clients: clientsResponse.clients,
    extensions: selectedExtensions,
    versions: selectedVersions,
    protocolFamilies: selectedFamilies,
    schemes: selectedSchemes,
    endpoints: selectedEndpoints,
    networkMode,
  };
}

/**
 * Get available extensions from selected facilitators, servers, and clients
 */
function getAvailableExtensions(
  facilitatorNames: string[],
  serverNames: string[],
  clientNames: string[],
  allFacilitators: DiscoveredFacilitator[],
  allServers: DiscoveredServer[],
  allClients: DiscoveredClient[],
): Array<{ name: string; description: string }> {
  const extensions = new Set<string>();
  const extensionInfo: Record<string, string> = {
    'bazaar': 'Discovery extension for resource discovery',
    'eip2612GasSponsoring': 'EIP-2612 gasless Permit2 approval',
  };

  // Collect from facilitators
  facilitatorNames.forEach(name => {
    const facilitator = allFacilitators.find(f => f.name === name);
    if (facilitator?.config.extensions) {
      facilitator.config.extensions.forEach(ext => extensions.add(ext));
    }
  });

  // Collect from servers
  serverNames.forEach(name => {
    const server = allServers.find(s => s.name === name);
    if (server?.config.extensions) {
      server.config.extensions.forEach(ext => extensions.add(ext));
    }
  });

  // Collect from clients
  clientNames.forEach(name => {
    const client = allClients.find(c => c.name === name);
    if (client?.config.extensions) {
      client.config.extensions.forEach(ext => extensions.add(ext));
    }
  });

  return Array.from(extensions).map(ext => ({
    name: ext,
    description: extensionInfo[ext] || ext
  }));
}

/**
 * Get available transports from discovered servers and clients
 */
function getAvailableTransports(
  allServers: DiscoveredServer[],
  allClients: DiscoveredClient[]
): string[] {
  const transports = new Set<string>();
  allServers.forEach(s => transports.add(s.config.transport || 'http'));
  allClients.forEach(c => transports.add(c.config.transport || 'http'));
  return Array.from(transports).sort();
}

/**
 * Filter scenarios based on preliminary selections (before version/family filtering)
 */
function filterScenariosBySelections(
  scenarios: TestScenario[],
  selections: { facilitators: string[]; servers: string[]; clients: string[] }
): TestScenario[] {
  return scenarios.filter(scenario => {
    // Facilitator filter
    const facilitatorName = scenario.facilitator?.name;
    if (!facilitatorName || !selections.facilitators.includes(facilitatorName)) {
      return false;
    }

    // Server filter
    if (!selections.servers.includes(scenario.server.name)) {
      return false;
    }

    // Client filter
    if (!selections.clients.includes(scenario.client.name)) {
      return false;
    }

    return true;
  });
}

/**
 * Format version array for display
 */
function formatVersions(versions?: number[]): string {
  if (!versions || versions.length === 0) return 'v?';
  if (versions.length === 1) return `v${versions[0]}`;
  return `v${versions.join(', v')}`;
}
