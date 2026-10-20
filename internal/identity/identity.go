package identity

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"os/user"
	"strconv"
	"syscall"
	"time"
)

type User struct {
	Name   string   `json:"name"`
	Home   string   `json:"home"`
	Shell  string   `json:"-"`
	UID    uint32   `json:"uid"`
	GID    uint32   `json:"gid"`
	Groups []uint32 `json:"-"`
}

// Self keeps authentication and file helpers on the running binary after updates.
const Self = "/proc/self/exe"

func Lookup(name string) (User, error) {
	var result User
	account, err := user.Lookup(name)
	if err != nil {
		return result, errors.New("account not found")
	}
	uid, err := strconv.ParseUint(account.Uid, 10, 32)
	if err != nil {
		return result, err
	}
	gid, err := strconv.ParseUint(account.Gid, 10, 32)
	if err != nil {
		return result, err
	}
	groups, err := account.GroupIds()
	if err != nil {
		return result, err
	}
	result = User{Name: account.Username, Home: account.HomeDir, UID: uint32(uid), GID: uint32(gid)}
	for _, group := range groups {
		id, err := strconv.ParseUint(group, 10, 32)
		if err != nil {
			return User{}, err
		}
		result.Groups = append(result.Groups, uint32(id))
	}
	result.Shell, err = shell(account.Username)
	return result, err
}

func Authenticate(ctx context.Context, service, name string, password []byte) (User, error) {
	defer clear(password)
	request, err := json.Marshal(authRequest{Service: service, Username: name, Password: password})
	if err != nil {
		return User{}, err
	}
	defer clear(request)
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, Self, "__auth")
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8"}
	cmd.Stdin = bytes.NewReader(request)
	if err = cmd.Run(); err != nil {
		return User{}, errors.New("invalid username, password, or account policy")
	}
	return Lookup(name)
}

func (u User) Command(ctx context.Context, executable string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Dir = u.Home
	cmd.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=" + u.Home, "USER=" + u.Name, "LOGNAME=" + u.Name, "SHELL=" + u.Shell, "TERM=xterm-256color", "LANG=C.UTF-8"}
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: u.UID, Gid: u.GID, Groups: u.Groups}, Pdeathsig: syscall.SIGKILL}
	return cmd
}
