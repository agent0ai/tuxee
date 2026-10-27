package terminal

import (
	"context"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"
)

// Locale installation is an administrator task; discover it once per server process.
var installedLocales = sync.OnceValue(func() []string {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/usr/bin/locale", "-a")
	cmd.Env = []string{"LANG=C.UTF-8"}
	output, err := cmd.Output()
	if err != nil {
		return nil
	}
	locales := strings.Fields(string(output))
	sort.Strings(locales)
	return locales
})

func languageEnvironment(code string, locales []string) []string {
	if code == "" {
		code = "en"
	}
	requested := strings.ReplaceAll(code, "-", "_")
	base, _, _ := strings.Cut(requested, "_")
	preferences := []string{requested}
	if requested != base {
		preferences = append(preferences, base)
	}
	if base != "en" {
		preferences = append(preferences, "en")
	}
	messages := "C.UTF-8"
	for _, candidate := range locales {
		name, encoding, _ := strings.Cut(candidate, ".")
		encoding, _, _ = strings.Cut(encoding, "@")
		if !strings.EqualFold(strings.ReplaceAll(encoding, "-", ""), "utf8") {
			continue
		}
		if strings.EqualFold(name, requested) {
			messages = candidate
			break
		}
		language, _, _ := strings.Cut(name, "_")
		if messages == "C.UTF-8" && strings.EqualFold(language, base) {
			messages = candidate
		}
	}
	// Change application messages only; LANG keeps UTF-8 and stable numeric/date formats.
	return []string{"LANGUAGE=" + strings.Join(preferences, ":"), "LC_MESSAGES=" + messages}
}
