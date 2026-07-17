/* Paquet autonome ne contenant QUE l'espace client (pas cabine.html/
   admin.html) — pensé pour être intégré/déposé tel quel : index.html EST
   déjà l'espace client (client.html n'est plus qu'une redirection vers
   index.html, gardée pour ne pas casser les liens existants — voir la
   racine du projet). N'inclut que les fichiers JS réellement chargés.
   Limite assumée : un compte cabine/admin qui se connecterait via les
   modales de ce fichier ne pourra pas être redirigé (cabine.html/
   admin.html absents de ce paquet) — normal, seul l'espace client est
   demandé ici. */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'dist-client');

const JS_FILES = [
  'supabase-config.js', 'supabase-client.js', 'db.js', 'auth.js', 'biometric.js',
  'pull-to-refresh.js', 'update-notifier.js', 'client.js',
];
const DIRS = ['css', 'img'];
// app-version.json doit vivre à la racine du paquet (même niveau
// qu'index.html) — voir js/update-notifier.js, qui compare la copie
// embarquée dans l'app à celle en ligne à cette même adresse relative.
const ROOT_FILES = ['app-version.json'];
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

// index.html EST déjà l'espace client (voir note en tête de fichier).
fs.copyFileSync(path.join(root, 'index.html'), path.join(outDir, 'index.html'));

for (const file of ROOT_FILES) {
  const src = path.join(root, file);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, file));
}

for (const dir of DIRS) {
  const src = path.join(root, dir);
  if (fs.existsSync(src)) copyRecursive(src, path.join(outDir, dir));
}

fs.mkdirSync(path.join(outDir, 'js'), { recursive: true });
for (const file of JS_FILES) {
  const src = path.join(root, 'js', file);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, 'js', file));
}

console.log('[build-dist-client] dist-client/ généré (index.html, ' + ROOT_FILES.concat(DIRS).concat(JS_FILES.map(f => 'js/' + f)).join(', ') + ')');
