#!/bin/bash
# Deploy the web build to somersaudio.com/autocarl — the web half of the
# desktop/web parity rule. Builds, uploads EVERY built asset plus index.html
# (assets first, so a mid-deploy visitor never sees index.html reference a
# chunk that isn't there yet — the app's self-update probe guards the same
# window), then verifies that every chunk the live bundle references
# actually resolves.
#
#   ./scripts/deploy-web.sh
#
# Superseded old-hash chunks are left on the server: they're immutable-cached
# and harmless, and still-running sessions may load them until they self-
# update. Prune occasionally by hand if clutter bothers you.
#
# Credentials: Hostinger SFTP password read from FileZilla's sitemanager.xml.
set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE_USER=u498712885
REMOTE_HOST=46.202.199.22
REMOTE_PORT=65002
REMOTE_DIR=domains/somersaudio.com/public_html/autocarl

echo "== build =="
npx vite build -c vite.web.config.ts

SFTP_PASS="$(python3 -c "
import xml.etree.ElementTree as ET, base64
t = ET.parse('$HOME/.config/filezilla/sitemanager.xml')
for s in t.iter('Server'):
    if s.findtext('Host') == '$REMOTE_HOST':
        print(base64.b64decode(s.findtext('Pass')).decode()); break
")"
[ -n "$SFTP_PASS" ] || { echo "no SFTP password found"; exit 1; }
export SFTP_PASS

echo "== upload (assets first, index.html last) =="
BATCH="$(mktemp)"
{
  echo "cd $REMOTE_DIR/assets"
  echo "lcd web-dist/assets"
  for f in web-dist/assets/*; do
    echo "put '$(basename "$f")'"
  done
  echo "cd .."
  echo "lcd .."
  echo "put index.html"
  echo "bye"
} > "$BATCH"

UPLOAD_LOG="$(mktemp)"
expect <<EXPEOF > "$UPLOAD_LOG" 2>&1
set timeout 600
spawn sftp -P $REMOTE_PORT -o StrictHostKeyChecking=accept-new -b $BATCH $REMOTE_USER@$REMOTE_HOST
expect {
  -re "(?i)password:" { send -- "\$env(SFTP_PASS)\r"; exp_continue }
  eof {}
}
EXPEOF
grep -cE "^sftp> put" "$UPLOAD_LOG" | sed 's/^/files uploaded: /' || true
rm -f "$BATCH" "$UPLOAD_LOG"

echo "== verify =="
python3 - <<'PYEOF'
import os, re, sys, urllib.request

def get(u, method='GET'):
    req = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}, method=method)
    return urllib.request.urlopen(req, timeout=30).read()

base = 'https://somersaudio.com/autocarl/'
html = get(base + '?deploycheck').decode()
top = re.findall(r'assets/(index-[A-Za-z0-9_-]+\.(?:js|css))', html)
local = set(os.listdir('web-dist/assets'))
stale = [t for t in top if t not in local]
if stale:
    sys.exit(f'live index.html references chunks not in this build: {stale}')
main_js = next(t for t in top if t.endswith('.js'))
js = get(base + 'assets/' + main_js).decode('utf-8', 'replace')
refs = (set(re.findall(r'(?:\./)?([A-Za-z0-9@._-]+-[A-Za-z0-9_-]{6,}\.(?:m?js|css|pdf|png))', js)) & local) | set(top)
bad = []
for c in sorted(refs):
    try:
        get(base + 'assets/' + c, 'HEAD')
    except Exception:
        bad.append(c)
if bad:
    sys.exit(f'MISSING on server after upload: {bad}')
print(f'verified {len(refs)} referenced chunks live')
PYEOF

echo "== done =="
