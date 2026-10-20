package web

import (
	"embed"
	"io/fs"
)

//go:embed dist
var assets embed.FS

func Assets() fs.FS {
	value, err := fs.Sub(assets, "dist")
	if err != nil {
		panic(err)
	}
	return value
}
