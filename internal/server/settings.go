package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"unicode/utf16"

	"tuxee/internal/files"
	"tuxee/internal/identity"
	"tuxee/internal/monitor"
)

type Panel struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Path     string `json:"path"`
	Terminal string `json:"terminal,omitempty"`
	X        int    `json:"x"`
	Y        int    `json:"y"`
	W        int    `json:"w"`
	H        int    `json:"h"`
}
type Workspace struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Columns int     `json:"columns"`
	Rows    int     `json:"rows"`
	Panels  []Panel `json:"panels"`
	Active  string  `json:"active"`
	Layout  *Layout `json:"layout,omitempty"`
}
type PanelPosition struct {
	ID string `json:"id"`
	X  int    `json:"x"`
	Y  int    `json:"y"`
	W  int    `json:"w"`
	H  int    `json:"h"`
}
type Layout struct {
	Mode   int             `json:"mode"`
	Custom []PanelPosition `json:"custom"`
}
type Settings struct {
	ServerName         string      `json:"serverName,omitempty"`
	ServerColor        string      `json:"serverColor,omitempty"`
	TerminalBackground string      `json:"terminalBackground,omitempty"`
	UploadConcurrency  *int        `json:"uploadConcurrency,omitempty"`
	Theme              string      `json:"theme"`
	Current            string      `json:"current"`
	Workspaces         []Workspace `json:"workspaces"`
	Monitoring         *Monitoring `json:"monitoring,omitempty"`
}
type Monitoring struct {
	Hidden   bool     `json:"hidden,omitempty"`
	CPU      bool     `json:"cpu"`
	Memory   bool     `json:"memory"`
	Swap     bool     `json:"swap"`
	Disks    []string `json:"disks"`
	Networks []string `json:"networks"`
	Interval int      `json:"interval"`
}

func LoadSettings(ctx context.Context, user identity.User) (Settings, error) {
	value := Settings{Theme: "dark", Workspaces: []Workspace{}}
	response, err := files.Run(ctx, user, files.Request{Operation: "settings-load"})
	if err != nil {
		return value, err
	}
	if err = json.Unmarshal(response.Settings, &value); err != nil {
		return value, err
	}
	err = migrateSettings(&value)
	return value, err
}
func validateSettings(value *Settings) error {
	return validateSettingsGrids(value, false)
}

func validateSettingsGrids(value *Settings, legacy bool) error {
	if n := value.UploadConcurrency; n != nil && (*n < 1 || *n > 8) {
		return errors.New("parallel uploads must be between 1 and 8")
	}
	for name, color := range map[string]string{"color marker": value.ServerColor, "terminal background": value.TerminalBackground} {
		if color == "" {
			continue
		}
		if len(color) != 7 || color[0] != '#' {
			return fmt.Errorf("%s must be a six-digit hex color", name)
		}
		if _, err := hex.DecodeString(color[1:]); err != nil {
			return fmt.Errorf("%s must be a six-digit hex color", name)
		}
	}
	value.ServerName = strings.TrimSpace(value.ServerName)
	// Match the browser input's maxlength, which counts UTF-16 code units.
	if len(utf16.Encode([]rune(value.ServerName))) > 64 || strings.ContainsRune(value.ServerName, 0) {
		return errors.New("server name must be at most 64 characters with no NUL")
	}
	if m := value.Monitoring; m != nil {
		if m.Interval != 2 && m.Interval != 5 && m.Interval != 10 || len(m.Disks) > 8 || len(m.Networks) > 8 || m.Disks == nil || m.Networks == nil {
			return errors.New("invalid monitoring preferences")
		}
		seen := map[string]bool{}
		for _, path := range m.Disks {
			if !filepath.IsAbs(path) || filepath.Clean(path) != path || len(path) > 4096 || strings.ContainsRune(path, 0) || seen[path] {
				return errors.New("invalid monitoring disk")
			}
			seen[path] = true
		}
		seen = map[string]bool{}
		for _, name := range m.Networks {
			if seen[name] || name != monitor.AllNetworks && (name == "" || len(name) > 15 || strings.ContainsAny(name, "/\x00 \t\n")) {
				return errors.New("invalid monitoring interface")
			}
			seen[name] = true
		}
	}
	if value.Workspaces == nil {
		return errors.New("workspaces must be an array")
	}
	if value.Theme != "dark" && value.Theme != "light" {
		return errors.New("theme must be dark or light")
	}
	// Reserve room for splitting the twelve legacy sixteen-panel workspaces without losing sessions.
	if len(value.Workspaces) > 24 {
		return errors.New("at most 24 workspaces are supported")
	}
	seen := map[string]bool{}
	current := value.Current == "" && len(value.Workspaces) == 0
	for _, ws := range value.Workspaces {
		if ws.Panels == nil {
			return errors.New("workspace panels must be an array")
		}
		if ws.ID == "" || len(ws.ID) > 80 || seen[ws.ID] || len(ws.Name) == 0 || len(ws.Name) > 60 {
			return errors.New("invalid or duplicate workspace")
		}
		seen[ws.ID] = true
		if ws.ID == value.Current {
			current = true
		}
		if !(ws.Columns == 4 && ws.Rows == 2 || ws.Columns == 2 && ws.Rows == 4 || legacy && len(value.Workspaces) <= 12 && ws.Columns == 8 && ws.Rows == 2) {
			return errors.New("invalid workspace grid dimensions")
		}
		if len(ws.Panels) > ws.Columns*ws.Rows {
			return errors.New("workspace is full")
		}
		positions := make([]PanelPosition, 0, len(ws.Panels))
		panelIDs := map[string]bool{}
		for _, panel := range ws.Panels {
			if panel.ID == "" || len(panel.ID) > 80 || seen[panel.ID] || panel.Kind != "files" && panel.Kind != "terminal" {
				return errors.New("invalid or duplicate panel")
			}
			seen[panel.ID] = true
			panelIDs[panel.ID] = true
			if panel.Path != "" && (!filepath.IsAbs(panel.Path) || len(panel.Path) > 4096) || len(panel.Terminal) > 80 {
				return errors.New("invalid panel location")
			}
			positions = append(positions, PanelPosition{panel.ID, panel.X, panel.Y, panel.W, panel.H})
		}
		if err := validatePanelPositions(positions, ws.Columns, ws.Rows); err != nil {
			return err
		}
		if layout := ws.Layout; layout != nil {
			if layout.Mode < 1 || layout.Mode > 3 || layout.Custom == nil || len(layout.Custom) != len(ws.Panels) {
				return errors.New("invalid layout cycle")
			}
			for _, position := range layout.Custom {
				if !panelIDs[position.ID] {
					return errors.New("custom layout panels do not match workspace")
				}
				delete(panelIDs, position.ID)
			}
			if err := validatePanelPositions(layout.Custom, ws.Columns, ws.Rows); err != nil {
				return err
			}
		}
	}
	if !current {
		return errors.New("current workspace does not exist")
	}
	return nil
}

