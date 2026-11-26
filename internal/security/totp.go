package security

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"net/url"
	"strings"
	"time"
)

type Factor struct {
	Secret     string   `json:"secret"`
	Recovery   []string `json:"recovery"`
	LastStep   int64    `json:"lastStep"`
	Failures   int      `json:"failures,omitempty"`
	RetryAfter int64    `json:"retryAfter,omitempty"`
}

func NewSecret() string {
	var key [20]byte
	if _, err := rand.Read(key[:]); err != nil {
		panic(err)
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(key[:])
}

func URI(secret, account string) string {
	return "otpauth://totp/" + url.PathEscape("Tuxee:"+account) + "?" + url.Values{"secret": {secret}, "issuer": {"Tuxee"}, "algorithm": {"SHA1"}, "digits": {"6"}, "period": {"30"}}.Encode()
}

func Code(secret string, step int64) string {
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	if err != nil || len(key) < 20 || step < 0 {
		return ""
	}
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(step))
	mac := hmac.New(sha1.New, key)
	mac.Write(counter[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 15
	return fmt.Sprintf("%06d", (binary.BigEndian.Uint32(sum[offset:offset+4])&0x7fffffff)%1000000)
}

func Verify(secret, code string, last int64, now time.Time) (int64, bool) {
	if len(code) != 6 {
		return 0, false
	}
	step := now.Unix() / 30
	for _, candidate := range []int64{step, step - 1, step + 1} {
		expected := Code(secret, candidate)
		if candidate > last && expected != "" && subtle.ConstantTimeCompare([]byte(expected), []byte(code)) == 1 {
			return candidate, true
		}
	}
	return 0, false
}

func RecoveryHash(code string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.ReplaceAll(strings.TrimSpace(code), "-", ""))))
	return hex.EncodeToString(sum[:])
}

func RecoveryCodes() ([]string, []string) {
	var codes, hashes []string
	for range 8 {
		var key [10]byte
		if _, err := rand.Read(key[:]); err != nil {
			panic(err)
		}
		raw := hex.EncodeToString(key[:])
		code := raw[:5] + "-" + raw[5:10] + "-" + raw[10:15] + "-" + raw[15:]
		codes = append(codes, code)
		hashes = append(hashes, RecoveryHash(code))
	}
	return codes, hashes
}
