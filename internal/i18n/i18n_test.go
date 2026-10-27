package i18n

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestCatalogLayersAndFrozenBundles(t *testing.T) {
	dir := t.TempDir()
	write := func(code, source string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, code+".json"), []byte(source), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("en", `{"texts":{"test.onlyEnglish":"English {name}","common.cancel":"System cancel"}}`)
	write("cs", `{"texts":{"common.cancel":"Zrušit systémově"}}`)
	write("eo", `{"name":"Esperanto","texts":{"common.cancel":"Nuligi"}}`)
	write("xx", `{"name":"broken",`)
	s := NewStore(dir)
	cs := s.Bundle("cs", "language_one")
	if cs.Texts["common.cancel"] != "Zrušit systémově" || cs.Texts["test.onlyEnglish"] != "English {name}" || cs.Texts["login.username"] != "Uživatelské jméno" {
		t.Fatal("catalog layer or fallback lost", cs.Language)
	}
	eo := s.Bundle("eo", "language_one")
	if eo.Texts["common.cancel"] != "Nuligi" || eo.Texts["login.username"] != "Username" {
		t.Fatal("new language must inherit English")
	}
	if s.Bundle("../../etc/passwd", "cookie").Language != "en" {
		t.Fatal("unknown language must fall back to English")
	}
	if len(cs.Languages) != len(NewStore(t.TempDir()).Bundle("en", "").Languages)+1 {
		t.Fatal(cs.Languages)
	}
	if s.Bundle("cs", "language_two").Cookie != "language_two" {
		t.Fatal("cookie identity leaked between bundles")
	}
	write("cs", `{"texts":{"common.cancel":"Nová verze"}}`)
	s.Refresh()
	if s.Bundle("cs", "").Texts["common.cancel"] != "Nová verze" || cs.Texts["common.cancel"] != "Zrušit systémově" {
		t.Fatal("refresh must preserve existing session snapshots")
	}
}

func TestMessagesAndWorkerRoundTrip(t *testing.T) {
	s := NewStore(t.TempDir())
	catalog := &Catalog{Texts: s.Bundle("cs", "").Texts}
	cause := &os.PathError{Op: "open", Path: "/private/report.txt", Err: syscall.EACCES}
	err := Wrap("terminal.displayFailed", cause, Vars{"detail": Describe(cause)})
	if !errors.Is(err, syscall.EACCES) {
		t.Fatal("wrapped identity lost")
	}
	data, _ := json.Marshal(Describe(err))
	var decoded Message
	if json.Unmarshal(data, &decoded) != nil {
		t.Fatal("message does not round-trip")
	}
	if text := catalog.Text(decoded); !strings.Contains(text, "přístup odepřen") || !strings.Contains(text, "/private/report.txt") {
		t.Fatal(text)
	}
	if got := From(&decoded, "").Error(); got != "Terminal display failed: open /private/report.txt: permission denied" {
		t.Fatal(got)
	}
	if got := catalog.Text(Message{Key: "missing.example", Vars: Vars{"name": "a\"b", "count": 3}}); got != `[!missing.example count=3 name="a\"b"]` {
		t.Fatal(got)
	}
	if got := catalog.Text(Message{Key: "files.selectName"}); got != "[!files.selectName]" {
		t.Fatal(got)
	}
	if got := catalog.Text(Message{Key: "files.selectName", Vars: Vars{"name": "{count}<script>"}}); got != "Vybrat {count}<script>" {
		t.Fatal("substitution must be one pass", got)
	}
}

func TestOverrideFilesAreBoundedAndRegular(t *testing.T) {
	dir := t.TempDir()
	if err := os.Symlink("/etc/passwd", filepath.Join(dir, "de.json")); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(dir, "fr.json"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "es.json"), []byte(strings.Repeat("x", maxCatalogBytes+1)), 0600); err != nil {
		t.Fatal(err)
	}
	s := NewStore(dir)
	if languages := s.Bundle("en", "").Languages; len(languages) != len(NewStore(t.TempDir()).Bundle("en", "").Languages) {
		t.Fatal(languages)
	}
}

func TestLanguageDirection(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "ar-EG.json"), []byte(`{"name":"العربية (مصر)","texts":{}}`), 0600); err != nil {
		t.Fatal(err)
	}
	s := NewStore(dir)
	for _, code := range []string{"ar", "fa", "he", "ar-EG", "en", "cs", "hi", "th", "pt-PT", "sk", "ca", "ms", "sr-Latn", "zh-CN", "zh-TW", "missing"} {
		want := "ltr"
		if code == "ar" || code == "fa" || code == "he" || code == "ar-EG" {
			want = "rtl"
		}
		if got := s.Bundle(code, "").Direction; got != want {
			t.Errorf("%s: direction %s, want %s", code, got, want)
		}
	}
}

func TestBuiltInLocaleSelection(t *testing.T) {
	s := NewStore(t.TempDir())
	for _, tc := range []struct{ code, name, save string }{
		{"pt-BR", "Português (Brasil)", "Salvar"},
		{"pt-PT", "Português (Portugal)", "Guardar"},
		{"zh-CN", "简体中文", "保存"},
		{"zh-TW", "繁體中文（台灣）", "儲存"},
		{"sk", "Slovenčina", "Uložiť"},
		{"ca", "Català", "Desa"},
		{"ms", "Bahasa Melayu", "Simpan"},
		{"sr-Latn", "Srpski (latinica)", "Sačuvaj"},
	} {
		t.Run(tc.code, func(t *testing.T) {
			bundle := s.Bundle(tc.code, "")
			if bundle.Language != tc.code || bundle.Texts["common.save"] != tc.save {
				t.Fatal("exact locale selection lost", bundle.Language, bundle.Texts["common.save"])
			}
			for _, language := range bundle.Languages {
				if language.Code == tc.code && language.Name == tc.name {
					return
				}
			}
			t.Fatal("missing native language choice", tc.code)
		})
	}
	for _, code := range []string{"pt", "zh", "sk-SK", "sr", "sr-Cyrl", "unknown"} {
		if got := s.Bundle(code, "").Language; got != "en" {
			t.Errorf("unknown code %s: got %s, want English fallback", code, got)
		}
	}
}
