import { explorerTxUrl } from "../format";
import { rejectionMessage, walletNetworkHint } from "../messages";
import type { PaymentView } from "../payment";

/**
 * Notice for the controller's non-terminal views.
 *
 * @param props - View and network names.
 * @param props.view - Current view.
 * @param props.networkName - Display name of the network.
 * @param props.network - Canonical network id.
 * @returns Notice or nothing.
 */
export function ViewNotice({
  view,
  networkName,
  network,
}: {
  view: PaymentView;
  networkName: string;
  network: string;
}) {
  switch (view.kind) {
    case "rejected":
      return (
        <div className="cardano-notice error">{rejectionMessage(view.reason, networkName)}</div>
      );
    case "wrong_network":
      return (
        <div className="cardano-notice error">
          <b>Wrong network?</b> The server could not find the funds being spent.{" "}
          {walletNetworkHint(networkName)}, then click Try again. Try again re-signs with the same
          funds, so it cannot charge you twice.
        </div>
      );
    case "retry":
      return (
        <div className="cardano-notice warn">
          The server could not check the chain just now. Check the payment status again in a moment.
        </div>
      );
    case "ambiguous": {
      const link = view.txId ? explorerTxUrl(network, view.txId) : undefined;
      return (
        <div className="cardano-notice warn">
          {view.autoRetry
            ? "Your payment was submitted and is waiting for confirmation. This page checks again automatically."
            : "Your payment was sent, but the server's answer was unclear. Check the payment status; this resends the same payment and cannot charge you twice."}
          {link && (
            <>
              {" "}
              <a href={link} target="_blank" rel="noopener noreferrer">
                View transaction
              </a>
            </>
          )}
        </div>
      );
    }
    default:
      return null;
  }
}
