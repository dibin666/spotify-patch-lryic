package patcher

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestParseArgs(t *testing.T) {
	cases := []struct {
		args []string
		want Options
	}{
		{nil, Options{Command: "install", Restart: "auto"}},
		{[]string{"status"}, Options{Command: "status", Restart: "auto"}},
		{[]string{"--mode", "local", "-y"}, Options{Command: "install", Mode: ModeLocal, Yes: true, Restart: "auto"}},
		{[]string{"apply", "--mode=direct", "--no-restart", "--quiet"}, Options{Command: "apply", Mode: ModeDirect, Restart: "no", Quiet: true}},
		{[]string{"--server", "https://lyrics.example.com/", "--hook"}, Options{Command: "install", Server: "https://lyrics.example.com", Hook: "on", Restart: "auto"}},
		/* PowerShell-style options of the old patch.ps1. */
		{[]string{"-Server", "https://a.example", "-NoRestart", "-SpotifyPath", `C:\Spotify`}, Options{Command: "install", Server: "https://a.example", Restart: "no", SpotifyPath: `C:\Spotify`}},
		{[]string{"-Direct"}, Options{Command: "install", Mode: ModeDirect, Restart: "auto"}},
		{[]string{"--no-direct", "--no-hook"}, Options{Command: "install", Mode: ModeCloud, Hook: "off", Restart: "auto"}},
		{[]string{"--local", "restore"}, Options{Command: "restore", Mode: ModeLocal, Restart: "auto"}},
	}
	for _, c := range cases {
		got, err := ParseArgs(c.args)
		if err != nil {
			t.Errorf("ParseArgs(%q): %v", c.args, err)
			continue
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("ParseArgs(%q) = %+v, want %+v", c.args, got, c.want)
		}
	}
	for _, bad := range [][]string{{"--mode", "nope"}, {"--server", "ftp://x"}, {"frobnicate"}, {"--what"}, {"--server"}} {
		if _, err := ParseArgs(bad); err == nil {
			t.Errorf("ParseArgs(%q) accepted", bad)
		}
	}
}

func TestBuildBundle(t *testing.T) {
	a := BuildBundle("9.9.9", ModeLocal, "https://s.example")
	js := string(a.JS)
	for _, placeholder := range []string{"__SPOT_LYRIC_VERSION__", "__SPOT_LYRIC_SERVER__", "__SPOT_LYRIC_MODE__", "__SPOT_LYRIC_LOCAL__"} {
		if strings.Contains(js, "'"+placeholder+"'") {
			t.Errorf("%s not replaced", placeholder)
		}
	}
	for _, want := range []string{"const PATCH_MODE = 'local'", "const DEFAULT_SERVER = 'https://s.example'", "const LOCAL_SERVICE = '" + LocalURL + "'", "SpotLyricCore"} {
		if !strings.Contains(js, want) {
			t.Errorf("bundle lacks %q", want)
		}
	}
	if !strings.HasPrefix(js, "/* Spot-Lyric for Spotify v9.9.9 - generated, do not edit */\n") {
		t.Error("bundle header")
	}
	if b := BuildBundle("9.9.9", ModeLocal, "https://s.example"); b.Digest != a.Digest {
		t.Error("digest is not deterministic")
	}
	if b := BuildBundle("9.9.9", ModeCloud, "https://s.example"); b.Digest == a.Digest {
		t.Error("mode does not change the build digest")
	}
}

/* fakeSpa writes a small archive shaped like Spotify's xpui.spa. */
func fakeSpa(t *testing.T, path string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for _, f := range []struct{ name, body string }{
		{"index.html", "<!doctype html><html><head></head><body><div id=\"main\"></div></body></html>"},
		{"xpui.js", strings.Repeat("console.log('spotify');\n", 200)},
		{"images/a.svg", "<svg/>"},
	} {
		fw, err := w.Create(f.name)
		if err != nil {
			t.Fatal(err)
		}
		fw.Write([]byte(f.body))
	}
	w.SetComment("spotify")
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func zipNames(t *testing.T, path string) []string {
	t.Helper()
	r, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	var names []string
	for _, f := range r.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := bytes.NewBuffer(nil).ReadFrom(rc); err != nil {
			t.Fatalf("%s: %v", f.Name, err) // CRC check of every entry
		}
		rc.Close()
		names = append(names, f.Name)
	}
	return names
}

