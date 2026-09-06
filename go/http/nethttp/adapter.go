package nethttp

import (
	"fmt"
	"net/http"
)

// NetHTTPAdapter implements HTTPAdapter for the standard net/http library.
type NetHTTPAdapter struct {
	r *http.Request
}

// NewNetHTTPAdapter creates a new adapter wrapping the given HTTP request.
func NewNetHTTPAdapter(r *http.Request) *NetHTTPAdapter {
	return &NetHTTPAdapter{r: r}
}

// GetHeader gets a request header by name.
func (a *NetHTTPAdapter) GetHeader(name string) string {
	return a.r.Header.Get(name)
}

// GetMethod gets the HTTP method.
func (a *NetHTTPAdapter) GetMethod() string {
	return a.r.Method
}

// GetPath gets the request path.
func (a *NetHTTPAdapter) GetPath() string {
	return a.r.URL.Path
}

// GetURL gets the full request URL.
func (a *NetHTTPAdapter) GetURL() string {
	scheme := "http"
	if a.r.TLS != nil {
		scheme = "https"
	}
	host := a.r.Host
	if host == "" {
		host = a.r.Header.Get("Host")
	}
	return fmt.Sprintf("%s://%s%s", scheme, host, a.r.URL.RequestURI())
}

// GetAcceptHeader gets the Accept header.
func (a *NetHTTPAdapter) GetAcceptHeader() string {
	return a.r.Header.Get("Accept")
}

// GetUserAgent gets the User-Agent header.
func (a *NetHTTPAdapter) GetUserAgent() string {
	return a.r.UserAgent()
}
