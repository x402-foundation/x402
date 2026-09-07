/**
 * Concrete Canton signers — the ledger-backed implementations of the injected
 * {@link ClientCantonSigner} / {@link FacilitatorCantonSigner} interfaces, built
 * on the bundled JSON Ledger API + Scan clients and the official
 * `@canton-network/core-tx-visualizer` hashing.
 *
 * `toClientCantonSigner` gives a payer everything to resolve a transfer factory,
 * interactive-prepare a `TransferFactory_Transfer`, and sign the recomputed hash.
 * `toFacilitatorCantonSigner` gives a facilitator everything to verify a payer's
 * inline signature (hash binding + topology-key Ed25519), read a merchant's
 * preapproval and a payer's holdings, and relay the signed transaction.
 *
 * Mirrors the SVM mechanism's `toClientSvmSigner` / `toFacilitatorSvmSigner`
 * split (see `mechanisms/svm/src/signer.ts`), and ports the production
 * `@ftptech/*` ledger logic that settles real CC + USDCx payments.
 */
import { createPrivateKey, randomUUID } from "node:crypto";
import { CantonClient, type TokenProvider } from "./ledger/client.js";
import { ScanClient, type ScanFlavor } from "./ledger/scan.js";
import { recomputeHash } from "./ledger/canton-hash.js";
import { signPreparedTransactionHash } from "./ledger/external-party.js";
import { createPayerProofVerifier, rawEd25519ToDerSpki } from "./ledger/payer-proof.js";
import { TransferFactoryService } from "./ledger/transfer-factory.js";
import type {
  ClientCantonSigner,
  FacilitatorCantonSigner,
  PreapprovalView,
  ExecuteResult,
} from "./signer.js";

/** Shared ledger/Scan connection config for both signers. */
export interface CantonLedgerConfig {
  /** Participant JSON Ledger API base URL. */
  participantUrl: string;
  /** Static bearer, or a resolver for OIDC. */
  token: string | TokenProvider;
  /** Ledger user the participant prepares/executes as. */
  userId: string;
  /** Global Synchronizer id to prepare on / read topology from. */
  synchronizerId: string;
  /** SV Scan base URL (registry resolves, preapproval, holdings). */
  scanUrl: string;
  /** Scan flavor; `sv` unlocks the registry resolves. Defaults to `sv`. */
  scanFlavor?: ScanFlavor;
  /** Additional SV Scan bases to fail over to. */
  scanFallbackUrls?: string[];
  /** Non-Amulet CIP-56 registries: instrument admin party → DA Registry Utility
   *  base URL. */
  tokenRegistries?: Record<string, string>;
  /** Request timeout in ms for ledger + Scan calls. */
  timeoutMs?: number;
  /** Override the fetch implementation (tests). */
  fetch?: typeof globalThis.fetch;
}

/** Client-signer config: {@link CantonLedgerConfig} plus the payer's key. */
export interface ClientCantonSignerConfig extends CantonLedgerConfig {
  /** The payer party (`hint::namespace-fingerprint`). */
  party: string;
  /** The payer's Ed25519 private key as a PKCS8 PEM string (signs the
   *  prepared-tx hash). */
  privateKeyPem: string;
  /** The payer's topology fingerprint (`Signature.signedBy`). Defaults to the
   *  namespace portion of `party` — correct for a single-key external party. */
  fingerprint?: string;
}

/** Facilitator-signer config: {@link CantonLedgerConfig} plus its own parties. */
export interface FacilitatorCantonSignerConfig extends CantonLedgerConfig {
  /** The facilitator parties this deployment relays as (the `feePayer`). */
  facilitatorParties: readonly string[];
  /**
   * Optional override for reading a payer's Ed25519 signing keys from topology.
   * The key SOURCE is deployment-specific: the participant JSON Ledger API JOSE
   * route (the default here) serves it on Canton 3.5.10+, but a Splice-distributed
   * participant does not — those deployments run an external topology reader (or
   * an admin gRPC read) instead. Return raw 32-byte points OR DER SPKI keys; both
   * are accepted. An empty array means "cannot verify" (the payer is refused).
   */
  fetchPayerSigningKey?: (party: string) => Promise<Buffer[]>;
}

/**
 * Pick the smallest single holding that covers `want`, else accumulate holdings
 * largest-first until they do. Mirrors the production input-selection heuristic
 * (leaves large holdings free for sibling transfers).
 *
 * @param amounts - Map of holding contract id → ledger-Decimal amount.
 * @param want - The transfer amount as a ledger Decimal string.
 * @returns The chosen holding contract ids.
 */
