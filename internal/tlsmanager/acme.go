package tlsmanager

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/go-acme/lego/v4/certcrypto"
	"github.com/go-acme/lego/v4/certificate"
	"github.com/go-acme/lego/v4/challenge/tlsalpn01"
	"github.com/go-acme/lego/v4/lego"
	"github.com/go-acme/lego/v4/registration"
)

type account struct {
	Email        string
	Registration *registration.Resource
	Key          crypto.PrivateKey
}

func (a *account) GetEmail() string                        { return a.Email }
func (a *account) GetRegistration() *registration.Resource { return a.Registration }
func (a *account) GetPrivateKey() crypto.PrivateKey        { return a.Key }

func (m *Manager) Present(domain, token, keyAuth string) error {
	cert, err := tlsalpn01.ChallengeCert(domain, keyAuth)
	if err != nil {
		return err
	}
	m.mu.Lock()
	m.challenge = cert
	m.mu.Unlock()
	return nil
}
func (m *Manager) CleanUp(_, _, _ string) error {
	m.mu.Lock()
	m.challenge = nil
	m.mu.Unlock()
	return nil
}

type contextTransport struct {
	ctx  context.Context
	base http.RoundTripper
}

func (t contextTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return t.base.RoundTrip(r.Clone(t.ctx))
}

func (m *Manager) issue(ctx context.Context, name string) error {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Minute)
	defer cancel()
	if err := verifyPublic(ctx, name); err != nil {
		return err
	}
	directory := m.options.ACMEDirectory
	if directory == "" {
		directory = lego.LEDirectoryProduction
	}
	hash := sha256.Sum256([]byte(directory))
	prefix := filepath.Join(m.options.Directory, "account-"+hex.EncodeToString(hash[:8]))
	a := &account{Email: m.options.Email}
	data, err := os.ReadFile(prefix + ".key")
	if errors.Is(err, os.ErrNotExist) {
		a.Key, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return err
		}
		data, err = encodeKey(a.Key)
		if err != nil {
			return err
		}
		if err = atomicWrite(prefix+".key", data); err != nil {
			return err
		}
	} else if err != nil {
		return err
	} else {
		block, _ := pem.Decode(data)
		if block == nil {
			return errors.New("invalid ACME account key")
		}
		a.Key, err = x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return err
		}
	}
	clear(data)
	if registrationData, err := os.ReadFile(prefix + ".json"); err == nil {
		if err = json.Unmarshal(registrationData, &a.Registration); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	config := lego.NewConfig(a)
	config.CADirURL = directory
	config.UserAgent = "Tuxee/0.1"
	config.Certificate.KeyType = certcrypto.EC256
	config.Certificate.Timeout = 2 * time.Minute
	config.HTTPClient.Timeout = 30 * time.Second
	config.HTTPClient.Transport = contextTransport{ctx, config.HTTPClient.Transport}
	client, err := lego.NewClient(config)
	if err != nil {
		return err
	}
	if err = client.Challenge.SetTLSALPN01Provider(m); err != nil {
		return err
	}
	if a.Registration == nil {
		a.Registration, err = client.Registration.Register(registration.RegisterOptions{TermsOfServiceAgreed: true})
		if err != nil {
			return err
		}
		data, err = json.Marshal(a.Registration)
		if err != nil {
			return err
		}
		if err = atomicWrite(prefix+".json", data); err != nil {
			return err
		}
	}
	request := certificate.ObtainRequest{Domains: []string{name}, Bundle: true}
	if net.ParseIP(name) != nil {
		request.Profile = "shortlived"
	}
	resource, err := client.Certificate.Obtain(request)
	if err != nil {
		return err
	}
	data = append(append([]byte(nil), resource.Certificate...), resource.PrivateKey...)
	defer clear(data)
	defer clear(resource.PrivateKey)
	cert, err := pair(data)
	if err != nil {
		return err
	}
	if err = cert.Leaf.VerifyHostname(name); err != nil {
		return err
	}
	if err = atomicWrite(m.certificatePath(name), data); err != nil {
		return err
	}
	m.mu.Lock()
	m.records[name].public = cert
	m.mu.Unlock()
	return nil
}
