/* Paquet autonome ne contenant QUE l'espace client (pas cabine.html/
   admin.html) — pensé pour être intégré/déposé tel quel : client.html
   devient index.html (index.html d'origine n'est de toute façon qu'une
   redirection immédiate vers client.html, voir ce fichier). N'inclut que
   les fichiers JS réellement chargés par client.html.
   Limite assumée : un compte cabine/admin qui se connecterait via les
   modales de ce fichier ne pourra pas être redirigé (cabine.html/
   admin.html absents de ce paquet) — normal, seul l'espace client est
   demandé ici. */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'dist-client');

const JS_FILES = [
  'supabase-config.js', 'supabase-client.js', 'db.js', 'auth.js', 'biometric.js', 'client.js',
];
const DIRS = ['css', 'img'];
const SKIP_RE = /\.bak$|~$|^\.DS_Store$|^Thumbs\.db$/i;

function copyRecursive(src, dest) {
  if (SKIP_RE.test(path.basename(src))) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// client.html -> index.html (voir note en tête de fichier).
fs.copyFileSync(path.join(root, 'client.html'), path.join(outDir, 'index.html'));

for (const dir of DIRS) {
  const src = path.join(root, dir);
  if (fs.existsSync(src)) copyRecursive(src, path.join(outDir, dir));
}

fs.mkdirSync(path.join(outDir, 'js'), { recursive: true });
for (const file of JS_FILES) {
  const src = path.join(root, 'js', file);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, 'js', file));
}

console.log('[build-dist-client] dist-client/ généré (index.html <- client.html, ' + DIRS.concat(JS_FILES.map(f => 'js/' + f)).join(', ') + ')');
