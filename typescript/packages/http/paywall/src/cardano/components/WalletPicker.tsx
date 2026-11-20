import type { DiscoveredWallet } from "../wallets";

/**
 * Wallet picker grid.
 *
 * @param props - Wallet list and handlers.
 * @param props.wallets - Discovered wallets (null while searching).
 * @param props.selectedKey - Selected wallet key.
 * @param props.onSelect - Select handler.
 * @param props.onConnect - Connect handler.
 * @returns The picker.
 */
export function WalletPicker(props: {
  wallets: DiscoveredWallet[] | null;
  selectedKey: string;
  onSelect: (key: string) => void;
  onConnect: () => void;
}) {
  const { wallets, selectedKey } = props;
  if (wallets === null) return <p className="status">Looking for Cardano wallets…</p>;
  if (wallets.length === 0) {
    return (
      <>
        <p className="status">
          No Cardano wallet found in this browser. Install a CIP-30 wallet such as Lace or Eternl,
          then reload this page.
        </p>
        <button className="button button-secondary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </>
    );
  }
  const selected = wallets.find(w => w.key === selectedKey);
  return (
    <>
      <div className="cardano-wallets" aria-label="Detected Cardano wallets">
        {wallets.map(wallet => (
          <button
            key={wallet.key}
            type="button"
            className="cardano-wallet"
            aria-pressed={wallet.key === selectedKey}
            onClick={() => props.onSelect(wallet.key)}
          >
            {wallet.icon && <img src={wallet.icon} alt="" />}
            <span>{wallet.name}</span>
          </button>
        ))}
      </div>
      <button className="button button-primary" disabled={!selected} onClick={props.onConnect}>
        {selected ? `Connect ${selected.name}` : "Connect wallet"}
      </button>
    </>
  );
}
