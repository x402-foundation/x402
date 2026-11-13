import { explorerTxUrl, shortId } from "../format";
import { BUY_AGAIN_ACK, SETTLEMENT_UNAVAILABLE_MESSAGE, terminalMessage } from "../messages";
import type { PaymentView } from "../payment";
import { Spinner } from "../Spinner";

/**
 * States where the page will not pay on its own: terminal conditions, and a
 * payment another tab already delivered. Where a way out exists it needs an
 * explicit acknowledgement.
 *
 * @param props - View and handlers.
 * @param props.view - Terminal or paid-elsewhere view.
 * @param props.ack - Whether the double-pay warning is acknowledged.
 * @param props.busy - Whether an action is running.
 * @param props.onAck - Acknowledge handler.
 * @param props.onDiscard - Reset / buy-again handler.
 * @returns The blocked UI.
 */
export function Blocked(props: {
  view: Extract<PaymentView, { kind: "terminal" } | { kind: "paid_elsewhere" }>;
  ack: boolean;
  busy: boolean;
  onAck: (value: boolean) => void;
  onDiscard: () => void;
}) {
  const { view } = props;
  const paidElsewhere = view.kind === "paid_elsewhere";
  const recoverable =
    paidElsewhere ||
    view.reason === "record_unreadable" ||
    view.reason === "merchant_misconfigured";
  return (
    <>
      {paidElsewhere ? (
        <div className="cardano-notice warn">
          <b>Already paid in another tab.</b> This content was paid for and opened in another tab
          after this page loaded. Reload to continue without paying again.
        </div>
      ) : (
        <div className="cardano-notice error">
          {view.possiblyPaid
            ? `${SETTLEMENT_UNAVAILABLE_MESSAGE} An earlier attempt of this payment may already be on chain${view.txId ? ` (transaction ${shortId(view.txId)})` : ""}. Check your wallet's history before resetting: if it landed, paying again charges you twice.`
            : terminalMessage(view.reason)}
        </div>
      )}
      {recoverable && (
        <div className="cardano-cta">
          {paidElsewhere && (
            <button className="button button-primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          )}
          <label className="cardano-ack">
            <input
              type="checkbox"
              checked={props.ack}
              onChange={e => props.onAck(e.target.checked)}
            />
            <span>
              {paidElsewhere
                ? BUY_AGAIN_ACK
                : "I have checked my wallet history and understand that if an earlier payment landed, paying again charges me twice."}
            </span>
          </label>
          <button
            className="button button-secondary"
            disabled={props.busy || !props.ack}
            onClick={props.onDiscard}
          >
            {paidElsewhere ? "Buy again" : "Reset and pay again"}
          </button>
        </div>
      )}
    </>
  );
}

/**
 * A payment the server confirmed whose content did not load: offers to load
 * it again (resending the same payment) or to start a new purchase.
 *
 * @param props - Settled state and handlers.
 * @param props.txId - Settled transaction id.
 * @param props.network - Canonical network id.
 * @param props.ack - Whether "pay again" is acknowledged.
 * @param props.busy - Whether an action is running.
 * @param props.error - Error from the last action.
 * @param props.onAck - Acknowledge handler.
 * @param props.onLoad - Resend handler.
 * @param props.onDiscard - New-purchase handler.
 * @returns The settled UI.
 */
export function Settled(props: {
  txId?: string;
  network: string;
  ack: boolean;
  busy: boolean;
  error?: string;
  onAck: (value: boolean) => void;
  onLoad: () => void;
  onDiscard: () => void;
}) {
  const link = props.txId ? explorerTxUrl(props.network, props.txId) : undefined;
  return (
    <>
      <div className="cardano-notice warn">
        <b>Payment confirmed.</b> The server accepted your payment, but the content did not load.
        Loading it again does not charge you.
        {link && (
          <>
            {" "}
            <a href={link} target="_blank" rel="noopener noreferrer">
              View transaction
            </a>
          </>
        )}
      </div>
      {props.error && <div className="cardano-notice error">{props.error}</div>}
      <div className="cardano-cta">
        <button className="button button-primary" disabled={props.busy} onClick={props.onLoad}>
          {props.busy ? <Spinner /> : "Load content"}
        </button>
        <label className="cardano-ack">
          <input
            type="checkbox"
            checked={props.ack}
            onChange={e => props.onAck(e.target.checked)}
          />
          <span>{BUY_AGAIN_ACK}</span>
        </label>
        <button
          className="button button-secondary"
          disabled={props.busy || !props.ack}
          onClick={props.onDiscard}
        >
          Start a new payment
        </button>
      </div>
    </>
  );
}

/**
 * Payment-status-unknown state with check, retry and discard.
 *
 * @param props - View and handlers.
 * @param props.view - The unresolved view.
 * @param props.network - Canonical network id.
 * @param props.amountText - Formatted amount.
 * @param props.ack - Whether the double-pay warning is acknowledged.
 * @param props.busy - Whether an action is running.
 * @param props.onAck - Acknowledge handler.
 * @param props.onCheckAgain - Resend handler.
 * @param props.onTryAgain - Re-sign handler.
 * @param props.onDiscard - Discard handler.
 * @param props.error - Error from the last action.
 * @param props.walletPicker - Picker shown when no wallet is connected.
 * @returns The unresolved UI.
 */
export function Unresolved(props: {
  view: Extract<PaymentView, { kind: "unresolved" }>;
  network: string;
  amountText: string;
  ack: boolean;
  busy: boolean;
  onAck: (value: boolean) => void;
  onCheckAgain: () => void;
  onTryAgain: () => void;
  onDiscard: () => void;
  error?: string;
  walletPicker?: React.ReactNode;
}) {
  const { view } = props;
  const link = view.txId ? explorerTxUrl(props.network, view.txId) : undefined;
  return (
    <>
      <div className="cardano-notice warn">
        <b>Payment status unknown.</b> Your payment of {props.amountText} may already be on chain,
        so this page will not ask you to sign with other funds
        {view.unlocked ? "" : ` before ${new Date(view.unlockAtMs).toLocaleTimeString()}`}.
      </div>
      <div className="payment-details">
        {view.txId && (
          <div className="payment-row">
            <span className="payment-label">Transaction</span>
            <span className="payment-value cardano-mono" title={view.txId}>
              {link ? (
                <a href={link} target="_blank" rel="noopener noreferrer">
                  {shortId(view.txId)}
                </a>
              ) : (
                shortId(view.txId)
              )}
            </span>
          </div>
        )}
      </div>
      {props.error && <div className="cardano-notice error">{props.error}</div>}
      <div className="cardano-cta">
        {view.canCheckAgain && (
          <button
            className="button button-primary"
            disabled={props.busy || !view.unlocked}
            onClick={props.onCheckAgain}
          >
            Check again
          </button>
        )}
        {view.unlocked && (
          <>
            {props.walletPicker ?? (
              <button
                className="button button-secondary"
                disabled={props.busy}
                onClick={props.onTryAgain}
              >
                Try again with the same funds
              </button>
            )}
            <label className="cardano-ack">
              <input
                type="checkbox"
                checked={props.ack}
                onChange={e => props.onAck(e.target.checked)}
              />
              <span>
                I understand that if this transaction is on chain and I pay again, I pay twice.
              </span>
            </label>
            <button
              className="button button-secondary"
              disabled={props.busy || !props.ack}
              onClick={props.onDiscard}
            >
              Discard and pay again
            </button>
          </>
        )}
      </div>
      <p className="status">
        If the transaction appears on the explorer, click Check again to collect your content.
      </p>
    </>
  );
}
