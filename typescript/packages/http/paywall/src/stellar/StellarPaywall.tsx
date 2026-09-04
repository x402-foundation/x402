import { useCallback, useState } from "react";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { resolveFaucetUrl } from "../faucetUrls";
import { getNetworkDisplayName } from "./utils";
import { Spinner } from "./Spinner";
import { statusError, statusInfo, type Status } from "./status";
import { useStellarBalance } from "./useStellarBalance";
import { useStellarPayment } from "./useStellarPayment";
import { useSWKConnection } from "./useSWKConnection";
import { useSWKSigner } from "./useSWKSigner";

type StellarPaywallProps = {
  paymentRequired: PaymentRequired;
  onSuccessfulResponse: (response: Response) => Promise<void>;
};

type StellarPaywallMainProps = {
  paymentRequired: PaymentRequired;
  stellarRequirement: PaymentRequirements;
  onSuccessfulResponse: (response: Response) => Promise<void>;
};

const STELLAR_PAYMENT_SCALE = 10_000_000;

/**
 * Paywall experience for Stellar networks. Validates that a Stellar payment
 * requirement exists and either renders the error shell or delegates to the
 * main component.
 *
 * @param props - Component props.
 * @param props.paymentRequired - Payment required response with accepts array.
 * @param props.onSuccessfulResponse - Callback invoked on successful 402 response.
 * @returns JSX element.
 */
export function StellarPaywall({ paymentRequired, onSuccessfulResponse }: StellarPaywallProps) {
  const stellarRequirement = paymentRequired.accepts.find(r => r.network.startsWith("stellar:"));

  if (!stellarRequirement) {
    return (
      <div className="container gap-8">
        <div className="header">
          <h1 className="title">Payment Required</h1>
        </div>
        <div className="content w-full">
          <div className="status status-error">
            No Stellar payment requirement found in paymentRequired.accepts
          </div>
        </div>
      </div>
    );
  }

  return (
    <StellarPaywallMain
      paymentRequired={paymentRequired}
      stellarRequirement={stellarRequirement}
      onSuccessfulResponse={onSuccessfulResponse}
    />
  );
}

/**
 * Main paywall component. Receives a guaranteed Stellar requirement and
 * handles wallet connection, balance fetching, and payment submission.
 *
 * @param props - Component props.
 * @param props.paymentRequired - Payment required response with accepts array.
 * @param props.stellarRequirement - Resolved Stellar payment requirement.
 * @param props.onSuccessfulResponse - Callback invoked on successful 402 response.
 * @returns JSX element.
 */
