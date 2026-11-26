package security

import (
	"encoding/base32"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTOTP(t *testing.T) {
	secret := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString([]byte("12345678901234567890"))
	for _, test := range []struct {
		timestamp int64
		code      string
	}{{59, "287082"}, {1111111109, "081804"}, {1111111111, "050471"}, {1234567890, "005924"}, {2000000000, "279037"}, {20000000000, "353130"}} {
		now := time.Unix(test.timestamp, 0)
		step, ok := Verify(secret, test.code, -1, now)
		if !ok || step != test.timestamp/30 {
			t.Fatalf("RFC vector %d failed", test.timestamp)
		}
		if _, ok := Verify(secret, test.code, step, now); ok {
			t.Fatal("replayed code accepted")
		}
		if _, ok := Verify(secret, test.code, -1, now.Add(2*time.Minute)); ok {
			t.Fatal("expired code accepted")
		}
	}
	if _, ok := Verify(secret, "", -1, time.Now()); ok {
		t.Fatal("empty code accepted")
	}
	if Code("invalid", 0) != "" {
		t.Fatal("invalid secret accepted")
	}
	if !strings.Contains(URI(secret, "root@server"), "issuer=Tuxee") {
		t.Fatal("missing issuer")
	}
	codes, hashes := RecoveryCodes()
	if len(codes) != 8 || len(hashes) != 8 {
		t.Fatal("missing recovery codes")
	}
	seen := map[string]bool{}
	for index, code := range codes {
		if seen[code] || RecoveryHash(strings.ToUpper(code)) != hashes[index] {
			t.Fatal("bad recovery code")
		}
		seen[code] = true
	}
}

func TestNetworksAndProxyTrust(t *testing.T) {
	policy := Network{AllowedNetworks: []string{"10.8.0.0/24", "203.0.113.42", "2001:db8::/64"}, TrustedProxies: []string{"127.0.0.1", "192.0.2.0/24"}}
	for _, test := range []struct {
		address string
		allowed bool
	}{{"10.8.0.8", true}, {"10.8.1.8", false}, {"203.0.113.42", true}, {"203.0.113.43", false}, {"2001:db8::1", true}, {"::1", false}, {"::ffff:10.8.0.8", true}} {
		if policy.Allows(netip.MustParseAddr(test.address)) != test.allowed {
			t.Fatalf("wrong admission for %s", test.address)
		}
	}
	for _, value := range []string{"10.8.*.*", "example.org", "0.0.0.0/33", "", "fe80::1%eth0", "::ffff:10.8.0.0/120"} {
		if _, err := ParseNetworks([]string{value}); err == nil {
			t.Fatalf("accepted %q", value)
		}
	}
	for _, test := range []struct{ peer, chain, expected string }{
		{"198.51.100.1:1234", "10.8.0.2", "198.51.100.1"},
		{"127.0.0.1:1234", "10.8.0.2, 192.0.2.8", "10.8.0.2"},
		{"127.0.0.1:1234", "10.8.0.2, 198.51.100.1", "198.51.100.1"},
		{"127.0.0.1:1234", "", "127.0.0.1"},
	} {
		r := httptest.NewRequest("GET", "http://localhost/", nil)
		r.RemoteAddr = test.peer
		if test.chain != "" {
			r.Header.Set("X-Forwarded-For", test.chain)
		}
		address, err := policy.ClientIP(r)
		if err != nil || address.String() != test.expected {
			t.Fatalf("proxy chain: %s %v", address, err)
		}
	}
	r := httptest.NewRequest("GET", "http://localhost/", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	r.Header.Set("X-Forwarded-For", "garbage")
	if _, err := policy.ClientIP(r); err == nil {
		t.Fatal("accepted invalid trusted proxy chain")
	}
}

func TestPolicyPersistenceFailsClosed(t *testing.T) {
	store := &NetworkStore{Directory: t.TempDir()}
	policy, err := store.Load()
	if err != nil || !policy.Allows(netip.MustParseAddr("192.0.2.1")) {
		t.Fatal("default must allow all")
	}
	if err = store.Save(Network{AllowedNetworks: []string{"10.8.0.9/24"}}); err != nil {
		t.Fatal(err)
	}
	policy, err = store.Load()
	if err != nil || policy.AllowedNetworks[0] != "10.8.0.0/24" || policy.Allows(netip.MustParseAddr("192.0.2.1")) {
		t.Fatal("policy not applied")
	}
	path := filepath.Join(store.Directory, "security.json")
	if err = os.WriteFile(path, []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = store.Load(); err == nil {
		t.Fatal("corrupt policy allowed")
	}
	if err = os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink("/dev/zero", path); err != nil {
		t.Fatal(err)
	}
	if _, err = store.Load(); err == nil {
		t.Fatal("symlink policy allowed")
	}
}
