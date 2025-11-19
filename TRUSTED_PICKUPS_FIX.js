// ========================================
// TRUSTED PICKUPS FIX FOR PARENTS.HTML
// ========================================
// Instructions: 
// 1. Find line 963 in parents.html (search for "// Load grants after claims")
// 2. DELETE lines 963-1056 (all the corrupted code)
// 3. PASTE the code below in that location

// Trusted pickups: render grants where I am the grantee
function renderTrusted(pickups) {
    trustedWrap.innerHTML = '';
    if (!Array.isArray(pickups) || !pickups.length) {
        trustedWrap.style.display = 'none';
        trustedEmpty.style.display = '';
        return;
    }
    trustedEmpty.style.display = 'none';
    trustedWrap.style.display = 'flex';

    for (const p of pickups) {
        const card = document.createElement('div');
        card.className = 'pass';
        const who = p.studentName || p.studentId;
        const by = p.grantorName ? `Granted by ${p.grantorName}` : '';
        const note = p.note ? ` · ${p.note}` : '';
        card.innerHTML = `
            <div class="hdr">
              <div class="std">${formatName(who)}</div>
              <span class="badge" title="Trusted pickup">Trusted</span>
            </div>
            <div class="win" aria-label="Pickup window">${p.window || 'Always'}${by ? ' · ' + by : ''}${note}</div>
            <div class="qr" aria-label="QR code"><div class="qr-host" data-base="${(p.basePayload || '')}"></div></div>
          `;
        trustedWrap.appendChild(card);
    }

    trustedWrap.querySelectorAll('.qr-host').forEach(host => {
        const base = host.getAttribute('data-base') || '';
        drawQrInto(host, base);
    });
}

async function loadTrustedPickups() {
    console.log('[parents] loadTrustedPickups: START');
    try {
        const call = (window.SD && window.SD.httpsCallable) ? window.SD.httpsCallable('listMyPickupAccess') : null;
        if (!call) {
            console.warn('[parents] loadTrustedPickups: httpsCallable not available');
            return;
        }
        console.log('[parents] loadTrustedPickups: Calling backend...');
        const resp = await call({});
        console.log('[parents] loadTrustedPickups: Response received', resp);

        const data = (resp && resp.data) || resp || {};
        const pickups = Array.isArray(data.pickups) ? data.pickups : [];
        console.log(`[parents] loadTrustedPickups: Found ${pickups.length} pickup(s)`);

        const mapped = pickups.map(p => {
            const tag = (p.tag || '').toString().trim();
            const base = tag ? ('car=' + encodeURIComponent(tag.toUpperCase())) : ('student=' + encodeURIComponent(p.studentId));
            return {
                studentId: p.studentId,
                studentName: p.studentName,
                window: p.window,
                grantorName: p.grantorName,
                note: p.note,
                basePayload: base,
            };
        });
        renderTrusted(mapped);
    } catch (e) {
        console.error('[parents] loadTrustedPickups: FAILED', e);
    }
}

// Load grants and trusted pickups after claims
document.addEventListener('sd:claims-ready', () => {
    console.log('[parents] sd:claims-ready event fired - loading grants and trusted pickups');
    loadGrants();
    loadTrustedPickups();
});

async function loadDiscoverable() {
    try {
        const call = callable('listDiscoverableParents');
        let orgId = window.SD?.orgId; let schoolId = window.SD?.schoolId;
        if (discSchool && discSchool.value) { const [o, s] = discSchool.value.split('|'); if (o && s) { orgId = o; schoolId = s; } }
        if (!orgId || !schoolId) return;
        try {
            if (!call) throw new Error('no-callable');
            const resp = await call({ orgId, schoolId, limit: 50 });
            const list = (resp?.data?.parents) || [];
            const cu = window.firebase?.auth()?.currentUser?.uid || null;
            renderDiscoverable(list, cu);
        } catch (e1) {
            console.warn('listDiscoverableParents callable failed', e1);
            // HTTP shim fallback
            try {
                const user = window.firebase?.auth()?.currentUser; if (!user) return;
                const token = await user.getIdToken();
                const url = `https://us-central1-dismissalcallerdev.cloudfunctions.net/listDiscoverableParentsHttp?orgId=${encodeURIComponent(orgId)}&schoolId=${encodeURIComponent(schoolId)}&limit=50`;
                const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
                const d = await res.json(); const list = (d?.parents) || [];
                renderDiscoverable(list, user?.uid || null);
            } catch (e2) { console.warn('HTTP listDiscoverableParentsHttp failed', e2); }
        }
    } catch (e) { console.warn('loadDiscoverable failed', e); }
}
discSchool?.addEventListener('change', loadDiscoverable);
