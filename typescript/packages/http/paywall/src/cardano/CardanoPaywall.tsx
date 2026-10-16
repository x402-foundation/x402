import { Address } from "@evolution-sdk/evolution";
import {
  assertCip30ProtocolParametersInBounds,
  CARDANO_NETWORK_ID_MAINNET,
  CIP30_MIN_WINDOW_SECONDS,
  type Cip30ProtocolParameters,
  getCardanoNetworkId,
  LOVELACE_ASSET,
} from "@x402/cardano";
import type { PaymentRequired } from "@x402/core/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AnchoredClock } from "./clock";
import { ColdStart } from "./components/ColdStart";
import { PayActions } from "./components/PayActions";
import { Blocked, Settled, Unresolved } from "./components/RecoveryViews";
import { Shell, type ShellProps } from "./components/Shell";
import { ViewNotice } from "./components/ViewNotice";
import { WalletPicker } from "./components/WalletPicker";
import {
  cardanoFaucetUrl,
  cardanoNetworkName,
  decodeWalletBalance,
  describeAsset,
  estimateExtraLovelace,
  formatAmount,
  formatAmountParts,
  isCardanoTestnet,
  lacksFunds,
  roundUpToTenthAda,
  summarizeBalance,
  type WalletBalance,
} from "./format";
import { PARAMETERS_OUT_OF_BOUNDS_MESSAGE, signingErrorMessage } from "./messages";
import { toCip30ProtocolParameters } from "./params";
import type { CardanoPageConfig } from "./paywall";
import { type LockRunner, PaymentController, type PaymentView, type StorageLike } from "./payment";
import { createSignPayment } from "./signing";
import { type DiscoveredWallet, type FullCip30Api, waitForCip30Wallets } from "./wallets";

/** Where the current payment attempt is. */
type Step = "idle" | "signing" | "sending";

interface Props {
  config: CardanoPageConfig;
  paymentRequired: PaymentRequired;
  currentUrl: string;
  faucetUrls?: Record<string, string>;
  clock: AnchoredClock;
  storage: StorageLike;
  /** Web Locks runner; undefined makes the page refuse to sign. */
  lock?: LockRunner;
  onSuccessfulResponse: (response: Response) => Promise<void>;
}

/** Connected wallet. */
interface Connection {
  name: string;
  api: FullCip30Api;
  address: string;
  balance?: WalletBalance;
}

/**
 * Cardano paywall page: wallet picker, balance, pay, and the payment states of
 * the controller (resend, re-sign, unresolved, discard).
 *
 * @param props - Page configuration and injected dependencies.
 * @returns The paywall UI.
 */
