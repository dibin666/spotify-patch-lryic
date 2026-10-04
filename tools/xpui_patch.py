#!/usr/bin/env python3
"""Inject / remove the Spot-Lyric bundle in Spotify's xpui.

Usage:
  xpui_patch.py patch   APPS_DIR BUNDLE.js BUNDLE.css VERSION
  xpui_patch.py restore APPS_DIR
  xpui_patch.py status  APPS_DIR

Works with the packed ``Apps/xpui.spa`` (zip) and with an extracted
``Apps/xpui/`` directory (e.g. after spicetify).  The original archive is kept
as ``xpui.spa.spot-lyric.bak``; when Spotify updates and ships a fresh
xpui.spa the backup is refreshed automatically.
"""
import hashlib
import os
import re
import shutil
import sys
import tempfile
import zipfile

ASSET_DIR = "spot-lyric"
BACKUP_SUFFIX = ".spot-lyric.bak"
BLOCK = re.compile(r"<!-- spot-lyric:start[^>]*-->.*?<!-- spot-lyric:end -->", re.S)
MARKER = re.compile(r"<!-- spot-lyric:start v(\S+) sha=(\w+) -->")


def injection(version, digest):
    return ('<!-- spot-lyric:start v%s sha=%s -->'
            '<link rel="stylesheet" href="/%s/spot-lyric.css">'
            '<script defer="defer" src="/%s/spot-lyric.js"></script>'
            '<!-- spot-lyric:end -->') % (version, digest, ASSET_DIR, ASSET_DIR)


def inject(html, version, digest):
    html = BLOCK.sub("", html)
    block = injection(version, digest)
    if "</body>" in html:
        return html.replace("</body>", block + "</body>", 1)
    return html + block


def clean(html):
    return BLOCK.sub("", html)


def marker(html):
    match = MARKER.search(html)
    return (match.group(1), match.group(2)) if match else None


def keep_owner(path, reference):
    """Give a rewritten file the owner/mode of the file it replaces."""
    try:
        st = os.stat(reference)
        os.chmod(path, st.st_mode & 0o7777)
        if os.geteuid() == 0:
            os.chown(path, st.st_uid, st.st_gid)
    except OSError:
        pass


def spa_paths(apps):
    spa = os.path.join(apps, "xpui.spa")
    return spa, spa + BACKUP_SUFFIX


def read_index(spa):
    with zipfile.ZipFile(spa) as z:
        return z.read("index.html").decode("utf-8")


def write_spa(source, target, html, assets):
    fd, tmp = tempfile.mkstemp(prefix=".xpui-", suffix=".spa", dir=os.path.dirname(target))
    os.close(fd)
    try:
        with zipfile.ZipFile(source) as src, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as dst:
            for info in src.infolist():
                if info.filename == "index.html" or info.filename.startswith(ASSET_DIR + "/"):
                    continue
                dst.writestr(info, src.read(info.filename))
            dst.writestr("index.html", html)
            for name, data in assets.items():
                dst.writestr(ASSET_DIR + "/" + name, data)
        keep_owner(tmp, target if os.path.exists(target) else source)
        os.replace(tmp, target)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def patch(apps, js_path, css_path, version):
    with open(js_path, "rb") as f:
        js = f.read()
    with open(css_path, "rb") as f:
        css = f.read()
    digest = hashlib.sha256(js + b"\0" + css).hexdigest()[:16]
    assets = {"spot-lyric.js": js, "spot-lyric.css": css}
    folder = os.path.join(apps, "xpui")
    if os.path.isfile(os.path.join(folder, "index.html")):
        index = os.path.join(folder, "index.html")
        with open(index, encoding="utf-8") as f:
            html = f.read()
        if marker(html) == (version, digest):
            print("UNCHANGED dir")
            return
        os.makedirs(os.path.join(folder, ASSET_DIR), exist_ok=True)
        for name, data in assets.items():
            with open(os.path.join(folder, ASSET_DIR, name), "wb") as f:
                f.write(data)
        with open(index, "w", encoding="utf-8") as f:
            f.write(inject(html, version, digest))
        print("PATCHED dir " + folder)
        return
    spa, backup = spa_paths(apps)
    if not os.path.isfile(spa):
        raise SystemExit("xpui.spa not found in " + apps)
    html = read_index(spa)
    current = marker(html)
    if current == (version, digest):
        print("UNCHANGED spa")
        return
    if current is None:
        # Fresh (possibly updated) archive from Spotify: this is the new original.
        shutil.copy2(spa, backup)
        keep_owner(backup, spa)
        source = backup
    else:
        if not os.path.isfile(backup):
            raise SystemExit("xpui.spa is patched but the backup is missing; reinstall spotify-client")
        source = backup
        html = read_index(backup)
    write_spa(source, spa, inject(html, version, digest), assets)
    print("PATCHED spa " + spa)


def restore(apps):
    folder = os.path.join(apps, "xpui")
    index = os.path.join(folder, "index.html")
    done = False
    if os.path.isfile(index):
        with open(index, encoding="utf-8") as f:
            html = f.read()
        if marker(html):
            with open(index, "w", encoding="utf-8") as f:
                f.write(clean(html))
            done = True
        shutil.rmtree(os.path.join(folder, ASSET_DIR), ignore_errors=True)
    spa, backup = spa_paths(apps)
    if os.path.isfile(spa) and marker(read_index(spa)):
        if os.path.isfile(backup):
            shutil.copy2(backup, spa + ".tmp")
            keep_owner(spa + ".tmp", spa)
            os.replace(spa + ".tmp", spa)
        else:
            write_spa(spa, spa, clean(read_index(spa)), {})
        done = True
    if os.path.isfile(backup):
        os.unlink(backup)
    print("RESTORED" if done else "NOT_PATCHED")


def status(apps):
    folder = os.path.join(apps, "xpui", "index.html")
    if os.path.isfile(folder):
        with open(folder, encoding="utf-8") as f:
            m = marker(f.read())
        print("dir " + ("patched v%s %s" % m if m else "not-patched"))
        return
    spa, backup = spa_paths(apps)
    if not os.path.isfile(spa):
        print("missing")
        return
    m = marker(read_index(spa))
    print("spa " + ("patched v%s %s" % m if m else "not-patched") + (" backup" if os.path.isfile(backup) else ""))


def main(argv):
    if len(argv) >= 6 and argv[1] == "patch":
        patch(argv[2], argv[3], argv[4], argv[5])
    elif len(argv) >= 3 and argv[1] == "restore":
        restore(argv[2])
    elif len(argv) >= 3 and argv[1] == "status":
        status(argv[2])
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
