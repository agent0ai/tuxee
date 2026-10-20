package update

import (
	"context"
	"sync"
	"time"
)

type Status struct {
	Current   string    `json:"current"`
	Latest    string    `json:"latest,omitempty"`
	Available bool      `json:"available"`
	CheckedAt time.Time `json:"checkedAt"`
	Error     string    `json:"error,omitempty"`
}

type Checker struct {
	mu      sync.Mutex
	status  Status
	attempt time.Time
	pending chan struct{}
	fetch   func(context.Context) (Release, error)
}

func NewChecker(version string) *Checker {
	return &Checker{status: Status{Current: version}, fetch: NewClient().Latest}
}

func (c *Checker) Status() Status { c.mu.Lock(); defer c.mu.Unlock(); return c.status }

func (c *Checker) Check(ctx context.Context) Status {
	c.mu.Lock()
	if done := c.pending; done != nil {
		c.mu.Unlock()
		select {
		case <-done:
		case <-ctx.Done():
		}
		return c.Status()
	}
	// All browser sessions share this limit, including failed checks.
	if time.Since(c.attempt) < time.Minute {
		result := c.status
		c.mu.Unlock()
		return result
	}
	c.attempt = time.Now()
	c.pending = make(chan struct{})
	c.mu.Unlock()
	release, err := c.fetch(ctx)
	c.mu.Lock()
	c.status.CheckedAt = time.Now()
	c.status.Error = ""
	if err != nil {
		c.status.Error = err.Error()
	} else {
		c.status.Latest = release.Tag
		c.status.Available = Newer(release.Tag, c.status.Current)
	}
	close(c.pending)
	c.pending = nil
	result := c.status
	c.mu.Unlock()
	return result
}

func nextCheck(now time.Time) time.Time {
	next := time.Date(now.Year(), now.Month(), now.Day(), 0, 1, 0, 0, now.Location())
	if !next.After(now) {
		next = next.AddDate(0, 0, 1)
	}
	return next
}

func (c *Checker) Run(ctx context.Context) {
	c.Check(ctx)
	for {
		timer := time.NewTimer(time.Until(nextCheck(time.Now())))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			c.Check(ctx)
		}
	}
}
