import { useState, useEffect } from "react";

/**
 * A custom hook that tracks whether a given media query matches the current viewport.
 * This hook handles both client-side and server-side rendering scenarios.
 *
 * @param {string} query - The media query string to match against (e.g. '(min-width: 768px)')
 * @returns {boolean} Returns true if the media query matches, false otherwise
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const mediaQuery = window.matchMedia(query);
    setMatches(mediaQuery.matches);

    const listener = (e: MediaQueryListEvent) => setMatches(e.matches);
    mediaQuery.addEventListener("change", listener);

    return () => mediaQuery.removeEventListener("change", listener);
  }, [query]);

  // Return false during SSR, actual value after mount
  if (!mounted) return false;

  return matches;
}