func migrateSettings(value *Settings) error {
	if err := validateSettingsGrids(value, true); err != nil {
		return err
	}
	for i := range len(value.Workspaces) {
		ws := &value.Workspaces[i]
		if ws.Columns != 8 {
			continue
		}
		ws.Columns = 4
		var overflow *Workspace
		if len(ws.Panels) > 8 {
			extra := *ws
			extra.ID, extra.Layout = rand.Text(), nil
			if len(extra.Name) <= 56 {
				extra.Name += " (2)"
			}
			extra.Panels = append([]Panel(nil), ws.Panels[8:]...)
			for _, panel := range extra.Panels {
				if panel.ID == ws.Active && value.Current == ws.ID {
					value.Current = extra.ID
				}
			}
			ws.Panels, ws.Layout = ws.Panels[:8], nil
			overflow = &extra
		}
		for _, part := range []*Workspace{ws, overflow} {
			if part == nil {
				continue
			}
			positions := make([]PanelPosition, 0, len(part.Panels))
			for _, p := range part.Panels {
				positions = append(positions, PanelPosition{p.ID, p.X / 2, p.Y, (p.X+p.W+1)/2 - p.X/2, p.H})
			}
			if validatePanelPositions(positions, 4, 2) != nil {
				part.Layout = nil
				for j := range positions {
					positions[j].X, positions[j].Y, positions[j].W, positions[j].H = j%4, j/4, 1, 1
				}
			}
			active := false
			for j, p := range positions {
				part.Panels[j].X, part.Panels[j].Y, part.Panels[j].W, part.Panels[j].H = p.X, p.Y, p.W, p.H
				active = active || p.ID == part.Active
			}
			if !active && len(part.Panels) > 0 {
				part.Active = part.Panels[0].ID
			}
			if layout := part.Layout; layout != nil {
				for j := range layout.Custom {
					p := &layout.Custom[j]
					p.X, p.W = p.X/2, (p.X+p.W+1)/2-p.X/2
				}
				if validatePanelPositions(layout.Custom, 4, 2) != nil {
					part.Layout = nil
				}
			}
		}
		if overflow != nil {
			value.Workspaces = append(value.Workspaces, *overflow)
		}
	}
	return validateSettings(value)
}

func validatePanelPositions(positions []PanelPosition, columns, rows int) error {
	cells := make([]bool, columns*rows)
	for _, panel := range positions {
		if panel.X < 0 || panel.Y < 0 || panel.W < 1 || panel.H < 1 || panel.X > columns || panel.Y > rows || panel.W > columns-panel.X || panel.H > rows-panel.Y {
			return errors.New("panel exceeds workspace grid")
		}
		for y := panel.Y; y < panel.Y+panel.H; y++ {
			for x := panel.X; x < panel.X+panel.W; x++ {
				i := y*columns + x
				if cells[i] {
					return errors.New("workspace panels overlap")
				}
				cells[i] = true
			}
		}
	}
	return nil
}
