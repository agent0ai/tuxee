package security

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"tuxee/internal/i18n"
)

type Network struct {
	AllowedNetworks []string `json:"allowedNetworks"`
	TrustedProxies  []string `json:"trustedProxies"`
}

func ParseNetworks(values []string) ([]netip.Prefix, error) {
	if len(values) > 128 {
		return nil, i18n.New("security.invalidNetworks")
	}
	var result []netip.Prefix
	for _, value := range values {
		value = strings.TrimSpace(value)
		prefix, err := netip.ParsePrefix(value)
		if err != nil {
			address, addressErr := netip.ParseAddr(value)
			if addressErr != nil || address.Zone() != "" {
				return nil, i18n.New("security.invalidNetworks")
			}
			address = address.Unmap()
			prefix = netip.PrefixFrom(address, address.BitLen())
		}
		if prefix.Addr().Is4In6() {
			return nil, i18n.New("security.invalidNetworks")
		}
		result = append(result, prefix.Masked())
	}
	return result, nil
}

func contains(prefixes []netip.Prefix, address netip.Addr) bool {
	for _, prefix := range prefixes {
		if prefix.Contains(address.Unmap()) {
			return true
		}
	}
	return false
}

func (n Network) Allows(address netip.Addr) bool {
	values, err := ParseNetworks(n.AllowedNetworks)
	return err == nil && (len(values) == 0 || contains(values, address))
}

func (n Network) ClientIP(r *http.Request) (netip.Addr, error) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return netip.Addr{}, err
	}
	address, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}, err
	}
	address = address.Unmap()
	proxies, err := ParseNetworks(n.TrustedProxies)
	if err != nil {
		return netip.Addr{}, err
	}
	if !contains(proxies, address) {
		return address, nil
	}
	header := r.Header.Values("X-Forwarded-For")
	if len(header) == 0 {
		return address, nil
	}
	if len(header) != 1 || len(header[0]) > 4096 {
		return netip.Addr{}, errors.New("invalid proxy chain")
	}
	chain := strings.Split(header[0], ",")
	for index := len(chain) - 1; index >= 0 && contains(proxies, address); index-- {
		address, err = netip.ParseAddr(strings.TrimSpace(chain[index]))
		if err != nil || address.Zone() != "" {
			return netip.Addr{}, errors.New("invalid proxy address")
		}
		address = address.Unmap()
	}
	return address, nil
}

type NetworkStore struct{ Directory string }

func (s *NetworkStore) Load() (Network, error) {
	value := Network{AllowedNetworks: []string{}, TrustedProxies: []string{}}
	if s == nil {
		return value, nil
	}
	file, err := os.OpenFile(filepath.Join(s.Directory, "security.json"), os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if errors.Is(err, os.ErrNotExist) {
		return value, nil
	}
	if err != nil {
		return value, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return value, err
	}
	if !info.Mode().IsRegular() || info.Size() > 32768 || info.Mode().Perm()&0022 != 0 || info.Sys().(*syscall.Stat_t).Uid != uint32(os.Geteuid()) {
		return value, os.ErrPermission
	}
	data, err := io.ReadAll(io.LimitReader(file, 32769))
	if err != nil {
		return value, err
	}
	if !strings.HasPrefix(strings.TrimSpace(string(data)), "{") {
		return value, errors.New("invalid network policy")
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&value); err != nil {
		return value, err
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return value, errors.New("invalid network policy")
	}
	if value.AllowedNetworks == nil {
		value.AllowedNetworks = []string{}
	}
	if value.TrustedProxies == nil {
		value.TrustedProxies = []string{}
	}
	if _, err = ParseNetworks(value.AllowedNetworks); err != nil {
		return value, err
	}
	_, err = ParseNetworks(value.TrustedProxies)
	return value, err
}

func (s *NetworkStore) Save(value Network) error {
	for _, values := range []*[]string{&value.AllowedNetworks, &value.TrustedProxies} {
		prefixes, err := ParseNetworks(*values)
		if err != nil {
			return err
		}
		*values = []string{}
		for _, prefix := range prefixes {
			*values = append(*values, prefix.String())
		}
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(s.Directory, ".security-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err = file.Write(append(data, '\n')); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	if err = os.Rename(file.Name(), filepath.Join(s.Directory, "security.json")); err != nil {
		return err
	}
	dir, err := os.Open(s.Directory)
	if err != nil {
		return err
	}
	defer dir.Close()
	if err = dir.Sync(); err != nil {
		return fmt.Errorf("sync network policy: %w", err)
	}
	return nil
}
