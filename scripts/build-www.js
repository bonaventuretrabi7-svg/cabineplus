/* Copie les seuls fichiers web nécessaires (html/css/js/img) dans www/,
   le webDir attendu par Capacitor pour le projet Android. Le reste du
   dépôt (node_modules, android/, downloads/, scripts de build…) n'a pas
   sa place dans le paquet applicatif. Aucune dépendance externe : Node
   pur, pour fonctionner même sans accès réseau à npm. */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const wwwDir = path.join(root, 'www');

const FILES = ['index.html', 'admin.html', 'cabine.html', 'client.html', 'sw.js'];
const DIRS = ['css', 'js', 'img'];

function copyRecursive(src, dest) {
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

// Repart d'un www/ propre à chaque build pour éviter les fichiers orphelins.
fs.rmSync(wwwDir, { recursive: true, force: true });
fs.mkdirSync(wwwDir, { recursive: true });

for (const file of FILES) {
  const src = path.join(root, file);
  if (fs.existsSync(src)) copyRecursive(src, path.join(wwwDir, file));
}
for (const dir of DIRS) {
  const src = path.join(root, dir);
  if (fs.existsSync(src)) copyRecursive(src, path.join(wwwDir, dir));
}

console.log('[build-www] www/ généré (' + FILES.concat(DIRS).join(', ') + ')');
