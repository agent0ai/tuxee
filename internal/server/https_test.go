package server

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"tuxee/internal/tlsmanager"
)

func TestHTTPSPortRedirect(t *testing.T) {
	manager, err := tlsmanager.New(tlsmanager.Options{Directory: t.TempDir(), Hosts: []string{"127.0.0.1"}})
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var requests atomic.Int32
	s := &http.Server{TLSConfig: manager.TLSConfig(), ReadHeaderTimeout: time.Second, MaxHeaderBytes: 4096,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requests.Add(1)
			if r.TLS == nil {
				http.Error(w, "plaintext reached app", http.StatusInternalServerError)
				return
			}
			w.Write([]byte("secure"))
		})}
	stopped := make(chan error, 1)
	go func() { stopped <- ServeHTTPS(s, listener) }()
	t.Cleanup(func() {
		s.Close()
		if err := <-stopped; err != http.ErrServerClosed {
			t.Errorf("server exit: %v", err)
		}
	})
	address := listener.Addr().String()
	// Idle clients cannot hold up either redirects or TLS handshakes.
	idle, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	defer idle.Close()
	raw := func(request string) *http.Response {
		t.Helper()
		conn, err := net.DialTimeout("tcp", address, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(2 * time.Second))
		if _, err = io.WriteString(conn, request); err != nil {
			t.Fatal(err)
		}
		response, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, response.Body)
		response.Body.Close()
		return response
	}
	for _, test := range []struct{ method, host, path string }{
		{"GET", address, "/folder/a%2Fb?q=a%26b&c=%20"},
		{"HEAD", "[::1]:9443", "/?"},
		{"GET", "example.test:443", "//other.test/a"},
		{"GET", "example.test:8443", "/"},
		{"GET", "example.test", "/"},
		{"POST", address, "/api/login"},
	} {
		request := fmt.Sprintf("%s %s HTTP/1.1\r\nHost: %s\r\nX-Forwarded-Host: other.test\r\nX-Forwarded-Proto: https\r\n", test.method, test.path, test.host)
		if test.method == "POST" {
			request += "Content-Length: 1000000\r\nExpect: 100-continue\r\n"
		}
		response := raw(request + "\r\n")
		if response.StatusCode != 308 || response.Header.Get("Location") != "https://"+test.host+test.path || !response.Close || len(response.Cookies()) != 0 {
			t.Fatalf("%s %s: %d %v", test.method, test.path, response.StatusCode, response.Header)
		}
	}
	for _, host := range []string{"", "user@other.test", `other.test\@example.test`} {
		response := raw("GET / HTTP/1.1\r\nHost: " + host + "\r\n\r\n")
		if response.StatusCode != 400 || response.Header.Get("Location") != "" {
			t.Fatalf("invalid host %q redirected: %v", host, response.Header)
		}
	}
	if response := raw("GET / HTTP/1.1\r\nHost: example.test\r\nX-Large: " + strings.Repeat("a", 20<<10) + "\r\n\r\n"); response.StatusCode != 400 {
		t.Fatalf("oversized headers: %d", response.StatusCode)
	}
	if requests.Load() != 0 {
		t.Fatal("plaintext reached the application")
	}
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(manager.RootCertificate())
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots}, ForceAttemptHTTP2: true}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 2 * time.Second}
	response, err := client.Get("http://" + address + "/?redirect=1")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || response.TLS == nil || response.ProtoMajor != 2 || string(body) != "secure" || requests.Load() != 1 {
		t.Fatalf("redirect follow / HTTP2: %v, %s, %s", err, response.Proto, body)
	}
	if err = manager.Present("127.0.0.1", "token", "key-authorization"); err != nil {
		t.Fatal(err)
	}
	challenge, err := tls.DialWithDialer(&net.Dialer{Timeout: 2 * time.Second}, "tcp", address, &tls.Config{
		InsecureSkipVerify: true, NextProtos: []string{"acme-tls/1"}, ServerName: "1.0.0.127.in-addr.arpa",
	})
	if err != nil {
		t.Fatal(err)
	}
	if challenge.ConnectionState().NegotiatedProtocol != "acme-tls/1" {
		t.Fatal("lost ACME ALPN")
	}
	challenge.Close()
	manager.CleanUp("", "", "")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := s.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	idle.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := idle.Read(make([]byte, 1)); err != io.EOF {
		t.Fatalf("idle detection connection not closed on shutdown: %v", err)
	}
}

func TestIndependentHTTPRedirect(t *testing.T) {
	for _, tc := range []struct{ host, port, origin, path, want string }{
		{"example.test:8080", "8443", "", "/a%2Fb?q=x%20y", "https://example.test:8443/a%2Fb?q=x%20y"},
		{"example.test:80", "443", "", "/?", "https://example.test/?"},
		{"[::1]:8080", "8443", "", "/", "https://[::1]:8443/"},
		{"[::1]:8080", "443", "", "/", "https://[::1]/"},
		{"internal:8080", "8443", "https://public.example:9443/", "/a%2Fb?q=1", "https://public.example:9443/a%2Fb?q=1"},
		{"bad/host", "443", "", "/", ""},
		{"user@host", "443", "", "/", ""},
	} {
		r := httptest.NewRequest("POST", "http://placeholder"+tc.path, strings.NewReader("never sent to app"))
		r.Host = tc.host
		r.Header.Set("X-Forwarded-Host", "untrusted.example")
		r.Header.Set("X-Forwarded-Proto", "http")
		w := httptest.NewRecorder()
		HTTPSRedirect(tc.port, tc.origin).ServeHTTP(w, r)
		status := http.StatusPermanentRedirect
		if tc.want == "" {
			status = http.StatusBadRequest
		}
		if w.Code != status || w.Header().Get("Location") != tc.want || w.Body.Len() != 0 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("redirect for %s: %d %v %q", tc.host, w.Code, w.Header(), w.Body.String())
		}
	}
}
