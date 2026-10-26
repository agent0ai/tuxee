package server

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
)

func TestUploadConcurrencySettings(t *testing.T) {
	for _, raw := range []string{"null", "1", "4", "8", "0", "9", "-1", "1.5", `"4"`} {
		t.Run(raw, func(t *testing.T) {
			var value Settings
			err := json.Unmarshal([]byte(`{"theme":"dark","workspaces":[],"uploadConcurrency":`+raw+`}`), &value)
			if err == nil {
				err = validateSettings(&value)
			}
			valid := raw == "null" || raw == "1" || raw == "4" || raw == "8"
			if (err == nil) != valid {
				t.Fatalf("unexpected validation result: %v", err)
			}
			if valid {
				data, err := json.Marshal(value)
				if err != nil {
					t.Fatal(err)
				}
				var restored Settings
				if err = json.Unmarshal(data, &restored); err != nil || !reflect.DeepEqual(value, restored) {
					t.Fatalf("setting did not round-trip: %s, %v", data, err)
				}
			}
		})
	}
	value := Settings{Theme: "dark", Workspaces: []Workspace{}}
	if err := validateSettings(&value); err != nil || value.UploadConcurrency != nil {
		t.Fatalf("missing setting must retain the frontend default: %v", err)
	}
}

func TestTerminalBackgroundSettings(t *testing.T) {
	for _, color := range []string{"", "#1a202c", "#ABCDEF", "#000000", "#ffffff", "red", "#123", "#12345678", "#12345g", " #123456", "rgb(26 32 44)"} {
		t.Run(color, func(t *testing.T) {
			value := Settings{Theme: "dark", Workspaces: []Workspace{}, TerminalBackground: color}
			valid := color == "" || color == "#1a202c" || color == "#ABCDEF" || color == "#000000" || color == "#ffffff"
			if err := validateSettings(&value); (err == nil) != valid {
				t.Fatalf("save validation: %v", err)
			}
			if err := migrateSettings(&value); (err == nil) != valid {
				t.Fatalf("load validation: %v", err)
			}
			if !valid {
				return
			}
			data, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			var restored Settings
			if err := json.Unmarshal(data, &restored); err != nil || restored.TerminalBackground != color {
				t.Fatalf("background did not round-trip: %s, %v", data, err)
			}
			var fields map[string]any
			if err := json.Unmarshal(data, &fields); err != nil {
				t.Fatal(err)
			}
			if _, present := fields["terminalBackground"]; present != (color != "") {
				t.Fatal("reset color must be omitted")
			}
		})
	}
}

func TestEightCellSettings(t *testing.T) {
	for _, grid := range [][2]int{{4, 2}, {2, 4}, {8, 2}, {4, 4}, {2, 2}} {
		value := Settings{Theme: "dark", Current: "ws", Workspaces: []Workspace{{ID: "ws", Name: "Workspace", Columns: grid[0], Rows: grid[1], Panels: []Panel{}}}}
		for i := range 8 {
			value.Workspaces[0].Panels = append(value.Workspaces[0].Panels, Panel{ID: fmt.Sprint(i), Kind: "files", X: i % grid[0], Y: i / grid[0], W: 1, H: 1})
		}
		valid := grid == [2]int{4, 2} || grid == [2]int{2, 4}
		if err := validateSettings(&value); (err == nil) != valid {
			t.Fatalf("grid %v: %v", grid, err)
		}
		value.Workspaces[0].Panels = append(value.Workspaces[0].Panels, Panel{ID: "ninth", Kind: "files", W: 1, H: 1})
		if validateSettings(&value) == nil {
			t.Fatal("accepted ninth panel")
		}
	}
}