func TestPatchSpaRoundTrip(t *testing.T) {
	apps := filepath.Join(t.TempDir(), "Apps")
	spa := filepath.Join(apps, "xpui.spa")
	original := fakeSpa(t, spa)
	b := BuildBundle("1.0.0", ModeCloud, DefaultServer)

	result, err := PatchApps(apps, "1.0.0", b)
	if err != nil || !strings.HasPrefix(result, "PATCHED") {
		t.Fatalf("patch: %q %v", result, err)
	}
	if backup, _ := os.ReadFile(spa + backupSuffix); !bytes.Equal(backup, original) {
		t.Error("backup differs from the original")
	}
	names := strings.Join(zipNames(t, spa), ",")
	if names != "index.html,xpui.js,images/a.svg,spot-lyric/spot-lyric.js,spot-lyric/spot-lyric.css" {
		t.Errorf("entries: %s", names)
	}
	html, _ := readZipEntry(spa, "index.html")
	if strings.Count(html, "spot-lyric:start") != 1 || !strings.Contains(html, `src="/spot-lyric/spot-lyric.js"></script><!-- spot-lyric:end --></body>`) {
		t.Errorf("index.html: %s", html)
	}
	if got := StatusApps(apps); got != "spa patched v1.0.0 "+b.Digest+" backup" {
		t.Errorf("status: %s", got)
	}
	if result, _ := PatchApps(apps, "1.0.0", b); result != "UNCHANGED" {
		t.Errorf("second patch: %s", result)
	}
	/* Another mode rebuilds from the backup: still one block. */
	local := BuildBundle("1.0.0", ModeLocal, DefaultServer)
	if result, _ := PatchApps(apps, "1.0.0", local); !strings.HasPrefix(result, "PATCHED") {
		t.Errorf("mode change: %s", result)
	}
	html, _ = readZipEntry(spa, "index.html")
	if strings.Count(html, "spot-lyric:start") != 1 || marker(html) != "1.0.0 "+local.Digest {
		t.Errorf("after mode change: %s", html)
	}
	/* Spotify updates itself: the new archive becomes the backup. */
	updated := fakeSpa(t, spa)
	if result, _ := PatchApps(apps, "1.0.0", b); !strings.HasPrefix(result, "PATCHED") {
		t.Errorf("after update: %s", result)
	}
	if backup, _ := os.ReadFile(spa + backupSuffix); !bytes.Equal(backup, updated) {
		t.Error("backup is not the updated archive")
	}
	if result, err := RestoreApps(apps); result != "RESTORED" || err != nil {
		t.Fatalf("restore: %s %v", result, err)
	}
	if data, _ := os.ReadFile(spa); !bytes.Equal(data, updated) {
		t.Error("restore is not byte-identical")
	}
	if isFile(spa + backupSuffix) {
		t.Error("backup left behind")
	}
	if result, _ := RestoreApps(apps); result != "NOT_PATCHED" {
		t.Errorf("second restore: %s", result)
	}

	/* Restore without a backup strips the plugin from the archive. */
	PatchApps(apps, "1.0.0", b)
	os.Remove(spa + backupSuffix)
	if result, err := RestoreApps(apps); result != "RESTORED" || err != nil {
		t.Fatalf("restore without backup: %s %v", result, err)
	}
	if names := strings.Join(zipNames(t, spa), ","); names != "index.html,xpui.js,images/a.svg" {
		t.Errorf("entries after restore: %s", names)
	}
	if html, _ := readZipEntry(spa, "index.html"); marker(html) != "" || strings.Contains(html, "spot-lyric") {
		t.Errorf("index.html after restore: %s", html)
	}
	/* Patched archive without backup cannot be re-patched safely. */
	PatchApps(apps, "1.0.0", b)
	os.Remove(spa + backupSuffix)
	if _, err := PatchApps(apps, "1.0.1", b); err == nil {
		t.Error("patch without backup accepted")
	}
}

