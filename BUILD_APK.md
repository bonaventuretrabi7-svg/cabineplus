# Générer l'APK Android de KBINE PLUS

Le projet Android natif (dossier `android/`) est déjà généré via
[Capacitor](https://capacitorjs.com) et prêt à être compilé — il enveloppe
l'espace client web (`client.html` et ses pages liées) dans une application
Android installable.

Cet environnement de développement ne dispose pas du JDK ni du SDK Android
(nécessaires uniquement pour la **compilation**, pas pour la configuration
qui est déjà faite) — l'étape ci-dessous doit donc être exécutée sur une
machine qui les a (ou via une CI comme GitHub Actions, voir plus bas).

## Prérequis (sur la machine qui compile)

- [Android Studio](https://developer.android.com/studio) (inclut le SDK Android), **ou** le SDK + JDK 17 installés séparément.
- Node.js 18+ (déjà nécessaire pour `npm run build:www`).

## 1. Installer les dépendances

```bash
npm install
```

## 2. Générer l'APK de debug (rapide, pour tester)

```bash
npm run cap:sync
cd android
./gradlew assembleDebug        # macOS/Linux
gradlew.bat assembleDebug      # Windows
```

L'APK est produit dans :
`android/app/build/outputs/apk/debug/app-debug.apk`

## 3. Générer l'APK de release (signé, pour diffusion)

1. Créer un keystore (une seule fois) :
   ```bash
   keytool -genkey -v -keystore kbineplus-release.keystore -alias kbineplus -keyalg RSA -keysize 2048 -validity 10000
   ```
2. Renseigner `android/keystore.properties` (à créer, non versionné) :
   ```properties
   storeFile=../kbineplus-release.keystore
   storePassword=********
   keyAlias=kbineplus
   keyPassword=********
   ```
3. Compiler :
   ```bash
   npm run cap:sync
   cd android
   ./gradlew assembleRelease
   ```
   APK produit dans :
   `android/app/build/outputs/apk/release/app-release.apk`

   (Sans configuration de signature, `assembleRelease` produit un APK non
   signé, installable uniquement en désactivant la vérification de
   signature — utiliser `assembleDebug` pour un test rapide.)

## 4. Publier l'APK pour le téléchargement depuis le site

Copier le fichier `.apk` obtenu vers `downloads/kbineplus.apk` à la racine
du projet web — c'est l'emplacement que pointe le bouton "Télécharger
l'application Android" ajouté dans l'espace client (`client.html`, visible
uniquement aux visiteurs sous Android, voir `js/client.js`
`renderAndroidAppBanner()`).

```bash
cp android/app/build/outputs/apk/release/app-release.apk downloads/kbineplus.apk
```

## Alternative : compiler via GitHub Actions (sans machine locale)

Si aucune machine avec Android Studio n'est disponible, un workflow CI
(`.github/workflows/build-apk.yml`, à créer) sur `ubuntu-latest` avec les
actions `actions/setup-java` + `android-actions/setup-android` peut lancer
les mêmes commandes (`npm install`, `npm run cap:sync`,
`./gradlew assembleDebug`) et publier l'APK résultant comme artefact de
build téléchargeable, sans jamais nécessiter d'installation locale.

## Modifier l'icône de l'application (optionnel)

Par défaut, le projet généré utilise l'icône Capacitor standard. Pour
utiliser le logo KBINE PLUS (`img/logo.png`) :

```bash
npm install -D @capacitor/assets
npx capacitor-assets generate --android
```

## À chaque modification du site web

Après toute modification de `client.html`, `admin.html`, `cabine.html`,
`css/`, `js/` ou `img/`, relancer `npm run cap:sync` avant de recompiler,
pour que l'application embarque la dernière version des pages.
