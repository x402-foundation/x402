The SIWX `supportedChains` list now keeps the order of the payment requirements, as the TypeScript and Go servers do. Previously it was built from a set, so its order could change between processes.
