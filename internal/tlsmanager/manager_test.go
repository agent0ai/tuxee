package tlsmanager

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"testing"
	"time"
)

func TestCorruptCacheAndHostLimitKeepTLSAvailable(t *testing.T) {
	opts := Options{Directory: t.TempDir(), Hosts: []string{"example.test"}}
	m, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(m.certificatePath("example.test"), []byte("broken certificate cache"), 0600); err != nil {
		t.Fatal(err)
	}
	m, err = New(opts)
	if err != nil {
		t.Fatal("corrupt public cache blocked local TLS:", err)
	}
	if status := m.Status("example.test"); status.Source != "local" || status.Error == "" {
		t.Fatal(status)
	}
	m.options.Automatic = true
	for i := 0; i < 80; i++ {
		name := fmt.Sprintf("host-%d.example.test", i)
		certificate, err := m.Certificate(name)
		if err != nil {
			t.Fatal("enrollment capacity blocked TLS:", err)
		}
		if err = certificate.Leaf.VerifyHostname(name); err != nil {
			t.Fatal(err)
		}
	}
	if len(m.records) > 64 {
		t.Fatal("unbounded TLS cache")
	}
	if status := m.Status("extra.example.test"); status.Source != "local" {
		t.Fatal(status)
	}
}

func TestEnrollmentUsesPublicHosts(t *testing.T) {
	m, err := New(Options{Directory: t.TempDir(), Hosts: []string{"EXAMPLE.COM.", "127.0.0.1"}, Automatic: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, host := range []string{"127.0.0.1", "localhost"} {
		if status := m.Status(host); status.Automatic || status.Source != "local" {
			t.Fatalf("unexpected enrollment for %s: %+v", host, status)
		}
	}
	if len(m.queue) != 0 {
		t.Fatal("private host triggered ACME")
	}
	if m.names[0] != "example.com" {
		t.Fatal("configured hostname was not normalized")
	}
	for range 2 {
		if status := m.Status("UNCONFIGURED.EXAMPLE.COM."); !status.Automatic || status.Source != "local" {
			t.Fatal(status)
		}
	}
	if len(m.queue) != 1 || <-m.queue != "unconfigured.example.com" {
		t.Fatal("unconfigured public host must queue exactly one order")
	}
	r := m.records["unconfigured.example.com"]
	r.pending = false
	r.last = time.Now()
	m.Certificate("unconfigured.example.com")
	if len(m.queue) != 0 {
		t.Fatal("request bypassed the retry delay")
	}
	r.last = time.Now().Add(-time.Hour)
	m.Certificate("unconfigured.example.com")
	if len(m.queue) != 1 {
		t.Fatal("retry was not queued after the delay")
	}
	<-m.queue
	r.pending = false
	r.last = time.Time{}
	m.options.Automatic = false
	m.Certificate("unconfigured.example.com")
	if len(m.queue) != 0 {
		t.Fatal("ACME off still queued an order")
	}
}

func TestLiveTLSFallbackAndSwitch(t *testing.T) {
	opts := Options{Directory: t.TempDir(), Automatic: true}
	m, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) }), TLSConfig: m.TLSConfig()}
	go server.ServeTLS(listener, "", "")
	defer server.Close()
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(m.RootCertificate())
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, ServerName: "example.test"}, DisableKeepAlives: true}}
	get := func() string {
		t.Helper()
		response, err := client.Get("https://" + listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		io.Copy(io.Discard, response.Body)
		return response.TLS.PeerCertificates[0].SerialNumber.String()
	}
	localSerial := get()
	if get() != localSerial || len(m.queue) != 1 || <-m.queue != "example.test" {
		t.Fatal("unconfigured SNI must queue exactly one order on a nonstandard TLS port")
	}
	public, err := localLeaf(m.ca, []string{"example.test"})
	if err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	m.records["example.test"].public = public
	m.records["example.test"].err = "simulated renewal failure"
	m.mu.Unlock()
	if got := get(); got != public.Leaf.SerialNumber.String() {
		t.Fatal("did not retain valid public certificate after renewal failure")
	}
	m.mu.Lock()
	public.Leaf.NotAfter = time.Now().Add(-time.Minute)
	m.mu.Unlock()
	if get() != localSerial {
		t.Fatal("did not fall back after public expiry")
	}
	restarted, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(m.RootCertificate(), restarted.RootCertificate()) {
		t.Fatal("local CA changed on restart")
	}
}

func TestTLSALPNOnExistingListener(t *testing.T) {
	m, err := New(Options{Directory: t.TempDir(), Hosts: []string{"127.0.0.1"}})
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{TLSConfig: m.TLSConfig()}
	go server.ServeTLS(listener, "", "")
	defer server.Close()
	if err = m.Present("127.0.0.1", "token", "key-authorization"); err != nil {
		t.Fatal(err)
	}
	connection, err := tls.Dial("tcp", listener.Addr().String(), &tls.Config{InsecureSkipVerify: true, NextProtos: []string{"acme-tls/1"}, ServerName: "1.0.0.127.in-addr.arpa"})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	state := connection.ConnectionState()
	if state.NegotiatedProtocol != "acme-tls/1" {
		t.Fatal("challenge ALPN not selected")
	}
	if err = state.PeerCertificates[0].VerifyHostname("127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, extension := range state.PeerCertificates[0].Extensions {
		if extension.Id.String() == "1.3.6.1.5.5.7.1.31" && extension.Critical {
			found = true
		}
	}
	if !found {
		t.Fatal("missing ACME challenge extension")
	}
	if err = m.CleanUp("", "", ""); err != nil {
		t.Fatal(err)
	}
}

func TestPublicNamePolicy(t *testing.T) {
	for _, name := range []string{"127.0.0.1", "10.1.2.3", "localhost", "server.local", "example.internal", "192.0.2.4", "::1", "fc00::1"} {
		if publicName(name) {
			t.Fatalf("private/reserved name admitted: %s", name)
		}
	}
	for _, name := range []string{"example.com", "1.1.1.1", "2606:4700:4700::1111"} {
		if !publicName(name) {
			t.Fatalf("public name rejected: %s", name)
		}
	}
}
