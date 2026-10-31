package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"strings"
	"tuxee/internal/i18n"
	"unicode"
	"unicode/utf16"

	"tuxee/internal/files"
	"tuxee/internal/identity"
	"tuxee/internal/monitor"
)

const (
	maxShellCommandBytes       = 4096
	maxDefaultDirectoryBytes   = 4096
	minUploadConcurrency       = 1
	maxUploadConcurrency       = 64
	minTerminalFontSize        = 6
	maxTerminalFontSize        = 128
	maxTerminalFontFamilyUnits = 512
	maxServerNameUnits         = 64
	maxWorkspaces              = 24
)

type Panel struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Path     string `json:"path"`
	Terminal string `json:"terminal,omitempty"`
	Pinned   bool   `json:"pinned,omitempty"`
	X        int    `json:"x"`
	Y        int    `json:"y"`
	W        int    `json:"w"`
	H        int    `json:"h"`
}
type Workspace struct {
	DefaultDirectory string  `json:"defaultDirectory,omitempty"`
	ID               string  `json:"id"`
	Name             string  `json:"name"`
	Columns          int     `json:"columns"`
	Rows             int     `json:"rows"`
	Panels           []Panel `json:"panels"`
	Active           string  `json:"active"`
	Layout           *Layout `json:"layout,omitempty"`
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
	HowToSeen                  bool                  `json:"howToSeen,omitempty"`
	Shortcuts                  map[string][][]string `json:"shortcuts,omitempty"`
	ClosedTerminalHistoryHours *int                  `json:"closedTerminalHistoryHours,omitempty"`
	ShellCommand               string                `json:"shellCommand,omitempty"`
	UseTuxeePrompt             *bool                 `json:"useTuxeePrompt,omitempty"`
	DefaultDirectory           string                `json:"defaultDirectory,omitempty"`
	ServerName                 string                `json:"serverName,omitempty"`
	ServerColor                string                `json:"serverColor,omitempty"`
	TerminalBackground         string                `json:"terminalBackground,omitempty"`
	TerminalBackgroundLight    string                `json:"terminalBackgroundLight,omitempty"`
	TerminalFontSize           *int                  `json:"terminalFontSize,omitempty"`
	TerminalFontFamily         string                `json:"terminalFontFamily,omitempty"`
	UploadConcurrency          *int                  `json:"uploadConcurrency,omitempty"`
	EditorLineWrap             *bool                 `json:"editorLineWrap,omitempty"`
	Theme                      string                `json:"theme"`
	Current                    string                `json:"current"`
	Workspaces                 []Workspace           `json:"workspaces"`
	Monitoring                 *Monitoring           `json:"monitoring,omitempty"`
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
	if err := validateShortcuts(value.Shortcuts); err != nil {
		return err
	}
	if n := value.ClosedTerminalHistoryHours; n != nil && (*n < 0 || *n > files.MaxClosedHistoryHours) {
		return i18n.New("backend.server.closedHistoryHoursRange", i18n.Vars{"min": 0, "max": files.MaxClosedHistoryHours})
	}
	value.ShellCommand = strings.TrimSpace(value.ShellCommand)
	if len(value.ShellCommand) > maxShellCommandBytes || strings.ContainsAny(value.ShellCommand, "\x00\r\n") {
		return i18n.New("backend.server.shellCommandLimit", i18n.Vars{"maxBytes": maxShellCommandBytes})
	}
	if err := validateDefaultDirectory(value.DefaultDirectory); err != nil {
		return err
	}
	if n := value.UploadConcurrency; n != nil && (*n < minUploadConcurrency || *n > maxUploadConcurrency) {
		return i18n.New("backend.server.uploadConcurrencyRange", i18n.Vars{"min": minUploadConcurrency, "max": maxUploadConcurrency})
	}
	if n := value.TerminalFontSize; n != nil && (*n < minTerminalFontSize || *n > maxTerminalFontSize) {
		return i18n.New("backend.server.terminalFontSizeRange", i18n.Vars{"min": minTerminalFontSize, "max": maxTerminalFontSize})
	}
	value.TerminalFontFamily = strings.TrimSpace(value.TerminalFontFamily)
	// xterm inserts this value into its renderer stylesheet.
	if len(utf16.Encode([]rune(value.TerminalFontFamily))) > maxTerminalFontFamilyUnits || strings.ContainsAny(value.TerminalFontFamily, ";{}\\<>") || strings.Contains(value.TerminalFontFamily, "/*") || strings.IndexFunc(value.TerminalFontFamily, unicode.IsControl) >= 0 {
		return i18n.New("backend.server.terminalFontFamilyInvalid", i18n.Vars{"max": maxTerminalFontFamilyUnits})
	}
	for name, color := range map[string]string{"settings.colorMarkerField": value.ServerColor, "settings.backgroundField": value.TerminalBackground, "settings.lightBackgroundField": value.TerminalBackgroundLight} {
		if color == "" {
			continue
		}
		if len(color) != 7 || color[0] != '#' {
			return i18n.New("backend.server.mustBeASixDigitHexColor", i18n.Vars{"name": &i18n.Message{Key: name}})
		}
		if _, err := hex.DecodeString(color[1:]); err != nil {
			return i18n.New("backend.server.mustBeASixDigitHexColor", i18n.Vars{"name": &i18n.Message{Key: name}})
		}
	}
	value.ServerName = strings.TrimSpace(value.ServerName)
	// Match the browser input's maxlength, which counts UTF-16 code units.
	if len(utf16.Encode([]rune(value.ServerName))) > maxServerNameUnits || strings.ContainsRune(value.ServerName, 0) {
		return i18n.New("backend.server.serverNameLimit", i18n.Vars{"max": maxServerNameUnits})
	}
	if m := value.Monitoring; m != nil {
		if m.Interval != 2 && m.Interval != 5 && m.Interval != 10 || len(m.Disks) > 8 || len(m.Networks) > 8 || m.Disks == nil || m.Networks == nil {
			return i18n.New("backend.server.invalidMonitoringPreferences")
		}
		seen := map[string]bool{}
		for _, path := range m.Disks {
			if !filepath.IsAbs(path) || filepath.Clean(path) != path || len(path) > maxDefaultDirectoryBytes || strings.ContainsRune(path, 0) || seen[path] {
				return i18n.New("backend.server.invalidMonitoringDisk")
			}
			seen[path] = true
		}
		seen = map[string]bool{}
		for _, name := range m.Networks {
			if seen[name] || name != monitor.AllNetworks && (name == "" || len(name) > 15 || strings.ContainsAny(name, "/\x00 \t\n")) {
				return i18n.New("backend.server.invalidMonitoringInterface")
			}
			seen[name] = true
		}
	}
	if value.Workspaces == nil {
		return i18n.New("backend.server.workspacesMustBeAnArray")
	}
	if value.Theme != "dark" && value.Theme != "light" {
		return i18n.New("backend.server.themeMustBeDarkOrLight")
	}
	// Reserve room for splitting the twelve legacy sixteen-panel workspaces without losing sessions.
	if len(value.Workspaces) > maxWorkspaces {
		return i18n.New("backend.server.workspaceCountLimit", i18n.Vars{"max": maxWorkspaces})
	}
	seen := map[string]bool{}
	current := value.Current == "" && len(value.Workspaces) == 0
	for _, ws := range value.Workspaces {
		if err := validateDefaultDirectory(ws.DefaultDirectory); err != nil {
			return err
		}
		if ws.Panels == nil {
			return i18n.New("backend.server.workspacePanelsMustBeAnArray")
		}
		if ws.ID == "" || len(ws.ID) > 80 || seen[ws.ID] || len(ws.Name) == 0 || len(ws.Name) > 60 {
			return i18n.New("backend.server.invalidOrDuplicateWorkspace")
		}
		seen[ws.ID] = true
		if ws.ID == value.Current {
			current = true
		}
		if !(ws.Columns == 4 && ws.Rows == 2 || ws.Columns == 2 && ws.Rows == 4 || legacy && len(value.Workspaces) <= 12 && ws.Columns == 8 && ws.Rows == 2) {
			return i18n.New("backend.server.invalidWorkspaceGridDimensions")
		}
		if len(ws.Panels) > ws.Columns*ws.Rows {
			return i18n.New("backend.server.workspaceIsFull")
		}
		positions := make([]PanelPosition, 0, len(ws.Panels))
		panelIDs := map[string]bool{}
		for _, panel := range ws.Panels {
			if panel.ID == "" || len(panel.ID) > 80 || seen[panel.ID] || panel.Kind != "files" && panel.Kind != "terminal" {
				return i18n.New("backend.server.invalidOrDuplicatePanel")
			}
			seen[panel.ID] = true
			panelIDs[panel.ID] = true
			if panel.Path != "" && !(panel.Kind == "files" && panel.Path == files.TrashPath) && (!filepath.IsAbs(panel.Path) || len(panel.Path) > 4096) || len(panel.Terminal) > 80 {
				return i18n.New("backend.server.invalidPanelLocation")
			}
			positions = append(positions, PanelPosition{panel.ID, panel.X, panel.Y, panel.W, panel.H})
		}
		if err := validatePanelPositions(positions, ws.Columns, ws.Rows); err != nil {
			return err
		}
		if layout := ws.Layout; layout != nil {
			if layout.Mode < 1 || layout.Mode > 3 || layout.Custom == nil || len(layout.Custom) != len(ws.Panels) {
				return i18n.New("backend.server.invalidLayoutCycle")
			}
			for _, position := range layout.Custom {
				if !panelIDs[position.ID] {
					return i18n.New("backend.server.customLayoutPanelsDoNotMatchWorkspace")
				}
				delete(panelIDs, position.ID)
			}
			if err := validatePanelPositions(layout.Custom, ws.Columns, ws.Rows); err != nil {
				return err
			}
		}
	}
	if !current {
		return i18n.New("backend.server.currentWorkspaceDoesNotExist")
	}
	return nil
}

