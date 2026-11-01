package keeper

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// Elevated descendants can outlive their unprivileged parent. Only kernel peer
// identity and kernel-reported children authorize assistance, never protocol PIDs.
func (c *Client) finishCleanup() error {
	poll := []unix.PollFd{{Fd: int32(c.peer.Fd()), Events: unix.POLLIN}}
	if _, err := unix.Poll(poll, 0); err == nil && poll[0].Revents&unix.POLLIN != 0 {
		return nil
	}
	root, err := os.OpenRoot(fmt.Sprintf("/proc/%d", c.peerPID))
	if err != nil {
		return err
	}
	defer root.Close()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		poll := []unix.PollFd{{Fd: int32(c.peer.Fd()), Events: unix.POLLIN}}
		if _, err = unix.Poll(poll, 0); err != nil {
			return err
		}
		if poll[0].Revents&unix.POLLIN != 0 {
			return nil
		}
		data, err := root.ReadFile(fmt.Sprintf("task/%d/children", c.peerPID))
		if err != nil {
			return err
		}
		for _, id := range strings.Fields(string(data)) {
			pid, err := strconv.Atoi(id)
			if err != nil || pid <= 1 {
				continue
			}
			child, err := os.OpenRoot(fmt.Sprintf("/proc/%d", pid))
			if err != nil {
				continue
			}
			stat, e := child.ReadFile("stat")
			fields := strings.Fields(string(stat)[strings.LastIndexByte(string(stat), ')')+1:])
			// The proc directory pins the child even if it exits during this check.
			if e == nil && len(fields) > 1 && fields[1] == strconv.Itoa(c.peerPID) {
				poll[0].Revents = 0
				if _, e = unix.Poll(poll, 0); e != nil || poll[0].Revents != 0 {
					child.Close()
					if e != nil {
						return e
					}
					if poll[0].Revents&unix.POLLIN != 0 {
						return nil
					}
					return os.ErrClosed
				}
				proc, e := child.Open(".")
				if e == nil {
					_ = unix.PidfdSendSignal(int(proc.Fd()), unix.SIGKILL, nil, 0)
					proc.Close()
				}
			}
			child.Close()
		}
		time.Sleep(20 * time.Millisecond)
	}
	return fmt.Errorf("terminal processes have not finished stopping")
}
