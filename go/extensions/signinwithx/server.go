package signinwithx

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/url"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	"github.com/x402-foundation/x402/go/v2/types"
)

// HookEvent describes SIWX server lifecycle events.
type HookEvent struct {
	Type     string
	Resource string
	Address  string
	Nonce    string
	Error    string
}

// ServerOptions configures the SIWX resource server extension.
type ServerOptions struct {
	Storage       Storage
	Origin        string
	VerifyOptions VerifyOptions
	OnEvent       func(HookEvent)
}

type ServerExtension struct {
	storage          Storage
	nonceStorage     NonceStorage
	configuredOrigin *url.URL
	verifyOptions    VerifyOptions
	onEvent          func(HookEvent)
}

// CreateResourceServerExtension creates a SIWX resource server extension.
func CreateResourceServerExtension(options ServerOptions) (*ServerExtension, error) {
	if options.Storage == nil {
		return nil, fmt.Errorf("SIWX storage is required")
	}
	configuredOrigin, err := normalizeConfiguredOrigin(options.Origin)
	if err != nil {
		return nil, err
	}
	return &ServerExtension{
		storage:          options.Storage,
		nonceStorage:     asNonceStorage(options.Storage),
		configuredOrigin: configuredOrigin,
		verifyOptions:    options.VerifyOptions,
		onEvent:          options.OnEvent,
	}, nil
}

// MustCreateResourceServerExtension creates a SIWX resource server extension and panics on invalid options.
func MustCreateResourceServerExtension(options ServerOptions) *ServerExtension {
	ext, err := CreateResourceServerExtension(options)
	if err != nil {
		panic(err)
	}
	return ext
}

func (e *ServerExtension) Key() string {
	return ExtensionKey
}

func (e *ServerExtension) DynamicInfoFields() []string {
	return []string{"nonce", "issuedAt", "expirationTime"}
}

func rebaseResourcePath(resourceURL string, configuredOrigin *url.URL) (string, error) {
	resource, err := url.Parse(resourceURL)
	if err != nil {
		return "", err
	}
	rebased := &url.URL{
		Scheme:   configuredOrigin.Scheme,
		Host:     configuredOrigin.Host,
		Path:     resource.Path,
		RawQuery: resource.RawQuery,
	}
	return rebased.String(), nil
}

func (e *ServerExtension) EnrichDeclaration(declaration interface{}, transportContext interface{}) interface{} {
	ext, ok := declaration.(Extension)
	if !ok {
		return declaration
	}

	info := ext.Info
	options := ext.Options
	if info.Version == "" {
		info.Version = Version
	}

	resourceURI := ""
	if reqCtx, ok := transportContext.(x402http.HTTPRequestContext); ok && reqCtx.Adapter != nil {
		requestURL := reqCtx.Adapter.GetURL()
		if requestURL != "" {
			if rebased, err := rebaseResourcePath(requestURL, e.configuredOrigin); err == nil {
				resourceURI = rebased
			}
		}
	}

	info.Domain = e.configuredOrigin.Host
	info.URI = resourceURI
	info.Nonce = randomNonce()
	info.IssuedAt = time.Now().UTC().Format(time.RFC3339)
	if resourceURI != "" {
		info.Resources = []string{resourceURI}
	}
	if options.ExpirationSeconds > 0 {
		info.ExpirationTime = time.Now().UTC().Add(time.Duration(options.ExpirationSeconds) * time.Second).Format(time.RFC3339)
	}

	supportedChains := ext.SupportedChains
	if len(options.Networks) == 0 {
		if reqCtx, ok := transportContext.(x402http.HTTPRequestContext); ok {
			supportedChains = supportedChainsFromRequirements(reqCtx.Requirements)
		}
	}

	ext.Info = info
	ext.SupportedChains = supportedChains
	if ext.Schema == nil {
		ext.Schema = Schema()
	}
	return ext
}

func supportedChainsFromRequirements(requirements []types.PaymentRequirements) []SupportedChain {
	if len(requirements) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(requirements))
	chains := make([]SupportedChain, 0, len(requirements))
	for _, requirement := range requirements {
		if requirement.Network == "" {
			continue
		}
		if _, ok := seen[requirement.Network]; ok {
			continue
		}
		seen[requirement.Network] = struct{}{}
		chains = append(chains, SupportedChain{
			ChainID: requirement.Network,
			Type:    SignatureTypeForNetwork(requirement.Network),
		})
	}
	return chains
}

func (e *ServerExtension) ResourceServerExtensionHooks() x402.ResourceServerExtensionHooks {
	return x402.ResourceServerExtensionHooks{
		OnAfterSettle: e.onAfterSettle,
	}
}

