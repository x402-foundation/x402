import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import { enrichConfigFromMechanisms } from './mechanisms';

/** Infra / helper dirs that must not be treated as e2e components. */
const SKIP_COMPONENT_DIRS = new Set([
  'shared',
  'node_modules',
  'external-proxies',
  'local',
  '.venv',
  '__pycache__',
  '.next',
]);

const LANGUAGES = new Set(['typescript', 'go', 'python']);
const TRANSPORTS = new Set(['http', 'mcp']);

type ComponentLocation = {
  directory: string;
  /** Path under the role dir, e.g. typescript/http/express or go/mcp */
  name: string;
  language: string;
  transport: string;
};

function componentName(roleDir: string, componentDir: string): string {
  return relative(roleDir, componentDir).split(/[/\\]/).join('/');
}

/**
 * Discover leaf components under role/{language}/{transport}/...
 * Layout: servers|clients / typescript|go|python / http|mcp / [component]
 */
export function discoverComponentLocations(roleDir: string): ComponentLocation[] {
  if (!existsSync(roleDir)) {
    return [];
  }

  const locations: ComponentLocation[] = [];

  for (const languageEnt of readdirSync(roleDir, { withFileTypes: true })) {
    if (!languageEnt.isDirectory() || !LANGUAGES.has(languageEnt.name)) {
      continue;
    }
    const language = languageEnt.name;
    const languageDir = join(roleDir, language);

    for (const transportEnt of readdirSync(languageDir, { withFileTypes: true })) {
      if (!transportEnt.isDirectory() || !TRANSPORTS.has(transportEnt.name)) {
        continue;
      }
      const transport = transportEnt.name;
      const transportDir = join(languageDir, transport);

      if (transport === 'mcp') {
        if (isComponentDir(transportDir)) {
          locations.push({
            directory: transportDir,
            name: componentName(roleDir, transportDir),
            language,
            transport,
          });
        }
        continue;
      }

      for (const componentEnt of readdirSync(transportDir, { withFileTypes: true })) {
        if (!componentEnt.isDirectory() || SKIP_COMPONENT_DIRS.has(componentEnt.name)) {
          continue;
        }
        const componentDir = join(transportDir, componentEnt.name);
        if (!isComponentDir(componentDir)) {
          continue;
        }
        locations.push({
          directory: componentDir,
          name: componentName(roleDir, componentDir),
          language,
          transport,
        });
      }
    }
  }

  return locations;
}

function isComponentDir(dir: string): boolean {
  return (
    existsSync(join(dir, 'test.config.json')) ||
    existsSync(join(dir, 'index.ts')) ||
    existsSync(join(dir, 'main.go')) ||
    existsSync(join(dir, 'main.py')) ||
    existsSync(join(dir, 'package.json')) // Next app
  );
}

/**
 * Resolve test.config.json for a component directory.
 * Returns null when the component uses inferred vanilla config from its path.
 */
function resolveComponentConfigPath(componentDir: string): string | null {
  const local = join(componentDir, 'test.config.json');
  if (existsSync(local)) {
    return local;
  }

  return null;
}

/** Infer type/language/transport for vanilla HTTP/MCP components without a local config. */
function synthesizeVanillaConfig(
  componentDir: string,
  nameOverride?: string,
): Record<string, unknown> | null {
  const normalized = resolve(componentDir).replace(/\\/g, '/');
  const parts = normalized.split('/');
  const roleIdx = parts.findIndex(p => p === 'servers' || p === 'clients' || p === 'facilitators');
  if (roleIdx < 0) {
    return null;
  }

  const roleDir = parts[roleIdx];
  const type =
    roleDir === 'servers' ? 'server' : roleDir === 'clients' ? 'client' : 'facilitator';

  if (roleDir === 'facilitators') {
    const language = parts[roleIdx + 1];
    if (!LANGUAGES.has(language)) {
      return null;
    }
    return {
      name: nameOverride ?? language,
      type: 'facilitator',
      language,
      x402Versions: [1, 2],
    };
  }

  const language = parts[roleIdx + 1];
  const transport = parts[roleIdx + 2];
  if (!LANGUAGES.has(language) || !TRANSPORTS.has(transport)) {
    return null;
  }

  const config: Record<string, unknown> = {
    name: nameOverride ?? basename(componentDir),
    type,
    language,
    transport,
  };

  if (type === 'server') {
    config.x402Version = 2;
  } else {
    config.x402Versions = transport === 'mcp' ? [2] : [1, 2];
  }

  return config;
}

/** Load component config, forcing `name` from the discovered component name when provided. */
export function loadComponentConfig(
  componentDir: string,
  nameOverride?: string,
): Record<string, unknown> | null {
  const configPath = resolveComponentConfigPath(componentDir);
  const config = configPath
    ? (JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>)
    : synthesizeVanillaConfig(componentDir, nameOverride);

  if (!config) {
    return null;
  }

  config.name = nameOverride ?? (config.name as string) ?? basename(componentDir);
  return enrichConfigFromMechanisms(config, {
    nameOverride: config.name as string,
    componentDir,
  });
}

/** Nearest language package root (directory with package.json under typescript/). */
function findTypescriptPackageRoot(componentDir: string): string | null {
  let dir = resolve(componentDir);
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg) && basename(dir) === 'typescript') {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: any package.json that is not Next's nested app when walking from express
  dir = resolve(componentDir);
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json')) && basename(dir) !== 'next') {
      // Prefer language root over next
      if (basename(dir) === 'typescript' || existsSync(join(dir, 'http')) || existsSync(join(dir, 'mcp'))) {
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve how to launch a component.
 * Prefer local run.sh when present (Next); otherwise language defaults.
 */
export function resolveRunCommand(componentDir: string): string[] {
  const runShPath = join(componentDir, 'run.sh');
  if (existsSync(runShPath)) {
    return ['bash', 'run.sh'];
  }

  if (existsSync(join(componentDir, 'index.ts'))) {
    // Nested package (Next) — already handled by run.sh typically
    if (existsSync(join(componentDir, 'package.json'))) {
      return ['pnpm', 'exec', 'tsx', 'index.ts'];
    }

    const packageRoot = findTypescriptPackageRoot(componentDir);
    if (!packageRoot) {
      throw new Error(`No TypeScript package root for ${componentDir}`);
    }

    const entry = relative(packageRoot, join(componentDir, 'index.ts'));
    return ['pnpm', '--dir', packageRoot, 'exec', 'tsx', entry];
  }

  if (existsSync(join(componentDir, 'main.py'))) {
    return [
      'bash',
      '-c',
      'uv sync --reinstall-package x402 --quiet && uv run python main.py',
    ];
  }

  if (existsSync(join(componentDir, 'go.mod')) || existsSync(join(componentDir, 'main.go'))) {
    return ['go', 'run', '.'];
  }

  throw new Error(`No run strategy for ${componentDir}`);
}
