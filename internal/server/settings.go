package server

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"

	"tuxee/internal/files"
	"tuxee/internal/identity"
	"tuxee/internal/monitor"
)

type Panel struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Path     string `json:"path"`
	Name     string `json:"name,omitempty"`
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
	Theme      string      `json:"theme"`
	Current    string      `json:"current"`
	Workspaces []Workspace `json:"workspaces"`
	Monitoring *Monitoring `json:"monitoring,omitempty"`
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
	return value, validateSettings(value)
}
func validateSettings(value Settings) error {
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
	if len(value.Workspaces) > 12 {
		return errors.New("at most 12 workspaces are supported")
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
		if !(ws.Columns == 4 && ws.Rows == 2 || ws.Columns == 2 && ws.Rows == 4 || ws.Columns == 8 && ws.Rows == 2) {
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
			if len(panel.Name) > 80 || strings.ContainsRune(panel.Name, 0) || panel.Name != "" && panel.Kind != "files" {
				return errors.New("invalid file browser name")
			}
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
