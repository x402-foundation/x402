import type { PaymentView } from "../payment";
import { Spinner } from "../Spinner";

/**
 * Label for the main button.
 *
 * @param view - Current view.
 * @param amountText - Formatted amount.
 * @returns Button text.
 */
function payLabel(view: PaymentView, amountText: string): string {
  switch (view.kind) {
    case "ambiguous":
    case "retry":
      return "Check payment status";
    case "rejected":
    case "wrong_network":
      return "Try again";
    default:
      return `Pay ${amountText}`;
  }
}

/**
 * Main actions: pay / try again / check status, wallet connection. A stored
 * payment can be re-checked without a wallet (resending needs no signature).
 *
 * @param props - State and handlers.
 * @param props.connected - Whether a wallet is connected.
 * @param props.view - Current controller view.
 * @param props.busy - Whether an action is running.
 * @param props.insufficient - Whether the wallet visibly lacks funds.
 * @param props.amountText - Formatted amount.
 * @param props.onPay - Pay / resend handler.
 * @param props.onDisconnect - Disconnect handler.
 * @param props.walletPicker - Wallet picker shown while disconnected.
 * @returns The action buttons.
 */
export function PayActions(props: {
  connected: boolean;
  view: PaymentView;
  busy: boolean;
  insufficient: boolean;
  amountText: string;
  onPay: () => void;
  onDisconnect: () => void;
  walletPicker: React.ReactNode;
}) {
  const { view, busy } = props;
  if (!props.connected) {
    const storedPayment = view.kind === "ambiguous" || view.kind === "retry";
    return (
      <div className="cardano-cta">
        {storedPayment && (
          <button className="button button-primary" disabled={busy} onClick={props.onPay}>
            {busy ? <Spinner /> : "Check payment status"}
          </button>
        )}
        {props.walletPicker}
      </div>
    );
  }
  return (
    <div className="cardano-cta">
      <button
        className="button button-primary"
        disabled={busy || props.insufficient}
        onClick={props.onPay}
      >
        {busy ? <Spinner /> : payLabel(view, props.amountText)}
      </button>
      <button className="button button-secondary" disabled={busy} onClick={props.onDisconnect}>
        Disconnect
      </button>
    </div>
  );
}
