/**
 * Copyright 2026 PayPal Holdings, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Local ambient declaration for the `canonicalize` npm package (RFC 8785
 * JCS reference implementation, MIT). Provides the type the package
 * itself ships in some versions but not others; harmless when the real
 * types are present.
 */
declare module "canonicalize" {
  function canonicalize(value: unknown): string | undefined;
  export default canonicalize;
}
