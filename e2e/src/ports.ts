// Ports blocked by the Fetch spec; Node.js fetch (undici) refuses to connect to them.
// See https://fetch.spec.whatwg.org/#block-bad-port
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679,
  6697, 10080,
]);

/** Returns successive ports, skipping those blocked by Node.js fetch. */
export function createPortAllocator(startPort = 4022): () => number {
  let next = startPort;
  return () => {
    while (FETCH_BLOCKED_PORTS.has(next)) {
      next++;
    }
    return next++;
  };
}
