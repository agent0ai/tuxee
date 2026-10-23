package processes

import (
	"os"
	"strconv"
	"strings"
)

func memoryKB(data []byte, name string) *uint64 {
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || fields[0] != name+":" {
			continue
		}
		if len(fields) != 3 || fields[2] != "kB" {
			return nil
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil || value > ^uint64(0)/1024 {
			return nil
		}
		value *= 1024
		return &value
	}
	return nil
}

func addMemory(a, b *uint64) *uint64 {
	if a == nil || b == nil || *a > ^uint64(0)-*b {
		return nil
	}
	value := *a + *b
	return &value
}

func (p *Process) readMemory(dir *os.File, status []byte) {
	data, err := readAt(dir, "smaps_rollup")
	if err == nil {
		p.RAM = addMemory(memoryKB(data, "Pss_Anon"), memoryKB(data, "Pss_Shmem"))
		p.FileRAM = memoryKB(data, "Pss_File")
		if p.RAM != nil {
			return
		}
	}
	// shortcut: unreadable PSS falls back to RSS, revisit if Linux exposes cheaper proportional counters.
	p.RAM = addMemory(memoryKB(status, "RssAnon"), memoryKB(status, "RssShmem"))
	p.EstimatedRAM = p.RAM != nil
}
