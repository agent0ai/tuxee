package tlsmanager

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/go-acme/lego/v4/challenge/tlsalpn01"
)

type Options struct {
	Directory, Email, ACMEDirectory string
	Hosts                           []string
	Automatic                       bool
}
type Status struct {
	Host      string    `json:"host"`
	Source    string    `json:"source"`
	Expires   time.Time `json:"expires"`
	Error     string    `json:"error,omitempty"`
	Automatic bool      `json:"automatic"`
}
type record struct {
	local, public *tls.Certificate
	last          time.Time
	err           string
	pending       bool
	used          time.Time
}

var errHostCapacity = errors.New("public enrollment is busy; using an uncached local certificate")

type Manager struct {
	mu        sync.Mutex
	options   Options
	ca        *tls.Certificate
	caPEM     []byte
	names     []string
	records   map[string]*record
	challenge *tls.Certificate
	queue     chan string
}

func New(options Options) (*Manager, error) {
	if !filepath.IsAbs(options.Directory) {
		return nil, errors.New("TLS state path must be absolute")
	}
	if err := os.MkdirAll(options.Directory, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(options.Directory)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("TLS state must be a real directory")
	}
	if err = os.Chmod(options.Directory, 0700); err != nil {
		return nil, err
	}
	ca, caPEM, err := loadCA(options.Directory)
	if err != nil {
		return nil, err
	}
	m := &Manager{options: options, ca: ca, caPEM: caPEM, records: map[string]*record{}, queue: make(chan string, 64)}
	names := slices.Clone(options.Hosts)
	if len(names) == 0 {
		addresses, _ := net.InterfaceAddrs()
		for _, address := range addresses {
			if ip, _, err := net.ParseCIDR(address.String()); err == nil && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() {
				names = append(names, ip.String())
			}
		}
	}
	for _, name := range append(names, "localhost", "127.0.0.1", "::1") {
		name, err = normalize(name)
		if err != nil {
			return nil, err
		}
		if !slices.Contains(m.names, name) {
			m.names = append(m.names, name)
		}
	}
	if len(m.names) > 32 {
		return nil, errors.New("at most 32 TLS hostnames are supported")
	}
	for _, name := range m.names {
		if _, err = m.ensureLocked(name); err != nil {
			return nil, err
		}
	}
	return m, nil
}
func (m *Manager) RootCertificate() []byte { return append([]byte(nil), m.caPEM...) }
func (m *Manager) certificatePath(name string) string {
	sum := sha256.Sum256([]byte(name))
	return filepath.Join(m.options.Directory, "public-"+hex.EncodeToString(sum[:16])+".pem")
}
func (m *Manager) ensureLocked(name string) (*record, error) {
	if record := m.records[name]; record != nil {
		record.used = time.Now()
		return record, nil
	}
	if len(m.records) >= 64 {
		oldest := ""
		for host, entry := range m.records {
			if !entry.pending && !slices.Contains(m.names, host) && (oldest == "" || entry.used.Before(m.records[oldest].used)) {
				oldest = host
			}
		}
		if oldest == "" {
			return nil, errHostCapacity
		}
		delete(m.records, oldest)
	}
	local, err := localLeaf(m.ca, append([]string{name}, m.names...))
	if err != nil {
		return nil, err
	}
	r := &record{local: local, used: time.Now()}
	if data, err := os.ReadFile(m.certificatePath(name)); err == nil {
		r.public, err = pair(data)
		clear(data)
		if err == nil {
			err = r.public.Leaf.VerifyHostname(name)
		}
		if err != nil {
			r.public = nil
			r.err = "Cached public certificate is unusable: " + err.Error()
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		r.err = "Cannot read cached public certificate: " + err.Error()
	}
	m.records[name] = r
	return r, nil
}

func (m *Manager) TLSConfig() *tls.Config {
	return &tls.Config{MinVersion: tls.VersionTLS12, NextProtos: []string{"h2", "http/1.1", tlsalpn01.ACMETLS1Protocol}, GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
		if slices.Contains(hello.SupportedProtos, tlsalpn01.ACMETLS1Protocol) {
			m.mu.Lock()
			defer m.mu.Unlock()
			if m.challenge == nil {
				return nil, errors.New("no TLS-ALPN challenge active")
			}
			return &tls.Config{MinVersion: tls.VersionTLS12, NextProtos: []string{tlsalpn01.ACMETLS1Protocol}, Certificates: []tls.Certificate{*m.challenge}}, nil
		}
		return nil, nil
	}, GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
		name := hello.ServerName
		if name == "" {
			name = m.names[0]
		}
		return m.Certificate(name)
	}}
}

