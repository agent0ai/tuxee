package server

import (
	"context"
	"log"
	"tuxee/internal/files"
	"tuxee/internal/identity"
)

// Called with settingsMu held so a late checkpoint cannot resurrect a closed panel.
func (s *Server) pruneEditors(ctx context.Context, user identity.User, settings Settings) {
	ids := []string{}
	for _, ws := range settings.Workspaces {
		for _, panel := range ws.Panels {
			if panel.Kind == "files" {
				ids = append(ids, panel.ID)
			}
		}
	}
	if _, err := files.Run(ctx, user, files.Request{Operation: "editor-prune", Instance: s.instanceID, Paths: ids}); err != nil {
		log.Printf("editor cleanup for %s: %v", user.Name, err)
	}
}