func TestPatchDirectory(t *testing.T) {
	apps := filepath.Join(t.TempDir(), "Apps")
	index := filepath.Join(apps, "xpui", "index.html")
	os.MkdirAll(filepath.Dir(index), 0o755)
	os.WriteFile(index, []byte("<html><body></body></html>"), 0o644)
	b := BuildBundle("1.0.0", ModeDirect, DefaultServer)
	if result, err := PatchApps(apps, "1.0.0", b); err != nil || !strings.HasPrefix(result, "PATCHED") {
		t.Fatalf("%s %v", result, err)
	}
	if !isFile(filepath.Join(apps, "xpui", "spot-lyric", "spot-lyric.js")) || StatusApps(apps) != "dir patched v1.0.0 "+b.Digest {
		t.Error("directory patch")
	}
	if result, _ := RestoreApps(apps); result != "RESTORED" {
		t.Error("directory restore")
	}
	if data, _ := os.ReadFile(index); string(data) != "<html><body></body></html>" || isDir(filepath.Join(apps, "xpui", "spot-lyric")) {
		t.Errorf("after restore: %s", data)
	}
}

func TestLinuxDirectDesktopEntry(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	system := filepath.Join(home, "system.desktop")
	os.WriteFile(system, []byte("[Desktop Entry]\nName=Spotify\nExec=spotify %U\nX-Spot-Lyric=old\n\n[Desktop Action Next]\nExec=spotify --next\n"), 0o644)
	saved := desktopSources
	desktopSources = func(*Ctx) []string { return []string{system} }
	defer func() { desktopSources = saved }()

	c := &Ctx{OS: "linux", Home: home, DataDir: filepath.Join(home, "data"), Opts: Options{Quiet: true}, out: &bytes.Buffer{}}
	if c.DirectEnabled() {
		t.Fatal("enabled before")
	}
	for i := 0; i < 2; i++ { // idempotent
		if err := c.EnableDirect(); err != nil {
			t.Fatal(err)
		}
	}
	data, _ := os.ReadFile(c.desktopOverride())
	profile := filepath.Join(home, ".config", "spotify-direct")
	want := "[Desktop Entry]\nName=Spotify\nExec=spotify --disable-web-security --user-data-dir=" + profile + " %U\n\n" +
		"[Desktop Action Next]\nExec=spotify --disable-web-security --user-data-dir=" + profile + " --next\nX-Spot-Lyric=direct\n"
	if string(data) != want {
		t.Errorf("desktop entry:\n%s\nwant:\n%s", data, want)
	}
	if target, err := os.Readlink(profile); err != nil || target != filepath.Join(home, ".config", "spotify") {
		t.Errorf("profile link: %s %v", target, err)
	}
	if !c.DirectEnabled() {
		t.Error("not enabled")
	}
	c.DisableDirect()
	if c.DirectEnabled() || isFile(c.desktopOverride()) {
		t.Error("still enabled")
	}
	if _, err := os.Lstat(profile); err == nil {
		t.Error("profile link left behind")
	}
}

func TestDirectUnsupportedOnMac(t *testing.T) {
	c := &Ctx{OS: "macos", Opts: Options{Quiet: true}, out: &bytes.Buffer{}}
	if c.DirectSupported() || c.EnableDirect() == nil {
		t.Error("macOS direct mode must be refused")
	}
}

func TestHookArgs(t *testing.T) {
	c := &Ctx{OS: "linux", SpotifyDir: "/usr/share/spotify"}
	got := strings.Join(c.hookArgs(ModeCloud, "https://s.example"), " ")
	if got != "apply --yes --quiet --mode cloud --server https://s.example --spotify-path /usr/share/spotify --no-restart" {
		t.Errorf("linux: %s", got)
	}
	c.OS = "windows"
	if got := strings.Join(c.hookArgs(ModeLocal, "https://x.example"), " "); got != "apply --yes --quiet --mode local --server https://x.example --spotify-path /usr/share/spotify" {
		t.Errorf("windows: %s", got)
	}
	/* Every hook command must parse, and keep its mode even with a server. */
	opts, err := ParseArgs(c.hookArgs(ModeDirect, DefaultServer))
	if err != nil || opts.Mode != ModeDirect || opts.Command != "apply" || !opts.Yes {
		t.Errorf("%+v %v", opts, err)
	}
}
