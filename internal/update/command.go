package update

import (
	"os/exec"
	"path/filepath"
	"strings"
)

// Command uses PATH only when it resolves to this installation, including after replacement.
func Command(executable string) string {
	path, err := exec.LookPath("tuxee")
	if err == nil {
		found, foundErr := filepath.EvalSymlinks(path)
		target, targetErr := filepath.EvalSymlinks(executable)
		if foundErr == nil && targetErr == nil {
			found, foundErr = filepath.Abs(found)
			target, targetErr = filepath.Abs(target)
			if foundErr == nil && targetErr == nil && found == target {
				return "tuxee"
			}
		}
	}
	return "'" + strings.ReplaceAll(executable, "'", "'\\''") + "'"
}
