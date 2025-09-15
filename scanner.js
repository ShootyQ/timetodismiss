// /scanner.js
// Camera QR scanner for car tags and student IDs.
// Emits:
//  - 'scan:car-tag'     with detail { tag }
//  - 'scan:student-id'  with detail { id }

(function(){
  let sheet, video, statusEl, closeBtn, flipBtn, flashBtn;
  let stream = null, track = null, useBack = true, torchOn = false;
  let rafId = 0;
  let lastText = '', lastAt = 0;
  let cooldownUntil = 0; // pause detection after a success
  const DETECT_INTERVAL = 120; // ms between detect attempts
  const DUP_MS = 1200;         // minimal interval to accept same payload twice

  const ZX = { ready: false, reader: null, controls: null };
  const hasBarcodeDetector = 'BarcodeDetector' in window;
  let detector = null;
  if (hasBarcodeDetector) {
    try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch {}
  }

  function ensureSheet(){
    sheet = document.getElementById('qrSheet');
    if (!sheet) { return false; }
    if (!sheet.dataset.wired){
      sheet.innerHTML = `
        <div class="qr-inner" style="position:fixed;inset:0;background:#0b132bE6;display:flex;flex-direction:column;z-index:1000">
          <div class="qr-bar" style="display:flex;align-items:center;gap:8px;justify-content:space-between;padding:10px 12px;color:#fff">
            <strong>Scanner</strong>
            <div style="display:flex;gap:8px;align-items:center">
              <button id="qrFlip"  class="btn btn-outline" type="button">Flip</button>
              <button id="qrFlash" class="btn btn-outline" type="button">Flash</button>
              <button id="qrClose" class="btn btn-primary" type="button">Close</button>
            </div>
          </div>
          <div class="qr-video-wrap" style="flex:1 1 auto;display:grid;place-items:center;padding:10px">
            <video id="qrVideo" playsinline autoplay style="max-width:96vw;max-height:70vh;border-radius:12px;background:#000"></video>
          </div>
          <div id="qrStatus" style="color:#fff;opacity:.9;text-align:center;padding:8px 12px;min-height:24px"></div>
        </div>`;
      video = document.getElementById('qrVideo');
      statusEl = document.getElementById('qrStatus');
      closeBtn = document.getElementById('qrClose');
      flipBtn  = document.getElementById('qrFlip');
      flashBtn = document.getElementById('qrFlash');

      closeBtn?.addEventListener('click', close);
      flipBtn?.addEventListener('click', async () => {
        useBack = !useBack;
        if (hasBarcodeDetector) {
          await startCamera();
        } else {
          // ZXing fallback: re-init with preferred device if possible
          await startZXing();
        }
      });
      flashBtn?.addEventListener('click', () => setTorch(!torchOn));
      sheet.dataset.wired = '1';
    } else {
      video = document.getElementById('qrVideo');
      statusEl = document.getElementById('qrStatus');
      closeBtn = document.getElementById('qrClose');
      flipBtn  = document.getElementById('qrFlip');
      flashBtn = document.getElementById('qrFlash');
    }
    return true;
  }

  function showSheet(v){
    if (!sheet) return;
    try { sheet.hidden = !v; } catch {}
    if (v) document.body.classList.add('no-scroll'); else document.body.classList.remove('no-scroll');
  }

  function status(msg){ if (statusEl) statusEl.textContent = msg || ''; }

  function norm(s){ return (s || '').toUpperCase().replace(/\s+/g,'').replace(/[^A-Z0-9\-]/g,''); }

  function dedupe(txt){
    const now = performance.now();
    if (txt === lastText && (now - lastAt) < DUP_MS) return true;
    lastText = txt; lastAt = now; return false;
  }

  function emitTag(tag){
    const ev = new CustomEvent('scan:car-tag', { detail: { tag }, bubbles: true });
    document.dispatchEvent(ev);
  }
  function emitStudent(id){
    const ev = new CustomEvent('scan:student-id', { detail: { id }, bubbles: true });
    document.dispatchEvent(ev);
  }

  function parsePayload(txt){
    const t = String(txt || '').trim();
    if (!t) return null;
    // Key=val format: car, tag, plate, ticket, student, sid
    if (t.includes('=')){
      const parts = t.split(/[&\n;]/).map(s=>s.trim()).filter(Boolean);
      const kv = {};
      for (const p of parts){
        const i = p.indexOf('='); if (i <= 0) continue;
        const k = decodeURIComponent(p.slice(0,i)).trim().toLowerCase();
        const v = decodeURIComponent(p.slice(i+1)).trim();
        if (k) kv[k] = v;
      }
      const stud = kv.student || kv.sid || kv.stud;
      if (stud) return { student: stud };
      const car = kv.car || kv.tag || kv.plate || kv.ticket;
      if (car) return { car };
    }
    // Bare string → car tag
    return { car: t };
  }

  function beep(){ try { new Audio('/chime.mp3').play().catch(()=>{}); } catch{} }

  async function setTorch(on){
    try{
      if (!track) return;
      const caps = track.getCapabilities?.();
      if (!caps || !('torch' in caps)) { status('Torch not supported'); return; }
      await track.applyConstraints({ advanced: [{ torch: !!on }] });
      torchOn = !!on;
      status(torchOn ? 'Flash on' : 'Flash off');
    }catch(e){ status('Torch unavailable'); }
  }

  async function startCamera(){
    stopCamera();
    try{
      const constraints = {
        audio: false,
        video: {
          facingMode: useBack ? { ideal: 'environment' } : { ideal: 'user' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      };
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      track = stream.getVideoTracks()[0] || null;
      if (video) video.srcObject = stream;
      await video?.play?.();
      status('Point camera at QR');
      scanLoopNative();
    }catch(e){
      status('Camera unavailable');
      console.error('[scanner] getUserMedia failed', e);
    }
  }

  function stopCamera(){
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    try { video && (video.srcObject = null); } catch {}
    try { stream && stream.getTracks().forEach(t => t.stop()); } catch {}
    stream = null; track = null; torchOn = false;
  }

  async function scanLoopNative(){
    if (!detector || !video) return;
    let lastTry = 0;
    const tick = async () => {
      rafId = requestAnimationFrame(tick);
      const now = performance.now();
  // Respect cooldown window
  if (now < cooldownUntil) { return; }
      if (now - lastTry < DETECT_INTERVAL) return;
      lastTry = now;
      try{
        const results = await detector.detect(video);
        if (results && results.length){
          const raw = results[0].rawValue || '';
          if (!raw || dedupe(raw)) return;
          handleResult(raw);
        }
      }catch(e){ /* ignore frame errors */ }
    };
    tick();
  }

  async function ensureZXing(){
    if (ZX.ready) return;
    try {
      const mod = await import('https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/esm/index.min.js');
      ZX.reader = new mod.BrowserMultiFormatReader();
      ZX.ready = true;
    }catch(e){ console.error('[scanner] ZXing load failed', e); }
  }

  async function enumerateVideoDevices(){
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter(d => d.kind === 'videoinput');
  }

  async function pickDeviceId(){
    const cams = await enumerateVideoDevices();
    if (cams.length === 0) return null;
    // naive pick: prefer environment/back label when available
    const back = cams.find(c => /back|rear|environment/i.test(c.label));
    const front = cams.find(c => /front|user/i.test(c.label));
    return (useBack ? (back?.deviceId || cams[0].deviceId) : (front?.deviceId || cams[0].deviceId));
  }

  async function startZXing(){
    // Stop any native camera first
    stopCamera();
    await ensureZXing();
    if (!ZX.ready) { status('Scanner unavailable'); return; }
    try {
      if (ZX.controls){ try{ ZX.controls.stop(); }catch{} ZX.controls = null; }
      const deviceId = await pickDeviceId();
      ZX.controls = await ZX.reader.decodeFromVideoDevice(deviceId || null, video, (result, err) => {
        if (result) {
          const text = String(result.getText?.() || result.text || '');
      // Respect cooldown and dedupe
      if (!text || performance.now() < cooldownUntil || dedupe(text)) return;
          handleResult(text);
        }
      });
      status('Point camera at QR');
    }catch(e){
      status('Scanner unavailable');
      console.error('[scanner] ZXing start failed', e);
    }
  }

  function handleResult(text){
    const parsed = parsePayload(text);
    if (!parsed) return;
    beep();
    if (parsed.student){ emitStudent(String(parsed.student).trim()); status('Student scanned'); }
    else if (parsed.car){ const t = norm(parsed.car); emitTag(t); status(`Tag: ${t}`); }
    // Begin short cooldown (2.2s) to prevent duplicate bursts
    cooldownUntil = performance.now() + 2200;
  }

  async function open(){
    if (!ensureSheet()) return;
    showSheet(true);
    // Escape closes
    document.addEventListener('keydown', escCloseOnce, { once: true });
    if (hasBarcodeDetector && detector) await startCamera(); else await startZXing();
  }

  function escCloseOnce(ev){ if (ev.key === 'Escape') close(); }

  function close(){
    try{ document.removeEventListener('keydown', escCloseOnce, { once: true }); }catch{}
    stopCamera();
    if (ZX.controls){ try{ ZX.controls.stop(); }catch{} ZX.controls = null; }
    showSheet(false);
  }

  // Wire the Master page button if present
  window.addEventListener('DOMContentLoaded', () => {
    ensureSheet();
    const btn = document.getElementById('openScanner');
    if (btn && !btn.dataset.wired){ btn.addEventListener('click', open); btn.dataset.wired='1'; }
  });

  // Public API if needed elsewhere
  window.TTDScanner = { open, close };
})();
// /scanner.js
// Standalone camera scanner. Emits 'scan:car-tag' events with { tag } only — never student names.

let sheet, video, statusEl, flipBtn, flashBtn;
let stream = null, track = null, useBack = true, torchOn = false;
let detector = ('BarcodeDetector' in window)
  ? new BarcodeDetector({ formats: ['qr_code'] })
  : null;

let rafId = null, lastText = '', lastAt = 0, coolUntil = 0;

const ZX = { ready: false, reader: null }; // lazy QR fallback

async function ensureZXing() {
  if (ZX.ready) return;
  const { BrowserMultiFormatReader } = await import('https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/esm/index.min.js');
  ZX.reader = new BrowserMultiFormatReader();
  ZX.ready = true;
}

function visible(v){ if (sheet) sheet.hidden = !v; }

async function startCamera() {
  stopCamera();
  try{
    const constraints = {
      audio: false,
      video: {
        facingMode: useBack ? 'environment' : 'user',
        width: { ideal: 1280 }, height: { ideal: 720 }
      }
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (!video) return;
    video.srcObject = stream;
    await video.play();
    track = stream.getVideoTracks()[0];
    status('Point camera at a QR or license plate…');
    scanLoop();
  } catch(e){ status('Camera blocked. Enable permissions and try again.'); }
}

function stopCamera() {
  if (rafId) cancelAnimationFrame(rafId), rafId = null;
  try{ if (track) { track.stop(); track = null; } }catch{}
  try{ if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } }catch{}
  if (video) video.srcObject = null;
  torchOn = false;
}

function status(msg){ if (statusEl) statusEl.textContent = msg; }

async function setTorch(on){
  try{
    if (!track) return;
    const caps = track.getCapabilities?.();
    if (caps?.torch) {
      await track.applyConstraints({ advanced: [{ torch: on }] });
      torchOn = on;
      status(on ? 'Flash: ON' : 'Flash: OFF');
    } else {
      status('Flash not supported on this camera.');
    }
  } catch {
    status('Could not toggle flash on this device.');
  }
}

function dedupe(txt){
  const now = performance.now();
  if (txt === lastText && (now - lastAt) < 1200) return true;
  lastText = txt; lastAt = now; return false;
}

function emitTag(tag){
  const ev = new CustomEvent('scan:car-tag', { detail: { tag }, bubbles: true });
  document.dispatchEvent(ev);
}

function emitStudent(id){
  const ev = new CustomEvent('scan:student-id', { detail: { id }, bubbles: true });
  document.dispatchEvent(ev);
}

async function scanOnce() {
  // 1) Native QR detection
  try {
    if (detector && video?.readyState >= 2) {
      const codes = await detector.detect(video);
      if (codes?.length) {
        const txt = codes[0].rawValue || codes[0].data || '';
        if (txt) return txt;
      }
    }
  } catch {}
  // 2) ZXing fallback
  try {
    await ensureZXing();
    if (ZX.reader && video) {
      const res = await ZX.reader.decodeOnceAsync(video).catch(()=>null);
      if (res?.text) return res.text;
    }
  } catch {}
  // 3) Future: add OCR for plates
  return null;
}

function scanLoop() {
  rafId = requestAnimationFrame(async () => {
    if (performance.now() < coolUntil) { return scanLoop(); }
    const txt = await scanOnce();
    if (txt && !dedupe(txt)) {
      const { car, plate, student } = parsePayload(txt);
      const tag = car || plate || '';
      if (tag) {
        try { beep(); } catch {}
        status('Scanned: ' + tag);
        emitTag(tag);
      } else if (student) {
        try { beep(); } catch {}
        status('Scanned student');
        emitStudent(student);
      }
      // Pause further detection briefly
      coolUntil = performance.now() + 2200;
    }
    scanLoop();
  });
}

function parsePayload(txt){
  // Accept:
  // 1) key=value strings like "car=MCA-ROWE" or "plate=ABC123" or "student=abc123"
  // 2) bare strings like "MCA-ROWE" (treated as car tag)
  const t = String(txt).trim();
  const kv = Object.fromEntries(
    t.split('&')
     .map(p => p.split('=').map(s => decodeURIComponent(s.trim())))
     .filter(a => a.length === 2 && a[0])
  );
  if (kv.car || kv.plate || kv.student) return { car: norm(kv.car), plate: norm(kv.plate), student: (kv.student||'').trim() };
  return { car: norm(t) };
}

function norm(s){ return (s || '').toUpperCase().replace(/\s+/g,'').replace(/[^A-Z0-9\-]/g,''); }

function beep(){
  try{
    const a = new AudioContext();
    const o = a.createOscillator(); const g = a.createGain();
    o.type = 'square'; o.frequency.value = 880; o.connect(g); g.connect(a.destination);
    o.start(); setTimeout(()=>{ o.stop(); a.close(); }, 120);
  }catch{}
}

// Boot wires
window.addEventListener('DOMContentLoaded', () => {
  sheet = document.getElementById('qrSheet');
  video = document.getElementById('qrVideo');
  statusEl = document.getElementById('qrStatus');
  flipBtn = document.getElementById('qrFlip');
  flashBtn = document.getElementById('qrFlash');

  document.getElementById('openScanner')?.addEventListener('click', open);
  document.getElementById('qrClose')?.addEventListener('click', close);

  flipBtn?.addEventListener('click', async () => {
    useBack = !useBack; status('Switching camera…');
    await startCamera();
  });

  flashBtn?.addEventListener('click', () => setTorch(!torchOn));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    if ((e.key === 's' || e.key === 'S') && !e.metaKey && !e.ctrlKey && !e.altKey) open();
  });
});

async function open(){
  visible(true);
  await startCamera();
}

function close(){
  visible(false);
  stopCamera();
}
