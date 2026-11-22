package files

import (
	"os/user"
	"strconv"
	"strings"

	"tuxee/internal/i18n"

	"golang.org/x/sys/unix"
)

// AccessChange applies only the permission bits and ownership fields the user edited.
type AccessChange struct {
	Owner string `json:"owner,omitempty"`
	Group string `json:"group,omitempty"`
	Mask  uint32 `json:"mask,omitempty"`
	Bits  uint32 `json:"bits,omitempty"`
}

type ownershipNames struct {
	users, groups map[uint32]string
}

func (n *ownershipNames) lookup(uid, gid uint32) (string, string) {
	if _, found := n.users[uid]; !found {
		var name string
		if account, err := user.LookupId(strconv.FormatUint(uint64(uid), 10)); err == nil {
			name = account.Username
		}
		n.users[uid] = name
	}
	if _, found := n.groups[gid]; !found {
		var name string
		if group, err := user.LookupGroupId(strconv.FormatUint(uint64(gid), 10)); err == nil {
			name = group.Name
		}
		n.groups[gid] = name
	}
	return n.users[uid], n.groups[gid]
}

type ownershipChange struct{ uid, gid int }

func (a *AccessChange) resolve() (ownershipChange, error) {
	change := ownershipChange{-1, -1}
	if a == nil || a.Mask&^0777 != 0 || a.Bits&^a.Mask != 0 {
		return change, i18n.New("backend.files.invalidWorkerRequest")
	}
	if len(a.Owner) > 256 || len(a.Group) > 256 || strings.ContainsRune(a.Owner, 0) || strings.ContainsRune(a.Group, 0) {
		return change, i18n.New("backend.files.invalidWorkerRequest")
	}
	owner, group := a.Owner, a.Group
	if owner != "" {
		if account, err := user.Lookup(owner); err == nil {
			owner = account.Uid
		}
	}
	if group != "" {
		if account, err := user.LookupGroup(group); err == nil {
			group = account.Gid
		}
	}
	var err error
	if change.uid, err = ownershipID(owner); err != nil {
		return change, err
	}
	change.gid, err = ownershipID(group)
	return change, err
}

func ownershipID(value string) (int, error) {
	if value == "" {
		return -1, nil
	}
	id, err := strconv.ParseUint(value, 10, 32)
	if err != nil || id == 1<<32-1 {
		return -1, i18n.New("backend.identity.accountNotFound")
	}
	return int(id), nil
}

func (a AccessChange) apply(path string, change ownershipChange) error {
	fd, err := unix.Open(path, unix.O_PATH|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return err
	}
	if a.Mask != 0 && stat.Mode&unix.S_IFMT == unix.S_IFLNK {
		return unix.EOPNOTSUPP
	}
	if change.uid == int(stat.Uid) {
		change.uid = -1
	}
	if change.gid == int(stat.Gid) {
		change.gid = -1
	}
	if change.uid != -1 || change.gid != -1 {
		if err := unix.Fchownat(fd, "", change.uid, change.gid, unix.AT_EMPTY_PATH|unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return err
		}
		// Linux can clear set-ID bits when ownership changes.
		if a.Mask != 0 {
			if err := unix.Fstat(fd, &stat); err != nil {
				return err
			}
		}
	}
	mode := stat.Mode & 07777
	next := (mode &^ a.Mask) | a.Bits
	if next == mode {
		return nil
	}
	if err := unix.Fchmodat(fd, "", next, unix.AT_EMPTY_PATH); err != unix.EOPNOTSUPP {
		return err
	}
	// Older kernels can address the same pinned inode through procfs.
	return unix.Chmod("/proc/self/fd/"+strconv.Itoa(fd), next)
}
