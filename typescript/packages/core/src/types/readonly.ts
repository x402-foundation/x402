/**
 * Recursive readonly for hook contexts so accidental in-place mutation is visible at compile time.
 * (Runtime mutation is still possible via other references; see extension enrich validation.)
 */
export type DeepReadonly<T> = T extends (infer U)[]
  ? ReadonlyArray<DeepReadonly<U>>
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;
