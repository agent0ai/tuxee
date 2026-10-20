package tlsmanager

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

func serial() *big.Int {
	n, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		panic(err)
	}
	return n
}
func encodeKey(key crypto.PrivateKey) ([]byte, error) {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), nil
}
func pair(data []byte) (*tls.Certificate, error) {
	certificate, err := tls.X509KeyPair(data, data)
	if err != nil {
		return nil, err
	}
	certificate.Leaf, err = x509.ParseCertificate(certificate.Certificate[0])
	return &certificate, err
}

func atomicWrite(path string, data []byte) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".tuxee-certificate-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err = file.Write(data); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

// Adapted from the8020/https/src/local.ts: one durable CA, short-lived leaves.
func loadCA(dir string) (*tls.Certificate, []byte, error) {
	path := filepath.Join(dir, "local-ca.pem")
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return nil, nil, err
		}
		now := time.Now()
		template := &x509.Certificate{SerialNumber: serial(), Subject: pkix.Name{CommonName: "Tuxee Local CA"}, NotBefore: now.Add(-time.Minute), NotAfter: now.AddDate(10, 0, 0), IsCA: true, BasicConstraintsValid: true, MaxPathLenZero: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
		der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
		if err != nil {
			return nil, nil, err
		}
		private, err := encodeKey(key)
		if err != nil {
			return nil, nil, err
		}
		defer clear(private)
		data = append(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), private...)
		if err = atomicWrite(path, data); err != nil {
			return nil, nil, err
		}
	} else if err != nil {
		return nil, nil, err
	}
	defer clear(data)
	ca, err := pair(data)
	if err != nil {
		return nil, nil, err
	}
	if !ca.Leaf.IsCA || time.Now().Before(ca.Leaf.NotBefore) || !time.Now().Before(ca.Leaf.NotAfter) {
		return nil, nil, errors.New("local CA is not valid; deliberate replacement and client trust setup are required")
	}
	return ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: ca.Certificate[0]}), nil
}

func localLeaf(ca *tls.Certificate, names []string) (*tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	until := now.Add(12 * time.Hour)
	if ca.Leaf.NotAfter.Before(until) {
		until = ca.Leaf.NotAfter
	}
	template := &x509.Certificate{SerialNumber: serial(), Subject: pkix.Name{CommonName: names[0]}, NotBefore: now.Add(-time.Minute), NotAfter: until, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true}
	for _, name := range names {
		if ip := net.ParseIP(name); ip != nil {
			template.IPAddresses = append(template.IPAddresses, ip)
		} else {
			template.DNSNames = append(template.DNSNames, name)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca.Leaf, &key.PublicKey, ca.PrivateKey)
	if err != nil {
		return nil, err
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	return &tls.Certificate{Certificate: [][]byte{der, ca.Certificate[0]}, PrivateKey: key, Leaf: leaf}, nil
}
