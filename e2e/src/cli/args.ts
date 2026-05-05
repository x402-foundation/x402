import { TestFilters } from './filters';
import type { NetworkMode } from '../networks/networks';

/**
 * Parse command-line arguments
 * Used primarily for CI/GitHub workflows
 */
export interface ParsedArgs {
  mode: 'interactive' | 'programmatic';
  verbose: boolean;
  logFile?: string;
  outputJson?: string;
  filters: TestFilters;
  showHelp: boolean;
  minimize: boolean;
  networkMode?: NetworkMode;  // undefined = prompt user, set = skip prompt
  parallel: boolean;
  concurrency: number;
  endpoints?: string[];
}

export function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);

  // Help flag
  if (args.includes('-h') || args.includes('--help')) {
    return {
      mode: 'interactive',
      verbose: false,
      filters: {},
      showHelp: true,
      minimize: false,
      parallel: false,
      concurrency: 4,
    };
  }

  // Check if any filter args present -> programmatic mode
  const hasFilterArgs = args.some(arg =>
    arg.startsWith('--transport=') ||
    arg.startsWith('--facilitators=') ||
    arg.startsWith('--servers=') ||
    arg.startsWith('--clients=') ||
    arg.startsWith('--extensions=') ||
    arg.startsWith('--versions=') ||
    arg.startsWith('--families=') ||
    arg.startsWith('--schemes=') ||
    arg.startsWith('--endpoints=')
  );

  const mode: 'interactive' | 'programmatic' = hasFilterArgs ? 'programmatic' : 'interactive';

  // Parse verbose
  const verbose = args.includes('-v') || args.includes('--verbose');

  // Parse log file — supports --log (timestamped default), --log=path, and legacy --log-file=path
  let logFile: string | undefined;
  const logArg = args.find(arg => arg === '--log' || arg.startsWith('--log='));
  const legacyLogArg = args.find(arg => arg.startsWith('--log-file='));
  if (logArg) {
    if (logArg.includes('=')) {
      logFile = logArg.split('=').slice(1).join('=');
    } else {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      logFile = `logs/e2e-run-${ts}.log`;
    }
  } else if (legacyLogArg) {
    logFile = legacyLogArg.split('=')[1];
  }

  // Parse JSON output file
  const outputJson = args.find(arg => arg.startsWith('--output-json='))?.split('=')[1];

  // Parse minimize flag
  const minimize = args.includes('--min');

  // Parse parallel mode flags
  const parallel = args.includes('--parallel');
  const concurrencyArg = args.find(arg => arg.startsWith('--concurrency='))?.split('=')[1];
  const concurrency = concurrencyArg ? parseInt(concurrencyArg, 10) : 4;

  // Parse network mode (optional - if not set, will prompt in interactive mode)
  let networkMode: NetworkMode | undefined;
  if (args.includes('--mainnet')) {
    networkMode = 'mainnet';
  } else if (args.includes('--testnet')) {
    networkMode = 'testnet';
  }

  // Parse filters (comma-separated lists)
  const transports = parseListArg(args, '--transport');
  const facilitators = parseListArg(args, '--facilitators');
  const servers = parseListArg(args, '--servers');
  const clients = parseListArg(args, '--clients');
  const extensions = parseListArg(args, '--extensions');
  const versions = parseListArg(args, '--versions')?.map(v => parseInt(v));
  const families = parseListArg(args, '--families');
  const schemes = parseListArg(args, '--schemes');
  const endpoints = parseListArg(args, '--endpoints');

  return {
    mode,
    verbose,
    logFile,
    outputJson,
    filters: {
      transports,
      facilitators,
      servers,
      clients,
      extensions,
      versions,
      protocolFamilies: families,
      schemes,
      endpoints,
    },
    showHelp: false,
    minimize,
    networkMode,
    parallel,
    concurrency,
    endpoints,
  };
}

function parseListArg(args: string[], argName: string): string[] | undefined {
  const arg = args.find(a => a.startsWith(`${argName}=`));
  if (!arg) return undefined;
  const value = arg.split('=')[1];
  return value.split(',').map(v => v.trim()).filter(v => v.length > 0);
}

export function printHelp(): void {
  console.log('Usage: pnpm test [options]');
  console.log('');
  console.log('Interactive Mode (default):');
  console.log('  pnpm test                  Launch interactive prompt mode');
  console.log('  pnpm test -v               Interactive with verbose logging');
  console.log('');
  console.log('Network Selection:');
  console.log('  --testnet                  Use testnet networks');
  console.log('  --mainnet                  Use mainnet networks ⚠️  Real funds!');
  console.log('  (If not specified, will prompt in interactive mode)');
  console.log('');
  console.log('Programmatic Mode (for CI/workflows):');
  console.log('  --transport=<list>         Comma-separated transports (e.g., http,mcp)');
  console.log('  --facilitators=<list>      Comma-separated facilitator names');
  console.log('  --servers=<list>           Comma-separated server names');
  console.log('  --clients=<list>           Comma-separated client names');
  console.log('  --extensions=<list>        Comma-separated extensions (e.g., bazaar)');
  console.log('  --versions=<list>          Comma-separated version numbers (e.g., 1,2)');
  console.log('  --families=<list>          Comma-separated protocol families (e.g., evm,svm,hedera)');
  console.log('  --schemes=<list>           Payment schemes: exact, upto, batch-settlement');
  console.log('  --endpoints=<list>         Comma-separated endpoint paths or regex patterns (auto-anchored)');
  console.log('');
  console.log('Options:');
  console.log('  -v, --verbose              Enable verbose logging');
  console.log('  --log[=<path>]             Write output to file (default: logs/e2e-run-<timestamp>.log)');
  console.log('  --log-file=<path>          Alias for --log=<path> (legacy)');
  console.log('  --output-json=<path>       Write structured JSON results to file');
  console.log('  --min                      Minimize tests (coverage-based skipping)');
  console.log('  --parallel                 Run server+facilitator combos concurrently');
  console.log('  --concurrency=<N>          Max concurrent combos (default: 4, requires --parallel)');
  console.log('  -h, --help                 Show this help message');
  console.log('');
  console.log('Examples:');
  console.log('  pnpm test                                           # Interactive mode (testnet)');
  console.log('  pnpm test --testnet                                 # Skip network prompt');
  console.log('  pnpm test --mainnet                                 # Use mainnet (real funds!)');
  console.log('  pnpm test --min -v                                  # Minimize with verbose');
  console.log('  pnpm test --transport=mcp                                # MCP transport only');
  console.log('  pnpm test --mainnet --facilitators=go --servers=express  # Mainnet programmatic');
  console.log("  pnpm test --testnet --endpoints='/protected'              # Exact path match");
  console.log("  pnpm test --testnet --endpoints='/protected-permit2.*'   # Regex: all permit2 routes");
  console.log('  pnpm test --testnet --schemes=exact,batch-settlement     # Only those payment schemes');
  console.log('  pnpm test --testnet --min --parallel -v                   # Parallel mode');
  console.log('  pnpm test --testnet --min --parallel --concurrency=2 -v   # Limited concurrency');
  console.log('');
  console.log('Note: --mainnet requires funded wallets with real tokens!');
  console.log('');
}
