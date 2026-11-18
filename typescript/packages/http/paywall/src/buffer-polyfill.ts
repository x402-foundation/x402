// Inject Buffer polyfill
// Necessary for viem if it's not provided elsewhere, e.g. from a wallet extension

import { Buffer } from "buffer";

globalThis.Buffer = Buffer;