func (m *Manager) Certificate(name string) (*tls.Certificate, error) {
	name, err := normalize(name)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	r, err := m.ensureLocked(name)
	if err != nil {
		if errors.Is(err, errHostCapacity) {
			return localLeaf(m.ca, []string{name})
		}
		return nil, err
	}
	now := time.Now()
	valid := r.public != nil && !now.Before(r.public.Leaf.NotBefore) && now.Before(r.public.Leaf.NotAfter)
	if !valid || time.Until(r.public.Leaf.NotAfter) < r.public.Leaf.NotAfter.Sub(r.public.Leaf.NotBefore)/3 {
		m.enqueueLocked(name, r)
	}
	if valid {
		return r.public, nil
	}
	if time.Until(r.local.Leaf.NotAfter) < time.Hour {
		r.local, err = localLeaf(m.ca, append([]string{name}, m.names...))
		if err != nil {
			return nil, err
		}
	}
	return r.local, nil
}
func (m *Manager) enqueueLocked(name string, r *record) {
	if !m.options.Automatic || !publicName(name) || r.pending || time.Since(r.last) < time.Hour {
		return
	}
	select {
	case m.queue <- name:
		r.pending = true
	default:
	}
}
func (m *Manager) Status(name string) Status {
	name, err := normalize(name)
	if err != nil {
		name = m.names[0]
	}
	cert, err := m.Certificate(name)
	status := Status{Host: name, Automatic: m.options.Automatic && publicName(name), Source: "local"}
	if err != nil {
		status.Error = err.Error()
		return status
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.records[name]
	status.Expires = cert.Leaf.NotAfter
	if r == nil {
		status.Error = errHostCapacity.Error()
		return status
	}
	status.Error = r.err
	if cert == r.public {
		status.Source = "public"
	}
	return status
}
func (m *Manager) Run(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()
	for _, name := range m.names {
		_, _ = m.Certificate(name)
	}
	for {
		select {
		case <-ctx.Done():
			return
		case name := <-m.queue:
			m.mu.Lock()
			r := m.records[name]
			r.last = time.Now()
			m.mu.Unlock()
			err := m.issue(ctx, name)
			m.mu.Lock()
			r.pending = false
			if err != nil {
				r.err = err.Error()
			} else {
				r.err = ""
			}
			m.mu.Unlock()
			select {
			case <-ctx.Done():
				return
			case <-time.After(30 * time.Second):
			}
		case <-ticker.C:
			m.mu.Lock()
			names := make([]string, 0, len(m.records))
			for name := range m.records {
				names = append(names, name)
			}
			m.mu.Unlock()
			for _, name := range names {
				_, _ = m.Certificate(name)
			}
		}
	}
}

var label = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

func normalize(name string) (string, error) {
	name = strings.TrimSuffix(strings.ToLower(name), ".")
	if ip, err := netip.ParseAddr(name); err == nil && ip.Zone() == "" {
		return ip.Unmap().String(), nil
	}
	if name == "" || len(name) > 253 {
		return "", errors.New("invalid TLS hostname")
	}
	for _, part := range strings.Split(name, ".") {
		if !label.MatchString(part) {
			return "", errors.New("invalid TLS hostname")
		}
	}
	return name, nil
}
func publicName(name string) bool {
	if ip, err := netip.ParseAddr(name); err == nil {
		return publicAddress(ip)
	}
	if !strings.Contains(name, ".") {
		return false
	}
	for _, suffix := range []string{".localhost", ".local", ".internal", ".home.arpa"} {
		if strings.HasSuffix(name, suffix) {
			return false
		}
	}
	return true
}
func publicAddress(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, block := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "::/96", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20", "5f00::/16", "fec0::/10"} {
		if netip.MustParsePrefix(block).Contains(ip) {
			return false
		}
	}
	return true
}
func verifyPublic(ctx context.Context, name string) error {
	addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip", name)
	if err != nil {
		return err
	}
	if len(addresses) == 0 {
		return errors.New("hostname has no public addresses")
	}
	for _, ip := range addresses {
		if !publicAddress(ip) {
			return errors.New("public issuance requires exclusively public addresses")
		}
	}
	return nil
}
