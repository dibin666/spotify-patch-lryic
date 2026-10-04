package patcher

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	spotlyric "github.com/dibin666/spotify-patch-lryic"
)

/*
The plugin lives in xpui.spa (a zip archive) next to Spotify's own UI:
spot-lyric/spot-lyric.{js,css} plus one marked block in index.html. The original
archive is kept as xpui.spa.spot-lyric.bak, so restoring is byte-identical. The
marker records the plugin version and a digest of the build, so an unchanged
build is not written again. Same layout as earlier releases of the patch scripts.
*/

const (
	assetDir     = "spot-lyric"
	backupSuffix = ".spot-lyric.bak"
)

var (
	blockRe  = regexp.MustCompile(`(?s)<!-- spot-lyric:start[^>]*-->.*?<!-- spot-lyric:end -->`)
	markerRe = regexp.MustCompile(`<!-- spot-lyric:start v(\S+) sha=(\w+) -->`)
)

/* Bundle is the plugin built for one configuration. */
type Bundle struct {
	JS, CSS []byte
	Digest  string
}

/* BuildBundle fills in version, mode and server addresses. */
func BuildBundle(version, mode, server string) Bundle {
	app := strings.NewReplacer(
		"__SPOT_LYRIC_VERSION__", version,
		"__SPOT_LYRIC_SERVER__", server,
		"__SPOT_LYRIC_MODE__", mode,
		"__SPOT_LYRIC_LOCAL__", LocalURL,
	).Replace(spotlyric.AppJS)
	js := []byte(fmt.Sprintf("/* Spot-Lyric for Spotify v%s - generated, do not edit */\n", version) + spotlyric.CoreJS + "\n" + app)
	css := []byte(spotlyric.AppCSS)
	return Bundle{JS: js, CSS: css, Digest: digest(js, css)}
}

/* sha256(js + "\0" + css), first 16 hex digits. */
func digest(js, css []byte) string {
	h := sha256.New()
	h.Write(js)
	h.Write([]byte{0})
	h.Write(css)
	return hex.EncodeToString(h.Sum(nil))[:16]
}

func marker(html string) string {
	if m := markerRe.FindStringSubmatch(html); m != nil {
		return m[1] + " " + m[2]
	}
	return ""
}

func inject(html, version, digest string) string {
	html = blockRe.ReplaceAllString(html, "")
	block := fmt.Sprintf(`<!-- spot-lyric:start v%s sha=%s --><link rel="stylesheet" href="/%s/spot-lyric.css"><script defer="defer" src="/%s/spot-lyric.js"></script><!-- spot-lyric:end -->`,
		version, digest, assetDir, assetDir)
	if i := strings.Index(html, "</body>"); i >= 0 {
		return html[:i] + block + html[i:]
	}
	return html + block
}

func readZipEntry(path, name string) (string, error) {
	r, err := zip.OpenReader(path)
	if err != nil {
		return "", err
	}
	defer r.Close()
	for _, f := range r.File {
		if f.Name == name {
			rc, err := f.Open()
			if err != nil {
				return "", err
			}
			defer rc.Close()
			data, err := io.ReadAll(rc)
			return string(data), err
		}
	}
	return "", fmt.Errorf("%s 中没有 %s", path, name)
}

/* writeSpa writes source's entries (without index.html and old plugin files) plus
 * the new index.html and assets to a temporary file next to target, then swaps it in. */
func writeSpa(source, target, html string, assets map[string][]byte) error {
	r, err := zip.OpenReader(source)
	if err != nil {
		return err
	}
	/* Closed before the rename: Windows cannot replace a file that is still open. */
	defer func() {
		if r != nil {
			r.Close()
		}
	}()
	info, err := os.Stat(target)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(target), ".xpui-*.spa")
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		if !ok {
			tmp.Close()
			os.Remove(tmp.Name())
		}
	}()
	w := zip.NewWriter(tmp)
	write := func(name string, data []byte, modified time.Time) error {
		f, err := w.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: modified})
		if err != nil {
			return err
		}
		_, err = f.Write(data)
		return err
	}
	wroteIndex := false
	for _, f := range r.File {
		switch {
		case strings.HasPrefix(f.Name, assetDir+"/"):
			continue
		case f.Name == "index.html":
			if err := write("index.html", []byte(html), f.Modified); err != nil {
				return err
			}
			wroteIndex = true
		default:
			if err := w.Copy(f); err != nil {
				return err
			}
		}
	}
	if !wroteIndex {
		return errors.New("xpui.spa 中没有 index.html")
	}
	for _, name := range []string{"spot-lyric.js", "spot-lyric.css"} {
		if data, found := assets[name]; found {
			if err := write(assetDir+"/"+name, data, time.Now()); err != nil {
				return err
			}
		}
	}
	if r.Comment != "" {
		_ = w.SetComment(r.Comment)
	}
	if err := w.Close(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	/* CreateTemp makes 0600 files: keep the archive readable for Spotify (root-owned installs). */
	_ = os.Chmod(tmp.Name(), info.Mode().Perm())
	r.Close()
	r = nil
	if err := os.Rename(tmp.Name(), target); err != nil {
		return err
	}
	ok = true
	return nil
}