export function CardanoPaywall(props: Props) {
  const { config, paymentRequired, currentUrl, clock, storage, lock, onSuccessfulResponse } = props;
  const requirement = config.selectedRequirement;
  const network = config.network;
  const networkName = cardanoNetworkName(network);
  const label = describeAsset(requirement.asset, network);
  const amount = BigInt(requirement.amount);
  const amountText = formatAmount(amount, label);
  const isToken = requirement.asset.toLowerCase() !== LOVELACE_ASSET;

  const [wallets, setWallets] = useState<DiscoveredWallet[] | null>(null);
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [showBalance, setShowBalance] = useState(false);
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string>("");
  const [ack, setAck] = useState(false);
  // The controller's sign callback outlives renders; it reads the wallet from here.
  const connectionRef = useRef<Connection | null>(null);
  useEffect(() => {
    connectionRef.current = connection;
  }, [connection]);

  const params = useMemo<Cip30ProtocolParameters | null | "invalid">(() => {
    if (!config.protocolParameters) return null;
    try {
      const p = toCip30ProtocolParameters(config.protocolParameters);
      assertCip30ProtocolParametersInBounds(p);
      return p;
    } catch {
      return "invalid";
    }
  }, [config.protocolParameters]);

  const controller = useMemo(
    () =>
      new PaymentController({
        resourceUrl: currentUrl,
        requirement,
        storage,
        clock,
        lock,
        send: async header => {
          setStep("sending");
          try {
            return await fetch(currentUrl, { headers: { "PAYMENT-SIGNATURE": header } });
          } catch {
            return undefined;
          }
        },
        sign: async pinnedNonce => {
          const current = connectionRef.current;
          if (!current) throw new Error("Connect a wallet before paying.");
          if (params === null) {
            throw new Error(
              "Cardano network parameters are not available yet, so this page cannot sign. Reload the page in a moment.",
            );
          }
          if (params === "invalid") throw new Error(PARAMETERS_OUT_OF_BOUNDS_MESSAGE);
          setStep("signing");
          return createSignPayment({
            api: current.api,
            network,
            protocolParameters: params,
            clock,
            paymentRequired,
            selectedRequirement: requirement,
          })(pinnedNonce);
        },
      }),
    [currentUrl, requirement, storage, clock, lock, network, params, paymentRequired],
  );

  // The stored payment state is known synchronously, so the first render
  // already shows it (e.g. a settled payment) instead of a signing screen.
  const [view, setView] = useState<PaymentView>(() => controller.view());
  useEffect(() => {
    setView(controller.view());
  }, [controller]);

  useEffect(() => {
    let cancelled = false;
    void waitForCip30Wallets(() => window.cardano).then(found => {
      if (cancelled) return;
      setWallets(found);
      if (found.length > 0) setSelectedKey(found[0].key);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const runPayment = useCallback(
    async (action: () => Promise<PaymentView>) => {
      const health = clock.health();
      if (health === "server_ahead") {
        setError(
          "This page's clock does not match your device. Check your device's date and time, then reload.",
        );
        return;
      }
      if (health !== "ok") {
        window.location.reload();
        return;
      }
      setError("");
      try {
        const next = await action();
        if (next.kind === "success") {
          // Forget the payment only once the content is on screen; if this
          // throws, the record stays "settled" and can never be re-signed.
          await onSuccessfulResponse(next.response);
          await controller.completeDelivery();
          return;
        }
        if (next.kind === "reload") {
          window.location.reload();
          return;
        }
        setView(next);
      } catch (err) {
        setError(signingErrorMessage(err, connectionRef.current?.name ?? "your wallet"));
        setView(controller.view());
      } finally {
        setStep("idle");
      }
    },
    [clock, controller, onSuccessfulResponse],
  );

  // settlement_pending: resend the identical header automatically.
  useEffect(() => {
    if (view.kind !== "ambiguous" || !view.autoRetry || step !== "idle") return;
    const delay = Math.max(0, view.retryAtMs - clock.now());
    const timer = setTimeout(() => void runPayment(() => controller.pay()), delay);
    return () => clearTimeout(timer);
  }, [view, step, clock, controller, runPayment]);

  // Unresolved: re-read the state when the lockout ends, so Check again,
  // Try again and Discard unlock without a reload.
  useEffect(() => {
    if (view.kind !== "unresolved" || view.unlocked) return;
    const delay = Math.max(0, view.unlockAtMs - clock.now()) + 500;
    const timer = setTimeout(() => setView(controller.view()), delay);
    return () => clearTimeout(timer);
  }, [view, clock, controller]);

  const connect = useCallback(async () => {
    const wallet = wallets?.find(w => w.key === selectedKey);
    if (!wallet) return;
    setError("");
    try {
      const api = await wallet.provider.enable();
      const networkId = await api.getNetworkId();
      if (networkId !== getCardanoNetworkId(network)) {
        const walletNetwork =
          networkId === CARDANO_NETWORK_ID_MAINNET ? "Cardano Mainnet" : "a Cardano testnet";
        setError(
          `${wallet.name} is on ${walletNetwork}, and this page charges on ${networkName}. Switch ${wallet.name} to ${networkName}, then connect again.`,
        );
        return;
      }
      const used = await api.getUsedAddresses();
      const unused = used.length > 0 ? [] : await api.getUnusedAddresses();
      const first = used[0] ?? unused[0];
      const address = first ? Address.toBech32(Address.fromHex(first)) : "";
      const balance = decodeWalletBalance(await api.getBalance());
      setConnection({ name: wallet.name, api, address, balance });
    } catch (err) {
      setError(signingErrorMessage(err, wallet.name));
    }
  }, [wallets, selectedKey, network, networkName]);

  const extraLovelace =
    params && params !== "invalid" ? estimateExtraLovelace(isToken, params) : undefined;
  const ada = describeAsset(LOVELACE_ASSET, network);
  const balanceText = summarizeBalance(connection?.balance, requirement.asset, label, ada);
  // Only gates a new signature: resending a sent payment must stay possible even
  // after the wallet's balance dropped because that payment landed.
  const willSign =
    view.kind === "ready" || view.kind === "rejected" || view.kind === "wrong_network";
  const insufficient =
    willSign && lacksFunds(connection?.balance, requirement.asset, amount, extraLovelace);

  const busy = step !== "idle";
  const shellProps: ShellProps = {
    description: paymentRequired.resource?.description,
    amountParts: formatAmountParts(amount, label),
    networkName,
    testnet: isCardanoTestnet(network),
    faucetUrl: cardanoFaucetUrl(network, props.faucetUrls),
  };

  // The prerequisites below gate only a NEW signature. A stored payment
  // (settled, ambiguous, unresolved, …) stays reachable so its identical header
  // can still be resent, even while network parameters are unavailable.
  if (willSign && requirement.maxTimeoutSeconds < CIP30_MIN_WINDOW_SECONDS) {
    // Refused before any wallet access: the signer would reject it anyway.
    return (
      <Shell {...shellProps}>
        <div className="cardano-notice error">
          {signingErrorMessage({ code: "payment_window_too_short" }, "your wallet")}
        </div>
      </Shell>
    );
  }
  if (willSign && params === null) {
    return <ColdStart {...shellProps} />;
  }
  if (willSign && params === "invalid") {
    return (
      <Shell {...shellProps}>
        <div className="cardano-notice error">{PARAMETERS_OUT_OF_BOUNDS_MESSAGE}</div>
      </Shell>
    );
  }

  const walletPicker = (
    <WalletPicker
      wallets={wallets}
      selectedKey={selectedKey}
      onSelect={setSelectedKey}
      onConnect={() => void connect()}
    />
  );

  return (
    <Shell {...shellProps}>
      {view.kind === "unresolved" ? (
        <Unresolved
          view={view}
          network={network}
          amountText={amountText}
          ack={ack}
          busy={busy}
          onAck={setAck}
          onCheckAgain={() => void runPayment(() => controller.checkAgain())}
          onTryAgain={() => void runPayment(() => controller.resign())}
          onDiscard={() => void runPayment(() => controller.discard(ack))}
          error={error}
          walletPicker={connection ? undefined : walletPicker}
        />
      ) : view.kind === "terminal" || view.kind === "paid_elsewhere" ? (
        <Blocked
          view={view}
          ack={ack}
          busy={busy}
          onAck={setAck}
          onDiscard={() => void runPayment(() => controller.discard(ack))}
        />
      ) : view.kind === "settled" ? (
        <Settled
          txId={view.txId}
          network={network}
          ack={ack}
          busy={busy}
          error={error}
          onAck={setAck}
          onLoad={() => void runPayment(() => controller.checkAgain())}
          onDiscard={() => void runPayment(() => controller.discard(ack))}
        />
      ) : (
        <>
          {connection && (
            <div className="payment-details">
              <div className="payment-row">
                <span className="payment-label">Wallet</span>
                <span className="payment-value cardano-mono">
                  {`${connection.address.slice(0, 12)}…${connection.address.slice(-4)} · ${connection.name}`}
                </span>
              </div>
              <div className="payment-row">
                <span className="payment-label">Available</span>
                <span className="payment-value">
                  <button className="balance-button" onClick={() => setShowBalance(v => !v)}>
                    {showBalance ? balanceText : "Show balance"}
                  </button>
                </span>
              </div>
            </div>
          )}

          {extraLovelace !== undefined && (
            <div className="cardano-notice warn">
              {isToken
                ? `Paying in ${label.symbol} also uses about ${formatAmount(roundUpToTenthAda(extraLovelace), ada)}: the network fee plus the minimum ADA that must travel with the token to the recipient.`
                : `Your wallet also pays a network fee of about ${formatAmount(roundUpToTenthAda(extraLovelace), ada)}.`}
            </div>
          )}

          <ViewNotice view={view} networkName={networkName} network={network} />
          {insufficient && (
            <div className="cardano-notice error">
              Not enough funds. This needs {amountText}
              {isToken ? ` plus about ${formatAmount(roundUpToTenthAda(extraLovelace!), ada)}` : ""}
              . {connection!.name} has {balanceText}.
            </div>
          )}
          {error && <div className="cardano-notice error">{error}</div>}

          {busy && (
            <ol className="cardano-steps" aria-label="Payment progress">
              <li className={step === "signing" ? "now" : "done"}>
                {step === "signing" ? `Approve in ${connection?.name ?? "your wallet"}…` : "Signed"}
              </li>
              <li className={step === "sending" ? "now" : ""}>Sending payment to the server</li>
              <li>Server settles on Cardano</li>
            </ol>
          )}

          <PayActions
            connected={connection !== null}
            view={view}
            busy={busy}
            insufficient={insufficient}
            amountText={amountText}
            onPay={() => void runPayment(() => controller.pay())}
            onDisconnect={() => setConnection(null)}
            walletPicker={walletPicker}
          />
          {busy && step === "signing" && (
            <p className="status">
              Your wallet only signs. The server submits the transaction after it verifies the
              payment.
            </p>
          )}
        </>
      )}
    </Shell>
  );
}
