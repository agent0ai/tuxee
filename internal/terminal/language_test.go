package terminal

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
	"tuxee/internal/identity"
)

func TestLanguageEnvironment(t *testing.T) {
	for _, tc := range []struct {
		language string
		locales  []string
		want     []string
	}{
		{"cs", []string{"C.utf8", "cs_CZ.utf8", "en_US.utf8"}, []string{"LANGUAGE=cs:en", "LC_MESSAGES=cs_CZ.utf8"}},
		{"cs", []string{"C.utf8", "cs_CZ.iso88592"}, []string{"LANGUAGE=cs:en", "LC_MESSAGES=C.UTF-8"}},
		{"pt-BR", []string{"pt_PT.utf8", "pt_BR.UTF-8"}, []string{"LANGUAGE=pt_BR:pt:en", "LC_MESSAGES=pt_BR.UTF-8"}},
		{"en-GB", []string{"en_US.utf8", "en_GB.utf8"}, []string{"LANGUAGE=en_GB:en", "LC_MESSAGES=en_GB.utf8"}},
		{"", nil, []string{"LANGUAGE=en", "LC_MESSAGES=C.UTF-8"}},
	} {
		if got := languageEnvironment(tc.language, tc.locales); !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("%s: %v", tc.language, got)
		}
	}
}

func TestTerminalChildLanguage(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("credential-dropped terminal requires root")
	}
	user, err := identity.Lookup("root")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	manager := NewManager()
	defer manager.Close()
	// A real child program sees the same preferences as a GUI launched from this shell.
	command := `python3 -c 'import json,os;json.dump({k:os.environ.get(k) for k in ["LANG","LC_MESSAGES","LANGUAGE","LC_ALL","LC_NUMERIC","LC_TIME"]},open("language.json","w"))'; exec sleep 30`
	session, err := manager.Create(user, dir, "language", 80, 24, command, "", "", "/bin/sh", false, "cs")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var data []byte
	for {
		data, err = os.ReadFile(filepath.Join(dir, "language.json"))
		if err == nil && json.Valid(data) {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("child did not report locale", ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
	var values map[string]*string
	if err := json.Unmarshal(data, &values); err != nil {
		t.Fatal(err)
	}
	if values["LANG"] == nil || *values["LANG"] != "C.UTF-8" || values["LANGUAGE"] == nil || *values["LANGUAGE"] != "cs:en" || values["LC_MESSAGES"] == nil {
		t.Fatal(string(data))
	}
	for _, name := range []string{"LC_ALL", "LC_NUMERIC", "LC_TIME"} {
		if values[name] != nil {
			t.Fatalf("changed %s: %s", name, data)
		}
	}
	if session.Info().Exited {
		t.Fatal("terminal exited")
	}
}
