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
      link.href = '/images/favicon.png'; // align with index.html
      document.head.appendChild(link);
    }
  }

  function ensureHeaderShell() {
  if (document.querySelector('header.site-header')) return;
    const header = document.createElement('header');
    header.className = 'site-header';
    header.innerHTML = `
      <div class="container header-inner" style="display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.75rem 1rem;">
        <a href="/index.html" class="brand" style="font-weight:800;text-decoration:none;">Time To Dismiss</a>
        <nav class="nav" style="display:flex;gap:1rem;flex-wrap:wrap;">
          <a href="/class.html" class="nav-link" data-requires="viewer">Classes</a>
          <a href="/master.html"  class="nav-link" data-requires="caller">Master Caller</a>
          <a href="/admin.html"   class="nav-link" data-requires="admin">Admin</a>
          <a href="/superintendent.html" class="nav-link" data-requires="superintendent">Superintendent</a>
        </nav>
        <div id="authBox" class="auth-inline" style="display:flex;gap:.5rem;align-items:center;">
          <div id="schoolBox" class="user-chip" style="display:none;align-items:center;gap:.4rem;min-width:0; margin-right:.25rem;">
            <span class="small muted">School:</span>
            <span id="schoolName" class="chip" style="font-weight:700; border:1px solid #e5e7eb; padding:.1rem .4rem; border-radius:999px; max-width:24ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"></span>
            <select id="schoolSelect" style="display:none; border:1px solid #e5e7eb; border-radius:10px; padding:.25rem .4rem;"></select>
          </div>
          <div id="signInBtns" class="signin-btns" style="display:flex; gap:.5rem; flex-wrap:wrap;">
            <button id="signInGoogle" class="btn" type="button">Sign in with Google</button>
            <button id="signInMicrosoft" class="btn btn-outline" type="button">Sign in with Microsoft</button>
          </div>
          <div id="userChip" class="user-chip" style="display:none;align-items:center;gap:.5rem;min-width:0;">
            <img id="userPhoto" alt="" style="width:28px;height:28px;border-radius:999px;display:none;object-fit:cover;" />
            <span id="userEmail" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:52vw;"></span>
            <span id="roleBadge" class="role-badge" style="display:none;padding:.1rem .4rem;border-radius:.4rem;font-size:.8rem;border:1px solid currentColor;opacity:.8;"></span>
            <button id="signOutBtn" class="btn btn--ghost" type="button">Sign out</button>
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
    return firebase.auth();
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

    auth.getRedirectResult().catch(e => {
      console.warn('[Auth] Redirect sign-in error:', e.code, e.message);
    });

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
    function applySchoolSelection(sel){
      // sel: { orgId, schoolId, name }
      if (!sel || !sel.schoolId) return;
      window.SD = window.SD || {};
      window.SD.orgId = sel.orgId || window.SD.orgId || window.SD.claims?.orgId || 'mn-conference';
      window.SD.schoolId = sel.schoolId;
      window.SD.schoolName = sel.name || sel.schoolId;
      try { localStorage.setItem('SD_SCHOOL', sel.schoolId); } catch {}
      if (schoolNameEl) schoolNameEl.textContent = window.SD.schoolName;
      // Announce to pages
      try {
        document.dispatchEvent(new CustomEvent('sd:school-changed', { detail: { orgId: window.SD.orgId, schoolId: sel.schoolId, schoolName: window.SD.schoolName } }));
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

      // schoolId: from claim or first of schoolIds; prefer a stored selection if still valid
      let sid = claims.schoolId || null;
      if (!sid && Array.isArray(claims.schoolIds) && claims.schoolIds.length){
        const pref = (() => { try { return localStorage.getItem('SD_SCHOOL') || ''; } catch { return ''; } })();
        if (pref && !claims.schoolIds.includes(pref)) {
          // Clear stale preference (e.g., showing MCA from prior session)
          try { localStorage.removeItem('SD_SCHOOL'); } catch {}
        }
        const chosen = (pref && claims.schoolIds.includes(pref)) ? pref : claims.schoolIds[0];
        sid = chosen || null;
      }
      if (sid) window.SD.schoolId = sid;

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
    function scheduleLoginRedirect(ms = 1800){
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

        // Seed school/org from claims first
        if (token?.claims?.schoolId) {
          window.SD = window.SD || {};
          window.SD.schoolId = token.claims.schoolId;
          // Default orgId when not present in claims
          window.SD.orgId = token.claims.orgId || window.SD.orgId || 'mn-conference';
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
    async function waitForEffectiveClaims(user, timeoutMs = 6500){
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