function selectInputHoldings(amounts: Map<string, string>, want: string): string[] {
  const target = Number(want);
  const all = [...amounts.entries()].map(([cid, amount]) => ({ cid, amount: Number(amount) }));
  const single = all.filter(h => h.amount >= target).sort((a, b) => a.amount - b.amount)[0];
  if (single) return [single.cid];
  const chosen: string[] = [];
  let acc = 0;
  for (const h of [...all].sort((a, b) => b.amount - a.amount)) {
    chosen.push(h.cid);
    acc += h.amount;
    if (acc >= target) break;
  }
  return chosen;
}

/**
 * Build a concrete {@link ClientCantonSigner} backed by a Canton participant +
 * Scan. Resolves the transfer factory, interactive-prepares the transfer, and
 * signs the recomputed hash with the payer's key.
 *
 * @param config - Ledger/Scan connection plus the payer's party and key.
 * @returns A client signer implementing prepareTransfer + signPrepared.
 */
export function toClientCantonSigner(config: ClientCantonSignerConfig): ClientCantonSigner {
  const client = new CantonClient({
    participantUrl: config.participantUrl,
    token: config.token,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.fetch ? { fetch: config.fetch } : {}),
  });
  const scan = new ScanClient({
    scanUrl: config.scanUrl,
    token: config.token,
    flavor: config.scanFlavor ?? "sv",
    ...(config.scanFallbackUrls ? { fallbackUrls: config.scanFallbackUrls } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.fetch ? { fetch: config.fetch } : {}),
  });
  const fingerprint = config.fingerprint ?? config.party.split("::")[1] ?? "";
  const privateKey = createPrivateKey(config.privateKeyPem);

  return {
    party: config.party,

    async prepareTransfer(input) {
      const { admin, id } = input.instrumentId;
      const registryBaseUrl = config.tokenRegistries?.[admin];
      // Read the payer's OWN unlocked holdings from the participant ACS via the
      // HoldingV1 interface — Canton Coin (Amulet) and any CIP-56 registry token
      // both implement it. This uses the live participant snapshot (the payer is
      // hosted here), avoiding the SV Scan daily-snapshot lag that would hand back
      // a just-spent, archived input cid.
      const holdings = new Map(
        (await client.readHoldingsV1(config.party, { admin, id })).map(h => [h.cid, h.amount]),
      );
      const inputHoldingCids = selectInputHoldings(holdings, input.amount);
      const factory = await scan.resolveTransferFactory({
        sender: config.party,
        receiver: input.receiver,
        amount: input.amount,
        admin,
        id,
        inputHoldingCids,
        ...(input.memo !== undefined ? { meta: { "x402.memo": input.memo } } : {}),
        ...(registryBaseUrl ? { registryBaseUrl } : {}),
      });
      const now = Date.now();
      const command = {
        ExerciseCommand: {
          templateId: factory.transferFactoryTemplateId,
          contractId: factory.factoryId,
          choice: "TransferFactory_Transfer",
          choiceArgument: {
            expectedAdmin: factory.instrumentId.admin,
            transfer: {
              sender: config.party,
              receiver: input.receiver,
              amount: input.amount,
              instrumentId: factory.instrumentId,
              requestedAt: new Date(now - 2000).toISOString(),
              executeBefore: new Date(now + input.executeBeforeSeconds * 1000).toISOString(),
              inputHoldingCids,
              meta: { values: input.memo !== undefined ? { "x402.memo": input.memo } : {} },
            },
            extraArgs: { context: factory.choiceContextData, meta: { values: {} } },
          },
        },
      };
      const prepared = await client.interactiveSubmissionPrepare({
        userId: config.userId,
        commandId: `x402-${randomUUID()}`,
        actAs: [config.party],
        synchronizerId: config.synchronizerId,
        commands: [command],
        disclosedContracts: factory.disclosedContracts,
      });
      return { preparedTransaction: prepared.preparedTransaction };
    },

    async signPrepared(preparedTransaction) {
      // Recompute the hash FROM these exact bytes (never a relay-supplied value)
      // and sign THAT — the hash binding that protects the payer from a lying
      // relay. The client scheme has already run verify-before-sign on these bytes.
      const hashB64 = await recomputeHash(preparedTransaction);
      const entry = signPreparedTransactionHash(hashB64, privateKey, fingerprint);
      return {
        preparedTxHashHex: Buffer.from(hashB64, "base64").toString("hex"),
        signatureB64: entry.signature,
        hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
      };
    },
  };
}

