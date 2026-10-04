/*
Package spotlyric holds the files the spot-lyric program ships: the plugin
injected into Spotify (src/) and the version number.
*/
package spotlyric

import (
	_ "embed"
	"strings"
)

//go:embed VERSION
var versionFile string

//go:embed src/core.js
var CoreJS string

//go:embed src/app.js
var AppJS string

//go:embed src/app.css
var AppCSS string

/* Version is the release version (VERSION file). */
func Version() string { return strings.TrimSpace(versionFile) }
