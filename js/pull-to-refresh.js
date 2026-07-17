/* ================================================================
   KBINE PLUS | Pull-to-refresh (glisser vers le bas pour actualiser)
   ================================================================
   Geste tactile générique pour l'espace client : au relâchement, ré-appelle
   la fonction de rechargement DÉJÀ EXISTANTE de la section active (voir
   PullToRefresh.register(), câblé depuis boot() dans js/client.js) —
   aucune logique de chargement de données n'est dupliquée ici, ce module
   ne fait que redéclencher celle déjà en place par section (loadHistory,
   loadProfit, etc.).

   100% CSS/JS, aucun plugin Capacitor natif : overscroll-behavior (voir
   css/style.css) neutralise le pull-to-refresh natif du navigateur/
   WebView, et ce module gère par-dessus le geste personnalisé avec sa
   propre résistance progressive.

   Chargé après js/biometric.js, avant js/client.js (voir index.html). */
const PullToRefresh = (() => {
  const MAX_PULL  = 100; // px, distance visuelle maximale de l'indicateur
  const THRESHOLD = 64;  // px (après amortissement) pour déclencher le refresh
  const DEAD_ZONE = 6;   // px de mouvement brut avant d'armer le geste (évite les faux déclenchements sur un tap/petit tremblement)

  const _handlers = {}; // { sectionName: fn (peut être async) }
  let _el = null, _ring = null;

  let _active = false;     // un doigt est posé et le geste est armé
  let _refreshing = false; // un refresh est en cours (ignore les nouveaux gestes)
  let _startY = 0;
  let _pull = 0;            // distance amortie courante

  // Amortissement progressif façon "rubber band" : approche MAX_PULL de
  // façon asymptotique, jamais de dépassement même sur un tirage brut très
  // long — c'est ce qui donne la sensation de résistance qui augmente
  // plus on tire loin. Fonction pure, testée isolément (voir
  // tests/pull-to-refresh.test.js) sans dépendre du DOM.
  function computePullDistance(rawDelta, maxPull) {
    if (rawDelta <= 0) return 0;
    return maxPull * (1 - Math.exp(-rawDelta / maxPull));
  }

  function _currentSectionName() {
    const active = document.querySelector('.cs-section.active');
    return active ? active.id.replace(/^cs-/, '') : null;
  }

  // Le scroll de la page se fait soit sur window (accueil, flux normal),
  // soit sur .cs-section.active elle-même (toutes les autres sections :
  // position:fixed + overflow-y:auto, voir css/style.css et showSection()
  // dans js/client.js) — un seul des deux est jamais réellement
  // scrollable à la fois.
  function _isAtTop() {
    if (document.body.classList.contains('on-home')) {
      return (document.scrollingElement || document.documentElement).scrollTop === 0;
    }
    const active = document.querySelector('.cs-section.active');
    return !active || active.scrollTop === 0;
  }

  // Modèle volontairement simple : un seul badge rond avec le logo de
  // l'app au centre (même repère visuel que l'écran de chargement au
  // boot, voir #page-loader/.pl-logo-img dans index.html) entouré d'un
  // anneau orange/vert qui suit le doigt puis tourne pendant le
  // rechargement. Aucun texte pendant le tirage (le mouvement + la
  // couleur suffisent) — un seul mot apparaît, seulement le temps du
  // rechargement réel, pour que le client sache précisément ce qui se
  // passe à ce moment précis sans surcharger le geste de messages qui
  // changent sans arrêt.
  function _buildIndicator() {
    const el = document.createElement('div');
    el.id = 'ptr-indicator';
    el.innerHTML = `
      <div class="ptr-ring-box">
        <div class="ptr-ring"></div>
        <img src="img/logo.png" alt="" class="ptr-logo">
      </div>
      <span class="ptr-label">Actualisation…</span>`;
    document.body.appendChild(el);
    return el;
  }

  function _setPull(px) {
    _pull = px;
    const clamped = Math.min(px, MAX_PULL);
    const ratio = Math.min(1, px / THRESHOLD);
    _el.style.transform = `translateX(-50%) translateY(${clamped - 46}px)`;
    _el.style.opacity = String(Math.min(1, ratio * 1.3));
    _ring.style.transform = `rotate(${clamped * 2.4}deg)`; // suit le doigt, avant le déclenchement
    _el.classList.toggle('ptr-ready', ratio >= 1); // l'anneau passe au vert dès le seuil franchi
  }

  function _reset(animated) {
    _el.classList.toggle('ptr-anim', !!animated);
    _el.classList.remove('ptr-loading', 'ptr-ready');
    _pull = 0;
    _el.style.transform = 'translateX(-50%) translateY(-46px)';
    _el.style.opacity = '0';
    _ring.style.transform = '';
  }

  async function _trigger() {
    _refreshing = true;
    _el.classList.add('ptr-anim', 'ptr-loading');
    _el.style.transform = 'translateX(-50%) translateY(18px)';
    _el.style.opacity = '1';
    _ring.style.transform = ''; // laisse la rotation continue en CSS (.ptr-loading) prendre le relais

    const name = _currentSectionName();
    const fn = name && _handlers[name];
    try { if (fn) await fn(); }
    catch (e) { /* une section qui échoue au rechargement ne doit jamais bloquer le geste */ }

    // Petit palier pour que le spinner reste perceptible même sur un
    // rechargement local quasi instantané (sinon l'animation clignote).
    await new Promise(r => setTimeout(r, 350));
    _refreshing = false;
    _reset(true);
  }

  function _onTouchStart(e) {
    if (_refreshing || _active) return;
    if (document.querySelector('.modal-overlay.open')) return; // ne pas interférer avec une modale ouverte
    if (e.target.closest && e.target.closest('.bottom-nav, input, textarea, select')) return;
    if (!_isAtTop()) return;
    _active = true;
    _startY = e.touches[0].clientY;
    _el.classList.remove('ptr-anim');
  }

  function _onTouchMove(e) {
    if (!_active || _refreshing) return;
    const rawDelta = e.touches[0].clientY - _startY - DEAD_ZONE;
    if (rawDelta <= 0) { if (_pull) _setPull(0); return; }
    if (!_isAtTop()) { _active = false; _reset(true); return; } // du scroll a repris ailleurs entre-temps
    e.preventDefault(); // neutralise le pull-to-refresh natif, uniquement pendant un tirage réel
    _setPull(computePullDistance(rawDelta, MAX_PULL));
  }

  function _onTouchEnd() {
    if (!_active) return;
    _active = false;
    if (_pull >= THRESHOLD) _trigger();
    else _reset(true);
  }

  // Déclare la fonction de rechargement à rappeler pour une section
  // donnée (nom sans le préfixe "cs-", ex. "historique", "profit").
  function register(sectionName, fn) { _handlers[sectionName] = fn; }

  function init() {
    if (_el) return; // déjà initialisé
    _el = _buildIndicator();
    _ring = _el.querySelector('.ptr-ring');
    document.addEventListener('touchstart', _onTouchStart, { passive: true });
    document.addEventListener('touchmove',  _onTouchMove,  { passive: false });
    document.addEventListener('touchend',   _onTouchEnd,   { passive: true });
    document.addEventListener('touchcancel',_onTouchEnd,   { passive: true });
  }

  return { init, register, computePullDistance };
})();