func TestLegacyWorkspaceMigration(t *testing.T) {
	for _, count := range []int{0, 4, 8, 9, 16} {
		value := Settings{Theme: "dark", Current: "ws", Workspaces: []Workspace{{ID: "ws", Name: "Workspace", Columns: 8, Rows: 2, Panels: []Panel{}}}}
		for i := range count {
			value.Workspaces[0].Panels = append(value.Workspaces[0].Panels, Panel{ID: fmt.Sprint(i), Kind: "terminal", Path: "/tmp", Terminal: fmt.Sprintf("session-%d", i), X: i % 8, Y: i / 8, W: 1, H: 1})
		}
		value.Workspaces[0].Active = fmt.Sprint(count - 1)
		original := append([]Panel(nil), value.Workspaces[0].Panels...)
		if err := migrateSettings(&value); err != nil {
			t.Fatal(err)
		}
		var panels []Panel
		for _, ws := range value.Workspaces {
			if ws.Columns != 4 || ws.Rows != 2 || len(ws.Panels) > 8 {
				t.Fatalf("invalid migrated workspace: %+v", ws)
			}
			panels = append(panels, ws.Panels...)
			if count > 0 && ws.ID == value.Current && ws.Active != fmt.Sprint(count-1) {
				t.Fatal("lost active panel")
			}
		}
		if len(panels) != count {
			t.Fatal("lost panels")
		}
		for i, p := range panels {
			p.X, p.Y, p.W, p.H = original[i].X, original[i].Y, original[i].W, original[i].H
			if p != original[i] {
				t.Fatal("changed panel metadata or terminal identity")
			}
		}
		before, _ := json.Marshal(value)
		if err := migrateSettings(&value); err != nil {
			t.Fatal(err)
		}
		after, _ := json.Marshal(value)
		if string(before) != string(after) {
			t.Fatal("migration must be idempotent")
		}
	}
}

func TestLegacyWorkspaceGeometry(t *testing.T) {
	value := Settings{Theme: "dark", Current: "ws", Workspaces: []Workspace{{ID: "ws", Name: "Workspace", Columns: 8, Rows: 2, Panels: []Panel{
		{ID: "a", Kind: "files", W: 2, H: 2}, {ID: "b", Kind: "terminal", X: 2, W: 6, H: 2},
	}, Layout: &Layout{Mode: 2, Custom: []PanelPosition{{ID: "a", W: 4, H: 2}, {ID: "b", X: 4, W: 4, H: 2}}}}}}
	if err := migrateSettings(&value); err != nil {
		t.Fatal(err)
	}
	ws := value.Workspaces[0]
	if ws.Panels[0].W != 1 || ws.Panels[1].X != 1 || ws.Panels[1].W != 3 || ws.Layout.Mode != 2 ||
		!reflect.DeepEqual(ws.Layout.Custom, []PanelPosition{{ID: "a", W: 2, H: 2}, {ID: "b", X: 2, W: 2, H: 2}}) {
		t.Fatalf("lost scaled current/custom geometry: %+v", ws)
	}
	value.Workspaces[0].Columns = 8
	value.Workspaces[0].Panels[1].X = 0
	before, _ := json.Marshal(value)
	if migrateSettings(&value) == nil {
		t.Fatal("migration accepted overlapping legacy panels")
	}
	after, _ := json.Marshal(value)
	if string(before) != string(after) {
		t.Fatal("invalid legacy settings were changed")
	}
	value.Workspaces[0].Panels[1].X = 2
	value.Workspaces[0].Layout.Custom = []PanelPosition{{ID: "a", W: 1, H: 2}, {ID: "b", X: 1, W: 1, H: 2}}
	if err := migrateSettings(&value); err != nil || value.Workspaces[0].Layout != nil {
		t.Fatalf("unrepresentable custom snapshot must reset to Custom: %v", err)
	}
}

func TestFullLegacyWorkspaceMigration(t *testing.T) {
	value := Settings{Theme: "dark", Current: "ws-0", Workspaces: []Workspace{}}
	for i := range 12 {
		ws := Workspace{ID: fmt.Sprintf("ws-%d", i), Name: "Workspace", Columns: 8, Rows: 2, Panels: []Panel{}}
		for j := range 16 {
			ws.Panels = append(ws.Panels, Panel{ID: fmt.Sprintf("panel-%d-%d", i, j), Kind: "files", X: j % 8, Y: j / 8, W: 1, H: 1})
		}
		value.Workspaces = append(value.Workspaces, ws)
	}
	if err := migrateSettings(&value); err != nil || len(value.Workspaces) != 24 {
		t.Fatalf("full legacy account could not migrate: %v", err)
	}
	value.Workspaces = append(value.Workspaces, Workspace{ID: "extra", Name: "Extra", Columns: 4, Rows: 2, Panels: []Panel{}})
	if validateSettings(&value) == nil {
		t.Fatal("accepted more than the migration workspace limit")
	}
}
