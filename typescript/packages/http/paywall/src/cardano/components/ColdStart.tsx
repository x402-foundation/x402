import { useEffect, useState } from "react";

import { Spinner } from "../Spinner";
import { Shell, type ShellProps } from "./Shell";

/** sessionStorage key counting reloads while the server's parameter cache is cold. */
export const COLD_RELOAD_STORAGE_KEY = "x402.cardano.v1.coldReloads";
/** Reloads attempted before the page gives up. */
const COLD_RELOAD_LIMIT = 3;
/** Delay before each reload. */
const COLD_RELOAD_DELAY_MS = 1500;

/**
 * Shown while the server's parameter cache is cold: reloads a few times, then
 * gives up.
 *
 * @param props - Frame props.
 * @returns The cold-start UI.
 */
export function ColdStart(props: ShellProps) {
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    let count = 0;
    try {
      count = Number(sessionStorage.getItem(COLD_RELOAD_STORAGE_KEY) ?? "0");
    } catch {
      count = COLD_RELOAD_LIMIT;
    }
    if (count >= COLD_RELOAD_LIMIT) {
      setGaveUp(true);
      return;
    }
    const timer = setTimeout(() => {
      try {
        sessionStorage.setItem(COLD_RELOAD_STORAGE_KEY, String(count + 1));
      } catch {
        // Without storage the counter cannot advance; the next load gives up.
      }
      window.location.reload();
    }, COLD_RELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <Shell {...props}>
      {gaveUp ? (
        <div className="cardano-notice error">
          Cardano network parameters are unavailable right now, so this page cannot prepare a
          payment. Try again in a few minutes.
        </div>
      ) : (
        <div className="cdn-preparing">
          <Spinner />
          Preparing payment…
        </div>
      )}
    </Shell>
  );
}
