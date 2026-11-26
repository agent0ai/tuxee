package files

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
	"tuxee/internal/i18n"
	"tuxee/internal/security"
)

type SecurityStatus struct {
	Enabled           bool     `json:"enabled"`
	RecoveryRemaining int      `json:"recoveryRemaining"`
	RecoveryCodes     []string `json:"recoveryCodes,omitempty"`
}

func securityOperation(ctx context.Context, request Request) (Response, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Response{}, err
	}
	path := filepath.Join(home, ".config", "tuxee", "security")
	if err = os.MkdirAll(path, 0700); err != nil {
		return Response{}, err
	}
	directory, err := os.OpenFile(path, os.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return Response{}, err
	}
	defer directory.Close()
	info, err := directory.Stat()
	if err != nil {
		return Response{}, err
	}
	if info.Sys().(*syscall.Stat_t).Uid != uint32(os.Geteuid()) || info.Mode().Perm()&0077 != 0 {
		return Response{}, os.ErrPermission
	}
	for {
		err = unix.Flock(int(directory.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, unix.EWOULDBLOCK) {
			return Response{}, err
		}
		select {
		case <-ctx.Done():
			return Response{}, ctx.Err()
		case <-time.After(10 * time.Millisecond):
		}
	}
	defer unix.Flock(int(directory.Fd()), unix.LOCK_UN)
	path = fmt.Sprintf("/proc/self/fd/%d/two-factor.json", directory.Fd())
	status := &SecurityStatus{}
	response := Response{Security: status}
	if request.Operation == "security-clear" {
		err = os.Remove(path)
		if errors.Is(err, os.ErrNotExist) {
			err = nil
		}
		if err == nil {
			err = directory.Sync()
		}
		return response, err
	}
	var factor security.Factor
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err == nil {
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			return response, err
		}
		if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 8192 || info.Sys().(*syscall.Stat_t).Uid != uint32(os.Geteuid()) {
			return response, os.ErrPermission
		}
		data, err := io.ReadAll(io.LimitReader(file, 8193))
		if err != nil {
			return response, err
		}
		if err = json.Unmarshal(data, &factor); err != nil {
			return response, err
		}
		if security.Code(factor.Secret, 0) == "" {
			return response, i18n.New("backend.files.invalidWorkerRequest")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return response, err
	}
	status.Enabled = factor.Secret != ""
	status.RecoveryRemaining = len(factor.Recovery)
	save := func() error {
		data, err := json.Marshal(factor)
		if err != nil {
			return err
		}
		if err = replaceFile(path, data); err != nil {
			return err
		}
		return directory.Sync()
	}
	switch request.Operation {
	case "security-status":
		return response, nil
	case "security-enable":
		if status.Enabled {
			return response, i18n.New("security.enabled")
		}
		step, valid := security.Verify(request.Content, request.Version, -1, time.Now())
		if !valid {
			return response, i18n.New("security.invalidCode")
		}
		codes, hashes := security.RecoveryCodes()
		factor = security.Factor{Secret: request.Content, LastStep: step, Recovery: hashes}
		if err = save(); err != nil {
			return response, err
		}
		status.Enabled = true
		status.RecoveryRemaining = len(hashes)
		status.RecoveryCodes = codes
		return response, nil
	case "security-verify", "security-disable":
		if !status.Enabled {
			if request.Operation == "security-verify" && request.Mode == "required" {
				return response, i18n.New("security.invalidCode")
			}
			return response, nil
		}
		now := time.Now()
		if now.Unix() < factor.RetryAfter {
			return response, i18n.New("backend.identity.loginAttemptLimit", i18n.Vars{"seconds": 60})
		}
		step, valid := security.Verify(factor.Secret, request.Content, factor.LastStep, now)
		if valid {
			factor.LastStep = step
		} else if request.Mode != "authenticator" {
			hash := security.RecoveryHash(request.Content)
			for index, expected := range factor.Recovery {
				if subtle.ConstantTimeCompare([]byte(hash), []byte(expected)) == 1 {
					factor.Recovery = append(factor.Recovery[:index], factor.Recovery[index+1:]...)
					valid = true
					break
				}
			}
		}
		if !valid {
			factor.Failures++
			if factor.Failures >= 5 {
				factor.Failures = 0
				factor.RetryAfter = now.Add(time.Minute).Unix()
			}
			if err = save(); err != nil {
				return response, err
			}
			return response, i18n.New("security.invalidCode")
		}
		factor.Failures = 0
		factor.RetryAfter = 0
		if request.Operation == "security-disable" {
			if err = os.Remove(path); err != nil {
				return response, err
			}
			status.Enabled = false
			status.RecoveryRemaining = 0
			return response, directory.Sync()
		}
		status.RecoveryRemaining = len(factor.Recovery)
		return response, save()
	default:
		return response, i18n.New("backend.files.invalidWorkerRequest")
	}
}
