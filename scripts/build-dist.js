/* Copie les seuls fichiers nécessaires à l'hébergement web (Hostinger ou
   équivalent) dans dist/ — même sélection de fichiers que build-www.js
   (Capacitor), mais distinct : dist/ est ce qu'on dépose tel quel dans
   public_html, jamais le dossier www/ (réservé à l'app Android). Aucune
   dépendance externe : Node pur. */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const distDir = path.join(root, 'dist');

const FILES = ['index.html', 'admin.html', 'cabine.html', 'client.html', 'sw.js'];
// downloads/ (APK Android publié) est optionnel : seulement copié s'il
// existe déjà (voir BUILD_APK.md — jamais généré automatiquement ici).
const DIRS = ['css', 'js', 'img', 'downloads'];

// Fichiers à ne jamais livrer (sauvegardes d'éditeur, fichiers cachés...).
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

// Repart d'un dist/ propre à chaque build pour éviter les fichiers orphelins.
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

for (const file of FILES) {
  const src = path.join(root, file);
  if (fs.existsSync(src)) copyRecursive(src, path.join(distDir, file));
}
for (const dir of DIRS) {
  const src = path.join(root, dir);
  if (fs.existsSync(src)) copyRecursive(src, path.join(distDir, dir));
}

console.log('[build-dist] dist/ généré (' + FILES.concat(DIRS).join(', ') + ')');