func (e *ServerExtension) ProtectedRequestHook() x402http.ProtectedRequestHook {
	return e.onProtectedRequest
}

func (e *ServerExtension) onAfterSettle(ctx x402.SettleResultContext) error {
	if ctx.Result == nil || !ctx.Result.Success || ctx.Result.Payer == "" {
		return nil
	}

	resource, ok := resourcePathFromPayload(ctx.Payload)
	if !ok {
		resource, ok = resourcePathFromPayloadBytes(ctx.PayloadBytes)
	}
	if !ok {
		return nil
	}

	if err := e.storage.RecordPayment(ctx.Ctx, resource, ctx.Result.Payer); err != nil {
		return err
	}
	e.emit(HookEvent{Type: "payment_recorded", Resource: resource, Address: ctx.Result.Payer})
	return nil
}

func (e *ServerExtension) onProtectedRequest(
	ctx context.Context,
	reqCtx x402http.HTTPRequestContext,
	routeConfig x402http.RouteConfig,
) (*x402http.ProtectedRequestHookResult, error) {
	if reqCtx.Adapter == nil {
		return nil, nil
	}

	header := reqCtx.Adapter.GetHeader(HeaderName)
	if header == "" {
		header = reqCtx.Adapter.GetHeader("sign-in-with-x")
	}
	if header == "" {
		return nil, nil
	}

	payload, err := ParseHeader(header)
	if err != nil {
		e.emit(HookEvent{Type: "validation_failed", Resource: reqCtx.Path, Error: err.Error()})
		return noProtectedRequestResult()
	}

	validation := ValidateMessage(payload, e.configuredOrigin, ValidationOptions{})
	if !validation.IsValid {
		e.emit(HookEvent{Type: "validation_failed", Resource: reqCtx.Path, Error: validation.InvalidMessage})
		return nil, nil
	}

	verification := VerifySignatureWithOptions(ctx, payload, e.verifyOptions)
	if !verification.IsValid || verification.Payer == "" {
		e.emit(HookEvent{Type: "validation_failed", Resource: reqCtx.Path, Error: verification.InvalidMessage})
		return nil, nil
	}

	if e.nonceStorage != nil {
		used, err := e.nonceStorage.HasUsedNonce(ctx, payload.Nonce)
		if err != nil {
			return nil, err
		}
		if used {
			e.emit(HookEvent{Type: "nonce_reused", Resource: reqCtx.Path, Nonce: payload.Nonce})
			return nil, nil
		}
	}

	grant := len(routeConfig.Accepts) == 0
	if !grant {
		var err error
		grant, err = e.storage.HasPaid(ctx, reqCtx.Path, verification.Payer)
		if err != nil {
			return nil, err
		}
	}
	if !grant {
		return nil, nil
	}

	if e.nonceStorage != nil {
		if err := e.nonceStorage.RecordNonce(ctx, payload.Nonce); err != nil {
			return nil, err
		}
	}
	e.emit(HookEvent{Type: "access_granted", Resource: reqCtx.Path, Address: verification.Payer})
	return &x402http.ProtectedRequestHookResult{GrantAccess: true}, nil
}

func noProtectedRequestResult() (*x402http.ProtectedRequestHookResult, error) {
	return nil, nil
}

func (e *ServerExtension) emit(event HookEvent) {
	if e.onEvent != nil {
		e.onEvent(event)
	}
}

func asNonceStorage(storage Storage) NonceStorage {
	nonceStorage, ok := storage.(NonceStorage)
	if !ok {
		return nil
	}
	return nonceStorage
}

func randomNonce() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}

func resourcePathFromPayload(payload x402.PaymentPayloadView) (string, bool) {
	switch p := payload.(type) {
	case types.PaymentPayload:
		return resourcePath(p.Resource)
	case *types.PaymentPayload:
		if p == nil {
			return "", false
		}
		return resourcePath(p.Resource)
	default:
		return "", false
	}
}

func resourcePathFromPayloadBytes(payloadBytes []byte) (string, bool) {
	if len(payloadBytes) == 0 {
		return "", false
	}
	payload, err := types.ToPaymentPayload(payloadBytes)
	if err != nil {
		return "", false
	}
	return resourcePath(payload.Resource)
}

func resourcePath(resource *types.ResourceInfo) (string, bool) {
	if resource == nil || resource.URL == "" {
		return "", false
	}
	parsed, err := url.Parse(resource.URL)
	if err != nil || parsed.Path == "" {
		return "", false
	}
	return parsed.Path, true
}
