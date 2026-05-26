import { useCallback, useState, useEffect } from "react";
import { generateOnrampSessionToken } from "./utils";

type UseOnrampSessionTokenProps = {
  sessionToken: string | undefined;
};

const TOKEN_EXPIRY_TIME = 5 * 60 * 1000;

/**
 * Custom hook to manage onramp session token state and lifecycle
 *
 * @param address - The user's wallet address
 * @returns Object containing session token state
 */
export function useOnrampSessionToken(address: string | undefined): UseOnrampSessionTokenProps {
  const [sessionToken, setSessionToken] = useState<string | undefined>();
  const [tokenTimestamp, setTokenTimestamp] = useState<number | null>(null);

  const isTokenExpired = useCallback(() => {
    if (!tokenTimestamp) return true;
    return Date.now() - tokenTimestamp > TOKEN_EXPIRY_TIME;
  }, [tokenTimestamp]);

  const generateToken = useCallback(async () => {
    if (!address) {
      return;
    }

    // Token expires after 5 minutes, but once authorized it can be used
    // indefinitely with the same sessionId
    if (!sessionToken || isTokenExpired()) {
      const token = await generateOnrampSessionToken(address);
      setSessionToken(token);
      setTokenTimestamp(Date.now());
    }
  }, [address, sessionToken, isTokenExpired]);

  // Generate token when address changes or component mounts
  useEffect(() => {
    if (address) {
      generateToken();
    } else {
      setSessionToken(undefined);
      setTokenTimestamp(null);
    }
  }, [address, generateToken]);

  return {
    sessionToken,
  };
}
