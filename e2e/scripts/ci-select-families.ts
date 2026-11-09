/**
 * Print comma-separated protocol families whose catalog-required env keys are all set.
 * Used by ci-select-families.sh so family gates stay catalog-driven.
 */
import {
  PROTOCOL_FAMILIES,
  requiredEnvForFamily,
} from '../src/networks/networks';

const families: string[] = [];

for (const family of PROTOCOL_FAMILIES) {
  const keys = requiredEnvForFamily(family);
  if (keys.length === 0) continue;
  if (keys.every(key => Boolean(process.env[key]?.trim()))) {
    families.push(family);
  }
}

if (families.length === 0) {
  console.error('No protocol families have all required wallet secrets configured.');
  console.error('Set variables in e2e/.env or export them in your shell.');
  process.exit(1);
}

console.log(families.join(','));
