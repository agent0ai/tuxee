package update

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
	_ "time/tzdata"

	"tuxee/internal/i18n"
)

type Schedule struct {
	Enabled  bool   `json:"enabled"`
	Hour     int    `json:"hour"`
	Timezone string `json:"timezone"`
	location *time.Location
}

func (s *Schedule) UnmarshalJSON(data []byte) error {
	var fields struct {
		Enabled  *bool  `json:"enabled"`
		Hour     *int   `json:"hour"`
		Timezone string `json:"timezone"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fields); err != nil || fields.Enabled == nil || fields.Hour == nil {
		return i18n.New("backend.server.invalidRequestBody")
	}
	*s = Schedule{Enabled: *fields.Enabled, Hour: *fields.Hour, Timezone: fields.Timezone}
	return s.validate()
}

func (s *Schedule) validate() error {
	if s.Hour < 0 || s.Hour > 23 || s.Timezone == "" || len(s.Timezone) > 128 {
		return i18n.New("backend.server.invalidRequestBody")
	}
	loc, err := time.LoadLocation(s.Timezone)
	if err != nil {
		return i18n.New("backend.server.invalidRequestBody")
	}
	s.location = loc
	return nil
}

// Disabled schedules keep the original daily check in server-local time.
func (s Schedule) nextCheck(now time.Time) time.Time {
	hour, minute := 0, 1
	if s.Enabled {
		now = now.In(s.location)
		hour, minute = s.Hour, 0
	}
	for day := now.Day(); ; day++ {
		next := time.Date(now.Year(), now.Month(), day, hour, minute, 0, 0, now.Location())
		// Date selects one occurrence of a repeated hour. Skip a nonexistent hour.
		if next.Hour() == hour && next.Minute() == minute && next.After(now) {
			return next
		}
	}
}

func (c *Checker) loadSchedule(state string) error {
	c.schedulePath = filepath.Join(state, "auto-update.json")
	c.schedule = Schedule{Hour: 4, Timezone: "Local", location: time.Local}
	data, err := os.ReadFile(c.schedulePath)
	if errors.Is(err, os.ErrNotExist) {
		c.schedule.Enabled, err = inTuxeeContainer()
		return err
	}
	if err != nil {
		return err
	}
	var saved Schedule
	if err := json.Unmarshal(data, &saved); err != nil {
		return err
	}
	c.schedule = saved
	return nil
}

func (c *Checker) Schedule() Schedule {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.schedule
}

func (c *Checker) SaveSchedule(s Schedule) error {
	if c.schedulePath == "" {
		return i18n.New("backend.server.updateChecksUnavailable")
	}
	if err := s.validate(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	f, err := os.CreateTemp(filepath.Dir(c.schedulePath), ".auto-update-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if err := json.NewEncoder(f).Encode(s); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(f.Name(), c.schedulePath); err != nil {
		return err
	}
	c.schedule = s
	select {
	case c.changed <- struct{}{}:
	default:
	}
	return nil
}
