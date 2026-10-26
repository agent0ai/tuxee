package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

func loadInstanceID(state string) (string, error) {
	path := filepath.Join(state, "instance-id")
	data, err := os.ReadFile(path)
	if err == nil {
		id := strings.TrimSpace(string(data))
		decoded, err := hex.DecodeString(id)
		if err != nil || len(decoded) != 16 {
			return "", errors.New("invalid instance ID in " + path)
		}
		return id, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", err
	}
	id := hex.EncodeToString(random[:])
	staged, err := os.CreateTemp(state, ".instance-id-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(staged.Name())
	defer staged.Close()
	if _, err := staged.WriteString(id + "\n"); err != nil {
		return "", err
	}
	if err := staged.Sync(); err != nil {
		return "", err
	}
	if err := staged.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(staged.Name(), path); err != nil {
		return "", err
	}
	return id, nil
}
