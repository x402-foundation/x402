#!/usr/bin/env bash
# Compiles the test contracts in src/ and writes artifacts/<Name>.json (ABI + creation
# bytecode), which deploy.ts reads. Needs Foundry (https://getfoundry.sh). The artifacts are
# committed, so only contract changes need a rebuild.
set -euo pipefail
cd "$(dirname "$0")"
forge build --silent
mkdir -p artifacts
for name in MockTransferExecutor SignedOwnerExecutor; do
  NAME="$name" node -e '
const name = process.env.NAME;
const a = require(`./out/${name}.sol/${name}.json`);
require("fs").writeFileSync(`artifacts/${name}.json`, JSON.stringify({
  contractName: name,
  abi: a.abi,
  bytecode: a.bytecode.object,
}, null, 2) + "\n");
'
  echo "wrote artifacts/$name.json"
done