/* copyFile copies keeping permissions and modification time (cp -p). */
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	_ = os.Chmod(tmp, info.Mode().Perm())
	_ = os.Chtimes(tmp, info.ModTime(), info.ModTime())
	return os.Rename(tmp, dst)
}

/* PatchApps injects the bundle. Returns "UNCHANGED" or "PATCHED <path>". */
func PatchApps(apps, version string, b Bundle) (string, error) {
	wanted := version + " " + b.Digest
	assets := map[string][]byte{"spot-lyric.js": b.JS, "spot-lyric.css": b.CSS}
	folder := filepath.Join(apps, "xpui")
	index := filepath.Join(folder, "index.html")
	if isFile(index) {
		/* Extracted xpui directory (spicetify / SpotX developer mode). */
		data, err := os.ReadFile(index)
		if err != nil {
			return "", err
		}
		if marker(string(data)) == wanted {
			return "UNCHANGED", nil
		}
		if err := os.MkdirAll(filepath.Join(folder, assetDir), 0o755); err != nil {
			return "", err
		}
		for name, content := range assets {
			if err := os.WriteFile(filepath.Join(folder, assetDir, name), content, 0o644); err != nil {
				return "", err
			}
		}
		if err := os.WriteFile(index, []byte(inject(string(data), version, b.Digest)), 0o644); err != nil {
			return "", err
		}
		return "PATCHED " + folder, nil
	}
	spa := filepath.Join(apps, "xpui.spa")
	backup := spa + backupSuffix
	html, err := readZipEntry(spa, "index.html")
	if err != nil {
		return "", err
	}
	current := marker(html)
	if current == wanted {
		return "UNCHANGED", nil
	}
	if current == "" {
		/* A fresh (possibly freshly updated) archive from Spotify becomes the new original. */
		if err := copyFile(spa, backup); err != nil {
			return "", err
		}
	} else {
		if !isFile(backup) {
			return "", errors.New("xpui.spa 已被修改但备份缺失，请重新安装 Spotify 后再试")
		}
		if html, err = readZipEntry(backup, "index.html"); err != nil {
			return "", err
		}
	}
	if err := writeSpa(backup, spa, inject(html, version, b.Digest), assets); err != nil {
		return "", err
	}
	return "PATCHED " + spa, nil
}

/* RestoreApps removes the plugin. Returns "RESTORED" or "NOT_PATCHED". */
func RestoreApps(apps string) (string, error) {
	restored := false
	folder := filepath.Join(apps, "xpui")
	index := filepath.Join(folder, "index.html")
	if isFile(index) {
		data, err := os.ReadFile(index)
		if err != nil {
			return "", err
		}
		if marker(string(data)) != "" {
			if err := os.WriteFile(index, []byte(blockRe.ReplaceAllString(string(data), "")), 0o644); err != nil {
				return "", err
			}
			restored = true
		}
		os.RemoveAll(filepath.Join(folder, assetDir))
	}
	spa := filepath.Join(apps, "xpui.spa")
	backup := spa + backupSuffix
	if isFile(spa) {
		html, err := readZipEntry(spa, "index.html")
		if err == nil && marker(html) != "" {
			if isFile(backup) {
				err = copyFile(backup, spa)
			} else {
				err = writeSpa(spa, spa, blockRe.ReplaceAllString(html, ""), nil)
			}
			if err != nil {
				return "", err
			}
			restored = true
		}
	}
	os.Remove(backup)
	if restored {
		return "RESTORED", nil
	}
	return "NOT_PATCHED", nil
}

/* StatusApps describes the patch state, e.g. "spa patched v1.3.0 0123456789abcdef backup". */
func StatusApps(apps string) string {
	index := filepath.Join(apps, "xpui", "index.html")
	if isFile(index) {
		data, _ := os.ReadFile(index)
		if m := marker(string(data)); m != "" {
			return "dir patched v" + m
		}
		return "dir not-patched"
	}
	spa := filepath.Join(apps, "xpui.spa")
	if !isFile(spa) {
		return "missing"
	}
	html, err := readZipEntry(spa, "index.html")
	if err != nil {
		return "unreadable: " + err.Error()
	}
	state := "spa not-patched"
	if m := marker(html); m != "" {
		state = "spa patched v" + m
	}
	if isFile(spa + backupSuffix) {
		state += " backup"
	}
	return state
}
