(function(){
  function onClaimsReady(cb){
    if (window.SD?.claims) cb(window.SD.claims);
    document.addEventListener('sd:claims-ready', (e) => cb(e.detail?.claims || {}), { once:true });
  }
  function hasRole(c, role){
    const admin  = !!c?.admin;
    const caller = !!(c?.caller || admin);
    const viewer = !!(c?.viewer || caller);
    if (role === 'admin')  return admin;
    if (role === 'caller') return caller;
    if (role === 'viewer') return viewer;
    return true;
  }
  async function guard(role, { redirect } = {}){
    const claims = await new Promise((resolve) => {
      if (window.SD?.claims) return resolve(window.SD.claims);
      const to = setTimeout(() => resolve(window.SD?.claims || {}), 8000);
      document.addEventListener('sd:claims-ready', (e) => { clearTimeout(to); resolve(e.detail?.claims || {}); }, { once:true });
    });
    const ok = hasRole(claims, role);
    if (!ok && redirect) location.replace(redirect);
    return ok ? claims : false;
  }
  window.Page = { onClaimsReady, guard };
})();