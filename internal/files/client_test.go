package files

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
	"tuxee/internal/i18n"
	"tuxee/internal/identity"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "__files" {
		if err := Worker(); err != nil {
			_ = json.NewEncoder(os.Stderr).Encode(i18n.Describe(err))
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestWorkerEarlyErrorRetainsTranslation(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("credential-dropped worker requires root")
	}
	user, err := identity.Lookup("root")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err = Start(ctx, user, Request{Operation: "read", Path: strings.Repeat("x", 9<<20)}, nil)
	message := i18n.Describe(err)
	if message == nil || message.Key != "backend.files.workerRequestTooLarge" {
		t.Fatalf("worker lost translation before its response header: %#v, %v", message, err)
	}
}
