package signinwithx

import (
	"testing"
)

func TestNormalizeConfiguredOriginCanonicalizesHost(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"https://api.example.com", "https://api.example.com"},
		{"https://api.example.com:443", "https://api.example.com"},
		{"https://API.Example.com", "https://api.example.com"},
		{"http://api.example.com:80", "http://api.example.com"},
		{"https://api.example.com:8443", "https://api.example.com:8443"},
		{"http://[2001:DB8::1]:443", "http://[2001:db8::1]:443"},
		{"https://[2001:DB8::1]:443", "https://[2001:db8::1]"},
	}

	for _, c := range cases {
		parsed, err := normalizeConfiguredOrigin(c.in)
		if err != nil {
			t.Fatalf("normalizeConfiguredOrigin(%q) returned error: %v", c.in, err)
		}
		if got := urlOrigin(parsed); got != c.want {
			t.Errorf("normalizeConfiguredOrigin(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestNormalizeConfiguredOriginRejects(t *testing.T) {
	cases := []string{
		"",
		"api.example.com",
		"ftp://api.example.com",
		"https://user:pass@api.example.com",
		"https://api.example.com/path",
		"https://api.example.com?x=1",
		"https://api.example.com#frag",
	}

	for _, c := range cases {
		if _, err := normalizeConfiguredOrigin(c); err == nil {
			t.Errorf("normalizeConfiguredOrigin(%q) returned nil error, want failure", c)
		}
	}
}