function StellarPaywallMain({
  paymentRequired,
  stellarRequirement,
  onSuccessfulResponse,
}: StellarPaywallMainProps) {
  const [status, setStatus] = useState<Status | null>(null);
  const [hideBalance, setHideBalance] = useState(true);

  const x402 = window.x402;
  const { network, asset } = stellarRequirement;
  const networkKey = network.split(":")[1] ?? "";
  const chainConfig = x402.config?.chainConfig;
  const assetCode = chainConfig?.[networkKey]?.usdcName || "USDC";
  const isTestnetUsdc =
    network === "stellar:testnet" && asset === chainConfig?.testnet?.usdcAddress;
  const faucetUrl = isTestnetUsdc ? resolveFaucetUrl(network, x402) : undefined;

  const { kitReady, address, connect, disconnect } = useSWKConnection({
    network,
    onStatus: setStatus,
  });

  const {
    isFetchingBalance,
    tokenBalanceFormatted,
    isMissingTrustline,
    assetMetadata,
    refreshBalance,
    resetBalance,
  } = useStellarBalance({
    address,
    network,
    asset,
    onStatus: setStatus,
  });

  const walletSigner = useSWKSigner({
    kitReady,
    network,
    address,
  });

  const { isPaying, submitPayment } = useStellarPayment({
    paymentRequired,
    walletSigner,
    onSuccessfulResponse,
    setStatus,
  });

  const amount =
    typeof x402.amount === "number"
      ? x402.amount
      : Number(stellarRequirement.amount) / STELLAR_PAYMENT_SCALE;

  const chainName = getNetworkDisplayName(network);

  const handleConnect = useCallback(async () => {
    await connect();
  }, [connect]);

  const handleDisconnect = useCallback(async () => {
    await disconnect();
    resetBalance();
    setStatus(
      statusInfo(
        "Wallet disconnected. To fully disconnect some wallets, you may need to disconnect from the wallet app itself.",
      ),
    );
  }, [disconnect, resetBalance]);

  const handlePayment = useCallback(async () => {
    if (!x402) {
      return;
    }

    if (!walletSigner || !address) {
      setStatus(statusError("Connect a Stellar wallet before paying."));
      return;
    }

    if (tokenBalanceFormatted === "") {
      setStatus(statusInfo(`Checking ${assetCode} balance...`));
      const freshBalance = await refreshBalance();
      if (Number(freshBalance) < amount) {
        setStatus(
          statusError(
            `Insufficient balance. Make sure you have enough ${assetCode} on ${chainName}.`,
          ),
        );
        return;
      }
    }

    try {
      await submitPayment();
    } catch (error) {
      setStatus(statusError(error instanceof Error ? error.message : "Payment failed."));
    }
  }, [
    x402,
    walletSigner,
    address,
    tokenBalanceFormatted,
    amount,
    assetCode,
    chainName,
    refreshBalance,
    submitPayment,
  ]);

  return (
    <div className="container gap-8">
      <div className="header">
        <h1 className="title">Payment Required</h1>
        <p>
          {paymentRequired.resource?.description && `${paymentRequired.resource.description}.`} To
          access this content, please pay ${amount} {chainName} {assetCode}.
          {faucetUrl && (
            <span>
              {" "}
              <a href={faucetUrl} target="_blank" rel="noopener noreferrer">
                Fund USDC ↗
              </a>
            </span>
          )}
        </p>
      </div>

      <div className="content w-full">
        <div className="payment-details">
          <div className="payment-row">
            <span className="payment-label">Wallet:</span>
            <span className="payment-value">
              {address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "-"}
            </span>
          </div>
          <div className="payment-row">
            <span className="payment-label">Available balance:</span>
            <span className="payment-value">
              {address ? (
                <button className="balance-button" onClick={() => setHideBalance(prev => !prev)}>
                  {!hideBalance && tokenBalanceFormatted
                    ? `$${tokenBalanceFormatted} ${assetCode}`
                    : isFetchingBalance
                      ? "Loading..."
                      : `••••• ${assetCode}`}
                </button>
              ) : (
                "-"
              )}
            </span>
          </div>
          <div className="payment-row">
            <span className="payment-label">Amount:</span>
            <span className="payment-value">
              ${amount} {assetCode}
            </span>
          </div>
          <div className="payment-row">
            <span className="payment-label">Network:</span>
            <span className="payment-value">{chainName}</span>
          </div>
        </div>

        <div className="cta-container">
          {!address ? (
            <>
              {kitReady && (
                <button className="button button-primary" onClick={handleConnect}>
                  Connect Wallet
                </button>
              )}
              {!kitReady && <div className="status status-info">Loading wallet options...</div>}
            </>
          ) : (
            <>
              <button className="button button-secondary" onClick={handleDisconnect}>
                Disconnect
              </button>
              <button
                className="button button-primary"
                onClick={handlePayment}
                disabled={isPaying || isMissingTrustline === true}
              >
                {!isPaying ? "Pay" : <Spinner />}
              </button>
            </>
          )}
        </div>

        {status && <div className={`status status-${status.type}`}>{status.message}</div>}

        {address && isMissingTrustline && (
          <div className="trustline-banner">
            <div className="trustline-icon" aria-hidden="true">
              !
            </div>
            <div className="trustline-body">
              <p className="trustline-title">
                {assetMetadata ? assetMetadata.code : "Asset"} trustline required
              </p>
              <p className="trustline-text">
                Your account needs a <strong>{assetMetadata ? assetMetadata.code : "asset"}</strong>{" "}
                trustline before you can hold or pay with this asset. Add one via{" "}
                <a
                  href="https://lab.stellar.org/account/fund"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Stellar Laboratory
                </a>
                : connect your wallet, add the {assetMetadata ? assetMetadata.code : "asset"}{" "}
                trustline, and sign the transaction.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
