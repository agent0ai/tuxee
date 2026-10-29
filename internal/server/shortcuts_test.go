package server

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestShortcutSettings(t *testing.T) {
	for _, test := range []struct {
		raw   string
		valid bool
	}{
		{`{}`, true}, {`{"shortcuts":null}`, true},
		{`{"shortcuts":{"app.about":[["Control+Shift+Space","KeyI"],["Meta+F2"]],"audio.mute":[[],[]]}}`, true},
		{`{"shortcuts":{"app.about":[["Alt+KeyA","Shift+KeyB","Digit1"],[]]}}`, true},
		{`{"shortcuts":{"panel.close":[["Alt+Shift+KeyW"],[]]}}`, true},
		{`{"shortcuts":{"desktop.close":[["Alt+Shift+KeyC"],[]]}}`, true},
		{`{"shortcuts":{"app.about":[["KeyA"],[]]}}`, false},
		{`{"shortcuts":{"app.about":[["Shift+KeyA"],[]]}}`, false},
		{`{"shortcuts":{"app.about":[["Control+Escape"],[]]}}`, false},
		{`{"shortcuts":{"app.about":[["Shift+Control+KeyA"],[]]}}`, false},
		{`{"shortcuts":{"app.about":[["Control+KeyA","KeyB","KeyC","KeyD"],[]]}}`, false},
		{`{"shortcuts":{"app.about":[["F13"],[]]}}`, false},
		{`{"shortcuts":{"app.about":[null,[]]}}`, false},
		{`{"shortcuts":{"app.about":[[]]}}`, false},
		{`{"shortcuts":{"app.about":[[],[],[]]}}`, false},
		{`{"shortcuts":{"app.about":[["Control+KeyA"],["Control+KeyA","KeyB"]]}}`, false},
		{`{"shortcuts":{"app.about":[["F2"],[]],"app.settings":[[],["F2"]]}}`, false},
		{`{"shortcuts":{"desktop.11":[[],[]]}}`, false},
		{`{"shortcuts":{"__proto__":[[],[]]}}`, false},
		{`{"shortcuts":{"app.about":"F2"}}`, false},
	} {
		settings := Settings{Theme: "dark", Workspaces: []Workspace{}}
		err := json.Unmarshal([]byte(test.raw), &settings)
		if err == nil {
			err = validateSettings(&settings)
		}
		if (err == nil) != test.valid {
			t.Fatalf("%s: %v", test.raw, err)
		}
		if !test.valid {
			continue
		}
		data, err := json.Marshal(settings)
		var loaded Settings
		if err != nil || json.Unmarshal(data, &loaded) != nil || migrateSettings(&loaded) != nil || !reflect.DeepEqual(settings, loaded) {
			t.Fatalf("shortcut round-trip: %s", data)
		}
	}
}