func validateDefaultDirectory(path string) error {
	if len(path) > maxDefaultDirectoryBytes || strings.ContainsRune(path, 0) || path != "" && path != "~" && !strings.HasPrefix(path, "~/") && !filepath.IsAbs(path) {
		return i18n.New("backend.server.defaultDirectoryFormat", i18n.Vars{"maxBytes": maxDefaultDirectoryBytes})
	}
	return nil
}

func (s Settings) defaultDirectory(home string) string {
	if s.DefaultDirectory == "" || s.DefaultDirectory == "~" {
		return home
	}
	if strings.HasPrefix(s.DefaultDirectory, "~/") {
		return filepath.Join(home, s.DefaultDirectory[2:])
	}
	return s.DefaultDirectory
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
			return i18n.New("backend.server.panelExceedsWorkspaceGrid")
		}
		for y := panel.Y; y < panel.Y+panel.H; y++ {
			for x := panel.X; x < panel.X+panel.W; x++ {
				i := y*columns + x
				if cells[i] {
					return i18n.New("backend.server.workspacePanelsOverlap")
				}
				cells[i] = true
			}
		}
	}
	return nil
}

func (s Settings) terminalColors() (string, string) {
	if s.Theme == "light" {
		background := s.TerminalBackgroundLight
		if background == "" {
			background = "#f8f9fc"
		}
		return background, "#1c2638"
	}
	return s.TerminalBackground, "#e6edf3"
}
