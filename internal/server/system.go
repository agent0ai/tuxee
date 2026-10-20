package server

import (
	"os"
	"strings"

	"golang.org/x/sys/unix"
	"tuxee/internal/identity"
)

type systemInfo struct {
	Version      string `json:"version"`
	OS           string `json:"os"`
	Kernel       string `json:"kernel"`
	Architecture string `json:"architecture"`
	Hostname     string `json:"hostname"`
	Username     string `json:"username"`
	UID          uint32 `json:"uid"`
	Home         string `json:"home"`
	Shell        string `json:"shell"`
}

func readSystemInfo(version string, user identity.User) (systemInfo, error) {
	var uname unix.Utsname
	if err := unix.Uname(&uname); err != nil {
		return systemInfo{}, err
	}
	info := systemInfo{
		Version: version, OS: unix.ByteSliceToString(uname.Sysname[:]),
		Kernel: unix.ByteSliceToString(uname.Release[:]), Architecture: unix.ByteSliceToString(uname.Machine[:]),
		Hostname: unix.ByteSliceToString(uname.Nodename[:]),
		Username: user.Name, UID: user.UID, Home: user.Home, Shell: user.Shell,
	}
	for _, path := range []string{"/etc/os-release", "/usr/lib/os-release"} {
		if data, err := os.ReadFile(path); err == nil {
			if name := osReleaseName(string(data)); name != "" {
				info.OS = name
			}
			break
		}
	}
	return info, nil
}

func osReleaseName(data string) string {
	for _, line := range strings.Split(data, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok || key != "PRETTY_NAME" {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) > 1 && value[0] == '\'' && value[len(value)-1] == '\'' {
			return value[1 : len(value)-1]
		}
		if len(value) > 1 && value[0] == '"' && value[len(value)-1] == '"' {
			return strings.NewReplacer(`\\`, `\`, `\"`, `"`, `\$`, `$`, "\\`", "`").Replace(value[1 : len(value)-1])
		}
		return value
	}
	return ""
}
