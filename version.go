/* Package spotlyric carries the release version (VERSION file) into the server program. */
package spotlyric

import (
	_ "embed"
	"strings"
)

//go:embed VERSION
var versionFile string

/* Version is the release version. */
func Version() string { return strings.TrimSpace(versionFile) }