/**
 * Build a concrete {@link FacilitatorCantonSigner} backed by a Canton participant
 * + Scan. Verifies a payer's inline signature (hash binding + topology-key
 * Ed25519), reads a merchant's preapproval and a payer's holdings, and relays the
 * signed transaction.
 *
 * @param config - Ledger/Scan connection plus the facilitator's own parties.
 * @returns A facilitator signer implementing verify/read/execute.
 */
export function toFacilitatorCantonSigner(
  config: FacilitatorCantonSignerConfig,
): FacilitatorCantonSigner {
  const client = new CantonClient({
    participantUrl: config.participantUrl,
    token: config.token,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.fetch ? { fetch: config.fetch } : {}),
  });
  const scan = new ScanClient({
    scanUrl: config.scanUrl,
    token: config.token,
    flavor: config.scanFlavor ?? "sv",
    ...(config.scanFallbackUrls ? { fallbackUrls: config.scanFallbackUrls } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.fetch ? { fetch: config.fetch } : {}),
  });
  const tfSvc = new TransferFactoryService({
    client,
    userId: config.userId,
    ...(config.tokenRegistries ? { tokenRegistries: config.tokenRegistries } : {}),
  });
  // Default key source: the participant JSON Ledger API JOSE route. A deployment
  // whose participant does not serve it (e.g. Splice) injects `fetchPayerSigningKey`.
  const keyLookup =
    config.fetchPayerSigningKey ??
    ((party: string) => client.getPartySigningKeys(config.synchronizerId, party));
  const verifyProof = createPayerProofVerifier({
    // Normalize to DER SPKI (raw 32-byte points are wrapped; DER passes through).
    fetchPayerSigningKey: async party => (await keyLookup(party)).map(rawEd25519ToDerSpki),
  });

  return {
    getAddresses() {
      return [...config.facilitatorParties];
    },

    async verifySignature(args) {
      const result = await verifyProof({
        preparedTransactionBytes: args.preparedTransactionBytes,
        claimedPreparedTxHash: args.claimedPreparedTxHash,
        signatureB64: args.signatureB64,
        payer: args.payer,
        hashingSchemeVersion: args.hashingSchemeVersion,
      });
      return {
        verified: result.verified,
        ...(result.preparedTxHashHex !== undefined
          ? { preparedTxHashHex: result.preparedTxHashHex }
          : {}),
        ...(result.publishedProtocolKeys !== undefined
          ? { publishedProtocolKeys: result.publishedProtocolKeys }
          : {}),
      };
    },

    async fetchPreapproval(party): Promise<PreapprovalView | null> {
      const rec = await scan.getTransferPreapprovalByParty(party);
      if (!rec) return null;
      return {
        receiver: rec.receiver,
        dso: rec.dso,
        expiresAt: rec.expiresAt,
        ...(rec.provider ? { provider: rec.provider } : {}),
        ...(rec.validFrom !== undefined ? { validFrom: rec.validFrom } : {}),
      };
    },

    async fetchOwnedHoldingAmounts(party): Promise<Map<string, string> | undefined> {
      try {
        return await scan.getOwnedAmuletAmounts(party);
      } catch {
        // A facilitator without SV Scan holdings access does not host this read;
        // the verify path treats undefined as "cannot check" (falls back to its
        // other gates) rather than failing the payment.
        return undefined;
      }
    },

    async executeSubmission(args): Promise<ExecuteResult> {
      // `signedBy` is the payer's own namespace fingerprint (the part after
      // `::`), which for a single-key external party IS its signing key's
      // fingerprint — the only identifier the participant will accept at execute.
      const signedBy = args.payer.split("::")[1] ?? "";
      const result = await tfSvc.execute({
        payer: args.payer,
        preparedTransaction: args.preparedTransactionBytes.toString("base64"),
        hashingSchemeVersion: args.hashingSchemeVersion as
          | "HASHING_SCHEME_VERSION_V1"
          | "HASHING_SCHEME_VERSION_V2",
        partySignatures: {
          signatures: [
            {
              party: args.payer,
              signatures: [
                {
                  format: "SIGNATURE_FORMAT_CONCAT",
                  signature: args.signatureB64,
                  signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519",
                  signedBy,
                },
              ],
            },
          ],
        },
        submissionId: `x402-inline-${randomUUID()}`,
        // Selects the registry vs Amulet funds-moved signal in confirmTransferred.
        ...(args.instrumentAdmin !== undefined ? { instrumentAdmin: args.instrumentAdmin } : {}),
      });
      return {
        updateId: result.updateId,
        transferred: result.transferred,
        confirmInconclusive: result.confirmInconclusive,
      };
    },
  };
}
