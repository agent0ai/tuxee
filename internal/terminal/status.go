package terminal

// RunningCount includes detached terminals and excludes post-mortem sessions.
func (m *Manager) RunningCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	count := 0
	for _, s := range m.sessions {
		s.mu.Lock()
		if !s.closed && !s.info.Exited && !s.archiveDead {
			count++
		}
		s.mu.Unlock()
	}
	return count
}
