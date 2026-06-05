package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/x402-foundation/x402/go/v2/extensions/signinwithx"
	x402http "github.com/x402-foundation/x402/go/v2/http"
)

type netHTTPAdapter struct {
	request *http.Request
}

func (a netHTTPAdapter) GetHeader(name string) string {
	return a.request.Header.Get(name)
}

func (a netHTTPAdapter) GetMethod() string {
	return a.request.Method
}

func (a netHTTPAdapter) GetPath() string {
	return a.request.URL.Path
}

func (a netHTTPAdapter) GetURL() string {
	scheme := "http"
	if a.request.TLS != nil {
		scheme = "https"
	}
	return fmt.Sprintf("%s://%s%s", scheme, a.request.Host, a.request.URL.Path)
}

func (a netHTTPAdapter) GetAcceptHeader() string {
	return a.request.Header.Get("Accept")
}

func (a netHTTPAdapter) GetUserAgent() string {
	return a.request.UserAgent()
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "4021"
	}

	storage := signinwithx.NewInMemoryStorage()
	extension := signinwithx.MustCreateResourceServerExtension(signinwithx.ServerOptions{
		Storage: storage,
		OnEvent: func(event signinwithx.HookEvent) {
			log.Printf("siwx event=%s resource=%s address=%s error=%s", event.Type, event.Resource, event.Address, event.Error)
		},
	})

	server := x402http.Newx402HTTPResourceServer(x402http.RoutesConfig{
		"GET /profile": {
			Accepts: x402http.PaymentOptions{},
			Extensions: map[string]interface{}{
				signinwithx.ExtensionKey: signinwithx.DeclareExtension(signinwithx.DeclareOptions{
					Statement:         "Sign in to access your profile",
					Networks:          []string{"eip155:8453"},
					ExpirationSeconds: 300,
				})[signinwithx.ExtensionKey],
			},
		},
	})
	server.RegisterExtension(extension)

	http.HandleFunc("/profile", func(w http.ResponseWriter, r *http.Request) {
		result := server.ProcessHTTPRequest(r.Context(), x402http.HTTPRequestContext{
			Adapter: netHTTPAdapter{request: r},
			Path:    r.URL.Path,
			Method:  r.Method,
		}, nil)
		if result.Type == x402http.ResultPaymentError {
			writePaymentError(w, result.Response)
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"authenticated": true,
			"profile": map[string]string{
				"name": "SIWX demo user",
			},
		})
	})

	http.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	log.Printf("sign-in-with-x server listening on http://localhost:%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

func writePaymentError(w http.ResponseWriter, response *x402http.HTTPResponseInstructions) {
	for key, value := range response.Headers {
		w.Header().Set(key, value)
	}
	if response.IsHTML {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(response.Status)
		_, _ = w.Write([]byte(response.Body.(string)))
		return
	}
	writeJSON(w, response.Status, response.Body)
}

func writeJSON(w http.ResponseWriter, status int, body interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
