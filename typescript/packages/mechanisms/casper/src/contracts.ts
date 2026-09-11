import {
  Contract,
  Key,
  ParamDictionaryIdentifier,
  ParamDictionaryIdentifierContractNamedKey,
  RpcClient,
  StateGetDictionaryResult,
} from "casper-js-sdk";

import { hexToBytes } from "./utils";

type CasperContractHash = {
  hash?: { toHex(): string };
  toJSON?(): string;
};

type CasperContractVersion = {
  contractHash: CasperContractHash;
  contractVersion: number;
  protocolVersionMajor: number;
};

type CasperContractPackage = {
  disabledVersions?: number[][];
  versions?: CasperContractVersion[];
};

type CasperStateResult = {
  storedValue: {
    contractPackage?: CasperContractPackage;
    contract?: CasperContract;
  };
};

type CasperEntryPoint = {
  name?: string;
};

type CasperContract = {
  entryPoints?: CasperEntryPoint[];
};

export async function getActiveContractForToken(
  rpcClient: InstanceType<typeof RpcClient>,
  assetKey: string,
): Promise<Contract & { contractHash: string }> {
  const packageState = await rpcClient.queryLatestGlobalState(`hash-${assetKey}`, []);

  const contractKey = findActiveContractHash(packageState);
  try {
    const contractState = await rpcClient.queryLatestGlobalState(contractKey, []);
    if (!contractState.storedValue.contract) {
      throw new Error("active contract not found");
    }
    return { ...contractState.storedValue.contract, contractHash: contractKey };
  } catch (error) {
    throw new Error(
      `failed to get active contract for token: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function contractVersionHash(version: CasperContractVersion): string {
  const hash = version.contractHash.hash?.toHex() ?? version.contractHash.toJSON?.();
  if (!hash) {
    throw new Error("contract version is missing contract hash");
  }
  return hash.replace(/^(hash-|contract-)/, "");
}

function findActiveContractHash(packageState: CasperStateResult): string {
  if (packageState.storedValue.contractPackage) {
    const contractPackage = packageState.storedValue.contractPackage;

    const versions = contractPackage?.versions ?? [];
    if (versions.length === 0) {
      throw new Error("contract package has no active versions");
    }

    const disabledVersions = new Set(
      (contractPackage?.disabledVersions ?? []).map(
        ([protocolVersionMajor, contractVersion]) => `${protocolVersionMajor}:${contractVersion}`,
      ),
    );
    const activeVersions = versions.filter(
      version =>
        !disabledVersions.has(`${version.protocolVersionMajor}:${version.contractVersion}`),
    );
    if (activeVersions.length === 0) {
      throw new Error("contract package has no enabled versions");
    }

    const activeVersionHash = activeVersions.reduce((selected, version) =>
      version.contractVersion > selected.contractVersion ? version : selected,
    );
    return `hash-${contractVersionHash(activeVersionHash)}`;
  }
  throw new Error("token package not found");
}

export async function readDictionaryU256OrDefault(
  rpcClient: InstanceType<typeof RpcClient>,
  contractHash: string,
  dictionaryName: string,
  itemKey: string,
): Promise<bigint> {
  try {
    const result = await readDictionaryItem(rpcClient, contractHash, dictionaryName, itemKey);
    const value = result.storedValue.clValue?.ui256?.toString();
    if (value && /^\d+$/.test(value)) {
      return BigInt(value);
    }
  } catch (error) {
    if (isMissingDictionaryItem(error)) {
      return 0n;
    }
    throw error;
  }
  throw new Error("invalid U256 dictionary value");
}

async function readDictionaryItem(
  rpcClient: InstanceType<typeof RpcClient>,
  contractKey: string,
  dictionaryName: string,
  itemKey: string,
) {
  return rpcClient.getDictionaryItemByIdentifier(
    null,
    new ParamDictionaryIdentifier(
      undefined,
      new ParamDictionaryIdentifierContractNamedKey(contractKey, dictionaryName, itemKey),
    ),
  );
}

function hasSourceErr(error: unknown): error is { sourceErr: { data?: unknown } } {
  return typeof error === "object" && error !== null && "sourceErr" in error;
}

export function isMissingDictionaryItem(error: unknown): boolean {
  return hasSourceErr(error) && /dictionary URef not found/i.test(String(error.sourceErr?.data));
}

export function dictionaryKeyForAddress(address: string): string {
  const key = Key.fromBytes(hexToBytes(address)).result;
  return Buffer.from(key.bytes()).toString("base64");
}

export function dictionaryKeyForUsedNonces(payer: string, nonce: string): string {
  const payerKey = Key.fromBytes(hexToBytes(payer)).result;
  return Buffer.concat([Buffer.from(payerKey.bytes()), Buffer.from(hexToBytes(nonce))]).toString(
    "base64",
  );
}

export async function readDictionaryBool(
  rpcClient: InstanceType<typeof RpcClient>,
  contractKey: string,
  dictionaryName: string,
  itemKey: string,
): Promise<boolean> {
  return parseUsedNonceResult(
    await readDictionaryItem(rpcClient, contractKey, dictionaryName, itemKey),
  );
}

function parseUsedNonceResult(result: StateGetDictionaryResult): boolean {
  const boolValue = result.storedValue.clValue?.bool?.getValue();
  if (typeof boolValue === "boolean") {
    return boolValue;
  }

  throw new Error("invalid used_nonces dictionary value");
}
