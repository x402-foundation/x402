package types

// ResourceServerExtension is a resource-side extension. Implementations
// surface a stable `Key()` plus an enrichment callback used to expand the
// extension declaration on the route.
//
// Optional capabilities are exposed via the per-capability interfaces in
// `go/server_hooks.go` (e.g. `ResourceServerExtensionHookProvider`,
// `ResourceServerExtensionEnrichPaymentRequiredProvider`,
// `ResourceServerExtensionEnrichSettleResponseProvider`). The resource
// server type-asserts to those interfaces at registration time.
type ResourceServerExtension interface {
	Key() string
	EnrichDeclaration(declaration interface{}, transportContext interface{}) interface{}
}
