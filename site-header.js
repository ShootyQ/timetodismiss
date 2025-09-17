/* =========================================================================
   site-header.js — universal header + Google Workspace sign-in
   Include on every page:
     <script src="/site-header.js" defer></script>
   ======================================================================= */

(function () {
  // Global build/version id for cache-busting across all pages
  const BUILD_ID = '2025-09-10-HDR4';

  // Proactively purge any old Service Workers and caches that could be serving stale assets
  (async function purgeSwAndCaches(){
    try {
      const FLAG = 'SD_SW_CLEARED_' + BUILD_ID;
      if (!localStorage.getItem(FLAG)) {
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations().catch(() => []);
          for (const r of regs) { try { await r.unregister(); } catch {} }
        }
        if (window.caches && caches.keys) {
          const keys = await caches.keys().catch(() => []);
          await Promise.all(keys.map(k => caches.delete(k).catch(()=>{})));
        }
        localStorage.setItem(FLAG, '1');
        try { console.info('[TTD] Purged SW and caches for build', BUILD_ID); } catch {}
      }
    } catch (e) {
      try { console.warn('[TTD] SW/caches purge failed:', e?.message || e); } catch {}
    }
  })();

  // bfcache guard: if page is restored from back/forward cache, force a reload
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      const url = new URL(location.href);
      url.searchParams.set('v', BUILD_ID);
      location.replace(url.toString());
    }
  });

  // Version mismatch guard: if stored build differs, force a fresh load with version param
  try {
    const prev = localStorage.getItem('SD_BUILD_ID');
    if (prev && prev !== BUILD_ID) {
      const url = new URL(location.href);
      url.searchParams.set('v', BUILD_ID);
      location.replace(url.toString());
    }
    localStorage.setItem('SD_BUILD_ID', BUILD_ID);
    window.SD = window.SD || {}; window.SD.BUILD_ID = BUILD_ID;
  } catch {}

      const firebaseConfig = {
    apiKey: "AIzaSyD3bCzCSGN2s-rBcevStOGfhTOKDSmmbCU",
    authDomain: "dismissalcaller.firebaseapp.com",
    projectId: "dismissalcaller",
    storageBucket: "dismissalcaller.appspot.com",
    messagingSenderId: "942492177246",
    appId: "1:942492177246:web:f4fb6ea6af42b9bde975cf",
    measurementId: "G-279958XEND"
  };

  const TEMP_ADMIN_EMAILS = new Set([
  'carlsonandy85@gmail.com',
  ]);

  // ======= Helpers =======
  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      if ([...document.scripts].some(s => s.src === src)) return resolve();
      const el = document.createElement('script');
      el.src = src; el.async = true;
      el.onload = resolve;
      el.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(el);
    });
  }
  function show(el){ el && (el.style.display = ''); }
  function hide(el){ el && (el.style.display = 'none'); }

  // Add once so every page has a favicon
  function ensureFavicon() {
    if (!document.querySelector('link[rel="icon"]')) {
      const link = document.createElement('link');
      link.rel = 'icon';
      link.type = 'image/png';
      link.href = '/favicon.png';
      document.head.appendChild(link);
    }
  }

  function ensureHeaderShell() {
    if (document.querySelector('header.site-header')) return;
    const header = document.createElement('header');
    header.className = 'site-header';
    header.innerHTML = `
          <div class="container header-inner">
            <a href="/index.html" class="brand" title="Home">Time To Dismiss</a>
            <nav class="nav nav-icons" aria-label="Primary">
              <a href="/class.html" class="nav-icon" data-requires="viewer" aria-label="Classes" title="Classes">
                <svg viewBox="0 0 24 24" aria-hidden="true" class="ic" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M4 10.5 12 6l8 4.5-8 4.5-8-4.5Z"/><path d="M6 12v4l6 3 6-3v-4"/>
                </svg>
              </a>
              <a href="/master.html"  class="nav-icon" data-requires="caller" aria-label="Master Caller" title="Master Caller">
                <svg viewBox="0 0 24 24" aria-hidden="true" class="ic" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M5 11v2"/><path d="M3 9v6"/><path d="M7 8v8"/><path d="m13 8.5 5-2.5v11l-5-2.5H9a3 3 0 0 1-3-3 3 3 0 0 1 3-3h4Z"/>
                </svg>
              </a>
              <a href="/admin.html"   class="nav-icon" data-requires="admin" aria-label="Admin" title="Admin">
                <svg viewBox="0 0 24 24" aria-hidden="true" class="ic" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 8.4 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H2a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 3.6 8.4a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H8a1.65 1.65 0 0 0 1-1.51V2a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V8c.74.3 1.27 1 1.27 1.82 0 .82-.53 1.52-1.27 1.82Z"/>
                </svg>
              </a>
              <a href="/superintendent.html" class="nav-icon" data-requires="superintendent" aria-label="Superintendent" title="Superintendent">
                <svg viewBox="0 0 24 24" aria-hidden="true" class="ic" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M9 21V9h6v12"/>
                </svg>
              </a>
              <a href="/prefs.html" class="nav-icon" data-requires="viewer" aria-label="Preferences" title="Preferences">
                <svg viewBox="0 0 24 24" aria-hidden="true" class="ic" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 8.4 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H2a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 3.6 8.4a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H8a1.65 1.65 0 0 0 1-1.51V2a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V8c.74.3 1.27 1 1.27 1.82 0 .82-.53 1.52-1.27 1.82Z"/>
                </svg>
              </a>
            </nav>
            <div id="authBox" class="auth-inline">
              <div id="schoolBox" class="school-chip" style="display:none;">
                <select id="schoolSelect" class="school-select" aria-label="Select school" title="Select school"></select>
                <span id="schoolName" class="sr-only"></span>
              </div>
              <div id="signInBtns" class="signin-btns">
                <button id="signInGoogle" class="btn btn-outline" type="button">Sign in</button>
                <button id="signInMicrosoft" class="btn btn-outline" type="button">Microsoft</button>
              </div>
              <div id="userChip" class="user-chip" style="display:none;">
                <button id="userAvatarBtn" class="avatar-btn" type="button" aria-haspopup="true" aria-expanded="false" title="Account">
                  <img id="userPhoto" alt="" />
                </button>
                <div id="userPop" class="user-pop" hidden>
                  <div class="user-pop-inner">
                    <div class="user-ident">
                      <div class="user-email" id="userEmail"></div>
                      <div class="user-role"><span id="roleBadge" class="role-badge"></span></div>
                    </div>
                    <hr class="user-div" />
                    <button id="signOutBtn2" class="btn btn-sm w-100" type="button">Sign out</button>
                  </div>
                </div>
                <button id="signOutBtn" class="btn btn--ghost" type="button" style="display:none;">Sign out</button>
              </div>
            </div>
          </div>
          <!-- Compact mobile toolbar -->
          <div class="hdr-mobile" style="align-items:center;justify-content:space-between;gap:8px;padding:6px 4%;">
        <button id="hdrMenuBtn" class="icon-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="hdrMenuPanel" title="Menu" aria-label="Open menu">☰</button>
        <button id="hdrAuthBtn" class="icon-btn" type="button" title="Account" aria-label="Account">
          <span id="hdrAuthIcon" aria-hidden="true">👤</span>
          <img id="hdrAuthPhoto" alt="" style="display:none;width:28px;height:28px;border-radius:999px;object-fit:cover;" />
        </button>
          </div>
          <div id="hdrMenuScrim" class="hdr-menu-scrim" hidden></div>
          <aside id="hdrMenuPanel" class="hdr-menu-panel" hidden aria-label="Menu">
        <div class="menu-inner">
          <div class="menu-head">
            <strong>Menu</strong>
            <button id="hdrMenuClose" class="icon-btn" type="button" aria-label="Close menu">✕</button>
          </div>
          <nav class="menu-links">
            <a href="/class.html" data-requires="viewer">Classes</a>
            <a href="/master.html"  data-requires="caller">Master Caller</a>
            <a href="/admin.html"   data-requires="admin">Admin</a>
            <a href="/superintendent.html" data-requires="superintendent">Superintendent</a>
            <a href="/prefs.html" data-requires="viewer">Preferences</a>
          </nav>
          <div class="menu-auth">
            <button id="hdrSignInGoogle" class="btn" type="button">Sign in with Google</button>
            <button id="hdrSignInMicrosoft" class="btn btn-outline" type="button">Sign in with Microsoft</button>
            <button id="hdrSignOut" class="btn btn-outline" type="button" style="display:none;">Sign out</button>
          </div>
        </div>
          </aside>
    `;
  // Build stamp (hidden) for quick verification in DOM and DevTools
    try {
      const meta = document.createElement('meta');
      meta.name = 'ttd-build';
      meta.content = BUILD_ID;
      document.head.appendChild(meta);
    } catch {}
    try { console.log('[TTD] site-header loaded, BUILD', BUILD_ID); } catch {}
    document.body.prepend(header);

    // By default, hide any role-gated links until claims are evaluated
    try {
      header.querySelectorAll('[data-requires="superintendent"]').forEach(el => {
        el.hidden = true; el.setAttribute('aria-hidden','true');
      });
    } catch {}
  }

  async function ensureFirebaseAndAuth() {
    if (!window.firebase) {
      await loadScriptOnce('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
      await loadScriptOnce('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js');
      await loadScriptOnce('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions-compat.js'); // already loaded here
      await loadScriptOnce('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js');
    }
    if (firebase.apps && firebase.apps.length === 0) {
      firebase.initializeApp(firebaseConfig);
    }
    // Ensure durable session persistence (fall back gracefully if blocked)
    const auth = firebase.auth();
    try {
      await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    } catch (e1) {
      try { await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION); }
      catch (e2) { try { await auth.setPersistence(firebase.auth.Auth.Persistence.NONE); } catch {} }
    }
    return auth;
  }

  // Prefer token claims to resolve tenant; fallback to domain mapping only if missing
  async function resolveTenant(db, user) {
    const idt = await user.getIdTokenResult(true);
    const claims = idt.claims || {};
    if (claims.schoolId) {
      return { schoolId: claims.schoolId, orgId: claims.orgId || 'mn-conference' };
    }
    const domain = (user.email || '').split('@')[1]?.toLowerCase();
    if (!domain) throw new Error('no-domain');
    const snap = await db.collection('domains').doc(domain).get();
    if (!snap.exists) throw new Error('domain-not-found');
    return snap.data();
  }

  // Expose a full reset helper: sign out, clear SW + caches, nuke storage, reload
  async function resetSession(hardReload=true){
    try {
      if (window.firebase && firebase.apps && firebase.apps.length){
        try { await firebase.auth().signOut(); } catch {}
      }
      if ('serviceWorker' in navigator) {
        try {
          const regs = await navigator.serviceWorker.getRegistrations().catch(() => []);
          for (const r of regs) { try { await r.unregister(); } catch {} }
        } catch {}
      }
      if (window.caches && caches.keys) {
        try {
          const keys = await caches.keys().catch(() => []);
          await Promise.all(keys.map(k => caches.delete(k).catch(()=>{})));
        } catch {}
      }
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
    } finally {
      if (hardReload) {
        const url = new URL(location.href);
        url.searchParams.delete('reset');
        url.searchParams.set('v', (window.SD && window.SD.BUILD_ID) || Date.now());
        location.replace(url.toString());
      }
    }
  }
  window.SD = window.SD || {}; window.SD.resetSession = resetSession;

  // ======= Main =======
  document.addEventListener('DOMContentLoaded', async () => {
    // If URL has ?reset=1, do a full reset once
    try {
      const u = new URL(location.href);
      if (u.searchParams.get('reset') === '1') {
        await resetSession(true);
        return; // navigation triggered
      }
    } catch {}

    ensureFavicon();
    ensureHeaderShell();

    // Add subtle shadow once scrolled
    (function headerStickiness(){
      const hdr = document.querySelector('header.site-header');
      if (!hdr) return;
      const onScroll = () => {
        if (window.scrollY > 4) hdr.classList.add('is-stuck');
        else hdr.classList.remove('is-stuck');
      };
      onScroll();
      window.addEventListener('scroll', onScroll, { passive: true });
    })();

    // Inline mobile CSS to avoid stale external CSS blocking the new header and menu polish
    (function ensureMobileHeaderStyles(){
      const id = 'sd-inline-mobile-menu';
      if (document.getElementById(id)) return;
      const css = `
      @media (max-width: 820px){
        /* Hide legacy header row; show compact toolbar */
        .site-header .header-inner{ display:none !important; }
        .site-header .hdr-mobile{ display:flex !important; position:sticky; top:0; background:#fff; z-index:1000; border-bottom:1px solid #eef2f7; padding:8px 4%; }
        .hdr-mobile .icon-btn{ background:none; border:0; padding:6px 8px; font-size:22px; line-height:1; border-radius:10px; }
        .hdr-mobile .icon-btn:active{ transform:translateY(1px); }

        /* Scrim + panel (smooth + compact) */
        .hdr-menu-scrim{ position:fixed; inset:0; background:rgba(15,23,42,.42); opacity:0; pointer-events:none; transition:opacity .2s ease; z-index:999; }
        body.menu-open .hdr-menu-scrim{ opacity:1; pointer-events:auto; }

        .hdr-menu-panel{ position:fixed; top:0; right:0; bottom:0; width:min(86vw, 320px); max-width:92vw; background:#fff; box-shadow:-12px 0 28px rgba(2,6,23,.14); transform:translateX(100%); transition:transform .24s cubic-bezier(.2,.8,.2,1); will-change:transform; z-index:1000; display:flex; flex-direction:column; }
        body.menu-open .hdr-menu-panel{ transform:translateX(0); }
        body.menu-open{ overflow:hidden; }

        .hdr-menu-panel .menu-inner{ display:flex; flex-direction:column; height:100%; padding:max(12px, env(safe-area-inset-top)) max(14px, env(safe-area-inset-right)) max(18px, env(safe-area-inset-bottom)) max(14px, env(safe-area-inset-left)); gap:10px; }
        .hdr-menu-panel .menu-head{ display:flex; align-items:center; justify-content:space-between; padding:2px 2px 8px; border-bottom:1px solid #f1f5f9; }
        .hdr-menu-panel .icon-btn{ background:none; border:0; font-size:22px; padding:6px; }

        .hdr-menu-panel .menu-links{ display:flex; flex-direction:column; gap:2px; padding:10px 0; }
        .hdr-menu-panel .menu-links a{ display:block; padding:8px 10px; border-radius:10px; font-weight:700; color:#0b132b; text-decoration:none; line-height:1.2; }
        .hdr-menu-panel .menu-links a:hover{ background:#f8fafc; }

        .hdr-menu-panel .menu-auth{ margin-top:auto; display:flex; gap:8px; }
        .hdr-menu-panel .btn{ padding:.5rem .7rem; border-radius:10px; }
      }
      `;
      const style = document.createElement('style');
      style.id = id;
      style.textContent = css;
      document.head.appendChild(style);
    })();

    // Menu open/close behavior (smooth, with accessibility niceties)
    (function initMobileMenu(){
      const btn = document.getElementById('hdrMenuBtn');
      const scrim = document.getElementById('hdrMenuScrim');
      const panel = document.getElementById('hdrMenuPanel');
      const closeBtn = document.getElementById('hdrMenuClose');
      if (!btn || !scrim || !panel) return;

      let lastFocused = null;
      const focusableSel = 'a,button,input,select,textarea,[tabindex]:not([tabindex="-1"])';

      function open(){
        lastFocused = document.activeElement;
        document.body.classList.add('menu-open');
        btn.setAttribute('aria-expanded','true');
        scrim.hidden = false;
        panel.hidden = false;
        // focus first item for quick keyboard access
        const first = panel.querySelector(focusableSel);
        if (first) setTimeout(() => first.focus(), 50);
        document.addEventListener('keydown', onKey);
      }
      function close(){
        document.body.classList.remove('menu-open');
        btn.setAttribute('aria-expanded','false');
        // let the slide-out finish before hiding for better a11y tree stability
        setTimeout(() => { scrim.hidden = true; panel.hidden = true; }, 260);
        document.removeEventListener('keydown', onKey);
        if (lastFocused && typeof lastFocused.focus === 'function') setTimeout(() => lastFocused.focus(), 0);
      }
      function onKey(e){ if (e.key === 'Escape') close(); }

      btn.addEventListener('click', open);
      closeBtn && closeBtn.addEventListener('click', close);
      scrim.addEventListener('click', close);

      // Basic focus trap while open (keeps tabbing inside panel)
      panel.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        const nodes = Array.from(panel.querySelectorAll(focusableSel)).filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null);
        if (nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      });
    })();

    const header     = document.querySelector('header.site-header');
    const signInBox  = header.querySelector('#signInBtns');
    const signInGoogleBtn = header.querySelector('#signInGoogle');
    const signInMsBtn = header.querySelector('#signInMicrosoft');
    const signOutBtn = header.querySelector('#signOutBtn');
  const signOutBtn2 = header.querySelector('#signOutBtn2');
    const userChip   = header.querySelector('#userChip');
    const userPhoto  = header.querySelector('#userPhoto');
    const userEmail  = header.querySelector('#userEmail');
    const roleBadge  = header.querySelector('#roleBadge');
    const adminLinks = [...header.querySelectorAll('[data-requires="admin"]')];
  // Mobile header elements
  const hdrMenuBtn   = header.querySelector('#hdrMenuBtn');
  const hdrAuthBtn   = header.querySelector('#hdrAuthBtn');
  const hdrAuthIcon  = header.querySelector('#hdrAuthIcon');
  const hdrAuthPhoto = header.querySelector('#hdrAuthPhoto');
  const hdrMenuPanel = header.querySelector('#hdrMenuPanel');
  const hdrMenuClose = header.querySelector('#hdrMenuClose');
  const hdrMenuScrim = header.querySelector('#hdrMenuScrim');
  const hdrSignInGoogle    = header.querySelector('#hdrSignInGoogle');
  const hdrSignInMicrosoft = header.querySelector('#hdrSignInMicrosoft');
  const hdrSignOut   = header.querySelector('#hdrSignOut');
  // School switcher elements
  const schoolBox   = header.querySelector('#schoolBox');
  const schoolNameEl= header.querySelector('#schoolName');
  const schoolSelect= header.querySelector('#schoolSelect');

    let auth;
    try {
      auth = await ensureFirebaseAndAuth();

      // Make Functions available to all pages (us-central1 by default)
      const FUNCTIONS_REGION = 'us-central1';
      window.SD = window.SD || {};
      window.SD.functions = firebase.app().functions(FUNCTIONS_REGION);
      window.SD.httpsCallable = (name) => window.SD.functions.httpsCallable(name);
    } catch (err) {
      console.error('Firebase load/init failed:', err);
      hide(userChip); show(signInBox);
      return;
    }

    // Track redirect processing so we don't prematurely redirect to login
    let _redirectResultPending = true;
    auth.getRedirectResult()
      .catch(e => { try { console.warn('[Auth] Redirect sign-in error:', e.code, e.message); } catch {} })
      .finally(() => { _redirectResultPending = false; });

  // Auth providers
  const googleProvider = new firebase.auth.GoogleAuthProvider();
  googleProvider.setCustomParameters({ prompt: 'select_account' });

  function makeMsProvider(tenant, domainHint){
    const p = new firebase.auth.OAuthProvider('microsoft.com');
    const params = { prompt: 'select_account' };
    if (tenant) params.tenant = tenant; // 'common', 'organizations', or 'consumers'
    if (domainHint) params.domain_hint = domainHint; // 'organizations' or 'consumers'
    p.setCustomParameters(params);
    return p;
  }

    // ===== School switcher helpers =====
    function setSchoolUIVisibility(showBox){
      if (!schoolBox) return;
      schoolBox.style.display = showBox ? 'flex' : 'none';
    }
    function getStoredSchoolSelection(){
      try {
        const raw = localStorage.getItem('SD_SCHOOL_OBJ');
        if (raw) return JSON.parse(raw);
      } catch {}
      // Back-compat: if only schoolId was stored
      try {
        const sid = localStorage.getItem('SD_SCHOOL');
        if (sid) return { schoolId: sid };
      } catch {}
      return null;
    }

    function applySchoolSelection(sel){
      // sel: { orgId, schoolId, name }
      if (!sel || !sel.schoolId) return;
      window.SD = window.SD || {};
      window.SD.orgId = sel.orgId || window.SD.orgId || window.SD.claims?.orgId || 'mn-conference';
      window.SD.schoolId = sel.schoolId;
      window.SD.schoolName = sel.name || sel.schoolId;
      // Persist both for cross-refresh stickiness (and keep legacy key)
      try {
        localStorage.setItem('SD_SCHOOL', sel.schoolId);
        localStorage.setItem('SD_SCHOOL_OBJ', JSON.stringify({ orgId: window.SD.orgId, schoolId: sel.schoolId, name: window.SD.schoolName, t: Date.now() }));
      } catch {}
      if (schoolNameEl) schoolNameEl.textContent = window.SD.schoolName;
      // Announce to pages
      try {
        document.dispatchEvent(new CustomEvent('sd:school-changed', { detail: { orgId: window.SD.orgId, schoolId: sel.schoolId, schoolName: window.SD.schoolName } }));
      } catch {}
      // Also re-emit claims-ready with updated school so pages depending on that event can react without a full reload
      try {
        const merged = { ...(window.SD.claims || {}), orgId: window.SD.orgId, schoolId: window.SD.schoolId };
        window.SD.claims = merged; window.claims = merged;
        document.dispatchEvent(new CustomEvent('sd:claims-ready', { detail: { claims: merged } }));
      } catch {}
    }
    async function fetchSchoolOptions(orgIds, schoolIds){
      const db = firebase.firestore();
      const optionsMap = new Map(); // key: schoolId, value: {orgId, schoolId, name}
      const orgList = Array.isArray(orgIds) && orgIds.length ? orgIds.slice() : (window.SD?.orgId ? [window.SD.orgId] : []);
      const sids = Array.isArray(schoolIds) ? schoolIds.filter(Boolean) : [];

      // Try to resolve provided schoolIds under provided orgs
      for (const sid of sids){
        let found = false;
        for (const oid of orgList){
          try {
            const doc = await db.collection('orgs').doc(oid).collection('schools').doc(sid).get();
            if (doc.exists){
              const data = doc.data() || {};
              optionsMap.set(sid, { orgId: oid, schoolId: sid, name: data.name || sid });
              found = true; break;
            }
          } catch {}
        }
        if (!found && !optionsMap.has(sid)){
          // fallback placeholder
          optionsMap.set(sid, { orgId: orgList[0] || 'mn-conference', schoolId: sid, name: sid });
        }
      }

      // If none provided (e.g., superintendent without specific school claims), list schools under first org
      if (optionsMap.size === 0 && orgList.length){
        try {
          const snap = await db.collection('orgs').doc(orgList[0]).collection('schools').limit(200).get();
          snap.forEach(d => {
            const sid = d.id; const data = d.data() || {};
            optionsMap.set(sid, { orgId: orgList[0], schoolId: sid, name: data.name || sid });
          });
        } catch {}
      }
      return Array.from(optionsMap.values()).sort((a,b)=>String(a.name||a.schoolId).localeCompare(String(b.name||b.schoolId), 'en', {sensitivity:'base'}));
    }
    async function buildUISchoolSwitcher(orgIds, schoolIds){
      if (!schoolBox || !schoolNameEl || !schoolSelect) return;
      const opts = await fetchSchoolOptions(orgIds, schoolIds);
      const claims = (window.SD && window.SD.claims) || {};
      const isSup = !!claims.superintendent;

      // Determine current selection
      const currentId = (window.SD && window.SD.schoolId) || (()=>{ try { return localStorage.getItem('SD_SCHOOL') || ''; } catch { return ''; } })();
      // Build select options
      schoolSelect.innerHTML = '';
      if (!currentId) {
        const ph = document.createElement('option'); ph.value = ''; ph.textContent = 'Select a school…'; schoolSelect.appendChild(ph);
      }
      for (const o of opts){
        const opt = document.createElement('option');
        opt.value = o.schoolId; opt.textContent = o.name || o.schoolId; opt.dataset.orgId = o.orgId || '';
        if (currentId && o.schoolId === currentId) opt.selected = true;
        schoolSelect.appendChild(opt);
      }
      // UI decision: show chip for single option; show dropdown when multiple or none selected
      const showDropdown = isSup || (!currentId) || (opts.length > 1);
      setSchoolUIVisibility(showDropdown || !!currentId);
      if (showDropdown) {
        schoolSelect.style.display = '';
        if (schoolNameEl) { schoolNameEl.style.display = 'none'; schoolNameEl.textContent = ''; }
      } else {
        schoolSelect.style.display = 'none';
        if (schoolNameEl) { const o = opts[0]; schoolNameEl.textContent = (o && (o.name || o.schoolId)) || currentId; schoolNameEl.style.display = ''; }
      }
      // Apply initial selection if available
      const selectedOption = schoolSelect.options[schoolSelect.selectedIndex];
      if (selectedOption && selectedOption.value){
        applySchoolSelection({ orgId: selectedOption.dataset.orgId || window.SD?.orgId, schoolId: selectedOption.value, name: selectedOption.textContent });
      }
      // Change handler
      schoolSelect.onchange = () => {
        const sel = schoolSelect.options[schoolSelect.selectedIndex];
        if (!sel || !sel.value) return;
        applySchoolSelection({ orgId: sel.dataset.orgId || window.SD?.orgId, schoolId: sel.value, name: sel.textContent });
      };
    }

    // Replace old admin-only visibility with role-driven nav
    function setRoleLinksFromClaims(token) {
      const isAdmin  = !!token?.claims?.admin;
      const isCaller = !!token?.claims?.caller;
      const isViewer = !!token?.claims?.viewer;
      const isSup    = !!token?.claims?.superintendent;

      const canCall  = isAdmin || isCaller;
      const canView  = isAdmin || isCaller || isViewer;

      const show = (els, ok) => els.forEach(el => {
        el.style.pointerEvents = ok ? '' : 'none';
        el.style.opacity = ok ? '' : '0.45';
        el.setAttribute('aria-hidden', ok ? 'false' : 'true');
      });
      // Superintendent: fully hide/show the link
      const toggleHidden = (selector, ok) => {
        document.querySelectorAll(selector).forEach(el => {
          el.hidden = !ok; el.setAttribute('aria-hidden', ok ? 'false' : 'true');
        });
      };

      show([...document.querySelectorAll('[data-requires="admin"]')],  isAdmin);
      show([...document.querySelectorAll('[data-requires="caller"]')], canCall);
      show([...document.querySelectorAll('[data-requires="viewer"]')], canView);
      toggleHidden('[data-requires="superintendent"]', isSup);

      // Role badge label
  const badges = [];
      if (isAdmin)  badges.push('Admin');
      if (isCaller) badges.push('Caller');
      if (isViewer && !isAdmin && !isCaller) badges.push('Viewer');
  if (isSup) badges.push('Superintendent');
      roleBadge.textContent = badges.join(' · ');
      roleBadge.style.display = badges.length ? '' : 'none';

      // Publish flags
      window.SD = window.SD || {};
  window.SD.roles   = { admin: isAdmin, caller: isCaller, viewer: isViewer, superintendent: isSup };
      window.SD.canCall = canCall;
      window.SD.canView = canView;
      window.SD.canAdmin = isAdmin;
    }

    // Make sign-in callable from other pages
    async function startSignIn(which = 'google') {
  let provider = googleProvider;
  if (which === 'microsoft') provider = makeMsProvider('common', 'organizations');
      try {
        await auth.signInWithPopup(provider);
      } catch (e) {
        console.error('[Auth] Popup sign-in failed:', e.code, e.message);
        const fallbackCodes = new Set([
          'auth/popup-blocked',
          'auth/popup-closed-by-user',
          'auth/cancelled-popup-request',
          'auth/operation-not-supported-in-this-environment',
          'auth/internal-error'
        ]);
        if (fallbackCodes.has(e.code)) {
          await auth.signInWithRedirect(provider);
          return;
        }
        alert('Sign-in failed: ' + (e.code || e.message));
      }
    }
    window.SD = window.SD || {};
    window.SD.startSignIn = startSignIn;

    // Desktop sign-in buttons
  signInGoogleBtn?.addEventListener('click', () => startSignIn('google'));
  signInMsBtn?.addEventListener('click', () => startSignIn('microsoft'));
    signOutBtn.addEventListener('click', () => auth.signOut());
  signOutBtn2?.addEventListener('click', () => auth.signOut());
    document.querySelectorAll('[data-login]').forEach(el => {
      el.addEventListener('click', (e) => { e.preventDefault(); startSignIn('google'); });
    });

    // Mobile menu helpers
    function openMenu(){
      if (!hdrMenuPanel) return;
      hdrMenuPanel.hidden = false; hdrMenuPanel.classList.add('open');
      if (hdrMenuScrim){ hdrMenuScrim.hidden = false; hdrMenuScrim.classList.add('open'); }
      hdrMenuBtn?.setAttribute('aria-expanded','true');
    }
    function closeMenu(){
      if (!hdrMenuPanel) return;
      hdrMenuPanel.classList.remove('open');
      if (hdrMenuScrim){ hdrMenuScrim.classList.remove('open'); setTimeout(()=>{ hdrMenuScrim.hidden = true; }, 200); }
      setTimeout(()=>{ hdrMenuPanel.hidden = true; }, 200);
      hdrMenuBtn?.setAttribute('aria-expanded','false');
    }
    hdrMenuBtn?.addEventListener('click', () => {
      const isOpen = hdrMenuPanel && !hdrMenuPanel.hidden && hdrMenuPanel.classList.contains('open');
      if (isOpen) closeMenu(); else openMenu();
    });
    hdrMenuClose?.addEventListener('click', closeMenu);
    hdrMenuScrim?.addEventListener('click', closeMenu);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  hdrSignInGoogle?.addEventListener('click', () => { closeMenu(); startSignIn('google'); });
  hdrSignInMicrosoft?.addEventListener('click', () => { closeMenu(); startSignIn('microsoft'); });
    hdrSignOut?.addEventListener('click', () => { closeMenu(); auth.signOut(); });

  // Read tenant + roles strictly from token claims (domain only as last-resort fallback elsewhere)
    async function resolveTenantAndRoles(user, token) {
      window.SD = window.SD || {};
      const claims = token?.claims || {};

      // Preferred school selection order:
      // 1) Valid stored preference (orgId+schoolId) if user has access (schoolIds includes it OR is superintendent)
      // 2) Token-provided primary schoolId
      // 3) First schoolIds[] entry
      let preferred = null;
      try {
        const stored = getStoredSchoolSelection();
        const isSup = !!claims.superintendent;
        const allowedList = Array.isArray(claims.schoolIds) ? claims.schoolIds : [];
        if (stored && stored.schoolId && (isSup || allowedList.includes(stored.schoolId))) {
          preferred = stored;
        } else if (stored && stored.schoolId && allowedList.length && !allowedList.includes(stored.schoolId)) {
          // Stored selection no longer valid for this user; clear it
          try { localStorage.removeItem('SD_SCHOOL'); localStorage.removeItem('SD_SCHOOL_OBJ'); } catch {}
        }
      } catch {}
      if (preferred && preferred.schoolId) {
        window.SD.orgId = preferred.orgId || window.SD.orgId || claims.orgId || 'mn-conference';
        window.SD.schoolId = preferred.schoolId;
      } else {
        let sid = claims.schoolId || null;
        if (!sid && Array.isArray(claims.schoolIds) && claims.schoolIds.length) {
          sid = claims.schoolIds[0] || null;
        }
        if (sid) window.SD.schoolId = sid;
        // orgId from claims if present
        if (claims.orgId) window.SD.orgId = window.SD.orgId || claims.orgId;
      }

      // roles strictly from claims
  const isAdmin  = !!claims.admin;
  const isCaller = !!claims.caller;
  const isSup    = !!claims.superintendent;
  const isViewer = !!claims.viewer || isAdmin || isCaller || isSup;

  window.SD.roles    = { admin: isAdmin, caller: isCaller, viewer: isViewer, superintendent: isSup };
      window.SD.canAdmin = isAdmin;
  window.SD.canCall  = (isAdmin || isCaller);
  window.SD.canView  = (isAdmin || isCaller || isViewer || isSup);

      // Drive nav
  setRoleLinksFromClaims({ claims: { ...claims, admin: isAdmin, caller: isCaller, viewer: isViewer, superintendent: isSup } });

      // Build school switcher from orgIds/schoolIds in claims (optional, may not exist yet)
      try {
        const schoolIds = Array.isArray(claims.schoolIds) ? claims.schoolIds.slice() : (claims.schoolId ? [claims.schoolId] : []);
        const orgIds = Array.isArray(claims.orgIds) ? claims.orgIds.slice() : (window.SD.orgId ? [window.SD.orgId] : []);
        const maybeBuild = (typeof buildSchoolSwitcher === 'function')
          ? buildSchoolSwitcher
          : (typeof buildUISchoolSwitcher === 'function' ? buildUISchoolSwitcher : null);
        if (maybeBuild) {
          await maybeBuild(orgIds, schoolIds);
        } else {
          try { console.debug('[TTD] School switcher not available; skipping UI switcher'); } catch {}
        }
      } catch (e) { try { console.warn('School switcher build failed:', e); } catch {} }
    }

    // ...existing code...

    // Ensure user has claims; NO legacy domain-based apply
    async function ensureClaims(user) {
      if (!user) return null;
      try {
        const before = await user.getIdTokenResult(); // no force-refresh first
        if (before?.claims && (before.claims.schoolId || before.claims.role || before.claims.admin || before.claims.viewer || before.claims.caller)) {
          window.SD = window.SD || {};
          window.SD.claims = before.claims;
          return before.claims;
        }
        // Legacy path disabled: do NOT call applySchoolClaim based on email domain
        // Instead, proceed with empty claims; owner/superintendent should provision roles via invite.
        window.SD = window.SD || {};
        window.SD.claims = before?.claims || {};
        return window.SD.claims;
      } catch (e) {
        try { console.warn('[ensureClaims] token read failed:', e); } catch {}
        const fallback = await user.getIdTokenResult(true).catch(()=>null);
        window.SD = window.SD || {};
        window.SD.claims = fallback?.claims || {};
        return window.SD.claims;
      }
    }

    // Pages that require auth; if signed out, redirect to index#login
    const PROTECTED = new Set([
      '/master.html',
      '/mastercaller.html',
      '/admin.html',
      '/manage.html',
      '/import.html',
      '/roles.html',
      '/owner.html',
      '/superintendent.html'
      ,'/prefs.html'
    ]);

    function redirectToLogin(){
      try {
        const u = new URL('/index.html', location.origin);
        u.hash = '#login';
        location.replace(u.toString());
      } catch { location.replace('/index.html#login'); }
    }

    // NEW: defer redirects to avoid bouncing during auth hydration
    let _pendingLoginTimer = null;
    function scheduleLoginRedirect(ms = 12000){
      // If we're still processing a redirect result, extend the grace period
      try { if (typeof _redirectResultPending !== 'undefined' && _redirectResultPending) ms = Math.max(ms, 9000); } catch {}
      try { clearTimeout(_pendingLoginTimer); } catch {}
      _pendingLoginTimer = setTimeout(() => {
        try {
          const auth = firebase.auth();
          if (!auth.currentUser) redirectToLogin();
        } catch { redirectToLogin(); }
      }, ms);
    }
    function cancelLoginRedirect(){
      try { clearTimeout(_pendingLoginTimer); } catch {}
      _pendingLoginTimer = null;
    }

  auth.onAuthStateChanged(async (user) => {
      if (!user) {
        show(signInBox);
        hide(userChip);
  // Reset school UI
  if (schoolSelect) { schoolSelect.innerHTML = ''; schoolSelect.style.display = 'none'; }
  if (schoolNameEl) { schoolNameEl.textContent = ''; schoolNameEl.style.display = 'none'; }
  setSchoolUIVisibility(false);

  // Mobile: show generic icon, show Sign in in the panel
  if (hdrAuthPhoto) hdrAuthPhoto.style.display = 'none';
  if (hdrAuthIcon)  hdrAuthIcon.style.display  = '';
  if (hdrSignInGoogle)  hdrSignInGoogle.style.display  = '';
  if (hdrSignInMicrosoft)  hdrSignInMicrosoft.style.display  = '';
  if (hdrSignOut) hdrSignOut.style.display = 'none';

        window.SD = window.SD || {};
        delete window.SD.schoolId;
        window.SD.roles = { admin:false, caller:false, viewer:false };
        window.SD.canCall = false;
        window.SD.canView = false;
        window.SD.canAdmin = false;
        window.SD.claims = {};
        window.claims = {};
        document.dispatchEvent(new CustomEvent('sd:claims-ready', { detail: { claims: null } }));

  // Hide superintendent link(s) when signed out
  try { document.querySelectorAll('[data-requires="superintendent"]').forEach(el => { el.hidden = true; el.setAttribute('aria-hidden','true'); }); } catch {}

        // If we're on a protected page, send to login quietly (no alerts)
        try {
          const path = location.pathname.replace(/\/+$/, '');
      if (PROTECTED.has(path)) scheduleLoginRedirect(1800); // defer instead of immediate
        } catch {}
        return;
      }

    // User arrived: cancel any pending redirect
    cancelLoginRedirect();

      const email = (user.email || '').toLowerCase();
      // Removed hard domain allowlist check; access is governed by claims/roles

      userEmail.textContent = email;
      if (user.photoURL) { userPhoto.src = user.photoURL; show(userPhoto); } else { hide(userPhoto); }
  hide(signInBox); show(userChip);
  // Desktop avatar popover toggle
  try {
    const btn = header.querySelector('#userAvatarBtn');
    const pop = header.querySelector('#userPop');
    if (btn && pop) {
      const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded','false'); };
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const nowHidden = !pop.hidden; // invert current state
        pop.hidden = nowHidden;
        const nowOpen = !pop.hidden; btn.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
      });
      document.addEventListener('click', (e) => {
        if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) close();
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    }
  } catch {}
      if (user.photoURL) { userPhoto.src = user.photoURL; show(userPhoto); } else { hide(userPhoto); }
  hide(signInBox); show(userChip);

  // Mobile: show avatar in toolbar
  if (hdrAuthPhoto && user.photoURL){ hdrAuthPhoto.src = user.photoURL; hdrAuthPhoto.style.display = ''; }
  if (hdrAuthIcon)  hdrAuthIcon.style.display = 'none';
  if (hdrSignInGoogle)  hdrSignInGoogle.style.display  = 'none';
  if (hdrSignInMicrosoft)  hdrSignInMicrosoft.style.display  = 'none';
  if (hdrSignOut) hdrSignOut.style.display = '';

  try {
        // Step B: ensure claims exist (may call CF and refresh token)
        await ensureClaims(user);

        // Now read fresh token with claims
        let token = await user.getIdTokenResult(true);

    // One-time per session: ask backend to recompute claims to drop any stale access
    // Track whether we explicitly requested a refresh so the first user doc snapshot forces a token reload
    let pendingClaimsRefresh = false;
        try {
          if (!sessionStorage.getItem('SD_CLAIMS_REFRESHED')) {
            const call = window.SD?.httpsCallable ? window.SD.httpsCallable('refreshMyClaims') : null;
            if (call) {
      pendingClaimsRefresh = true; // ensure first snapshot triggers token reload even if version already bumped
      await call();
      // Wait for new claims to actually appear (bounded poll)
      token = await waitForEffectiveClaims(user, 8000);
            }
            sessionStorage.setItem('SD_CLAIMS_REFRESHED', '1');
          }
        } catch {}

        // Seed school/org from claims only if not already set via stored preference
        if (!window.SD?.schoolId && token?.claims?.schoolId) {
          window.SD = window.SD || {};
          window.SD.schoolId = token.claims.schoolId;
        }
        if (!window.SD?.orgId) {
          window.SD.orgId = token?.claims?.orgId || window.SD.orgId || 'mn-conference';
        }

        // If missing, fallback to domain mapping once (but NOT for superintendent-only users)
        const isSup = !!(token?.claims && token.claims.superintendent);
        if (!window.SD?.schoolId) {
          if (!isSup) {
            try {
              const db = firebase.firestore();
              const t = await resolveTenant(db, user);
              window.SD.schoolId = t.schoolId;
              if (t.orgId) window.SD.orgId = t.orgId;
            } catch (e) {
              try { console.warn('[Tenant fallback] domain mapping failed:', e?.message || e); } catch {}
            }
          } else {
            // Superintendent without an explicit school — keep school unset; pages should offer a school picker
            // Prefer orgId(s) from claims if available
            const orgIds = Array.isArray(token?.claims?.orgIds) ? token.claims.orgIds : (token?.claims?.orgId ? [token.claims.orgId] : []);
            if (orgIds.length && !window.SD.orgId) window.SD.orgId = orgIds[0];
            // NEW: if claims do not provide any org identifier, attempt a one-time domain mapping fallback
            if (!orgIds.length && !window.SD.orgId) {
              try {
                const db = firebase.firestore();
                const t = await resolveTenant(db, user); // may throw if domain not mapped
                if (t && t.orgId) {
                  window.SD.orgId = t.orgId;
                  // do NOT set schoolId here; superintendent still picks a school later
                }
              } catch (e) {
                try { console.warn('[Sup fallback] No orgIds in claims and domain mapping failed:', e?.message || e); } catch {}
              }
            }
          }
        }

        // Roles and switcher from claims
        await resolveTenantAndRoles(user, token);
        // If school still unresolved for superintendent, build UI switcher to prompt selection
        try {
          const claims = token?.claims || {};
          if (!window.SD?.schoolId) {
            const orgIds = Array.isArray(claims.orgIds) ? claims.orgIds : (window.SD?.orgId ? [window.SD.orgId] : []);
            const schoolIds = Array.isArray(claims.schoolIds) ? claims.schoolIds : [];
            await buildUISchoolSwitcher(orgIds, schoolIds);
          }
        } catch {}

  // Step C: publish merged claims and notify pages
        const mergedClaims = {
          ...(token?.claims || {}),
          schoolId: window.SD.schoolId,
          orgId: window.SD.orgId || (token?.claims?.orgId),
          admin:  !!window.SD.roles?.admin,
          caller: !!window.SD.roles?.caller,
          viewer: !!window.SD.roles?.viewer
        };
        window.SD.claims = mergedClaims;
        window.claims = mergedClaims; // optional shim for older code
        document.dispatchEvent(new CustomEvent('sd:claims-ready', { detail: { claims: mergedClaims } }));

        // If a page defines initAppWithClaims, call it now
        if (typeof window.initAppWithClaims === 'function') {
          window.initAppWithClaims(mergedClaims);
        }

        // Live claims invalidation: listen for bumps in /users/{uid}
        try {
          const db = firebase.firestore();
          const uref = db.collection('users').doc(user.uid);
          let lastVersion = null;
          uref.onSnapshot(async (snap) => {
            const data = snap.data() || {};
            const ver = data.claimsVersion || 0;
            const first = (lastVersion === null);
            const changed = (ver !== lastVersion);
            if (first || changed || pendingClaimsRefresh) {
              lastVersion = ver;
              // Force refresh token and re-run role resolve quickly on first or changed version
              let t2 = await user.getIdTokenResult(true);
              await resolveTenantAndRoles(user, t2);
              const freshClaims = { ...(t2?.claims || {}), schoolId: window.SD.schoolId, orgId: window.SD.orgId || (t2?.claims?.orgId) };
              window.SD.claims = freshClaims;
              document.dispatchEvent(new CustomEvent('sd:claims-ready', { detail: { claims: freshClaims } }));
              pendingClaimsRefresh = false;
            }
          });
        } catch (e) { try { console.warn('claims bump watch failed', e); } catch {} }
      } catch (e) {
        console.error('Error ensuring claims / resolving roles:', e);
        setRoleLinksFromClaims({ claims: {} });
      }
    });
    // Helper: wait until token contains any role-ish claim (or timeout)
    // Adaptive poll: faster early (every 200ms first 1.5s) then 350ms; trims max wait to ~6.5s.
    // Still treats any roles array (claims.roles = ['admin']) as success.
    async function waitForEffectiveClaims(user, timeoutMs = 15000){
      const start = Date.now();
      const hasRoles = (c) => !!(c.owner || c.superintendent || c.admin || c.caller || c.viewer || (Array.isArray(c.roles) && c.roles.length));
      while (Date.now() - start < timeoutMs){
        try {
          const t = await user.getIdTokenResult(true);
          const c = t?.claims || {};
          if (hasRoles(c)) return t;
        } catch {}
        const elapsed = Date.now() - start;
        const delay = elapsed < 1500 ? 200 : 350;
        await new Promise(r => setTimeout(r, delay));
      }
      try { return await user.getIdTokenResult(true); } catch { return null; }
    }
  });
})();
