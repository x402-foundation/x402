import horizontalWhiteSvg from "../assets/cardano-horizontal-white.svg";

/**
 * Turns SVG markup into an `<img>`-safe data URI (no inline SVG, no scripts).
 *
 * @param svg - SVG markup.
 * @returns Data URI.
 */
function svgDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const LOGO_WHITE = svgDataUri(horizontalWhiteSvg);

/** Props shared by every frame of the page. */
export interface ShellProps {
  description?: string;
  amountParts: { value: string; unit: string };
  networkName: string;
  testnet: boolean;
  faucetUrl?: string;
}

/**
 * Page frame shared by every state: official Cardano header with the amount,
 * the body, and a footer.
 *
 * @param props - Frame content.
 * @param props.description - Resource description.
 * @param props.amountParts - Amount number and unit, e.g. "1.50" and "USDM".
 * @param props.networkName - Network display name.
 * @param props.testnet - Whether the network is a testnet.
 * @param props.faucetUrl - Testnet faucet link.
 * @param props.children - Body.
 * @returns The frame.
 */
export function Shell(props: ShellProps & { children: React.ReactNode }) {
  const { value, unit } = props.amountParts;
  return (
    <div className="cdn">
      <main className="cdn-card" aria-labelledby="cdn-title">
        <header className="cdn-hero">
          <div className="cdn-hero-top">
            <img className="cdn-logo" src={LOGO_WHITE} alt="Cardano" />
            <span className={`cdn-pill ${props.testnet ? "testnet" : "mainnet"}`}>
              {props.networkName.replace(/^Cardano /, "")}
            </span>
          </div>
          <h1 className="cdn-eyebrow" id="cdn-title">
            Payment required
          </h1>
          <p className="cdn-amount">
            {value}
            {unit && <span>{unit}</span>}
          </p>
          {props.description && <p className="cdn-desc">{props.description}</p>}
        </header>
        <div className="cdn-body">{props.children}</div>
        <footer className="cdn-foot">
          <span>Paid on {props.networkName} with x402</span>
          {props.faucetUrl && (
            <a href={props.faucetUrl} target="_blank" rel="noopener noreferrer">
              Get test ADA
            </a>
          )}
        </footer>
      </main>
    </div>
  );
}
