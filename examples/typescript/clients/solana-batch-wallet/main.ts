import { getWallets } from "@wallet-standard/app";
import { createSignableMessage, getBase58Decoder, getUtf8Codec } from "@solana/kit";
import { signBatchAuthorization, type BatchAuthorizationFormat } from "@x402/svm";

// The diagnostic records the raw Wallet Standard response before normalization.
// This is intentionally separate from the production toBatchClientSigner guard.
const registry = getWallets();
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const select = element<HTMLSelectElement>("wallet");
const output = element<HTMLPreElement>("result");
const binary = element<HTMLButtonElement>("binary");
const text = element<HTMLButtonElement>("text");
const download = element<HTMLButtonElement>("download");
const connect = element<HTMLButtonElement>("connect");
const captures: unknown[] = [];
let connection:
  | {
      wallet: ReturnType<typeof registry.get>[number];
      account: {
        address: string;
        publicKey: Uint8Array;
        chains: readonly string[];
        features: readonly string[];
      };
    }
  | undefined;

function refresh() {
  connect.disabled = registry.get().length === 0;
  if (connect.disabled)
    output.textContent =
      "No Wallet Standard wallets detected in this browser. Open this page in the browser containing your wallet extension.";
  select.replaceChildren(
    ...registry.get().map((wallet, i) => {
      const option = document.createElement("option");
      option.value = String(i);
      option.textContent = wallet.name;
      return option;
    }),
  );
}
registry.on("register", refresh);
registry.on("unregister", refresh);
refresh();
const randomAddress = () => getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)));
const channelId = randomAddress(),
  operator = randomAddress(),
  requestId = crypto.randomUUID();
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
async function describe(bytes: Uint8Array) {
  return {
    length: bytes.length,
    hex: hex(bytes),
    sha256: hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))),
  };
}
connect.onclick = async () => {
  try {
    const wallet = registry.get()[Number(select.value)];
    const feature = wallet?.features["standard:connect"] as
      | {
          connect(): Promise<{
            accounts: NonNullable<typeof connection>["account"][];
          }>;
        }
      | undefined;
    if (!feature) throw new Error("The selected wallet cannot connect.");
    const { accounts } = await feature.connect();
    const account = accounts.find(
      account =>
        account.chains.some(chain => chain.startsWith("solana:")) &&
        account.features.includes("solana:signMessage"),
    );
    if (!account || !wallet.features["solana:signMessage"])
      throw new Error("No Solana account with message signing was returned.");
    connection = { wallet, account };
    binary.disabled = text.disabled = false;
    output.textContent = `Connected to ${wallet.name}. No signature has been requested.`;
  } catch (error) {
    output.textContent = String(error);
  }
};
async function capture(format: BatchAuthorizationFormat) {
  if (!connection) return;
  connect.disabled = binary.disabled = text.disabled = true;
  const { wallet, account } = connection;
  const record: Record<string, unknown> = {
    capturedAt: new Date().toISOString(),
    wallet: wallet.name,
    extensionVersion: element<HTMLInputElement>("extension").value || null,
    installedSolanaSnapVersion: element<HTMLInputElement>("snap").value || null,
    walletStandardVersion: wallet.version,
    signingFeatureVersion: (wallet.features["solana:signMessage"] as { version?: string }).version,
    format,
    fields: {
      payer: account.address,
      channelId,
      operator,
      requestId,
      authorizedAmount: "1000",
      expiresAt: 1,
    },
  };
  try {
    const feature = wallet.features["solana:signMessage"] as {
      signMessage(input: { account: typeof account; message: Uint8Array }): Promise<
        {
          signedMessage: Uint8Array;
          signature: Uint8Array;
          signatureType?: string;
        }[]
      >;
    };
    await signBatchAuthorization(
      {
        address: account.address as never,
        signMessages: async messages => {
          const original = new Uint8Array(messages[0].content);
          const input = new Uint8Array(original);
          record.original = await describe(original);
          const [response] = await feature.signMessage({
            account,
            message: input,
          });
          if (!response) throw new Error("The wallet returned no signing result.");
          const returned = new Uint8Array(response.signedMessage),
            signature = new Uint8Array(response.signature);
          record.inputAfterCall = await describe(input);
          record.returnedSignedMessage = await describe(returned);
          record.signature = {
            hex: hex(signature),
            base58: getBase58Decoder().decode(signature),
            type: response.signatureType ?? "ed25519",
          };
          record.publicKeyHex = hex(account.publicKey);
          const candidate = new Uint8Array(
            createSignableMessage(getUtf8Codec().decode(original)).content,
          );
          record.utf8Candidate = await describe(candidate);
          const key = await crypto.subtle.importKey(
            "raw",
            new Uint8Array(account.publicKey),
            "Ed25519",
            false,
            ["verify"],
          );
          record.verification = {
            original: await crypto.subtle.verify("Ed25519", key, signature, original),
            returnedSignedMessage: await crypto.subtle.verify("Ed25519", key, signature, returned),
            utf8Candidate: await crypto.subtle.verify("Ed25519", key, signature, candidate),
            returnedEqualsOriginal: hex(returned) === hex(original),
          };
          return [{ [account.address]: signature }] as never;
        },
      },
      channelId,
      operator,
      requestId,
      1000n,
      1,
      format,
    );
  } catch (error) {
    record.error = String(error);
  } finally {
    captures.push(record);
    output.textContent = JSON.stringify(record, null, 2);
    connect.disabled = binary.disabled = text.disabled = download.disabled = false;
  }
}
binary.onclick = () => {
  void capture("binary");
};
text.onclick = () => {
  void capture("text-v1");
};
download.onclick = () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(captures, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "solana-batch-wallet-capture.json";
  anchor.click();
  URL.revokeObjectURL(url);
};
