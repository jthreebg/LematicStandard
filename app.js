const ICO = {
      clip: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="8" y="3.2" width="8" height="3.6" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="5.2" y="5.2" width="13.6" height="15.6" rx="2.4" stroke="currentColor" stroke-width="1.2"/><path d="M9 12h6M9 16h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
      search: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="6.2" stroke="currentColor" stroke-width="1.8"/><path d="M20 20l-3.6-3.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
      warn: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 4.2L21.2 20.2H2.8L12 4.2z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10.2v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="17.6" r="1" fill="currentColor"/></svg>',
      cam: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4.2 8.4h3l1.4-2.2h6.8l1.4 2.2h3c.9 0 1.6.7 1.6 1.6v8.2c0 .9-.7 1.6-1.6 1.6H4.2c-.9 0-1.6-.7-1.6-1.6V10c0-.9.7-1.6 1.6-1.6z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="13.4" r="3.1" stroke="currentColor" stroke-width="1.8"/></svg>',
      doc: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 3.4h7.2L19.6 9v11.2c0 .8-.7 1.4-1.5 1.4H7c-.8 0-1.5-.6-1.5-1.4V4.8c0-.8.7-1.4 1.5-1.4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14.2 3.5V9h5.3" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.6 13h6.8M8.6 16.4h4.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
      check: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.2" stroke="currentColor" stroke-width="1.8"/><path d="M8.2 12.2l2.6 2.6 5-5.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    };

    // ========== DATA ==========
    let APP_DATA = null;
    let currentInspection = null;
    let editingInspectionId = null; // when set, start form is in edit-meta mode
    let currentSectionIndex = 0;
    let currentItemIndex = 0;
    let inspectListMode = false;
    let inspectSlideDir = null;
    let extraSectionTab = null;
    let notesSource = 'inspection';
    let results = {}; // item_id -> {condition, notes, impacts, severity, photoDataUrl}
    let findings = [];

    // Load data
    function setActiveMachine(model) {
      const key = model || 'LX-8';
      const pack = (window.MACHINE_TEMPLATES && (window.MACHINE_TEMPLATES[key] || window.MACHINE_TEMPLATES['LX-8'])) || window.EMBEDDED_DATA;
      APP_DATA = pack || { sections: [], items: [], lists: {} };
      return APP_DATA;
    }
    async function loadData({ init = true } = {}) {
      if (window.MACHINE_TEMPLATES && window.MACHINE_TEMPLATES['LX-8']) {
        setActiveMachine('LX-8');
      } else if (window.EMBEDDED_DATA && window.EMBEDDED_DATA.sections && window.EMBEDDED_DATA.sections.length) {
        APP_DATA = window.EMBEDDED_DATA;
      } else {
        try {
          const res = await fetch('inspection_data.json');
          APP_DATA = await res.json();
        } catch (e) {
          console.warn('Could not load data');
          APP_DATA = { sections: [], items: [], lists: {} };
        }
      }
      if (init) initApp();
      return APP_DATA;
    }

    // ========== STORAGE (IndexedDB + localStorage fallback) ==========
    const LX_DB_NAME = 'lematic-lx8';
    const LX_DB_VER = 1;
    const storeMem = {
      inspections: null,
      visits: null,
      jobs: null,
      ready: false
    };
    let lxDb = null;
    let lxPersistTimer = null;

    function lsRead(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return parsed == null ? fallback : parsed;
      } catch (e) { return fallback; }
    }
    function lsWrite(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; }
      catch (e) { return false; }
    }

    function idbOpen() {
      if (lxDb) return Promise.resolve(lxDb);
      if (!('indexedDB' in window)) return Promise.reject(new Error('no-idb'));
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(LX_DB_NAME, LX_DB_VER);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
          if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
        };
        req.onsuccess = () => { lxDb = req.result; resolve(lxDb); };
        req.onerror = () => reject(req.error || new Error('idb-open-failed'));
      });
    }
    function idbGetKv(key) {
      return idbOpen().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readonly');
        const req = tx.objectStore('kv').get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }));
    }
    function idbSetKv(key, value) {
      return idbOpen().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      }));
    }
    function idbPutPhoto(rec) {
      return idbOpen().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction('photos', 'readwrite');
        tx.objectStore('photos').put(rec);
        tx.oncomplete = () => resolve(rec.id);
        tx.onerror = () => reject(tx.error);
      }));
    }
    function idbGetPhoto(id) {
      if (!id) return Promise.resolve(null);
      return idbOpen().then(db => new Promise((resolve, reject) => {
        const req = db.transaction('photos', 'readonly').objectStore('photos').get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      }));
    }
    function idbDeletePhotos(ids) {
      const list = (ids || []).filter(Boolean);
      if (!list.length) return Promise.resolve();
      return idbOpen().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction('photos', 'readwrite');
        const st = tx.objectStore('photos');
        list.forEach(id => st.delete(id));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }));
    }
    function idbGetAllPhotos() {
      return idbOpen().then(db => new Promise((resolve, reject) => {
        const req = db.transaction('photos', 'readonly').objectStore('photos').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      })).catch(() => []);
    }

    function dataUrlToBlob(dataUrl) {
      try {
        const m = String(dataUrl).match(/^data:([^;]+);base64,(.*)$/);
        if (!m) return null;
        const bin = atob(m[2]);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new Blob([arr], { type: m[1] || 'image/jpeg' });
      } catch (e) { return null; }
    }
    function blobToObjectUrl(blob) {
      if (!blob) return '';
      try { return URL.createObjectURL(blob); } catch (e) { return ''; }
    }
    function compressImageFile(file, maxEdge, quality) {
      maxEdge = maxEdge || 1600;
      quality = quality == null ? 0.72 : quality;
      return new Promise((resolve) => {
        if (!file) return resolve(null);
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          try {
            let w = img.naturalWidth || img.width;
            let h = img.naturalHeight || img.height;
            const scale = Math.min(1, maxEdge / Math.max(w, h));
            w = Math.max(1, Math.round(w * scale));
            h = Math.max(1, Math.round(h * scale));
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            canvas.toBlob((blob) => {
              URL.revokeObjectURL(url);
              resolve(blob || file);
            }, 'image/jpeg', quality);
          } catch (e) {
            URL.revokeObjectURL(url);
            resolve(file);
          }
        };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
        img.src = url;
      });
    }

    async function hydratePhotoUrl(ph) {
      if (!ph) return ph;
      if (typeof ph === 'string') {
        if (ph.indexOf('data:') === 0 || ph.indexOf('blob:') === 0) return { url: ph, caption: '' };
        const rec = await idbGetPhoto(ph).catch(() => null);
        if (rec && rec.blob) return { id: ph, url: blobToObjectUrl(rec.blob), caption: rec.caption || '' };
        return { url: ph, caption: '' };
      }
      if (ph.url && (String(ph.url).indexOf('data:') === 0 || String(ph.url).indexOf('blob:') === 0 || String(ph.url).indexOf('http') === 0)) return ph;
      if (ph.id) {
        const rec = await idbGetPhoto(ph.id).catch(() => null);
        if (rec && rec.blob) return { id: ph.id, url: blobToObjectUrl(rec.blob), caption: ph.caption || rec.caption || '' };
      }
      return ph;
    }

    async function persistPhotoRecord(photo, prefix) {
      if (!photo) return photo;
      const caption = typeof photo === 'string' ? '' : (photo.caption || '');
      const existingId = typeof photo === 'object' ? photo.id : null;
      const url = typeof photo === 'string' ? photo : (photo.url || '');
      if (existingId && (!url || url.indexOf('blob:') === 0)) {
        return { id: existingId, caption };
      }
      if (url && url.indexOf('data:') === 0) {
        const blob = dataUrlToBlob(url);
        if (!blob) return { url: url, caption };
        const id = existingId || (prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
        await idbPutPhoto({ id, blob, caption, createdAt: Date.now() }).catch(() => null);
        return { id, caption };
      }
      if (photo && photo.blob instanceof Blob) {
        const id = existingId || (prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
        await idbPutPhoto({ id, blob: photo.blob, caption, createdAt: Date.now() }).catch(() => null);
        return { id, caption };
      }
      if (existingId) return { id: existingId, caption };
      return { url: url, caption };
    }

    function stripInspectionPhotos(list) {
      return (list || []).map(ins => {
        const copy = Object.assign({}, ins);
        if (copy.results) {
          const r2 = {};
          Object.keys(copy.results).forEach(k => {
            const row = Object.assign({}, copy.results[k]);
            if (row.photoId) delete row.photoDataUrl;
            else if (row.photoDataUrl && String(row.photoDataUrl).indexOf('blob:') === 0) delete row.photoDataUrl;
            else if (row.photoDataUrl && String(row.photoDataUrl).length > 80 && String(row.photoDataUrl).indexOf('data:') === 0) {
              /* kept only as last-resort fallback if IDB write failed */
            }
            r2[k] = row;
          });
          copy.results = r2;
        }
        if (copy.findings) {
          copy.findings = copy.findings.map(f => {
            const ff = Object.assign({}, f);
            if (ff.photoId) delete ff.photoDataUrl;
            return ff;
          });
        }
        return copy;
      });
    }

    async function extractInspectionBlobs(list) {
      const out = [];
      for (const ins of (list || [])) {
        const copy = JSON.parse(JSON.stringify(ins));
        const insId = copy.id || ('ins_' + Date.now());
        copy.id = insId;
        if (copy.results) {
          for (const k of Object.keys(copy.results)) {
            const row = copy.results[k] || {};
            if (row.photoDataUrl && String(row.photoDataUrl).indexOf('data:') === 0 && !row.photoId) {
              const saved = await persistPhotoRecord({ url: row.photoDataUrl }, 'ins_' + insId + '_' + k);
              if (saved && saved.id) {
                row.photoId = saved.id;
                delete row.photoDataUrl;
              }
            } else if (row.photoDataUrl && String(row.photoDataUrl).indexOf('blob:') === 0) {
              delete row.photoDataUrl;
            }
            copy.results[k] = row;
          }
        }
        if (copy.findings) {
          for (let i = 0; i < copy.findings.length; i++) {
            const f = copy.findings[i] || {};
            if (f.photoDataUrl && String(f.photoDataUrl).indexOf('data:') === 0 && !f.photoId) {
              const saved = await persistPhotoRecord({ url: f.photoDataUrl }, 'insf_' + insId + '_' + i);
              if (saved && saved.id) {
                f.photoId = saved.id;
                delete f.photoDataUrl;
              }
            }
            copy.findings[i] = f;
          }
        }
        out.push(copy);
      }
      return out;
    }

    async function hydrateInspectionBlobs(list) {
      const out = [];
      for (const ins of (list || [])) {
        const copy = Object.assign({}, ins);
        if (copy.results) {
          const r2 = {};
          for (const k of Object.keys(copy.results)) {
            const row = Object.assign({}, copy.results[k]);
            if (row.photoId && !row.photoDataUrl) {
              const rec = await idbGetPhoto(row.photoId).catch(() => null);
              if (rec && rec.blob) row.photoDataUrl = blobToObjectUrl(rec.blob);
            }
            r2[k] = row;
          }
          copy.results = r2;
        }
        if (copy.findings) {
          const next = [];
          for (const f of copy.findings) {
            const ff = Object.assign({}, f);
            if (ff.photoId && !ff.photoDataUrl) {
              const rec = await idbGetPhoto(ff.photoId).catch(() => null);
              if (rec && rec.blob) ff.photoDataUrl = blobToObjectUrl(rec.blob);
            }
            next.push(ff);
          }
          copy.findings = next;
        }
        out.push(copy);
      }
      return out;
    }

    async function persistAllStores() {
      const visits = storeMem.visits || [];
      const inspections = storeMem.inspections || [];
      const slimVisits = [];
      for (const v of visits) {
        const copy = Object.assign({}, v);
        const photos = [];
        for (const ph of (v.photos || [])) {
          photos.push(await persistPhotoRecord(ph, 'vis_' + (v.id || 'x')));
        }
        copy.photos = photos;
        slimVisits.push(copy);
      }
      const slimIns = await extractInspectionBlobs(inspections);
      try {
        await idbSetKv('visits', slimVisits);
        await idbSetKv('inspections', slimIns);
      } catch (e) {
        console.warn('IndexedDB persist failed', e);
      }
      lsWrite('lx8_visits_meta', slimVisits.map(v => ({
        id: v.id, customer: v.customer, equip: v.equip, dates: v.dates, tech: v.tech,
        scope: v.scope, status: v.status, updatedAt: v.updatedAt,
        findings: (v.findings || []).length, photos: (v.photos || []).length
      })));
      try {
        const tiny = stripInspectionPhotos(slimIns).map(ins => {
          const c = Object.assign({}, ins);
          if (c.results) {
            Object.keys(c.results).forEach(k => {
              if (c.results[k] && c.results[k].photoDataUrl) delete c.results[k].photoDataUrl;
            });
          }
          return c;
        });
        lsWrite('lx8_inspections', tiny);
      } catch (e) {}
      try { lsWrite('lx8_visits', slimVisits); } catch (e) {}
    }

    function schedulePersist() {
      clearTimeout(lxPersistTimer);
      lxPersistTimer = setTimeout(() => {
        persistAllStores().catch(err => console.warn(err));
      }, 180);
    }

    async function bootStorage() {
      let visits = lsRead('lx8_visits', []);
      let inspections = lsRead('lx8_inspections', []);
      try {
        await idbOpen();
        // Read the two metadata stores in parallel. Photo blobs are deliberately
        // hydrated after the first screen is painted so startup stays responsive.
        const [idbVisits, idbIns] = await Promise.all([
          idbGetKv('visits').catch(() => null),
          idbGetKv('inspections').catch(() => null)
        ]);
        if (Array.isArray(idbVisits) && idbVisits.length) visits = idbVisits;
        if (Array.isArray(idbIns) && idbIns.length) inspections = idbIns;
        if (!(Array.isArray(idbVisits) && idbVisits.length) && Array.isArray(visits) && visits.length) {
          idbSetKv('visits', visits).catch(() => {});
        }
      } catch (e) {
        console.warn('IndexedDB unavailable, using localStorage', e);
      }
      storeMem.visits = Array.isArray(visits) ? visits : [];
      storeMem.inspections = Array.isArray(inspections) ? inspections : [];
      storeMem.ready = true;
      try {
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      } catch (e) {}
    }

    // Hydrate photo blobs after the initial UI is ready. This preserves the
    // existing photo behavior without making every app launch wait on blobs.
    function hydrateStoredPhotosInBackground() {
      const run = async () => {
        try {
          const inspections = storeMem.inspections || [];
          const visits = storeMem.visits || [];
          if (inspections.length) storeMem.inspections = await hydrateInspectionBlobs(inspections);
          for (const v of visits) {
            if (v.photos && v.photos.length) v.photos = await Promise.all(v.photos.map(hydratePhotoUrl));
          }
        } catch (e) { console.warn('Background photo hydration failed', e); }
      };
      if ('requestIdleCallback' in window) requestIdleCallback(run, {timeout: 1500});
      else setTimeout(run, 250);
    }

    function saveInspections(list) {
      storeMem.inspections = Array.isArray(list) ? list : [];
      schedulePersist();
      const ok = lsWrite('lx8_inspections', stripInspectionPhotos(storeMem.inspections));
      if (!ok) {
        try {
          const slim = stripInspectionPhotos(storeMem.inspections);
          if (lsWrite('lx8_inspections', slim)) return true;
        } catch (e2) {}
        toast('Saved to device storage (IndexedDB)');
      }
      return true;
    }
    function loadInspections() {
      if (storeMem.inspections) {
        storeMem.inspections = ensureSampleInspection(storeMem.inspections);
        return storeMem.inspections;
      }
      const raw = lsRead('lx8_inspections', []);
      storeMem.inspections = ensureSampleInspection(Array.isArray(raw) ? raw : []);
      try { saveInspections(storeMem.inspections); } catch (e) {}
      return storeMem.inspections;
    }
    function saveCurrentDraft() {
      if (!currentInspection) return;
      currentInspection.results = results;
      currentInspection.findings = findings;
      currentInspection.currentSectionIndex = currentSectionIndex;
      currentInspection.currentItemIndex = currentItemIndex;
      currentInspection.updatedAt = new Date().toISOString();
      let list = loadInspections();
      const idx = list.findIndex(i => i.id === currentInspection.id);
      if (idx >= 0) list[idx] = currentInspection;
      else list.unshift(currentInspection);
      saveInspections(list);
    }

    // ========== UI HELPERS ==========
    // Navigation history is screen-based so the header back chevron always
    // returns to the page the user actually came from.  Individual pages
    // (such as a selected time-card week) keep their own state separately.
    const navHistory = [];
    let navGoingBack = false;

    function showScreen(id) {
      const current = document.querySelector('.screen.active');
      const currentId = current ? current.id : '';
      if (!navGoingBack && currentId && currentId !== id) {
        navHistory.push(currentId);
      }
      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      const screenEl = document.getElementById(id);
      if (screenEl) screenEl.classList.add('active');
      if (id !== 'screenPunchlist') {
        const overlay = document.getElementById('pl-modal');
        if (overlay && overlay.classList.contains('show')) {
          try { closeModal(); } catch (e) { overlay.classList.remove('show'); }
        }
      }
      document.body.classList.toggle('inspect-active', id === 'screenInspect');
      document.body.classList.toggle('on-findings', id === 'screenFindings');
      document.body.classList.toggle('on-inspect-notes', id === 'screenNotes');
      document.body.classList.toggle('on-inspect-preview', id === 'screenInspectPreview');
      if (id === 'screenInspect' && typeof window.bindInspectCamFab === 'function') window.bindInspectCamFab();
      const bottom = document.getElementById('bottomBar');
      const barInspect = document.getElementById('barInspect');
      const bars = {
        screenFindings: 'barFindings',
        screenNotes: 'barFindings',
        screenInspectPreview: 'barFindings'
      };
      const barIds = ['barInspect', 'barFindings', 'barNotes', 'barPreview'];
      if (bottom) {
        if (bars[id]) {
          bottom.classList.remove('hidden');
          barIds.forEach(bid => {
            const el = document.getElementById(bid);
            if (el) el.classList.toggle('hidden', bid !== bars[id]);
          });
        } else {
          bottom.classList.add('hidden');
        }
      }
      // Header red glow only on home
      document.body.classList.toggle('on-home', id === 'screenHome');
      document.body.classList.toggle('on-time', id === 'screenTime' || id === 'screenTimeEdit' || id === 'screenTimePeriod');
      document.body.classList.toggle('on-time-period', id === 'screenTimePeriod');
      document.body.classList.toggle('on-settings', id === 'screenSettings');
      document.body.classList.toggle('on-punchlist', id === 'screenPunchlist');
      document.body.classList.toggle('on-pl-edit', id === 'screenPunchlistEdit');
      document.body.classList.toggle('on-jobs-list', id === 'screenJobsList');
      // Show the global header back chevron on every navigable page.
      // Home, the Settings landing page, and the main Time Cards landing page
      // keep their existing header behavior; all other screens can now return
      // to the actual previous screen via navHistory.
      const genericBackScreens = new Set([
        'screenJobsList', 'screenJobDetail', 'screenJobForm',
        'screenInspectList', 'screenPunchlistList', 'screenPunchlistEdit', 'screenTimePeriod'
      ]);
      document.body.classList.toggle('has-screen-back', genericBackScreens.has(id));
      const fab = document.getElementById('fab-add');
      if (fab) {
        if (id === 'screenJobsList') {
          fab.title = 'Add Job';
          fab.setAttribute('aria-label', 'Add Job');
        } else if (id === 'screenPunchlist') {
          fab.title = 'Add Item';
          fab.setAttribute('aria-label', 'Add Item');
        }
      }
      document.body.classList.toggle('on-list-search', id === 'screenInspectList' || id === 'screenJobsList');
      document.body.classList.toggle('on-notes', id === 'screenNotes');
      if (id === 'screenNotes') {
        initNotesEditor();
        requestAnimationFrame(placeNotesFormatBar);
      } else {
        document.body.classList.remove('notes-focus');
        document.body.classList.remove('notes-typing');
      }
      const tripFlow = isTripFlowScreen(id);
      const inspectFlow = id === 'screenInspect' || id === 'screenFindings' || id === 'screenNotes';
      document.body.classList.toggle('on-inspect-flow', inspectFlow);
      const inInspections = (
        id === 'screenStart' ||
        id === 'screenInspect' ||
        id === 'screenFindings' ||
        (id === 'screenNotes') ||
        id === 'screenInspectPreview'
      );
      document.body.classList.toggle('on-inspections', inInspections);
      if (id === 'screenFindings') extraSectionTab = 'findings';
      else if (id === 'screenNotes') extraSectionTab = 'notes';
      else if (id === 'screenInspect') extraSectionTab = null;
      if (inspectFlow && typeof APP_DATA !== 'undefined' && APP_DATA && APP_DATA.sections) {
        renderSectionDots(true);
      }
      if (id !== 'screenHome') closeSearch();
      // Always reveal chrome when switching screens
      window.scrollTo(0, 0);
      resetChrome();
      requestAnimationFrame(measureHeaderHeight);
    }
    function toast(msg, ms = 2200) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), ms);
    }
    function setHeader(title) {
      // Logo is fixed; title change is optional / no-op for branded header
    }

    // ========== HOME ==========
    let searchQuery = '';



    let editingPunchlistKey = '';
    let punchlistEditIsNew = false;

    function fillPunchlistEditJobSelect(selectedId) {
      const sel = document.getElementById('plEditJob');
      if (!sel) return;
      let jobs = [];
      try {
        jobs = (typeof inspectJobsSource === 'function') ? inspectJobsSource() : ((typeof loadJobs === 'function' ? loadJobs() : []) || []);
      } catch (e) {
        jobs = (typeof loadJobs === 'function' ? loadJobs() : []) || [];
      }
      jobs.forEach(j => { try { if (typeof ensureJobIdentity === 'function') ensureJobIdentity(j); } catch (e) {} });
      const current = String(selectedId || '');
      function labelOf(j) {
        try {
          const n = (typeof jobDisplayName === 'function') ? jobDisplayName(j) : '';
          if (n && String(n).trim() && n !== 'Job' && !(typeof isInternalId === 'function' && isInternalId(n))) return String(n);
        } catch (e) {}
        return j.customer || j.site || j.name || 'Untitled job';
      }
      const sorted = jobs.filter(j => j && j.id).slice().sort((a, b) => String(b.date || b.createdAt || '').localeCompare(String(a.date || a.createdAt || '')));
      sel.innerHTML = '<option value="">Select job</option>' + sorted.map(j => {
        const id = String(j.id);
        const selAttr = current && current === id ? ' selected' : '';
        return '<option value="' + id.replace(/"/g,'&quot;') + '"' + selAttr + '>' + labelOf(j).replace(/</g,'&lt;') + '</option>';
      }).join('');
      if (current && sorted.some(j => String(j.id) === current)) sel.value = current;
    }

    function openPunchlistEdit(key, opts) {
      opts = opts || {};
      punchlistEditIsNew = !!opts.isNew;
      editingPunchlistKey = key || '';
      const heading = document.getElementById('plEditHeading');
      if (heading) heading.textContent = punchlistEditIsNew ? 'New punchlist' : 'Edit punchlist';
      const nameEl = document.getElementById('plEditName');
      let currentName = (typeof punchlistDisplayName === 'function') ? punchlistDisplayName(key) : '';
      if (typeof isInternalId === 'function' && isInternalId(currentName)) currentName = '';
      if (nameEl) {
        nameEl.value = punchlistEditIsNew ? '' : currentName;
        nameEl.placeholder = 'Punchlist name';
      }
      let jobId = '';
      try {
        if (typeof window.getPunchlistJobId === 'function') jobId = window.getPunchlistJobId(key) || '';
      } catch (e) {}
      if (!jobId && opts.job && opts.job.id) jobId = opts.job.id;
      fillPunchlistEditJobSelect(jobId);
      showScreen('screenPunchlistEdit');
      setHeader('Punchlist');
      document.body.classList.add('on-pl-edit');
      setTimeout(() => { try { if (nameEl) nameEl.focus(); } catch (e) {} }, 80);
    }

    function requestDeletePunchlist() {
      const key = editingPunchlistKey || ((typeof window.getCurrentPunchlistKey === 'function') ? window.getCurrentPunchlistKey() : '');
      if (!key) { toast('No punchlist to delete'); return; }
      const name = (typeof punchlistDisplayName === 'function') ? punchlistDisplayName(key) : 'Punchlist';
      if (typeof showDeleteConfirm === 'function') {
        showDeleteConfirm(key, 'punchlist', 'Delete punchlist?', '"' + name + '" and its items will be permanently deleted.');
      } else {
        pendingDeleteId = key;
        pendingDeleteKind = 'punchlist';
        const modal = document.getElementById('deleteModal');
        document.getElementById('deleteModalTitle').textContent = 'Delete punchlist?';
        document.getElementById('deleteModalLabel').textContent = '"' + name + '" and its items will be permanently deleted.';
        modal.classList.remove('hidden');
        modal.classList.add('show');
      }
    }

    async function savePunchlistEdit() {
      const key = editingPunchlistKey;
      if (!key) { toast('Punchlist not found'); return; }
      const nameEl = document.getElementById('plEditName');
      let name = ((nameEl && nameEl.value) || '').trim() || 'Punchlist';
      if (typeof isInternalId === 'function' && isInternalId(name)) { toast('Choose a different name'); return; }
      const jobSel = document.getElementById('plEditJob');
      const jobId = jobSel ? jobSel.value : '';
      if (typeof window.updatePunchlistMeta !== 'function') { toast('Could not save'); return; }
      await window.updatePunchlistMeta(key, name, jobId);
      document.body.classList.remove('on-pl-edit');
      editingPunchlistKey = '';
      punchlistEditIsNew = false;
      showScreen('screenPunchlist');
      setHeader('Punchlist');
      if (typeof populateJobSelect === 'function') populateJobSelect();
      if (typeof window.renderList === 'function') window.renderList();
      toast('Saved ' + name);
    }

    function cancelPunchlistEdit() {
      document.body.classList.remove('on-pl-edit');
      const wasNew = punchlistEditIsNew;
      punchlistEditIsNew = false;
      editingPunchlistKey = '';
      if (wasNew) {
        if (typeof openPunchlistRecentList === 'function') openPunchlistRecentList();
        else {
          showScreen('screenPunchlistList');
          setHeader('Punchlist');
          if (typeof refreshPunchlistHome === 'function') refreshPunchlistHome();
        }
        return;
      }
      showScreen('screenPunchlist');
      setHeader('Punchlist');
    }

    let linkingPunchlistName = '';
    function fillPunchlistJobSelect(selectedId) {
      const sel = document.getElementById('plLinkJobSelect');
      if (!sel) return;
      const jobs = (typeof loadJobs === 'function' ? loadJobs() : []) || [];
      let html = '<option value="">— No job —</option>';
      jobs.forEach(j => {
        if (!j || !j.id) return;
        const label = (typeof jobDisplayName === 'function') ? jobDisplayName(j) : (j.customer || 'Job');
        const selAttr = selectedId && selectedId === j.id ? ' selected' : '';
        html += '<option value="' + String(j.id).replace(/"/g, '&quot;') + '"' + selAttr + '>' + String(label).replace(/</g, '&lt;') + '</option>';
      });
      sel.innerHTML = html;
    }
    function closePunchlistLinkSheet() {
      const sheet = document.getElementById('plLinkJobSheet');
      if (sheet) {
        sheet.classList.remove('show');
        sheet.hidden = true;
        sheet.setAttribute('hidden', '');
      }
      linkingPunchlistName = '';
    }
    window.openPunchlistLinkSheet = openPunchlistLinkSheet;
    window.closePunchlistLinkSheet = closePunchlistLinkSheet;
    function openPunchlistLinkSheet(name) {
      linkingPunchlistName = name || '';
      const title = document.getElementById('plLinkJobTitle');
      if (title) title.textContent = name || 'Link job';
      let currentId = '';
      const items = document.querySelectorAll('#recentPunchlistList .list-item');
      items.forEach((card) => {
        if (card.getAttribute('data-job-name') === name) currentId = card.getAttribute('data-job-id') || '';
      });
      fillPunchlistJobSelect(currentId);
      const viewBtn = document.getElementById('plLinkJobView');
      if (viewBtn) viewBtn.style.display = currentId ? 'flex' : 'none';
      const sheet = document.getElementById('plLinkJobSheet');
      if (sheet) {
        sheet.hidden = false;
        sheet.removeAttribute('hidden');
        sheet.classList.add('show');
      }
    }
    async function savePunchlistJobLink() {
      const name = linkingPunchlistName;
      const sel = document.getElementById('plLinkJobSelect');
      const jobId = sel ? sel.value : '';
      if (!name || typeof window.setPunchlistJobLink !== 'function') {
        closePunchlistLinkSheet();
        return;
      }
      await window.setPunchlistJobLink(name, jobId);
      closePunchlistLinkSheet();
      if (typeof refreshPunchlistHome === 'function') await refreshPunchlistHome();
      toast(jobId ? 'Punchlist linked to job' : 'Job unlinked');
    }
    function viewLinkedPunchlistJob() {
      const sel = document.getElementById('plLinkJobSelect');
      const jobId = sel ? sel.value : '';
      closePunchlistLinkSheet();
      if (jobId && typeof openJobDetail === 'function') openJobDetail(jobId);
    }

    async function refreshPunchlistHome() {
      const container = document.getElementById('recentPunchlistList');
      if (!container) return;
      try {
        if (typeof window.getPunchlistSummaries === 'function') {
          const rows = await window.getPunchlistSummaries();
          if (!rows.length) {
            container.innerHTML = `<div class="empty-state"><div class="icon"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4.2" y="3.2" width="15.6" height="17.6" rx="2.2" stroke="currentColor" stroke-width="1.2"/><path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></div><p>No punchlists yet.<br>Tap “+ Punchlist” to begin.</p></div>`;
            return;
          }
          container.innerHTML = rows.map(row => {
            const done = row.complete || 0;
            const total = row.total || 0;
            const open = total - done;
            const allDone = total > 0 && open === 0;
            const statusClass = allDone ? 'badge-complete' : (done > 0 ? 'badge-draft' : 'badge-draft');
            const statusLabel = allDone ? 'Complete' : (total === 0 ? 'Empty' : 'Open');
            const rowTone = allDone ? 'list-complete' : '';
            const jobLine = row.jobLabel
              ? row.jobLabel
              : 'No job linked';
            return `
              <div class="list-item ${rowTone}" data-job-name="${String(row.key || row.name).replace(/"/g, '&quot;')}" data-job-id="${String(row.jobId || '').replace(/"/g, '&quot;')}">
                <div class="list-item-main" data-action="open">
                  <div class="title">${row.name}</div>
                  <div class="sub">${jobLine}</div>
                  <div class="sub">${total} item${total !== 1 ? 's' : ''} · ${done} complete${open ? ' · ' + open + ' open' : ''}</div>
                </div>
                <div class="list-item-actions">
                  <button type="button" class="btn-edit" data-action="edit">Edit</button>
                  <span class="badge ${statusClass}">${statusLabel}</span>
                </div>
              </div>`;
          }).join('');
          container.querySelectorAll('.list-item').forEach(el => {
            const name = el.getAttribute('data-job-name');
            const openBtn = el.querySelector('[data-action="open"]');
            if (openBtn) openBtn.addEventListener('click', async () => {
              if (typeof window.openPunchlistByName === 'function') {
                await window.openPunchlistByName(name);
                showScreen('screenPunchlist');
                setHeader('Punchlist');
                if (typeof window.renderList === 'function') window.renderList();
              }
            });
            const editBtn = el.querySelector('[data-action="edit"]');
            if (editBtn) editBtn.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              openPunchlistEdit(name, { isNew: false });
            });
          });
          return;
        }
      } catch (e) {
        console.warn(e);
      }
      container.innerHTML = `<div class="empty-state"><div class="icon"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4.2" y="3.2" width="15.6" height="17.6" rx="2.2" stroke="currentColor" stroke-width="1.2"/><path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></div><p>No punchlists yet.<br>Tap “+ Punchlist” to begin.</p></div>`;
    }

    function formatJobDateRange(job) {
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const parse = (v) => {
        if (!v) return null;
        const s = String(v).slice(0, 10);
        const p = s.split('-').map(Number);
        if (p.length < 3 || !p[0] || !p[1] || !p[2]) return null;
        return { y: p[0], m: p[1], d: p[2] };
      };
      const fmt = (dt, withYear) => months[dt.m - 1] + ' ' + dt.d + (withYear ? ', ' + dt.y : '');
      const a = parse(job && job.date);
      const b = parse(job && job.endDate);
      if (a && b) {
        if (a.y === b.y) return fmt(a, false) + ' - ' + fmt(b, true);
        return fmt(a, true) + ' - ' + fmt(b, true);
      }
      if (a) return fmt(a, true);
      if (b) return fmt(b, true);
      return '';
    }
    function jobDayStamp(v) {
      if (!v) return null;
      const n = Date.parse(String(v).slice(0, 10) + 'T00:00:00');
      return Number.isNaN(n) ? null : n;
    }
    function jobStatusFromDates(job) {
      // A technician can explicitly complete a job before the date range ends.
      if (job && String(job.status || '').toLowerCase() === 'complete') return 'Complete';
      const start = jobDayStamp(job && job.date);
      const end = jobDayStamp(job && job.endDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayMs = today.getTime();
      if (start != null && todayMs < start) return 'Planned';
      if (start != null && end != null && todayMs >= start && todayMs <= end) return 'In Progress';
      if (start != null && end == null && todayMs >= start) return 'In Progress';
      if (end != null && todayMs > end) return 'Complete';
      if (start == null && end != null && todayMs <= end) return 'In Progress';
      return (job && job.status) || 'Planned';
    }
    function applyJobStatuses(list) {
      const arr = Array.isArray(list) ? list : [];
      let changed = false;
      arr.forEach(job => {
        if (!job) return;
        const next = jobStatusFromDates(job);
        if (job.status !== next) {
          job.status = next;
          changed = true;
        }
      });
      return changed;
    }
    function isPastJobByDate(job) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayMs = today.getTime();
      const end = jobDayStamp(job && job.endDate);
      const start = jobDayStamp(job && job.date);
      if (end != null) return end < todayMs;
      if (start != null) return start < todayMs;
      return false;
    }
    function getCurrentJobs() {
      return loadJobs().filter(j => j && !isPastJobByDate(j));
    }
    let homeDateEditJobId = null;
    function openHomeJobDatesEditor(jobId) {
      const job = loadJobs().find(j => j.id === jobId);
      if (!job) return;
      homeDateEditJobId = jobId;
      const s = document.getElementById('homeJobDateStart');
      const e = document.getElementById('homeJobDateEnd');
      if (s) s.value = job.date || '';
      if (e) e.value = job.endDate || '';
      const modal = document.getElementById('jobDatesModal');
      if (!modal) return;
      modal.classList.remove('hidden');
      modal.classList.add('show');
    }
    function closeHomeJobDatesEditor() {
      const modal = document.getElementById('jobDatesModal');
      if (!modal) return;
      modal.classList.add('hidden');
      modal.classList.remove('show');
      homeDateEditJobId = null;
    }
    function saveHomeJobDates() {
      if (!homeDateEditJobId) return;
      const list = loadJobs();
      const job = list.find(j => j.id === homeDateEditJobId);
      if (!job) return;
      job.date = (document.getElementById('homeJobDateStart') || {}).value || '';
      job.endDate = (document.getElementById('homeJobDateEnd') || {}).value || '';
      job.status = jobStatusFromDates(job);
      saveJobs(list);
      closeHomeJobDatesEditor();
      refreshHomeCurrentJob();
      if (typeof refreshJobsList === 'function') refreshJobsList();
    }
    function refreshHomeCurrentJob() {
      const card = document.getElementById('homeCurrentJobCard');
      if (!card) return;
      const current = getCurrentJobs();
      if (!current.length) {
        card.classList.add('hidden');
        document.body.classList.remove('on-home-has-job');
        return;
      }
      const job = current[0];
      card.classList.remove('hidden');
      document.body.classList.add('on-home-has-job');
      const item = document.getElementById('homeCurrentJobItem');
      if (item) {
        const dateRange = formatJobDateRange(job);
        const sub = [job.site, job.technician, dateRange].filter(Boolean).join(' · ');
        const classes = ['pl-item'];
        if (job.status === 'Complete') classes.push('list-complete');
        else if (job.status === 'In Progress') classes.push('job-inprogress');
        else classes.push('job-planned');
        item.className = classes.join(' ');
        const siteLine = [job.site, job.technician].filter(Boolean).join(' · ');
        const jobInspects = loadInspections().filter(i => i && i.jobId === job.id);
        const inspectCount = jobInspects.length;
        let openItems = 0, doneItems = 0;
        try {
          if (typeof window.getPunchlistSummaries === 'function') {
            /* filled below if summaries already loaded */
          }
        } catch (e) {}
        item.innerHTML = `
          <div class="hj-top">
            <span class="hj-label">Current job</span>
            <button type="button" class="hj-dates" id="homeCurrentJobDates">${dateRange ? jobEsc(dateRange) : 'Set dates'}</button>
          </div>
          <div class="hj-name">${jobEsc(job.customer || 'Untitled job')}</div>
          ${siteLine ? `<div class="hj-meta">${jobEsc(siteLine)}</div>` : ''}
          <div class="hj-stats" id="homeCurrentJobStats"><span><b class="n-open">0</b> Open</span><span><b class="n-done">0</b> Complete</span><span><b class="n-ins">${inspectCount}</b> Inspection${inspectCount===1?'':'s'}</span></div>`;
        const statsEl = item.querySelector('#homeCurrentJobStats');
        const fillStats = (openN, doneN) => {
          if (!statsEl) return;
          statsEl.innerHTML = `<span><b class="n-open">${openN}</b> Open</span><span><b class="n-done">${doneN}</b> Complete</span><span><b class="n-ins">${inspectCount}</b> Inspection${inspectCount===1?'':'s'}</span>`;
        };
        const key = jobDisplayName(job);
        if (typeof window.searchPunchlistItems === 'function') {
          window.searchPunchlistItems(' ').catch(() => []);
        }
        if (typeof window.getPunchlistStatsForJob === 'function') {
          window.getPunchlistStatsForJob(job).then(s => fillStats(s.open || 0, s.complete || 0)).catch(() => fillStats(0, 0));
        } else if (typeof window.getPunchlistSummaries === 'function') {
          window.getPunchlistSummaries().then(rows => {
            const row = (rows || []).find(r => r && r.jobId === job.id) || (rows || []).find(r => r.name === key || r.name === job.customer);
            if (!row) { fillStats(0, 0); return; }
            fillStats(Math.max(0, (row.total || 0) - (row.complete || 0)), row.complete || 0);
          }).catch(() => fillStats(0, 0));
        }
      }
      card.onclick = (e) => {
        if (e.target.closest('.hj-dates')) return;
        if (typeof openJobDetail === 'function') openJobDetail(job.id);
      };
      const dateBtn = document.getElementById('homeCurrentJobDates');
      if (dateBtn) dateBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openHomeJobDatesEditor(job.id);
      };
    }

    function refreshHome() {
      const inspections = loadInspections();
      let list = inspections;
      const container = document.getElementById('recentList');
      if (!container) {
        refreshHomeCurrentJob();
        refreshStorageCard();
        return;
      }
      if (list.length === 0) {
        container.innerHTML = `<div class="empty-state"><div class="icon">${ICO.clip}</div><p>No inspections yet.<br>Tap “+ Inspection” to begin.</p></div>`;
        refreshHomeCurrentJob();
        refreshStorageCard();
        return;
      }
      container.innerHTML = list.slice(0, 30).map(ins => {
        const findCount = (ins.findings || []).length;
        const statusClass = ins.status === 'Complete' ? 'badge-complete' : 'badge-draft';
        const statusLabel = ins.status === 'Complete' ? 'Complete' : 'Draft';
        const rowTone = ins.status === 'Complete' ? 'list-complete' : '';
        return `
          <div class="list-item ${rowTone}" data-id="${ins.id}">
            <div class="list-item-main" data-action="open">
              <div class="title">${ins.customer || 'Unknown'} – ${ins.model || 'LX-8'} – ${ins.serial || 'No S/N'}</div>
              <div class="sub">${ins.technician || ''} · ${ins.date || ''} · ${findCount} finding${findCount !== 1 ? 's' : ''}</div>
            </div>
            <div class="list-item-actions">
              <button class="btn-edit" data-action="edit" type="button">Edit</button>
              <span class="badge ${statusClass}">${statusLabel}</span>
            </div>
          </div>`;
      }).join('');
      container.querySelectorAll('.list-item').forEach(el => {
        const id = el.dataset.id;
        el.querySelector('[data-action="open"]').addEventListener('click', () => openInspection(id));
        el.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
          e.stopPropagation();
          editInspectionMeta(id);
        });
      });
      refreshHomeCurrentJob();
        refreshStorageCard();
    }

    function formatBytes(n) {
      n = Number(n) || 0;
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + ' KB';
      if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
      return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    }
    async function refreshStorageCard() {
      const line = document.getElementById('storageLine');
      const sub = document.getElementById('storageSub');
      const fill = document.getElementById('storageBarFill');
      if (!line) return;
      const visits = (typeof loadVisits === 'function' ? loadVisits() : []) || [];
      const inspections = (typeof loadInspections === 'function' ? loadInspections() : []) || [];
      const jobs = (typeof loadJobs === 'function' ? loadJobs() : []) || [];
      let photoCount = 0;
      visits.forEach(v => { photoCount += (v.photos || []).length; });
      inspections.forEach(ins => {
        if (ins.results) Object.keys(ins.results).forEach(k => {
          if (ins.results[k] && (ins.results[k].photoId || ins.results[k].photoDataUrl)) photoCount += 1;
        });
        (ins.findings || []).forEach(f => { if (f && (f.photoId || f.photoDataUrl)) photoCount += 1; });
      });
      let used = 0;
      let quota = 0;
      let persisted = false;
      try {
        const timeout = (p, ms) => Promise.race([
          p,
          new Promise((_, rej) => setTimeout(() => rej(new Error("storage-timeout")), ms))
        ]);
        if (navigator.storage && navigator.storage.estimate) {
          const est = await timeout(navigator.storage.estimate(), 1500);
          used = est.usage || 0;
          quota = est.quota || 0;
        }
        if (navigator.storage && navigator.storage.persisted) {
          persisted = await timeout(navigator.storage.persisted(), 800);
        }
      } catch (e) {}
      if (quota) {
        const pct = Math.max(1, Math.min(100, Math.round((used / quota) * 100)));
        line.textContent = formatBytes(used) + ' of ' + formatBytes(quota) + ' used';
        if (fill) fill.style.width = pct + '%';
      } else {
        line.textContent = jobs.length + ' jobs · ' + inspections.length + ' inspections';
        if (fill) fill.style.width = photoCount ? '12%' : '2%';
      }
      const bits = [];
      bits.push(jobs.length + ' job' + (jobs.length === 1 ? '' : 's'));
      bits.push(inspections.length + ' inspection' + (inspections.length === 1 ? '' : 's'));
      bits.push(photoCount + ' photo' + (photoCount === 1 ? '' : 's'));
      bits.push(persisted ? 'kept by the OS' : 'ask the OS to keep');
      if (sub) sub.textContent = bits.join(' · ');
    }

    async function blobToUint8(blob) {
      const buf = await blob.arrayBuffer();
      return new Uint8Array(buf);
    }
    function safeZipName(s) {
      return String(s || 'item').replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'item';
    }
    async function exportBackupZip() {
      toast('Building backup…');
      try {
        await persistAllStores();
        const visits = JSON.parse(JSON.stringify(loadVisits() || []));
        visits.forEach(v => {
          (v.photos || []).forEach(ph => { if (ph && ph.url) delete ph.url; });
        });
        const inspections = stripInspectionPhotos(JSON.parse(JSON.stringify(loadInspections() || [])));
        const jobs = JSON.parse(JSON.stringify(loadJobs() || []));
        const photos = await idbGetAllPhotos();
        const files = [
          { name: 'manifest.json', data: JSON.stringify({
            app: 'lematic-lx8',
            version: 1,
            exportedAt: new Date().toISOString(),
            visits: visits.length,
            inspections: inspections.length,
            jobs: jobs.length,
            photos: photos.length
          }, null, 2) },
          { name: 'visits.json', data: JSON.stringify(visits) },
          { name: 'inspections.json', data: JSON.stringify(inspections) },
          { name: 'jobs.json', data: JSON.stringify(jobs) }
        ];
        if (typeof window.getPunchlistBackup === 'function') {
          files.push({ name: 'punchlist.json', data: JSON.stringify(window.getPunchlistBackup()) });
        }
        for (const rec of photos) {
          if (!rec || !rec.id || !rec.blob) continue;
          const ext = (rec.blob.type && rec.blob.type.indexOf('png') >= 0) ? 'png' : 'jpg';
          files.push({
            name: 'photos/' + safeZipName(rec.id) + '.' + ext,
            data: await blobToUint8(rec.blob)
          });
        }
        const bytes = zipStore(files);
        const blob = new Blob([bytes], { type: 'application/zip' });
        const a = document.createElement('a');
        const stamp = new Date().toISOString().slice(0, 10);
        a.href = URL.createObjectURL(blob);
        a.download = 'LeMatic_backup_' + stamp + '.zip';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        toast('Backup downloaded');
      } catch (e) {
        console.warn(e);
        toast('Backup failed');
      }
    }
    function unzipStore(u8) {
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const files = [];
      let o = 0;
      while (o + 30 <= u8.length) {
        const sig = dv.getUint32(o, true);
        if (sig === 0x06054b50 || sig === 0x02014b50) break;
        if (sig !== 0x04034b50) break;
        const method = dv.getUint16(o + 8, true);
        const comp = dv.getUint32(o + 18, true);
        const uncomp = dv.getUint32(o + 22, true);
        const nameLen = dv.getUint16(o + 26, true);
        const extraLen = dv.getUint16(o + 28, true);
        const name = new TextDecoder().decode(u8.subarray(o + 30, o + 30 + nameLen));
        const start = o + 30 + nameLen + extraLen;
        if (method !== 0) throw new Error('compressed-zip');
        files.push({ name, data: u8.subarray(start, start + (comp || uncomp)) });
        o = start + (comp || uncomp);
      }
      return files;
    }
    function u8ToText(u8) {
      return new TextDecoder().decode(u8);
    }
    async function importBackupZip(file) {
      if (!file) return;
      toast('Restoring backup…');
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        const files = unzipStore(buf);
        const byName = {};
        files.forEach(f => { byName[f.name] = f.data; });
        if (!byName['visits.json'] && !byName['inspections.json'] && !byName['punchlist.json']) {
          toast('Not a LeMatic backup');
          return;
        }
        const visits = byName['visits.json'] ? JSON.parse(u8ToText(byName['visits.json'])) : [];
        const inspections = byName['inspections.json'] ? JSON.parse(u8ToText(byName['inspections.json'])) : [];
        const jobs = byName['jobs.json'] ? JSON.parse(u8ToText(byName['jobs.json'])) : [];
        const photoFiles = files.filter(f => f.name.indexOf('photos/') === 0);
        for (const pf of photoFiles) {
          const base = pf.name.split('/').pop();
          const id = base.replace(/\.(jpg|jpeg|png)$/i, '');
          const mime = /\.png$/i.test(base) ? 'image/png' : 'image/jpeg';
          const blob = new Blob([pf.data], { type: mime });
          await idbPutPhoto({ id, blob, caption: '', createdAt: Date.now() });
        }
        storeMem.visits = Array.isArray(visits) ? visits : [];
        storeMem.inspections = Array.isArray(inspections) ? inspections : [];
        storeMem.jobs = Array.isArray(jobs) ? jobs : [];
        try { saveJobs(storeMem.jobs); } catch (e) {}
        for (const v of storeMem.visits) {
          if (v.photos && v.photos.length) v.photos = await Promise.all(v.photos.map(hydratePhotoUrl));
        }
        storeMem.inspections = await hydrateInspectionBlobs(storeMem.inspections);
        await persistAllStores();
        if (byName['punchlist.json'] && typeof window.setPunchlistBackup === 'function') {
          try {
            const pl = JSON.parse(u8ToText(byName['punchlist.json']));
            await window.setPunchlistBackup(pl);
          } catch (err) {
            console.warn('punchlist restore', err);
          }
        }
        refreshHome();
        toast(byName['punchlist.json'] ? 'Backup restored' : 'Inspections restored — this zip has no punchlists');
      } catch (e) {
        console.warn(e);
        toast(String(e && e.message) === 'compressed-zip' ? 'Need an uncompressed LeMatic backup' : 'Restore failed');
      }
    }

    function loadVisits() { return []; }
    function saveVisits(list) {}
    function isTripFlowScreen(id) { return false; }
    function persistVisit(opts) { return {}; }
    function openVisit(id) {}
    function openDeleteVisitModal(id) {}
    function performDeleteVisit(id) {}

    // ========== JOBS ==========
    let editingJobId = null;

    const SAMPLE_JOB_ID = 'job_sample_demo';
    function getSampleJob() {
      const today = new Date();
      const end = new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000);
      const iso = (d) => d.toISOString().slice(0, 10);
      return {
        id: SAMPLE_JOB_ID,
        customer: 'BBU Sample Bakery',
        site: 'Orangeburg',
        contact: 'John Doe',
        technician: 'Sample Tech',
        date: iso(today),
        endDate: iso(end),
        po: 'PO-DEMO-1001',
        status: 'In Progress',
        scope: 'Demo trip for testing Job Detail, inspections, and punchlist linking.\n\n• Inspect LX-8 line 2\n• Capture punchlist items as found\n• Verify bagger guides and slicer linkage',
        notes: 'Sample job — safe to edit or delete while testing.',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isSample: true
      };
    }
    const SAMPLE_INSPECTION_ID = 'ins_example_orangeburg';
    function getSampleInspectionRecord() {
      const exampleResults = {1:{condition:'N/A'},2:{condition:'N/A'},3:{condition:'N/A'},4:{condition:'N/A'},5:{condition:'N/A'},6:{condition:'Good'},7:{condition:'Fair',notes:'Belting is stretched.'},8:{condition:'Good'},9:{condition:'Good'},10:{condition:'Fair',notes:'Some wear but can be adjusted.'},11:{condition:'Fair',notes:'Missing 4 but not needed on clusters.'},12:{condition:'Pass'},13:{condition:'Good'},14:{condition:'Fair',notes:'Belting is stretched.'},15:{condition:'Fair'},16:{condition:'Good',impacts:['Performance']},17:{condition:'Poor',notes:'Both are worn. Infeed is worn a lot.',impacts:['Performance'],severity:2},18:{condition:'Good'},19:{condition:'Fair',notes:'Circuit breaker tripped.'},20:{condition:'Good'},21:{condition:'Good'},22:{condition:'Poor',notes:'Worn smooth, should replace.',impacts:['Performance'],severity:2},23:{condition:'Fair',notes:'Center support bushings gone.'},24:{condition:'Fair',notes:'Play in base, pin, and clevis.'},25:{condition:'Fair',notes:'Broken top corner, op side gate.'},26:{condition:'Good'},27:{condition:'Good'},28:{condition:'Good'},29:{condition:'Good'},30:{condition:'Pass'},31:{condition:'Fair',notes:'Belting new but lane guides have worn grooves in rubber grip top.'},32:{condition:'Good'},33:{condition:'Poor',notes:'Infeed nose bar worn and transition gap is large.',impacts:['Performance'],severity:2},34:{condition:'Good'},35:{condition:'Good'},36:{condition:'Pass'},37:{condition:'Pass'},38:{condition:'Pass',notes:'Blade break prox cable has been cut and taped back together.'},39:{condition:'Good'},40:{condition:'Fair',notes:'Guides showing wear. Mix of old and new belts. Belts should be replaced in sets.'},41:{condition:'Good'},42:{condition:'N/A'},43:{condition:'Good'},44:{condition:'Poor',notes:'Missing blade guides. Blade wipers are broken.',impacts:['Downtime', 'Performance'],severity:2},45:{condition:'Poor',notes:'Bearings are bad, need to be replaced.',impacts:['Downtime', 'Performance'],severity:2},46:{condition:'Fair',notes:'Idler pulley new, drive pulley is worn.'},47:{condition:'Good',notes:'One bad hub, LeMatic and maintenance replaced.'},48:{condition:'Pass'},49:{condition:'Good',notes:'We installed a new blade, old blade had a lot of crumb build up.'},50:{condition:'Good'},51:{condition:'Good'},52:{condition:'Pass'},53:{condition:'Good'},54:{condition:'Good'},55:{condition:'Poor',notes:'Missing tensioner assembly.',impacts:['Downtime', 'Performance'],severity:2},56:{condition:'Good'},57:{condition:'Within Spec'},58:{condition:'Good'},59:{condition:'Good'},60:{condition:'Good'},61:{condition:'N/A'},62:{condition:'Good'},63:{condition:'Good'},65:{condition:'Pass'},66:{condition:'Pass',notes:'Prox is ok but linkage is worn and turning off prox.'},67:{condition:'Poor',notes:'Linkage worn out and needs to be replaced.',impacts:['Downtime', 'Performance'],severity:2},68:{condition:'Good'},69:{condition:'Good'},70:{condition:'Good'},71:{condition:'Good'},72:{condition:'Pass'},73:{condition:'Good'},75:{condition:'Pass'},76:{condition:'Good'},77:{condition:'Good'},78:{condition:'Poor',notes:'Blades are very rusty.',severity:2},79:{condition:'Pass'},81:{condition:'Good'},82:{condition:'Good'},83:{condition:'Fair',notes:'Track is showing some wear.',impacts:['Downtime']},84:{condition:'Good'},85:{condition:'Within Spec'},86:{condition:'Within Spec'},87:{condition:'Good'},88:{condition:'Good'},90:{condition:'Pass'},91:{condition:'Pass'},92:{condition:'Good'},93:{condition:'Good'},94:{condition:'Pass'},95:{condition:'Good'},96:{condition:'Fair',notes:'Non op bagger guides missing bolts.',impacts:['Performance']},97:{condition:'Poor',notes:'Transfer grate is bent, should be replaced.',impacts:['Performance'],severity:2},98:{condition:'Fair',notes:'Friction top is worn smooth, buns may slide.'},99:{condition:'Good'},100:{condition:'Good'},101:{condition:'Pass'},102:{condition:'Good'},103:{condition:'Fair',notes:'Dead plate is slightly bent.'},104:{condition:'Fair',notes:'Some play in clevis.'},105:{condition:'Good'},106:{condition:'Fair',notes:'Brackets were bent, LeMatic and maintenance fixed.'},107:{condition:'Fair',notes:'Some play in clevis'},108:{condition:'Poor',notes:'Bearings feel tight.',impacts:['Downtime'],severity:2},109:{condition:'Good'},110:{condition:'Fail',notes:'Lower drive belt cover is missing',impacts:['Safety'],severity:2},111:{condition:'Fair'},112:{condition:'Fair',notes:'Lift screws slightly noisy needs a little lube.'},113:{condition:'Poor',notes:'Broken tab.',impacts:['Performance'],severity:2},114:{condition:'Good'},115:{condition:'Within Spec'},116:{condition:'Fair',notes:'Should be cleaned.'},117:{condition:'Good'},118:{condition:'Good'},119:{condition:'Good'},120:{condition:'Good'},121:{condition:'Fair',notes:'Belt is slightly old but ok.'},122:{condition:'Good'},123:{condition:'Good'},124:{condition:'Good'},125:{condition:'Good'},126:{condition:'Good'},127:{condition:'Good'},128:{condition:'Within Spec'},129:{condition:'Good'},130:{condition:'Good'},131:{condition:'Out of Spec',notes:'Timing belts are getting loose.',severity:2},132:{condition:'Good'},133:{condition:'Good'},134:{condition:'Good'},135:{condition:'Pass'}};
      return {
        id: SAMPLE_INSPECTION_ID,
        jobId: SAMPLE_JOB_ID,
        customer: 'BBU Sample Bakery',
        site: 'Orangeburg',
        model: 'LX-8',
        serial: '44621019 Line 1',
        technician: 'Josh Denig',
        date: '2026-02-22',
        po: 'PO-DEMO-1001',
        status: 'Draft',
        results: exampleResults,
        findings: [],
        currentSectionIndex: 1,
        createdAt: new Date().toISOString(),
        overallCondition: 'Needs Attention',
        coverCards: [
          { tag: 'Safety', title: 'Missing elevator drive belt cover', body: 'Lower drive-belt cover is off. Put it on before Monday.' },
          { tag: 'Uptime', title: 'Hinge tensioners', body: 'All three lines. Line 2 is worst. Order the full assembly.' },
          { tag: 'Slice', title: 'Bottom-slicer linkage', body: 'Worn on all three. Order LH sleeves and clevises.' }
        ],
        summaryNotes: "The baggers are in much better condition now than they were a year ago. The bottom slicer linkage and the hinge slicer drive chain tensioners should be the immediate focus for improvement as both of those items can lead to a loss in efficiency and an increase in downtime.\n\nThe horizontal blades in the hinge slicer are the double notch design. They should be swapped for single notch blades as it is very easy to install blades incorrectly, this will lead to a poor slice and/or damage to the machine.\n\nBlade scrapers for the band slicers could increase the life of the blades and decrease down time due to blades coming off."
      };
    }
    function ensureSampleInspection(list) {
      const arr = Array.isArray(list) ? list.slice() : [];
      const idx = arr.findIndex(i => i && i.id === SAMPLE_INSPECTION_ID);
      if (idx < 0) {
        const full = (typeof window !== 'undefined' && window.__SAMPLE_INSPECTION_FULL) || getSampleInspectionRecord();
        arr.unshift(full);
      } else {
        arr[idx].jobId = SAMPLE_JOB_ID;
        if (!arr[idx].customer) arr[idx].customer = 'BBU Sample Bakery';
      }
      return arr;
    }
    function ensureSampleJob(list) {
      const arr = Array.isArray(list) ? list.slice() : [];
      const sample = getSampleJob();
      const idx = arr.findIndex(j => j && j.id === SAMPLE_JOB_ID);
      if (idx < 0) arr.unshift(sample);
      else {
        arr[idx] = Object.assign({}, arr[idx], {
          site: sample.site,
          contact: sample.contact
        });
      }
      return arr;
    }
    function loadJobs() {
      window.loadJobs = loadJobs;
      const fromLs = lsRead('lx8_jobs', []);
      const mem = Array.isArray(storeMem.jobs) ? storeMem.jobs : [];
      const src = mem.length ? mem : (Array.isArray(fromLs) ? fromLs : []);
      storeMem.jobs = ensureJobsIdentities(ensureSampleJob(src));
      if (applyJobStatuses(storeMem.jobs)) saveJobs(storeMem.jobs);
      return storeMem.jobs;
    }

    function saveJobs(list) {
      storeMem.jobs = ensureJobsIdentities(Array.isArray(list) ? list : []);
      const ok = lsWrite('lx8_jobs', storeMem.jobs);
      if (!ok) {
        try {
          if (lsWrite('lx8_jobs', storeMem.jobs)) return true;
        } catch (e) {}
      }
      try { idbSetKv('jobs', storeMem.jobs); } catch (e) {}
      return ok;
    }

    function jobEsc(s) {
      return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    function jobStatusClass(status) {
      const s = String(status || '').toLowerCase();
      if (s === 'complete' || s === 'done') return 'badge-complete';
      if (s === 'in progress') return 'badge-inprogress';
      return 'badge-planned';
    }

    function refreshJobsList() {
      const container = document.getElementById('jobsList');
      if (!container) return;
      const list = loadJobs().slice().sort((a, b) => String(b.date || b.createdAt || '').localeCompare(String(a.date || a.createdAt || '')));
      if (!list.length) {
        container.innerHTML = `<div class="empty">
          <div class="icon"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.5" y="7.5" width="17" height="12" rx="2.2" stroke="currentColor" stroke-width="1.2"/><path d="M8.5 7.5V6A1.5 1.5 0 0 1 10 4.5h4A1.5 1.5 0 0 1 15.5 6v1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M3.5 12.5h17" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M11 12.5v2.2h2v-2.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
          <div>No jobs yet</div>
          <div style="margin-top:8px;font-size:13px;opacity:0.8">Tap + to start a trip</div>
        </div>`;
        return;
      }
            const dayStamp = (v) => {
        if (!v) return null;
        const n = Date.parse(String(v).slice(0, 10) + 'T00:00:00');
        return Number.isNaN(n) ? null : n;
      };
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayMs = today.getTime();
      const isPastJob = (job) => {
        const end = dayStamp(job.endDate);
        const start = dayStamp(job.date);
        if (end != null) return end < todayMs;
        if (start != null) return start < todayMs;
        return false;
      };
      const current = list.filter(j => !isPastJob(j));
      const past = list.filter(isPastJob);

      function jobCard(job) {
        const dateRange = formatJobDateRange(job);
        const sub = [job.site, job.technician, dateRange].filter(Boolean).join(' · ');
        const scopePreview = (job.scope || '').trim().replace(/\s+/g, ' ').slice(0, 90);
        const classes = ['pl-item'];
        if (job.status === 'Complete') classes.push('list-complete');
        else if (job.status === 'In Progress') classes.push('job-inprogress');
        else classes.push('job-planned');
        return `<div class="${classes.join(' ')}" data-job-id="${job.id}">
          <div class="list-item-main">
            <div class="title">${jobEsc(job.customer || 'Untitled job')}</div>
            <div class="sub">${jobEsc(sub || 'No details yet')}</div>
            ${scopePreview ? `<div class="action-line">${jobEsc(scopePreview)}${(job.scope || '').length > 90 ? '…' : ''}</div>` : ''}
          </div>
          <div class="list-item-actions">
            <span class="badge ${jobStatusClass(job.status)}">${jobEsc(job.status || 'Planned')}</span>
          </div>
        </div>`;
      }

      let html = '';
      if (current.length) {
        html += '<div class="jobs-section-label">Current job</div>' + current.map(jobCard).join('');
      }
      if (past.length) {
        html += '<div class="jobs-section-label">Past jobs</div>' + past.map(jobCard).join('');
      }
      container.innerHTML = html;
      container.querySelectorAll('[data-job-id]').forEach(el => {
        el.addEventListener('click', () => openJobDetail(el.getAttribute('data-job-id')));
      });
    }

    function fillJobCustomerList() {
      const jobs = loadJobs();
      const customers = [...new Set(jobs.map(j => j.customer).filter(Boolean))];
      const dl = document.getElementById('jobCustomerList');
      if (dl) dl.innerHTML = customers.map(c => `<option value="${jobEsc(c)}">`).join('');
    }

    function initJobForm(job) {
      document.getElementById('jobCustomer').value = job?.customer || '';
      document.getElementById('jobSite').value = job?.site || '';
      document.getElementById('jobContact').value = job?.contact || '';
      document.getElementById('jobTechnician').value = job?.technician || profileName() || (lsRead('lx8_last_tech', '') || '');
      document.getElementById('jobDate').value = job?.date || new Date().toISOString().slice(0, 10);
      document.getElementById('jobEndDate').value = job?.endDate || '';
      document.getElementById('jobPO').value = job?.po || '';
      document.getElementById('jobSO').value = job?.so || '';
      document.getElementById('jobStatus').value = job?.status || 'Planned';
      document.getElementById('jobScope').value = job?.scope || '';
      document.getElementById('jobNotes').value = job?.notes || '';
      fillJobCustomerList();
      setJobMachineFields(job?.machine || 'LX-8');
      jobSerialsDraft = normalizeJobSerials(Array.isArray(job?.serials) ? job.serials : []);
      populateJobSerialSelect(jobSerialsDraft, jobSerialsDraft[0] || '');
      if (typeof renderJobSerialChips === 'function') renderJobSerialChips();
      updateJobMachineSummary();
    }

    let jobSerialsDraft = [];
    let machineModalMode = 'job';
    let pendingInspectJobId = null;

    function updateJobMachineSummary() {
      const el = document.getElementById('jobMachineSummaryText');
      if (!el) return;
      const machine = readJobMachine() || 'No machine';
      const serial = readJobSerial() || (jobSerialsDraft[0] || '');
      el.textContent = serial ? (machine + ' · ' + serial) : (machine + ' · add serial');
    }

    function openMachineModal() {
      const modal = document.getElementById('machineModal');
      if (!modal) return;
      if (!machineModalMode) machineModalMode = 'job';
      if (typeof hideInspectJobSelect === 'function' && machineModalMode === 'job') hideInspectJobSelect();
      if (machineModalMode === 'job') {
        const title = document.getElementById('machineModalTitle');
        const done = document.getElementById('machineModalDone');
        if (title) title.textContent = 'Machine & serials';
        if (done) done.textContent = 'Done';
      }
      if (machineModalMode === 'startInspect' && typeof populateInspectJobSelect === 'function') {
        populateInspectJobSelect(pendingInspectJobId);
      }
      modal.classList.remove('hidden');
      modal.classList.add('show');
      modal.setAttribute('aria-hidden', 'false');
    }

    function closeMachineModal() {
      const modal = document.getElementById('machineModal');
      if (!modal) return;
      const serial = readJobSerial();
      if (serial && !jobSerialsDraft.some(s => String(s).toLowerCase() === serial.toLowerCase())) {
        jobSerialsDraft.push(serial);
      }
      modal.classList.add('hidden');
      modal.classList.remove('show');
      modal.setAttribute('aria-hidden', 'true');
      updateJobMachineSummary();
    }


    function serialSortValue(s) {
      const m = String(s || '').match(/(\d+)(?!.*\d)/);
      return m ? parseInt(m[1], 10) : 0;
    }
    function jobSerialText(s) {
      if (s && typeof s === 'object') return String(s.serial || s.id || '').trim();
      return String(s || '').trim();
    }
    function normalizeJobSerials(list) {
      const out = [];
      (list || []).forEach(s => {
        const text = jobSerialText(s);
        if (!text) return;
        if (out.some(x => jobSerialText(x).toLowerCase() === text.toLowerCase())) return;
        out.push(text);
      });
      return out.sort((a, b) => serialSortValue(a) - serialSortValue(b) || a.localeCompare(b));
    }
    function taggedJobSerials(list) {
      return normalizeJobSerials(list).map((serial, i) => ({ serial, line: String(i + 1) }));
    }
    function renderJobSerialChips() {
      const wrap = document.getElementById('jobSerialChips');
      if (!wrap) return;
      jobSerialsDraft = normalizeJobSerials(jobSerialsDraft);
      if (!jobSerialsDraft.length) {
        wrap.innerHTML = '<div class="job-serial-empty">No serials yet</div>';
        updateJobMachineSummary();
        return;
      }
      const tagged = taggedJobSerials(jobSerialsDraft);
      wrap.innerHTML = tagged.map((row, i) =>
        `<div class="job-serial-row">
          <span class="line-chip on">${jobEsc(row.line)}</span>
          <span class="job-serial-text">${jobEsc(row.serial)}</span>
          <button type="button" class="job-serial-chip job-serial-remove" data-idx="${i}" aria-label="Remove">×</button>
        </div>`
      ).join('');
      wrap.querySelectorAll('.job-serial-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-idx'));
          jobSerialsDraft.splice(idx, 1);
          jobSerialsDraft = normalizeJobSerials(jobSerialsDraft);
          renderJobSerialChips();
        });
      });
      updateJobMachineSummary();
    }

    function addJobSerialFromInput() {
      const input = document.getElementById('jobSerialInput');
      if (!input) return;
      const v = input.value.trim();
      if (!v) return;
      if (!jobSerialsDraft.some(s => jobSerialText(s).toLowerCase() === v.toLowerCase())) jobSerialsDraft.push(v);
      jobSerialsDraft = normalizeJobSerials(jobSerialsDraft);
      input.value = '';
      renderJobSerialChips();
    }

    function setInspectMachineFields(value) {
      const sel = document.getElementById('inspectMachine');
      const custom = document.getElementById('inspectMachineCustom');
      if (!sel || !custom) return;
      const known = ['LX-8', 'LX-7', 'LS-132', 'LS-133'];
      const v = String(value || '').trim();
      if (!v || known.includes(v)) {
        sel.value = v || 'LX-8';
        custom.value = '';
        custom.classList.add('hidden');
      } else {
        sel.value = '__other';
        custom.value = v;
        custom.classList.remove('hidden');
      }
    }

    function readInspectMachine() {
      const sel = document.getElementById('inspectMachine');
      const custom = document.getElementById('inspectMachineCustom');
      if (!sel) return '';
      if (sel.value === '__other') return (custom && custom.value.trim()) || '';
      return sel.value;
    }

    function setJobMachineFields(value) {
      const sel = document.getElementById('jobMachine');
      const custom = document.getElementById('jobMachineCustom');
      if (!sel || !custom) return;
      const known = ['LX-8', 'LX-7', 'LS-132', 'LS-133'];
      const v = String(value || '').trim();
      if (!v || known.includes(v)) {
        sel.value = v || 'LX-8';
        custom.value = '';
        custom.classList.add('hidden');
      } else {
        sel.value = '__other';
        custom.value = v;
        custom.classList.remove('hidden');
      }
    }

    function readJobMachine() {
      const sel = document.getElementById('jobMachine');
      const custom = document.getElementById('jobMachineCustom');
      if (!sel) return '';
      if (sel.value === '__other') return (custom && custom.value.trim()) || '';
      return sel.value;
    }

    function inspectJobsSource() {
      let jobs = [];
      try { jobs = loadJobs() || []; } catch (e) { jobs = []; }
      if (!jobs.length) {
        try { jobs = JSON.parse(localStorage.getItem('lx8_jobs') || '[]') || []; } catch (e) { jobs = []; }
      }
      jobs = (jobs || []).filter(j => j && typeof j === 'object');
      jobs.forEach(j => { try { ensureJobIdentity(j); } catch (e) {} });
      return jobs;
    }
    function populateInspectJobSelect(selectedId) {
      const wrap = document.getElementById('inspectJobGroup');
      const sel = document.getElementById('inspectModalJobSelect');
      if (wrap) {
        wrap.classList.remove('hidden');
        wrap.style.display = 'block';
      }
      if (!sel) return;
      const jobs = inspectJobsSource();
      const current = String(selectedId || pendingInspectJobId || sel.value || '');
      function labelOf(j) {
        try {
          const n = jobDisplayName(j);
          if (n && String(n).trim() && n !== 'Job') return String(n);
        } catch (e) {}
        return j.customer || j.site || 'Untitled job';
      }
      const sorted = jobs.slice().sort((a, b) => String(b.date || b.createdAt || '').localeCompare(String(a.date || a.createdAt || '')));
      sel.innerHTML = '<option value="">Select job</option>' + sorted.map(j => {
        const id = String(j.id || '');
        if (!id) return '';
        const selAttr = id === current ? ' selected' : '';
        return '<option value="' + id.replace(/"/g,'&quot;') + '"' + selAttr + '>' + labelOf(j).replace(/</g,'&lt;') + '</option>';
      }).join('');
      if (current && jobs.some(j => String(j.id) === current)) sel.value = current;
      sel.onchange = function() {
        const id = sel.value || '';
        pendingInspectJobId = id || null;
        const job = jobs.find(j => String(j.id) === String(id));
        jobSerialsDraft = (job && Array.isArray(job.serials)) ? job.serials.slice() : [];
        if (job && job.machine && typeof setInspectMachineFields === 'function') setInspectMachineFields(job.machine);
        if (typeof populateJobSerialSelect === 'function') populateJobSerialSelect(jobSerialsDraft, jobSerialsDraft[0] || '');
      };
    }
        function hideInspectJobSelect() {
      const wrap = document.getElementById('inspectJobGroup');
      if (wrap) wrap.classList.add('hidden');
    }
    function populateJobSerialSelect(serials, selected) {
      const sel = document.getElementById('inspectSerialSelect');
      const custom = document.getElementById('inspectSerialInput');
      if (!sel) return;
      const list = Array.isArray(serials) ? serials.filter(Boolean) : [];
      const selVal = String(selected || '').trim();
      sel.innerHTML = '<option value="">Select serial</option>' +
        list.map(s => `<option value="${jobEsc(s)}">${jobEsc(s)}</option>`).join('') +
        '<option value="__other">Other</option>';
      if (selVal && list.some(s => s === selVal)) {
        sel.value = selVal;
        if (custom) { custom.value = ''; custom.classList.add('hidden'); }
      } else if (selVal) {
        sel.value = '__other';
        if (custom) { custom.value = selVal; custom.classList.remove('hidden'); }
      } else if (list.length === 1) {
        sel.value = list[0];
        if (custom) { custom.value = ''; custom.classList.add('hidden'); }
      } else {
        sel.value = '';
        if (custom) { custom.value = ''; custom.classList.add('hidden'); }
      }
    }

    function readJobSerial() {
      const sel = document.getElementById('inspectSerialSelect');
      const custom = document.getElementById('inspectSerialInput');
      if (sel && sel.value === '__other') return (custom && custom.value.trim()) || '';
      if (sel && sel.value) return sel.value.trim();
      return (custom && custom.value.trim()) || '';
    }

    let detailJobId = null;

    function openJobDetail(id) {
      const job = loadJobs().find(j => j.id === id);
      if (!job) { toast('Job not found'); return; }
      detailJobId = id;
      showScreen('screenJobDetail');
      setHeader('Job');
      refreshJobDetail();
    }


    function jobDetailTimecardEntries(job) {
      let entries = [];
      try {
        if (typeof window.tcLoad === 'function') window.tcLoad();
      } catch (e) {}
      try {
        if (window.tcState && Array.isArray(window.tcState.entries)) entries = window.tcState.entries;
      } catch (e) {}
      if (!entries.length) {
        try {
          const raw = JSON.parse(localStorage.getItem('lx8_timecards') || 'null');
          if (raw && Array.isArray(raw.entries)) entries = raw.entries;
        } catch (e) {}
      }
      if (!job) return entries.slice();
      const match = (typeof window.tcEntryMatchesJob === 'function')
        ? (en) => window.tcEntryMatchesJob(en, job)
        : (en) => !!(en && job && en.jobId && job.id && String(en.jobId) === String(job.id));
      return entries.filter(match);
    }
    function jobDetailEntryHours(en) {
      try {
        if (typeof window.tcEntryHours === 'function') return Number(window.tcEntryHours(en) || 0);
      } catch (e) {}
      if (!en) return 0;
      if (en.manualHours != null && en.manualHours !== '' && !isNaN(Number(en.manualHours))) return Number(en.manualHours);
      if (en.clockIn && en.clockOut) return Math.max(0, (Number(en.clockOut) - Number(en.clockIn)) / 3600000);
      return 0;
    }
    function renderJobDetailTimecards(job) {
      const rows = jobDetailTimecardEntries(job).slice().sort((a, b) => {
        const av = Number(a.clockIn || Date.parse(a.date || '') || 0);
        const bv = Number(b.clockIn || Date.parse(b.date || '') || 0);
        return bv - av;
      });
      let total = 0;
      rows.forEach(en => { total += jobDetailEntryHours(en); });
      total = Math.round(total * 100) / 100;
      const hv = document.getElementById('jdHoursValue');
      if (hv) hv.textContent = rows.length ? (total.toFixed(2) + ' h on this job') : 'No hours yet';
      const listEl = document.getElementById('jobDetailTimeList');
      if (!listEl) return;
      if (!rows.length) {
        listEl.innerHTML = '<div class="empty-state compact"><p>No time cards linked to this job yet.</p></div>';
        return;
      }
      listEl.innerHTML = rows.map(en => {
        const hrs = jobDetailEntryHours(en);
        const day = en.date || '';
        const type = en.type ? String(en.type) : '';
        return '<div class="list-item" data-tc-id="' + String(en.id || '').replace(/"/g, '&quot;') + '">' +
          '<div class="list-item-main" data-action="open-tc">' +
          '<div class="title">' + jobEsc(day || 'Time entry') + '</div>' +
          '<div class="sub">' + jobEsc([hrs.toFixed(2) + ' h', type].filter(Boolean).join(' · ')) + '</div>' +
          '</div></div>';
      }).join('');
      listEl.querySelectorAll('[data-action="open-tc"]').forEach(el => {
        el.addEventListener('click', () => {
          const id = el.closest('.list-item') && el.closest('.list-item').getAttribute('data-tc-id');
          const open = window.tcOpenEdit || (typeof tcOpenEdit === 'function' ? tcOpenEdit : null);
          const cards = window.openTimeCards || (typeof openTimeCards === 'function' ? openTimeCards : null);
          if (id && open) open(id);
          else if (cards) cards();
        });
      });
    }
    function setJobProgressRow(id, complete, title, detail) {
      const row = document.getElementById(id);
      if (!row) return;
      const icon = row.querySelector('.jd-progress-icon');
      const text = row.querySelector('small');
      if (icon) icon.textContent = complete ? '✓' : '○';
      row.classList.toggle('complete', !!complete);
      if (text) text.textContent = detail || title || '';
    }

    function refreshJobProgress(job, inspections, punchTotal, punchDone, hours) {
      const inspectDone = inspections && inspections.length > 0 && inspections.every(i => i.status === 'Complete');
      const punchDoneAll = punchTotal > 0 && punchDone >= punchTotal;
      const timeDone = Number(hours || 0) > 0;
      const completed = [inspectDone, punchDoneAll, timeDone].filter(Boolean).length;
      const count = document.getElementById('jdProgressCount');
      const title = document.getElementById('jdProgressTitle');
      if (count) count.textContent = completed + ' / 3 complete';
      if (title) title.textContent = job.status === 'Complete' ? 'Job complete' : (completed === 3 ? 'Ready to complete' : 'Work in progress');
      setJobProgressRow('jdProgressInspection', inspectDone, 'Inspection', inspections.length ? (inspectDone ? inspections.length + ' complete' : inspections.filter(i => i.status !== 'Complete').length + ' open') : 'Not started');
      setJobProgressRow('jdProgressPunchlist', punchDoneAll, 'Punchlist', punchTotal ? (punchDone + ' of ' + punchTotal + ' complete') : 'Not started');
      setJobProgressRow('jdProgressTime', timeDone, 'Time', timeDone ? Number(hours).toFixed(2) + ' hours recorded' : 'No hours recorded');
      const btn = document.getElementById('btnCompleteJob');
      if (btn) {
        btn.textContent = job.status === 'Complete' ? 'Reopen Job' : 'Complete Job';
        btn.classList.toggle('is-complete', job.status === 'Complete');
      }
    }

    async function toggleJobComplete() {
      if (!detailJobId) return;
      const list = loadJobs();
      const job = list.find(j => j.id === detailJobId);
      if (!job) return;
      if (job.status === 'Complete') {
        job.status = 'In Progress';
        saveJobs(list);
        refreshHomeCurrentJob();
        await refreshJobDetail();
        toast('Job reopened');
        return;
      }
      let openWarnings = [];
      try {
        const inspections = loadInspections().filter(i => i.jobId === job.id);
        if (inspections.some(i => i.status !== 'Complete')) openWarnings.push('inspection still open');
        if (typeof window.getPunchlistSummaries === 'function') {
          const rows = await window.getPunchlistSummaries();
          const row = (rows || []).find(r => r && String(r.jobId) === String(job.id));
          if (row && Number(row.total || 0) > Number(row.complete || 0)) openWarnings.push('punchlist has open items');
        }
      } catch (e) {}
      if (openWarnings.length) {
        const ok = window.confirm('This job still has ' + openWarnings.join(' and ') + '.\n\nComplete the job anyway?');
        if (!ok) return;
      }
      job.status = 'Complete';
      job.completedAt = new Date().toISOString();
      saveJobs(list);
      refreshHomeCurrentJob();
      await refreshJobDetail();
      toast('Job completed');
    }

    async function refreshJobDetail() {
      const job = loadJobs().find(j => j.id === detailJobId);
      if (!job) {
        toast('Job not found');
        showScreen('screenJobsList');
        setHeader('Jobs');
        refreshJobsList();
        return;
      }

      document.getElementById('jobDetailTitle').textContent = job.customer || 'Untitled job';
      const subParts = [job.site, job.technician].filter(Boolean);
      document.getElementById('jobDetailSub').textContent = subParts.join(' · ') || '';
      const badge = document.getElementById('jobDetailStatusBadge');
      if (badge) {
        badge.textContent = job.status || 'Planned';
        badge.className = 'badge hidden';
      }

      const dash = (v) => (v && String(v).trim()) ? String(v).trim() : '—';
      document.getElementById('jdSite').textContent = dash(job.site);
      document.getElementById('jdContact').textContent = dash(job.contact);
      document.getElementById('jdTech').textContent = dash(job.technician);
      document.getElementById('jdDates').textContent = formatJobDateRange(job) || '—';
      document.getElementById('jdPO').textContent = dash(job.po);
      renderJobDetailTimecards(job);
      const jobHours = jobDetailTimecardEntries(job).reduce((sum, en) => sum + jobDetailEntryHours(en), 0);

      const scopeCard = document.getElementById('jobDetailScopeCard');
      const scope = (job.scope || '').trim();
      const notes = (job.notes || '').trim();
      if (scope || notes) {
        scopeCard.classList.remove('hidden');
        document.getElementById('jdScope').textContent = scope || '';
        document.getElementById('jdScope').style.display = scope ? '' : 'none';
        const notesEl = document.getElementById('jdNotes');
        if (notes) {
          notesEl.textContent = notes;
          notesEl.classList.remove('hidden');
        } else {
          notesEl.classList.add('hidden');
        }
      } else {
        scopeCard.classList.add('hidden');
      }

      // Linked inspections
      const inspections = loadInspections().filter(i => i.jobId === job.id);
      const inspectList = document.getElementById('jobDetailInspectList');
      const draftN = inspections.filter(i => i.status !== 'Complete').length;
      const doneN = inspections.filter(i => i.status === 'Complete').length;
      if (!inspections.length) {
        document.getElementById('jdInspectCount').textContent = 'None yet';
        inspectList.innerHTML = `<div class="empty-state compact"><p>No inspections linked yet.</p></div>`;
      } else {
        document.getElementById('jdInspectCount').textContent =
          (draftN ? draftN + ' open' : '') + (draftN && doneN ? ' · ' : '') + (doneN ? doneN + ' complete' : '') || (inspections.length + ' total');
        inspectList.innerHTML = inspections.slice(0, 20).map(ins => {
          const findCount = (ins.findings || []).length;
          const statusClass = ins.status === 'Complete' ? 'badge-complete' : 'badge-draft';
          const statusLabel = ins.status === 'Complete' ? 'Complete' : 'Draft';
          const rowTone = ins.status === 'Complete' ? 'list-complete' : '';
          return `<div class="list-item ${rowTone}" data-id="${ins.id}">
            <div class="list-item-main" data-action="open">
              <div class="title">${jobEsc(ins.customer || 'Unknown')} – ${jobEsc(ins.model || 'LX-8')} – ${jobEsc(ins.serial || 'No S/N')}</div>
              <div class="sub">${jobEsc(ins.technician || '')} · ${jobEsc(ins.date || '')} · ${findCount} finding${findCount !== 1 ? 's' : ''}</div>
            </div>
            <div class="list-item-actions">
              <span class="badge ${statusClass}">${statusLabel}</span>
            </div>
          </div>`;
        }).join('');
        inspectList.querySelectorAll('.list-item').forEach(el => {
          const id = el.dataset.id;
          el.querySelector('[data-action="open"]').addEventListener('click', () => openInspection(id));
        });
      }

      // Punchlist summary for this job — prefer jobId link from Edit picker
      let punchTotal = 0, punchDone = 0, punchName = '', punchLinked = false;
      try {
        const key = (typeof punchlistKeyForJob === 'function') ? punchlistKeyForJob(job) : (job.customer || '');
        if (typeof window.getPunchlistSummaries === 'function') {
          const rows = await window.getPunchlistSummaries();
          const match = (rows || []).find(r => r && r.jobId && r.jobId === job.id)
            || (rows || []).find(r => r && r.name === key);
          if (match) {
            punchTotal = match.total || 0;
            punchDone = match.complete || 0;
            punchName = match.name || key;
            punchLinked = true;
          }
        }
        if (!punchName) punchName = key;
      } catch (e) {}
      if (!punchLinked && punchTotal === 0) {
        document.getElementById('jdPunchCount').textContent = 'None yet';
      } else {
        const open = punchTotal - punchDone;
        document.getElementById('jdPunchCount').textContent =
          punchTotal === 0 ? 'Linked · no items yet' : (punchTotal + ' item' + (punchTotal !== 1 ? 's' : '') + (open ? ' · ' + open + ' open' : ' · complete'));
      }

      const punchList = document.getElementById('jobDetailPunchList');
      let punchRows = [];
      try {
        if (typeof window.getPunchlistSummaries === 'function') {
          const rows = await window.getPunchlistSummaries();
          punchRows = (rows || []).filter(r => r && r.jobId && String(r.jobId) === String(job.id));
        }
      } catch (e) { punchRows = []; }
      if (!punchRows.length && punchLinked) {
        punchRows = [{ key: '', name: punchName, total: punchTotal, complete: punchDone, jobId: job.id }];
      }
      if (!punchRows.length) {
        punchList.innerHTML = `<div class="empty-state compact"><p>No punchlist linked. Edit a punchlist and pick this job.</p></div>`;
      } else {
        punchList.innerHTML = punchRows.map((row) => {
          const total = row.total || 0;
          const done = row.complete || 0;
          const openN = total - done;
          const allDone = total > 0 && openN === 0;
          const title = row.name || punchName || 'Punchlist';
          const key = row.key || '';
          return `<div class="list-item ${allDone ? 'list-complete' : ''}" data-action="open-punch" data-pl-key="${jobEsc(key)}" data-pl-name="${jobEsc(title)}">
          <div class="list-item-main">
            <div class="title">${jobEsc(title)}</div>
            <div class="sub">${total} item${total !== 1 ? 's' : ''} · ${done} complete${openN ? ' · ' + openN + ' open' : ''}</div>
          </div>
          <div class="list-item-actions">
            <span class="badge ${allDone ? 'badge-complete' : 'badge-draft'}">${allDone ? 'Complete' : 'Open'}</span>
          </div>
        </div>`;
        }).join('');
        punchList.querySelectorAll('[data-action="open-punch"]').forEach(el => {
          el.addEventListener('click', async () => {
            const key = el.getAttribute('data-pl-key') || '';
            const name = el.getAttribute('data-pl-name') || '';
            try {
              if (typeof window.openPunchlistByName !== 'function') {
                toast('Punchlist not ready');
                return;
              }
              await window.openPunchlistByName(key || name);
              showScreen('screenPunchlist');
              setHeader('Punchlist');
              if (typeof window.populateJobSelect === 'function') window.populateJobSelect();
              if (typeof window.renderList === 'function') window.renderList();
            } catch (err) {
              console.error(err);
              toast('Could not open punchlist');
            }
          });
        });
      }
      refreshJobProgress(job, inspections, punchTotal, punchDone, jobHours);
    }

    function openJob(id) {
      // Edit form
      const job = loadJobs().find(j => j.id === id);
      if (!job) { toast('Job not found'); return; }
      editingJobId = id;
      detailJobId = id;
      initJobForm(job);
      document.getElementById('btnSaveJob').textContent = 'Save Job';
      document.getElementById('btnDeleteJob').classList.remove('hidden');
      showScreen('screenJobForm');
      setHeader('Edit Job');
    }

    function startInspectionForDetailJob() {
      const job = loadJobs().find(j => j.id === detailJobId);
      if (!job) { toast('Job not found'); return; }
      currentInspection = null;
      editingInspectionId = null;
      results = {};
      findings = [];
      currentSectionIndex = 0;
      applyJobToInspectionForm(job);
      const model = job.machine || 'LX-8';
      const known = ['LX-8', 'LX-7', 'LS-132', 'LS-133'];
      const modelEl = document.getElementById('inpModel');
      if (modelEl) {
        if (known.includes(model)) modelEl.value = model;
        else modelEl.value = 'LX-8';
      }
      fillInspectionSerialOptions(job);
      jobSerialsDraft = Array.isArray(job.serials) ? job.serials.slice() : [];
      machineModalMode = 'startInspect';
      const title = document.getElementById('machineModalTitle');
      const done = document.getElementById('machineModalDone');
      if (title) title.textContent = 'Link job';
      if (done) done.textContent = 'Start inspection';
      if (typeof populateInspectJobSelect === 'function') populateInspectJobSelect(job && job.id);
      setInspectMachineFields(job.machine || 'LX-8');
      populateJobSerialSelect(jobSerialsDraft, jobSerialsDraft[0] || '');
      openMachineModal();
      toast('Add machine type and serial number to start inspection');
    }

    function fillInspectionSerialOptions(job) {
      let dl = document.getElementById('jobSerialList');
      if (!dl) {
        dl = document.createElement('datalist');
        dl.id = 'jobSerialList';
        const serialInp = document.getElementById('inpSerial');
        if (serialInp) {
          serialInp.setAttribute('list', 'jobSerialList');
          serialInp.parentNode.appendChild(dl);
        }
      }
      const serials = (job && Array.isArray(job.serials)) ? job.serials : [];
      dl.innerHTML = serials.map(s => `<option value="${jobEsc(s)}">`).join('');
    }

    function startInspectionFromMachinePopup() {
      const picked = document.getElementById('inspectModalJobSelect') || document.getElementById('inspectJobSelect');
      const jobId = (picked && picked.value) || pendingInspectJobId || detailJobId;
      if (machineModalMode === 'startInspect' && !jobId) {
        toast('Select a job to link this inspection');
        return;
      }
      const job = jobId ? loadJobs().find(j => j.id === jobId) : null;
      const serial = readJobSerial();
      const model = (typeof readInspectMachine === 'function' && readInspectMachine()) || (job && job.machine) || 'LX-8';
      if (!job) {
        closeMachineModal();
        machineModalMode = 'job';
        pendingInspectJobId = null;
        if (typeof setActiveMachine === 'function') setActiveMachine(model);
        currentInspection = {
          id: 'ins_' + Date.now(),
          customer: '',
          model,
          serial: serial || 'TBD',
          technician: profileName() || '',
          date: new Date().toISOString().slice(0, 10),
          po: '',
          status: 'Draft',
          results: {},
          findings: [],
          currentSectionIndex: 0,
          createdAt: new Date().toISOString()
        };
        saveCurrentDraft();
        renderSection();
        showScreen('screenInspect');
        setHeader('Inspecting');
        toast('Inspection started');
        return;
      }
      if (serial) {
        if (!jobSerialsDraft.some(s => String(s).toLowerCase() === serial.toLowerCase())) jobSerialsDraft.push(serial);
        rememberJobSerial(job.id, serial);
      }
      closeMachineModal();
      machineModalMode = 'job';
      pendingInspectJobId = null;
      currentInspection = null;
      editingInspectionId = null;
      results = {};
      findings = [];
      currentSectionIndex = 0;
      if (typeof setActiveMachine === 'function') setActiveMachine(model);
      currentInspection = {
        id: 'ins_' + Date.now(),
        customer: job.customer || '',
        model,
        serial,
        technician: job.technician || profileName() || '',
        date: job.date || new Date().toISOString().slice(0, 10),
        po: job.po || '',
        jobId: job.id,
        bakeryId: bakeryIdFromJob(job),
        machineId: serial ? machineIdFromSerial(serial) : '',
        status: 'Draft',
        results: {},
        findings: [],
        currentSectionIndex: 0,
        createdAt: new Date().toISOString()
      };
      saveCurrentDraft();
      renderSection();
      showScreen('screenInspect');
      setHeader('Inspecting');
    }

    function rememberJobSerial(jobId, serial) {
      if (!jobId || !serial) return;
      const list = loadJobs();
      const job = list.find(j => j.id === jobId);
      if (!job) return;
      if (!Array.isArray(job.serials)) job.serials = [];
      if (!job.serials.some(s => String(s).toLowerCase() === serial.toLowerCase())) {
        job.serials.push(serial);
        saveJobs(list);
      }
      jobSerialsDraft = job.serials.slice();
    }

    async function startPunchlistForDetailJob() {
      const job = loadJobs().find(j => j.id === detailJobId);
      if (!job) { toast('Job not found'); return; }
      try {
        if (typeof window.openPunchlistForJob !== 'function') {
          toast('Punchlist not ready');
          return;
        }
        openPunchlistStartSheet(job);
        return;
      } catch (e) {
        console.error(e);
        toast('Could not open punchlist');
      }
    }

    function openNewJob() {
      editingJobId = null;
      initJobForm(null);
      document.getElementById('btnSaveJob').textContent = 'Save Job';
      document.getElementById('btnDeleteJob').classList.add('hidden');
      showScreen('screenJobForm');
      setHeader('New Job');
    }

    function saveJobFromForm() {
      const customer = document.getElementById('jobCustomer').value.trim();
      const tech = document.getElementById('jobTechnician').value.trim();
      const scope = document.getElementById('jobScope').value.trim();
      const so = document.getElementById('jobSO').value.trim();
      if (!customer || !tech) {
        toast('Please fill Customer and Technician');
        return;
      }
      const payload = {
        customer,
        site: document.getElementById('jobSite').value.trim(),
        contact: document.getElementById('jobContact').value.trim(),
        technician: tech,
        date: document.getElementById('jobDate').value,
        endDate: document.getElementById('jobEndDate').value,
        po: document.getElementById('jobPO').value.trim(),
        so: document.getElementById('jobSO').value.trim(),
        status: document.getElementById('jobStatus').value || 'Planned',
        scope,
        machine: readJobMachine(),
        serials: jobSerialsDraft.slice(),
        notes: document.getElementById('jobNotes').value.trim(),
        updatedAt: new Date().toISOString()
      };
      payload.status = jobStatusFromDates(payload);
      try { lsWrite('lx8_last_tech', tech); } catch (e) {}
      const list = loadJobs();
      if (editingJobId) {
        const idx = list.findIndex(j => j.id === editingJobId);
        if (idx < 0) { toast('Job not found'); return; }
        list[idx] = { ...list[idx], ...payload };
        toast('Job updated');
      } else {
        const newId = 'job_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        list.unshift(ensureJobIdentity({
          id: newId,
          createdAt: new Date().toISOString(),
          ...payload
        }));
        editingJobId = newId;
        toast('Job saved');
      }
      saveJobs(list);
      const savedId = editingJobId;
      editingJobId = null;
      if (savedId) {
        detailJobId = savedId;
        showScreen('screenJobDetail');
        setHeader('Job');
        refreshJobDetail();
      } else {
        showScreen('screenJobsList');
        setHeader('Jobs');
        refreshJobsList();
      }
      refreshHomeCurrentJob();
        refreshStorageCard();
    }

    function deleteJobCurrent() {
      const id = editingJobId || detailJobId;
      if (!id) {
        toast('No job to delete');
        return;
      }
      pendingDeleteId = id;
      pendingDeleteKind = 'job';
      document.getElementById('deleteModalTitle').textContent = 'Delete job?';
      document.getElementById('deleteModalLabel').textContent =
        'This job and its details will be permanently deleted.';
      const modal = document.getElementById('deleteModal');
      modal.classList.remove('hidden');
      modal.classList.add('show');
      modal.setAttribute('aria-hidden', 'false');
    }

    function performDeleteJob(id) {
      if (!id) {
        toast('No job to delete');
        return;
      }
      const list = loadJobs();
      const before = list.length;
      const next = list.filter(j => j.id !== id);
      if (next.length === before) {
        toast('Job not found');
        closeDeleteModal();
        return;
      }
      saveJobs(next);
      const check = loadJobs();
      if (check.some(j => j.id === id)) {
        toast('Delete failed — storage error');
        return;
      }
      if (editingJobId === id) editingJobId = null;
      if (detailJobId === id) detailJobId = null;
      const delBtn = document.getElementById('btnDeleteJob');
      if (delBtn) delBtn.classList.add('hidden');
      closeDeleteModal();
      toast('Job deleted');
      showScreen('screenJobsList');
      setHeader('Jobs');
      refreshJobsList();
      refreshHomeCurrentJob();
        refreshStorageCard();
    }

    let pendingDeleteId = null;
    let pendingDeleteKind = 'inspection';

    function openDeleteModal(id) {
      const list = loadInspections();
      const ins = list.find(i => i.id === id);
      if (!ins) {
        toast('Inspection not found');
        return;
      }
      pendingDeleteId = id;
      pendingDeleteKind = 'inspection';
      document.getElementById('deleteModalTitle').textContent = 'Delete inspection?';
      const modal = document.getElementById('deleteModal');
      document.getElementById('deleteModalLabel').textContent =
        'This inspection report will be permanently deleted.';
      modal.classList.remove('hidden');
      modal.classList.add('show');
      modal.setAttribute('aria-hidden', 'false');
    }


    function showDeleteConfirm(id, kind, title, label) {
      pendingDeleteId = id;
      pendingDeleteKind = kind || 'inspection';
      const titleEl = document.getElementById('deleteModalTitle');
      const labelEl = document.getElementById('deleteModalLabel');
      const modal = document.getElementById('deleteModal');
      if (titleEl) titleEl.textContent = title || 'Delete?';
      if (labelEl) labelEl.textContent = label || 'This cannot be undone.';
      if (!modal) { toast('Delete dialog missing'); return; }
      modal.classList.remove('hidden');
      modal.classList.add('show');
      modal.style.display = 'flex';
      modal.style.zIndex = '30000';
      modal.setAttribute('aria-hidden', 'false');
    }
    function closeDeleteModal() {
      pendingDeleteId = null;
      pendingDeleteKind = 'inspection';
      const modal = document.getElementById('deleteModal');
      modal.classList.add('hidden');
      modal.classList.remove('show');
      modal.style.display = '';
      modal.style.zIndex = '';
      modal.setAttribute('aria-hidden', 'true');
    }

    function performDeleteInspection(id) {
      if (!id) {
        toast('No inspection to delete');
        return;
      }
      const list = loadInspections();
      const before = list.length;
      const next = list.filter(i => i.id !== id);
      if (next.length === before) {
        toast('Inspection not found');
        closeDeleteModal();
        return;
      }
      saveInspections(next);

      // Verify write stuck
      const check = loadInspections();
      if (check.some(i => i.id === id)) {
        toast('Delete failed — storage error');
        return;
      }

      if (currentInspection && currentInspection.id === id) {
        currentInspection = null;
        results = {};
        findings = [];
      }
      editingInspectionId = null;
      document.getElementById('btnBeginInspection').textContent = 'Begin Inspection';
      const delBtn = document.getElementById('btnDeleteInspection');
      if (delBtn) delBtn.classList.add('hidden');

      closeDeleteModal();
      toast('Inspection deleted');
      showScreen('screenInspectList');
      setHeader('Inspections');
      refreshHome();
    }

    document.getElementById('btnDeleteInspection').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = editingInspectionId || (currentInspection && currentInspection.id);
      if (!id) {
        toast('No inspection to delete');
        return;
      }
      openDeleteModal(id);
    });

    document.getElementById('deleteModalCancel').addEventListener('click', (e) => {
      e.preventDefault();
      closeDeleteModal();
    });

    document.getElementById('deleteModalConfirm').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = pendingDeleteId;
      const kind = pendingDeleteKind;
      if (!id) {
        closeDeleteModal();
        return;
      }
      const run = (fn, arg) => {
        const impl = (typeof fn === 'function') ? fn : null;
        if (!impl) { toast('Delete failed'); closeDeleteModal(); return; }
        impl(arg);
      };
      if (kind === 'visit') run(window.performDeleteVisit || performDeleteVisit, id);
      else if (kind === 'job') run(window.performDeleteJob || performDeleteJob, id);
      else if (kind === 'punchlist-item') run(window.performDeletePunchlistItem || performDeletePunchlistItem, id);
      else if (kind === 'punchlist-photo') {
        const fn = window.removePhoto || removePhoto;
        if (typeof fn === 'function') fn();
        if (typeof closePunchlistPhoto === 'function') closePunchlistPhoto();
        closeDeleteModal();
        toast('Photo deleted');
      }
      else if (kind === 'punchlist') run(window.performDeletePunchlist || performDeletePunchlist, id);
      else if (kind === 'timecard') run(window.performDeleteTimecard, id);
      else if (kind === 'inspect-photo') run(window.performDeleteInspectPhoto || performDeleteInspectPhoto, id);
      else run(window.performDeleteInspection || performDeleteInspection, id);
    });

    // Tap backdrop to cancel
    document.getElementById('deleteModal').addEventListener('click', (e) => {
      if (e.target.id === 'deleteModal') closeDeleteModal();
    });

    function openInspection(id) {
      closeSearch();
      const list = loadInspections();
      const ins = list.find(i => i.id === id);
      if (!ins) return;
      currentInspection = ins;
      setActiveMachine(ins.model || 'LX-8');
      results = ins.results || {};
      findings = ins.findings || [];
      currentSectionIndex = Math.max(0, ins.currentSectionIndex || 0);
      currentItemIndex = Math.max(0, ins.currentItemIndex || 0);
      editingInspectionId = null;
      extraSectionTab = 'findings';
      showFindings();
    }

    function editInspectionMeta(id) {
      closeSearch();
      const list = loadInspections();
      const ins = list.find(i => i.id === id);
      if (!ins) return;
      editingInspectionId = id;
      currentInspection = ins;
      // Prefill form
      document.getElementById('inpCustomer').value = ins.customer || '';
      document.getElementById('inpModel').value = ins.model || 'LX-8';
      document.getElementById('inpSerial').value = ins.serial || '';
      document.getElementById('inpTechnician').value = ins.technician || profileName() || '';
      document.getElementById('inpDate').value = ins.date || new Date().toISOString().slice(0, 10);
      document.getElementById('inpPO').value = ins.po || '';
      // Autocomplete customers
      const customers = [...new Set(list.map(i => i.customer).filter(Boolean))];
      document.getElementById('customerList').innerHTML = customers.map(c => `<option value="${c}">`).join('');
      // Linked job chip
      linkedJobIdForStart = ins.jobId || null;
      fillInspectJobSelect(ins.jobId || '');
      const group = document.getElementById('jobLinkGroup');
      if (group) group.classList.remove('hidden');
      if (true) {
        document.getElementById('inpCustomer').value = ins.customer || '';
        document.getElementById('inpModel').value = ins.model || 'LX-8';
        document.getElementById('inpSerial').value = ins.serial || '';
        document.getElementById('inpTechnician').value = ins.technician || profileName() || '';
        document.getElementById('inpDate').value = ins.date || '';
        document.getElementById('inpPO').value = ins.po || '';
      } else {
        const group = document.getElementById('jobLinkGroup');
        if (group) group.classList.add('hidden');
      }
      // Update button label + show delete
      const btn = document.getElementById('btnBeginInspection');
      btn.textContent = 'Save Changes';
      document.getElementById('btnDeleteInspection').classList.remove('hidden');
      document.getElementById('exampleInspectCard').classList.add('hidden');
      showScreen('screenStart');
      setHeader('Edit Inspection');
    }

    // ========== START ==========
    function initStartForm() {
      // Always start blank for a new inspection
      document.getElementById('inpCustomer').value = '';
      document.getElementById('inpModel').value = 'LX-8';
      document.getElementById('inpSerial').value = '';
      document.getElementById('inpSerial').placeholder = 'Enter serial number';
      document.getElementById('inpTechnician').value = '';
      document.getElementById('inpDate').value = new Date().toISOString().slice(0, 10);
      document.getElementById('inpPO').value = '';
      linkedJobIdForStart = null;
      fillInspectJobSelect('');
      const group = document.getElementById('jobLinkGroup');
      if (group) group.classList.remove('hidden');
      // Autocomplete suggestions only (does not fill the fields)
      const list = loadInspections();
      const customers = [...new Set(list.map(i => i.customer).filter(Boolean))];
      document.getElementById('customerList').innerHTML = customers.map(c => `<option value="${c}">`).join('');
    }


    document.getElementById('btnLoadExampleInspection').addEventListener('click', () => {
      closeSearch();
      const exampleResults = {1:{condition:'N/A'},2:{condition:'N/A'},3:{condition:'N/A'},4:{condition:'N/A'},5:{condition:'N/A'},6:{condition:'Good'},7:{condition:'Fair',notes:'Belting is stretched.'},8:{condition:'Good'},9:{condition:'Good'},10:{condition:'Fair',notes:'Some wear but can be adjusted.'},11:{condition:'Fair',notes:'Missing 4 but not needed on clusters.'},12:{condition:'Pass'},13:{condition:'Good'},14:{condition:'Fair',notes:'Belting is stretched.'},15:{condition:'Fair'},16:{condition:'Good',impacts:['Performance']},17:{condition:'Poor',notes:'Both are worn. Infeed is worn a lot.',impacts:['Performance'],severity:2},18:{condition:'Good'},19:{condition:'Fair',notes:'Circuit breaker tripped.'},20:{condition:'Good'},21:{condition:'Good'},22:{condition:'Poor',notes:'Worn smooth, should replace.',impacts:['Performance'],severity:2},23:{condition:'Fair',notes:'Center support bushings gone.'},24:{condition:'Fair',notes:'Play in base, pin, and clevis.'},25:{condition:'Fair',notes:'Broken top corner, op side gate.'},26:{condition:'Good'},27:{condition:'Good'},28:{condition:'Good'},29:{condition:'Good'},30:{condition:'Pass'},31:{condition:'Fair',notes:'Belting new but lane guides have worn grooves in rubber grip top.'},32:{condition:'Good'},33:{condition:'Poor',notes:'Infeed nose bar worn and transition gap is large.',impacts:['Performance'],severity:2},34:{condition:'Good'},35:{condition:'Good'},36:{condition:'Pass'},37:{condition:'Pass'},38:{condition:'Pass',notes:'Blade break prox cable has been cut and taped back together.'},39:{condition:'Good'},40:{condition:'Fair',notes:'Guides showing wear. Mix of old and new belts. Belts should be replaced in sets.'},41:{condition:'Good'},42:{condition:'N/A'},43:{condition:'Good'},44:{condition:'Poor',notes:'Missing blade guides. Blade wipers are broken.',impacts:['Downtime', 'Performance'],severity:2},45:{condition:'Poor',notes:'Bearings are bad, need to be replaced.',impacts:['Downtime', 'Performance'],severity:2},46:{condition:'Fair',notes:'Idler pulley new, drive pulley is worn.'},47:{condition:'Good',notes:'One bad hub, LeMatic and maintenance replaced.'},48:{condition:'Pass'},49:{condition:'Good',notes:'We installed a new blade, old blade had a lot of crumb build up.'},50:{condition:'Good'},51:{condition:'Good'},52:{condition:'Pass'},53:{condition:'Good'},54:{condition:'Good'},55:{condition:'Poor',notes:'Missing tensioner assembly.',impacts:['Downtime', 'Performance'],severity:2},56:{condition:'Good'},57:{condition:'Within Spec'},58:{condition:'Good'},59:{condition:'Good'},60:{condition:'Good'},61:{condition:'N/A'},62:{condition:'Good'},63:{condition:'Good'},65:{condition:'Pass'},66:{condition:'Pass',notes:'Prox is ok but linkage is worn and turning off prox.'},67:{condition:'Poor',notes:'Linkage worn out and needs to be replaced.',impacts:['Downtime', 'Performance'],severity:2},68:{condition:'Good'},69:{condition:'Good'},70:{condition:'Good'},71:{condition:'Good'},72:{condition:'Pass'},73:{condition:'Good'},75:{condition:'Pass'},76:{condition:'Good'},77:{condition:'Good'},78:{condition:'Poor',notes:'Blades are very rusty.',severity:2},79:{condition:'Pass'},81:{condition:'Good'},82:{condition:'Good'},83:{condition:'Fair',notes:'Track is showing some wear.',impacts:['Downtime']},84:{condition:'Good'},85:{condition:'Within Spec'},86:{condition:'Within Spec'},87:{condition:'Good'},88:{condition:'Good'},90:{condition:'Pass'},91:{condition:'Pass'},92:{condition:'Good'},93:{condition:'Good'},94:{condition:'Pass'},95:{condition:'Good'},96:{condition:'Fair',notes:'Non op bagger guides missing bolts.',impacts:['Performance']},97:{condition:'Poor',notes:'Transfer grate is bent, should be replaced.',impacts:['Performance'],severity:2},98:{condition:'Fair',notes:'Friction top is worn smooth, buns may slide.'},99:{condition:'Good'},100:{condition:'Good'},101:{condition:'Pass'},102:{condition:'Good'},103:{condition:'Fair',notes:'Dead plate is slightly bent.'},104:{condition:'Fair',notes:'Some play in clevis.'},105:{condition:'Good'},106:{condition:'Fair',notes:'Brackets were bent, LeMatic and maintenance fixed.'},107:{condition:'Fair',notes:'Some play in clevis'},108:{condition:'Poor',notes:'Bearings feel tight.',impacts:['Downtime'],severity:2},109:{condition:'Good'},110:{condition:'Fail',notes:'Lower drive belt cover is missing',impacts:['Safety'],severity:2},111:{condition:'Fair'},112:{condition:'Fair',notes:'Lift screws slightly noisy needs a little lube.'},113:{condition:'Poor',notes:'Broken tab.',impacts:['Performance'],severity:2},114:{condition:'Good'},115:{condition:'Within Spec'},116:{condition:'Fair',notes:'Should be cleaned.'},117:{condition:'Good'},118:{condition:'Good'},119:{condition:'Good'},120:{condition:'Good'},121:{condition:'Fair',notes:'Belt is slightly old but ok.'},122:{condition:'Good'},123:{condition:'Good'},124:{condition:'Good'},125:{condition:'Good'},126:{condition:'Good'},127:{condition:'Good'},128:{condition:'Within Spec'},129:{condition:'Good'},130:{condition:'Good'},131:{condition:'Out of Spec',notes:'Timing belts are getting loose.',severity:2},132:{condition:'Good'},133:{condition:'Good'},134:{condition:'Good'},135:{condition:'Pass'}};
      currentInspection = {
        id: 'ins_example_orangeburg',
        jobId: (typeof SAMPLE_JOB_ID !== 'undefined' ? SAMPLE_JOB_ID : 'job_sample_demo'),
        customer: 'BBU Sample Bakery',
        site: 'Orangeburg',
        model: 'LX-8',
        serial: '44621019 Line 1',
        technician: 'Josh Denig',
        date: '2026-02-22',
        po: 'PO-DEMO-1001',
        status: 'Draft',
        results: exampleResults,
        findings: [],
        currentSectionIndex: 1,
        createdAt: new Date().toISOString(),
        overallCondition: 'Needs Attention',
        coverCards: [
          { tag: 'Safety', title: 'Missing elevator drive belt cover', body: 'Lower drive-belt cover is off. Put it on before Monday.' },
          { tag: 'Uptime', title: 'Hinge tensioners', body: 'All three lines. Line 2 is worst. Order the full assembly.' },
          { tag: 'Slice', title: 'Bottom-slicer linkage', body: 'Worn on all three. Order LH sleeves and clevises.' }
        ],
        summaryNotes: "The baggers are in much better condition now than they were a year ago. The bottom slicer linkage and the hinge slicer drive chain tensioners should be the immediate focus for improvement as both of those items can lead to a loss in efficiency and an increase in downtime.\n\nThe horizontal blades in the hinge slicer are the double notch design. They should be swapped for single notch blades as it is very easy to install blades incorrectly, this will lead to a poor slice and/or damage to the machine.\n\nBlade scrapers for the band slicers could increase the life of the blades and decrease down time due to blades coming off."
      };
      currentInspection.jobId = SAMPLE_JOB_ID;
      currentInspection.results = exampleResults;
      try { window.__SAMPLE_INSPECTION_FULL = JSON.parse(JSON.stringify(currentInspection)); } catch (e) {}
      results = exampleResults;
      findings = [];
      currentSectionIndex = 1;
      editingInspectionId = null;
      const list = loadInspections().filter(i => i.id !== currentInspection.id);
      list.unshift(currentInspection);
      saveInspections(list);
      updateFindings();
      currentInspection.findings = findings;
      saveCurrentDraft();
      renderSection(true);
      showScreen('screenInspect');
      toast('Orangeburg Line 1 example loaded');
    });

    document.getElementById('homeTileInspect').addEventListener('click', () => {
      closeSearch();
      showScreen('screenInspectList');
      setHeader('Inspections');
      refreshHome();
    });
    function getLastPunchlistName() {
      try {
        if (typeof lsRead === 'function') return lsRead('lx8_last_punchlist', '') || '';
        return localStorage.getItem('lx8_last_punchlist') || '';
      } catch (e) { return ''; }
    }
    function setLastPunchlistName(name) {
      if (!name) return;
      try {
        if (typeof lsWrite === 'function') lsWrite('lx8_last_punchlist', name);
        else localStorage.setItem('lx8_last_punchlist', name);
      } catch (e) {}
      try { window.__lastPunchlistName = name; } catch (e) {}
    }
    window.setLastPunchlistName = setLastPunchlistName;
    window.getLastPunchlistName = getLastPunchlistName;

    async function openPunchlistRecentList() {
      closeSearch();
      showScreen('screenPunchlistList');
      setHeader('Punchlist');
      if (typeof refreshPunchlistHome === 'function') await refreshPunchlistHome();
    }

    async function resumeLastPunchlistOrList() {
      closeSearch();
      const last = (getLastPunchlistName() || '').trim();
      if (last && typeof window.openPunchlistByName === 'function') {
        try {
          const rows = typeof window.getPunchlistSummaries === 'function'
            ? await window.getPunchlistSummaries()
            : [];
          const match = rows.find(r => r && (r.name === last || r.key === last || r.jobId === last));
          // Resume when the list exists and is "in progress":
          // empty (ready to capture) or has open items. If fully complete, show All lists.
          if (match) {
            const open = (match.total || 0) - (match.complete || 0);
            const inProgress = match.total === 0 || open > 0;
            if (inProgress) {
              await window.openPunchlistByName(last);
              showScreen('screenPunchlist');
              setHeader('Punchlist');
              if (typeof window.renderList === 'function') window.renderList();
              return;
            }
          }
        } catch (e) {
          console.warn(e);
        }
      }
      await openPunchlistRecentList();
    }

        const plList = document.getElementById('recentPunchlistList');
    if (plList && plList.dataset.editBound !== '1') {
      plList.dataset.editBound = '1';
      plList.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('[data-action="edit"]') : null;
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const card = btn.closest('.list-item');
        const name = card ? card.getAttribute('data-job-name') : '';
        if (name) openPunchlistLinkSheet(name);
      });
    }
    const plLinkSave = document.getElementById('plLinkJobSave');
    if (plLinkSave && plLinkSave.dataset.bound !== '1') {
      plLinkSave.dataset.bound = '1';
      plLinkSave.addEventListener('click', savePunchlistJobLink);
    }
    const plLinkCancel = document.getElementById('plLinkJobCancel');
    if (plLinkCancel && plLinkCancel.dataset.bound !== '1') {
      plLinkCancel.dataset.bound = '1';
      plLinkCancel.addEventListener('click', closePunchlistLinkSheet);
    }
    const plLinkView = document.getElementById('plLinkJobView');
    if (plLinkView && plLinkView.dataset.bound !== '1') {
      plLinkView.dataset.bound = '1';
      plLinkView.addEventListener('click', viewLinkedPunchlistJob);
    }
    document.getElementById('homeTilePunchlist').addEventListener('click', () => {
      resumeLastPunchlistOrList();
    });

    const btnHeaderPunchlist = document.getElementById('btnHeaderPunchlist');
    if (btnHeaderPunchlist) btnHeaderPunchlist.addEventListener('click', () => {
      openPunchlistRecentList();
    });
    const btnPunchlistAllLists = document.getElementById('btnPunchlistAllLists');
    if (btnPunchlistAllLists) btnPunchlistAllLists.addEventListener('click', () => {
      openPunchlistRecentList();
    });
    document.getElementById('homeTileJobs').addEventListener('click', () => {
      closeSearch();
      showScreen('screenJobsList');
      setHeader('Jobs');
      refreshJobsList();
    });
    document.getElementById('btnCancelJob').addEventListener('click', () => {
      editingJobId = null;
      document.getElementById('btnDeleteJob').classList.add('hidden');
      if (detailJobId && loadJobs().some(j => j.id === detailJobId)) {
        showScreen('screenJobDetail');
        setHeader('Job');
        refreshJobDetail();
      } else {
        showScreen('screenJobsList');
        setHeader('Jobs');
        refreshJobsList();
      }
    });
    document.getElementById('btnEditJobDetail').addEventListener('click', () => {
      if (detailJobId) openJob(detailJobId);
    });
    document.getElementById('btnJobStartInspection').addEventListener('click', () => startInspectionForDetailJob());
    document.getElementById('btnJobOpenPunchlist').addEventListener('click', () => startPunchlistForDetailJob());
    const completeJobBtn = document.getElementById('btnCompleteJob');
    if (completeJobBtn) completeJobBtn.addEventListener('click', () => { toggleJobComplete().catch(e => { console.error(e); toast('Could not update job'); }); });
    const jdInspectProgress = document.getElementById('jdProgressInspection');
    if (jdInspectProgress) jdInspectProgress.addEventListener('click', () => startInspectionForDetailJob());
    const jdPunchProgress = document.getElementById('jdProgressPunchlist');
    if (jdPunchProgress) jdPunchProgress.addEventListener('click', () => startPunchlistForDetailJob());
    const jdTimeProgress = document.getElementById('jdProgressTime');
    if (jdTimeProgress) jdTimeProgress.addEventListener('click', () => openTimeCards());

    const btnJobMachinePopup = document.getElementById('btnJobMachinePopup');
    if (btnJobMachinePopup) btnJobMachinePopup.addEventListener('click', () => {
      machineModalMode = 'job';
      openMachineModal();
    });
    const jobDatesCancel = document.getElementById('jobDatesCancel');
    if (jobDatesCancel) jobDatesCancel.addEventListener('click', closeHomeJobDatesEditor);
    const jobDatesSave = document.getElementById('jobDatesSave');
    if (jobDatesSave) jobDatesSave.addEventListener('click', saveHomeJobDates);
    const jobDatesModal = document.getElementById('jobDatesModal');
    if (jobDatesModal) jobDatesModal.addEventListener('click', (e) => {
      if (e.target.id === 'jobDatesModal') closeHomeJobDatesEditor();
    });
    const machineCancel = document.getElementById('machineModalCancel');
    if (machineCancel) machineCancel.addEventListener('click', () => {
      machineModalMode = 'job';
      closeMachineModal();
    });
    const machineDone = document.getElementById('machineModalDone');
    if (machineDone) machineDone.addEventListener('click', () => {
      if (machineModalMode === 'startInspect') {
        startInspectionFromMachinePopup();
        return;
      }
      closeMachineModal();
    });
    const machineModal = document.getElementById('machineModal');
    if (machineModal) machineModal.addEventListener('click', (e) => {
      if (e.target.id === 'machineModal') closeMachineModal();
    });
    const addSerialBtn = document.getElementById('btnAddJobSerial');
    if (addSerialBtn) addSerialBtn.addEventListener('click', addJobSerialFromInput);
    const serialInp = document.getElementById('jobSerialInput');
    if (serialInp) serialInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addJobSerialFromInput(); }
    });
    const jobSerialSel = document.getElementById('inspectSerialSelect');
    if (jobSerialSel) {
      jobSerialSel.addEventListener('change', () => {
        const custom = document.getElementById('inspectSerialInput');
        if (!custom) return;
        if (jobSerialSel.value === '__other') {
          custom.classList.remove('hidden');
          custom.focus();
        } else {
          custom.classList.add('hidden');
          custom.value = '';
        }
        updateJobMachineSummary();
      });
    }
    const inspectMachineSel = document.getElementById('inspectMachine');
    if (inspectMachineSel) {
      inspectMachineSel.addEventListener('change', () => {
        const custom = document.getElementById('inspectMachineCustom');
        if (!custom) return;
        if (inspectMachineSel.value === '__other') {
          custom.classList.remove('hidden');
          custom.focus();
        } else {
          custom.classList.add('hidden');
          custom.value = '';
        }
      });
    }
    const jobMachineSel = document.getElementById('jobMachine');
    if (jobMachineSel) {
      jobMachineSel.addEventListener('change', () => {
        const custom = document.getElementById('jobMachineCustom');
        if (!custom) return;
        if (jobMachineSel.value === '__other') {
          custom.classList.remove('hidden');
          custom.focus();
        } else {
          custom.classList.add('hidden');
          custom.value = '';
        }
        updateJobMachineSummary();
      });
    }
    document.getElementById('btnSaveJob').addEventListener('click', () => saveJobFromForm());
    document.getElementById('btnDeleteJob').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      deleteJobCurrent();
    });

    // ========== JOB LINKING (inspections + punchlist) ==========
    let pendingJobPickPurpose = null; // 'inspection' | 'punchlist'
    let linkedJobIdForStart = null;


    function newEntityId(prefix) {
      return String(prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
    function isInternalId(value) {
      return /^(job|ins|pl|tc|vis|bakery|machine)_/i.test(String(value || '').trim());
    }
    function slugId(prefix, text) {
      const s = String(text || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
      return s ? (prefix + '_' + s) : '';
    }
    function bakeryIdFromJob(job) {
      if (!job) return '';
      return job.bakeryId || slugId('bakery', job.customer || job.site || '');
    }
    function machineIdFromSerial(serial) {
      return slugId('machine', serial);
    }
    function ensureJobIdentity(job) {
      if (!job || typeof job !== 'object') return job;
      if (!job.id || !isInternalId(job.id)) job.id = newEntityId('job');
      if (!job.bakeryId) job.bakeryId = bakeryIdFromJob(job);
      const serials = Array.isArray(job.serials) ? job.serials : (job.serial ? [job.serial] : []);
      job.serials = serials.filter(Boolean);
      job.machineIds = job.serials.map(machineIdFromSerial).filter(Boolean);
      if (!job.createdAt) job.createdAt = new Date().toISOString();
      return job;
    }
    function ensureJobsIdentities(list) {
      const out = (list || []).map(ensureJobIdentity);
      return out;
    }
    function jobById(id) {
      if (!id) return null;
      return (loadJobs() || []).find(j => j && j.id === id) || null;
    }
    function jobDisplayName(job) {
      if (!job) return 'Job';
      const customer = String(job.customer || '').trim();
      const site = String(job.site || '').trim();
      const label = site ? ((customer || 'Job') + ' – ' + site) : (customer || 'Job');
      return isInternalId(label) ? 'Job' : label;
    }

    function jobSubLine(job) {
      if (!job) return '';
      const parts = [];
      if (job.technician) parts.push(job.technician);
      const range = formatJobDateRange(job);
      if (range) parts.push(range);
      if (job.status) parts.push(job.status);
      return parts.join(' · ');
    }

    function punchlistKeyForJob(job) {
      if (!job) return '';
      ensureJobIdentity(job);
      return job.id;
    }
    function punchlistDisplayName(keyOrJob) {
      if (!keyOrJob) return 'Punchlist';
      if (typeof keyOrJob === 'object') return jobDisplayName(keyOrJob);
      const key = String(keyOrJob);
      try {
        if (typeof window.getPunchlistName === 'function') {
          const named = window.getPunchlistName(key);
          if (named && !isInternalId(named)) return named;
        }
      } catch (e) {}
      if (!isInternalId(key)) return key;
      const job = jobById(key);
      if (job) return jobDisplayName(job);
      return 'Punchlist';
    }

    function ensurePunchlistBucketForJob(job) {
      if (!job) return;
      if (!data) data = { jobs: {}, currentJob: '' };
      if (!data.jobs) data.jobs = {};
      const key = punchlistKeyForJob(job);
      if (!data.jobs[key]) data.jobs[key] = [];
      data.currentJob = key;
      if (!data.jobIdByKey) data.jobIdByKey = {};
      data.jobIdByKey[key] = job.id;
      if (!data.keyByJobId) data.keyByJobId = {};
      data.keyByJobId[job.id] = key;
      if (typeof plSaveData === 'function') plSaveData();
      if (typeof populateJobSelect === 'function') populateJobSelect();
      return key;
    }

    function closeJobPicker() {
      pendingJobPickPurpose = null;
      const modal = document.getElementById('jobPickerModal');
      if (!modal) return;
      modal.classList.add('hidden');
      modal.classList.remove('show');
      modal.setAttribute('aria-hidden', 'true');
    }

    function openJobPicker(purpose) {
      const jobs = (typeof loadJobs === 'function' ? loadJobs() : []) || [];
      pendingJobPickPurpose = purpose;
      const modal = document.getElementById('jobPickerModal');
      const listEl = document.getElementById('jobPickerList');
      const title = document.getElementById('jobPickerTitle');
      if (!modal || !listEl) return;

      title.textContent = purpose === 'punchlist' ? 'Select Job for Punchlist' : 'Select Job for Inspection';

      const skipLabel = purpose === 'punchlist' ? 'Continue without a job' : 'Continue without a job';
      const skipSub = purpose === 'punchlist'
        ? 'Start a punchlist not linked to a job'
        : 'Enter customer details manually';
      let html = '';
      if (!jobs.length) {
        html += `<div class="job-picker-empty">No jobs yet.<br>You can continue without one, or create a job first.</div>`;
      } else {
        const sorted = jobs.slice().sort((a, b) => String(b.date || b.createdAt || '').localeCompare(String(a.date || a.createdAt || '')));
        html += sorted.map(job => {
          const sub = jobSubLine(job);
          return `<button type="button" class="job-picker-item" data-job-id="${jobEsc(job.id)}">
            <span class="jp-title">${jobEsc(jobDisplayName(job))}</span>
            ${sub ? `<span class="jp-sub">${jobEsc(sub)}</span>` : ''}
          </button>`;
        }).join('');
      }
      html += `<button type="button" class="job-picker-item job-picker-skip" data-job-id="__none__">
        <span class="jp-title">${skipLabel}</span>
        <span class="jp-sub">${skipSub}</span>
      </button>`;
      listEl.innerHTML = html;
      listEl.querySelectorAll('[data-job-id]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-job-id');
          onJobPicked(id);
        });
      });

      modal.classList.remove('hidden');
      modal.classList.add('show');
      modal.setAttribute('aria-hidden', 'false');
    }

    function fillInspectJobSelect(selectedId) {
      const sel = document.getElementById('inspectJobSelect');
      if (!sel) return;
      if (typeof tcJobOptionsHtml === 'function') {
        sel.innerHTML = tcJobOptionsHtml(selectedId || '');
      } else {
        const jobs = (typeof loadJobs === 'function' ? loadJobs() : []) || [];
        let html = '<option value="">— No job —</option>';
        jobs.forEach(j => {
          if (!j || !j.id) return;
          const label = (typeof jobDisplayName === 'function') ? jobDisplayName(j) : (j.customer || 'Job');
          const selAttr = selectedId && selectedId === j.id ? ' selected' : '';
          html += '<option value="' + String(j.id).replace(/"/g, '&quot;') + '"' + selAttr + '>' + String(label).replace(/</g, '&lt;') + '</option>';
        });
        sel.innerHTML = html;
      }
      sel.disabled = false;
      sel.removeAttribute('disabled');
      if (selectedId) {
        sel.value = selectedId;
        if (sel.value !== selectedId) {
          const opt = document.createElement('option');
          opt.value = selectedId;
          opt.textContent = 'Current job';
          opt.selected = true;
          sel.appendChild(opt);
          sel.value = selectedId;
        }
      }
    }
    function applyJobToInspectionForm(job) {
      linkedJobIdForStart = job ? job.id : null;
      const group = document.getElementById('jobLinkGroup');
      if (group) group.classList.remove('hidden');
      fillInspectJobSelect(job ? job.id : (linkedJobIdForStart || ''));
      if (job) {
        const cust = document.getElementById('inpCustomer');
        const tech = document.getElementById('inpTechnician');
        const date = document.getElementById('inpDate');
        const po = document.getElementById('inpPO');
        if (cust && !cust.value) cust.value = job.customer || '';
        if (tech && !tech.value) tech.value = job.technician || ((typeof profileName === 'function') ? profileName() : '') || '';
        if (date && !date.value) date.value = job.date || new Date().toISOString().slice(0, 10);
        if (po && !po.value) po.value = job.po || '';
        if (job.site && document.getElementById('inpSerial') && !document.getElementById('inpSerial').value) {
          document.getElementById('inpSerial').placeholder = job.site;
        }
      }
    }
    (function bindInspectJobSelect() {
      const sel = document.getElementById('inspectJobSelect');
      if (!sel || sel.dataset.bound === '1') return;
      sel.dataset.bound = '1';
      sel.addEventListener('change', () => {
        const id = sel.value || '';
        linkedJobIdForStart = id || null;
        if (!id) return;
        const job = (typeof loadJobs === 'function' ? loadJobs() : []).find(j => j && j.id === id);
        if (!job) return;
        const cust = document.getElementById('inpCustomer');
        if (cust) cust.value = job.customer || cust.value;
        const tech = document.getElementById('inpTechnician');
        if (tech && !tech.value) tech.value = job.technician || ((typeof profileName === 'function') ? profileName() : '') || '';
        const model = document.getElementById('inpModel');
        if (model && job.machine) model.value = job.machine;
      });
    })();

    async function onJobPicked(jobId) {
      const purpose = pendingJobPickPurpose;
      const skip = !jobId || jobId === '__none__';
      const job = skip ? null : loadJobs().find(j => j.id === jobId);
      if (!skip && !job) {
        toast('Job not found');
        closeJobPicker();
        return;
      }
      closeJobPicker();

      if (purpose === 'inspection') {
        currentInspection = null;
        editingInspectionId = null;
        results = {};
        findings = [];
        currentSectionIndex = 0;
        document.getElementById('btnBeginInspection').textContent = 'Begin Inspection';
        document.getElementById('btnDeleteInspection').classList.add('hidden');

        // Linked job: start inspection immediately (edit details later from card)
        if (job) {
          const model = 'LX-8';
          setActiveMachine(model);
          currentInspection = {
            id: 'ins_' + Date.now(),
            customer: job.customer || '',
            model,
            serial: (job.site || '').trim() || 'TBD',
            technician: job.technician || profileName() || '',
            date: job.date || new Date().toISOString().slice(0, 10),
            po: job.po || '',
            jobId: job.id,
            status: 'Draft',
            results: {},
            findings: [],
            currentSectionIndex: 0,
            createdAt: new Date().toISOString()
          };
          linkedJobIdForStart = null;
          saveCurrentDraft();
          renderSection();
          showScreen('screenInspect');
          setHeader('Inspecting');
          toast('Inspection started — ' + jobDisplayName(job));
          return;
        }

        // No job: show manual start form
        initStartForm();
        applyJobToInspectionForm(null);
        document.getElementById('exampleInspectCard').classList.remove('hidden');
        showScreen('screenStart');
        setHeader('New Inspection');
        return;
      }

      if (purpose === 'punchlist') {
        try {
          if (typeof window.openPunchlistForJob !== 'function') {
            toast('Punchlist not ready');
            return;
          }
          const label = await window.openPunchlistForJob(job || null);
          showScreen('screenPunchlist');
          setHeader('Punchlist');
          if (typeof window.renderList === 'function') window.renderList();
          toast(job ? ('Punchlist: ' + jobDisplayName(job)) : 'Punchlist (no job)');
        } catch (err) {
          console.error(err);
          toast('Could not open punchlist');
        }
      }
    }

    document.getElementById('jobPickerCancel').addEventListener('click', () => closeJobPicker());
    document.getElementById('jobPickerGoJobs').addEventListener('click', () => {
      closeJobPicker();
      showScreen('screenJobsList');
      setHeader('Jobs');
      if (typeof refreshJobsList === 'function') refreshJobsList();
    });

    document.getElementById('jobPickerModal').addEventListener('click', (e) => {
      if (e.target.id === 'jobPickerModal') closeJobPicker();
    });


    const btnBackupZip = document.getElementById('btnBackupZip');
    const btnRestoreZip = document.getElementById('btnRestoreZip');
    const restoreZipInput = document.getElementById('restoreZipInput');
    if (btnBackupZip) btnBackupZip.addEventListener('click', () => exportBackupZip());
    if (btnRestoreZip) btnRestoreZip.addEventListener('click', () => restoreZipInput && restoreZipInput.click());
    if (restoreZipInput) restoreZipInput.addEventListener('change', ev => {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (file) importBackupZip(file);
    });

    function getActiveCurrentJob() {
      const list = (typeof getCurrentJobs === 'function') ? getCurrentJobs() : [];
      return (list && list[0]) || null;
    }
    function startInspectionForJob(job) {
      pendingInspectJobId = job ? job.id : null;
      currentInspection = null;
      editingInspectionId = null;
      results = {};
      findings = [];
      currentSectionIndex = 0;
      const beginBtn = document.getElementById('btnBeginInspection');
      if (beginBtn) beginBtn.textContent = 'Begin Inspection';
      const delBtn = document.getElementById('btnDeleteInspection');
      if (delBtn) delBtn.classList.add('hidden');
      if (job) applyJobToInspectionForm(job);
      else applyJobToInspectionForm(null);
      const model = (job && job.machine) || 'LX-8';
      const modelEl = document.getElementById('inpModel');
      if (modelEl) modelEl.value = model;
      jobSerialsDraft = (job && Array.isArray(job.serials)) ? job.serials.slice() : [];
      if (typeof fillInspectionSerialOptions === 'function' && job) fillInspectionSerialOptions(job);
      machineModalMode = 'startInspect';
      const title = document.getElementById('machineModalTitle');
      const done = document.getElementById('machineModalDone');
      if (title) title.textContent = 'Link job';
      if (done) done.textContent = 'Start inspection';
      if (typeof populateInspectJobSelect === 'function') populateInspectJobSelect(job && job.id);
      if (typeof setInspectMachineFields === 'function') setInspectMachineFields(model);
      if (typeof populateJobSerialSelect === 'function') populateJobSerialSelect(jobSerialsDraft, jobSerialsDraft[0] || '');
      openMachineModal();
      toast('Select a job, machine, and serial to start inspection');
    }
    function fillPunchlistStartJobSelect(selectedId) {
      const sel = document.getElementById('plStartJob');
      if (!sel) return;
      let jobs = [];
      try {
        jobs = (typeof inspectJobsSource === 'function') ? inspectJobsSource() : ((typeof loadJobs === 'function' ? loadJobs() : []) || []);
      } catch (e) {
        jobs = (typeof loadJobs === 'function' ? loadJobs() : []) || [];
      }
      jobs.forEach(j => { try { if (typeof ensureJobIdentity === 'function') ensureJobIdentity(j); } catch (e) {} });
      const current = String(selectedId || '');
      function labelOf(j) {
        try {
          const n = (typeof jobDisplayName === 'function') ? jobDisplayName(j) : '';
          if (n && String(n).trim() && n !== 'Job') return String(n);
        } catch (e) {}
        return j.customer || j.site || 'Untitled job';
      }
      const sorted = jobs.filter(j => j && j.id).slice().sort((a, b) => String(b.date || b.createdAt || '').localeCompare(String(a.date || a.createdAt || '')));
      sel.innerHTML = '<option value="">Select job</option>' + sorted.map(j => {
        const id = String(j.id);
        const selAttr = current && current === id ? ' selected' : '';
        return '<option value="' + id.replace(/"/g,'&quot;') + '"' + selAttr + '>' + labelOf(j).replace(/</g,'&lt;') + '</option>';
      }).join('');
      if (current && sorted.some(j => String(j.id) === current)) sel.value = current;
    }
    function openPunchlistStartSheet(job) {
      const sheet = document.getElementById('plStartSheet');
      if (!sheet) { toast('Punchlist sheet missing'); return; }
      const nameEl = document.getElementById('plStartName');
      if (nameEl) nameEl.value = '';
      fillPunchlistStartJobSelect(job && job.id);
      sheet.classList.remove('hidden');
      sheet.classList.add('show');
      sheet.setAttribute('aria-hidden', 'false');
    }
    function closePunchlistStartSheet() {
      const sheet = document.getElementById('plStartSheet');
      if (!sheet) return;
      sheet.classList.add('hidden');
      sheet.classList.remove('show');
      sheet.setAttribute('aria-hidden', 'true');
    }
    async function confirmPunchlistStart() {
      const nameEl = document.getElementById('plStartName');
      let name = ((nameEl && nameEl.value) || '').trim() || 'Punchlist';
      if (typeof isInternalId === 'function' && isInternalId(name)) { toast('Choose a different name'); return; }
      const jobId = (document.getElementById('plStartJob') && document.getElementById('plStartJob').value) || '';
      const jobs = (typeof loadJobs === 'function' ? loadJobs() : []) || [];
      const job = jobId ? (jobs.find(j => j && String(j.id) === String(jobId)) || null) : null;
      if (typeof window.createPunchlistForJob !== 'function') { toast('Punchlist not ready'); return; }
      const key = await window.createPunchlistForJob(job || null);
      if (typeof window.updatePunchlistMeta === 'function') await window.updatePunchlistMeta(key, name, jobId);
      closePunchlistStartSheet();
      if (typeof window.openPunchlistByName === 'function') await window.openPunchlistByName(key);
      showScreen('screenPunchlist');
      setHeader('Punchlist');
      if (typeof window.populateJobSelect === 'function') window.populateJobSelect();
      if (typeof window.renderList === 'function') window.renderList();
    }
    function startPunchlistForCurrentJob(job) {
      openPunchlistStartSheet(job || null);
    }
    document.getElementById('btnNewInspection').addEventListener('click', () => {
      closeSearch();
      const current = (typeof getActiveCurrentJob === 'function') ? getActiveCurrentJob() : null;
      startInspectionForJob(current || null);
    });
    
    (function bindPunchlistEditUi() {
      const save = document.getElementById('plEditSave');
      const cancel = document.getElementById('plEditCancel');
      const rename = document.getElementById('btnRenamePunchlist');
      if (save && save.dataset.bound !== '1') {
        save.dataset.bound = '1';
        save.addEventListener('click', () => { savePunchlistEdit().catch(err => { console.error(err); toast('Could not save'); }); });
      }
      if (cancel && cancel.dataset.bound !== '1') {
        cancel.dataset.bound = '1';
        cancel.addEventListener('click', cancelPunchlistEdit);
      }
      const delPl = document.getElementById('plEditDelete');
      if (delPl && delPl.dataset.bound !== '1') {
        delPl.dataset.bound = '1';
        delPl.addEventListener('click', (e) => {
          e.preventDefault();
          requestDeletePunchlist();
        });
      }
      if (rename && rename.dataset.bound !== '1') {
        rename.dataset.bound = '1';
        rename.addEventListener('click', () => {
          const key = (typeof window.getCurrentPunchlistKey === 'function') ? window.getCurrentPunchlistKey() : '';
          if (!key) { toast('No punchlist'); return; }
          openPunchlistEdit(key, { isNew: false });
        });
      }
    })();

        (function bindPunchlistStartSheet() {
      const done = document.getElementById('plStartDone');
      const cancel = document.getElementById('plStartCancel');
      const sheet = document.getElementById('plStartSheet');
      if (done && done.dataset.bound !== '1') {
        done.dataset.bound = '1';
        done.addEventListener('click', () => { confirmPunchlistStart().catch(err => { console.error(err); toast('Could not create punchlist'); }); });
      }
      if (cancel && cancel.dataset.bound !== '1') {
        cancel.dataset.bound = '1';
        cancel.addEventListener('click', closePunchlistStartSheet);
      }
      if (sheet && sheet.dataset.bound !== '1') {
        sheet.dataset.bound = '1';
        sheet.addEventListener('click', (e) => { if (e.target.id === 'plStartSheet') closePunchlistStartSheet(); });
      }
    })();
    document.getElementById('btnNewPunchlist').addEventListener('click', () => {
      try { if (typeof closeSearch === 'function') closeSearch(); } catch (e) {}
      try {
        const job = (typeof getActiveCurrentJob === 'function') ? getActiveCurrentJob() : null;
        openPunchlistStartSheet(job || null);
      } catch (err) {
        console.error(err);
        toast('Could not open punchlist');
      }
    });


    document.getElementById('btnCancelStart').addEventListener('click', () => {
      editingInspectionId = null;
      document.getElementById('btnBeginInspection').textContent = 'Begin Inspection';
      document.getElementById('btnDeleteInspection').classList.add('hidden');
      showScreen('screenInspectList');
      setHeader('Inspections');
      refreshHome();
    });

    document.getElementById('btnBeginInspection').addEventListener('click', () => {
      const customer = document.getElementById('inpCustomer').value.trim();
      const serial = document.getElementById('inpSerial').value.trim();
      const tech = document.getElementById('inpTechnician').value.trim();
      if (!customer || !serial || !tech) {
        toast('Please fill Customer, Serial # and Technician');
        return;
      }
      if (linkedJobIdForStart) rememberJobSerial(linkedJobIdForStart, serial);
      const model = document.getElementById('inpModel').value.trim() || 'LX-8';
      setActiveMachine(model);
      const date = document.getElementById('inpDate').value;
      const po = document.getElementById('inpPO').value.trim();

      // Edit existing inspection metadata
      if (editingInspectionId) {
        const list = loadInspections();
        const idx = list.findIndex(i => i.id === editingInspectionId);
        if (idx < 0) {
          toast('Inspection not found');
          return;
        }
        list[idx].customer = customer;
        list[idx].model = model;
        list[idx].serial = serial;
        list[idx].technician = tech;
        list[idx].date = date;
        list[idx].po = po;
        const jobSel = document.getElementById('inspectJobSelect');
        const pickedJob = (jobSel && jobSel.value) ? jobSel.value : (linkedJobIdForStart || null);
        list[idx].jobId = pickedJob || null;
        linkedJobIdForStart = pickedJob || null;
        list[idx].updatedAt = new Date().toISOString();
        saveInspections(list);
        currentInspection = list[idx];
        editingInspectionId = null;
        document.getElementById('btnBeginInspection').textContent = 'Begin Inspection';
        document.getElementById('btnDeleteInspection').classList.add('hidden');
        toast('Inspection details updated');
        showScreen('screenInspectList');
        setHeader('Inspections');
        refreshHome();
        return;
      }

      // Create new inspection
      currentInspection = {
        id: 'ins_' + Date.now(),
        customer,
        model,
        serial,
        technician: tech,
        date,
        po,
        jobId: (document.getElementById('inspectJobSelect') && document.getElementById('inspectJobSelect').value) || linkedJobIdForStart || null,
        status: 'Draft',
        results: {},
        findings: [],
        currentSectionIndex: 0,
        createdAt: new Date().toISOString()
      };
      linkedJobIdForStart = null;
      results = {};
      findings = [];
      currentSectionIndex = 0;
      saveCurrentDraft();
      renderSection();
      showScreen('screenInspect');
      setHeader('Inspecting');
      toast('Inspection started');
    });

    // ========== INSPECTION ==========
    function getItemsForSection(sectionId) {
      const items = (APP_DATA && APP_DATA.items) || [];
      return items
        .filter(i => i.section_id === sectionId)
        .sort((a, b) => a.item_order_in_section - b.item_order_in_section);
    }

    function shortSectionName(name) {
      // Keep names readable but compact for the horizontal scroller
      const map = {
        'Spread Conveyor': 'Spread Conv.',
        'Accumulating Conveyor': 'Accum. Conv.',
        'Grouper Section': 'Grouper',
        'Slicing Conveyor': 'Slicing Conv.',
        'Band Slicer': 'Band Slicer',
        'Hinge Slicer': 'Hinge Slicer',
        'Bottom Slicer': 'Bottom Slicer',
        'Top Slicer': 'Top Slicer',
        'Cross-Over Conveyor': 'Cross-Over',
        'Bagger': 'Bagger',
        'Over Head Paddle Conveyor': 'Paddle Conv.',
        'Tying Conveyor': 'Tying Conv.'
      };
      return map[name] || name;
    }

    function renderSectionDots(scrollToCurrent) {
      const container = document.getElementById('sectionDots');
      if (!container || !APP_DATA || !APP_DATA.sections) return;
      const inspectCurrent = extraSectionTab == null;
      let html = APP_DATA.sections.map((s, idx) => {
        let cls = 'section-dot';
        if (idx < currentSectionIndex) cls += ' done';
        if (inspectCurrent && idx === currentSectionIndex) cls += ' current';
        const sectionItems = getItemsForSection(s.section_id);
        const hasFinding = sectionItems.some(it => {
          const r = results[it.item_id];
          return r && isBadResult(it, r.condition);
        });
        if (hasFinding) cls += ' has-findings';
        const label = shortSectionName(s.section);
        return `<div class="${cls}" data-idx="${idx}" title="${s.section}">${label}</div>`;
      }).join('');
      html = `<div class="section-dot${extraSectionTab === 'findings' ? ' current' : ''}" data-extra="findings">Home</div>` + html;
      container.innerHTML = html;
      container.querySelectorAll('.section-dot').forEach(d => {
        d.addEventListener('click', () => {
          if (d.dataset.extra === 'findings') {
            extraSectionTab = 'findings';
            if (currentInspection) saveCurrentDraft();
            updateFindings();
            showFindings();
            return;
          }
          if (d.dataset.extra === 'notes') {
            extraSectionTab = 'notes';
            if (currentInspection) {
              saveCurrentDraft();
              if (!document.getElementById('summaryNotes').value && currentInspection.summaryNotes) {
                setNotesContent(currentInspection.summaryNotes);
              }
            }
            notesSource = 'inspection';
            showFindings();
            setHeader('Inspection');
            requestAnimationFrame(() => {
              const el = document.getElementById('inspectNotesSection');
              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            return;
          }
          extraSectionTab = null;
          const tapped = parseInt(d.dataset.idx, 10);
          if (tapped === currentSectionIndex && document.getElementById('screenInspect').classList.contains('active')) {
            inspectListMode = !inspectListMode;
            saveCurrentDraft();
            renderSection(false);
            return;
          }
          inspectListMode = false;
          currentSectionIndex = tapped;
          currentItemIndex = 0;
          showScreen('screenInspect');
          renderSection(true);
        });
      });
      // Only auto-scroll the dots bar when changing sections intentionally
      if (scrollToCurrent) {
        const current = container.querySelector('.section-dot.current');
        if (current) current.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }
    }

    function isBadResult(item, value) {
      if (!value) return false;
      const bad = (item.photo_required_if || '').toLowerCase();
      return value.toLowerCase() === bad ||
        (item.inspection_type === 'Condition' && (value === 'Poor' || value === 'Damaged')) ||
        (item.inspection_type === 'Functional' && value === 'Fail') ||
        (item.inspection_type === 'Measurement' && value === 'Out of Spec');
    }

    function isFairResult(value) {
      return value === 'Fair';
    }

    function showsFindingPanel(item, value) {
      return isBadResult(item, value) || isFairResult(value);
    }
    function isCleanResult(item, value) {
      if (!value) return false;
      return !showsFindingPanel(item, value);
    }
    function preferredGoodChoice(item) {
      const choices = String(item.choices || '').split('|').map(s => s.trim()).filter(Boolean);
      const prefer = ['Good','Pass','Within Spec','OK','Yes'];
      for (const p of prefer) {
        const hit = choices.find(c => c.toLowerCase() === p.toLowerCase());
        if (hit) return hit;
      }
      return choices.find(c => !showsFindingPanel(item, c)) || '';
    }
    function preferredNAChoice(item) {
      const choices = String(item.choices || '').split('|').map(s => s.trim()).filter(Boolean);
      const hit = choices.find(c => c.toLowerCase() === 'n/a' || c.toLowerCase() === 'na');
      return hit || 'N/A';
    }
    function markRestOfSectionGood() {
      if (!APP_DATA || !APP_DATA.sections) return;
      const section = APP_DATA.sections[currentSectionIndex];
      if (!section) return;
      const items = getItemsForSection(section.section_id);
      let n = 0;
      items.forEach(item => {
        const val = preferredNAChoice(item);
        results[item.item_id] = Object.assign({}, results[item.item_id] || {}, { condition: val });
        delete results[item.item_id].impacts;
        delete results[item.item_id].notes;
        delete results[item.item_id].severity;
        n += 1;
      });
      updateFindings();
      saveCurrentDraft();
      const left = currentSectionItems().findIndex(it => !results[it.item_id] || !results[it.item_id].condition);
      currentItemIndex = left >= 0 ? left : Math.max(0, currentSectionItems().length - 1);
      renderSection(false);
      toast(n ? ('Section marked N/A') : 'Nothing to mark');
    }
    function scrollToNextOpenItem(afterId) {
      goToNextInspectItem();
    }
    function currentSectionItems() {
      if (!APP_DATA || !APP_DATA.sections || !APP_DATA.sections[currentSectionIndex]) return [];
      return getItemsForSection(APP_DATA.sections[currentSectionIndex].section_id);
    }
    function animateInspectOut(dir, then) {
      if (inspectListMode) { then(); return; }
      const card = document.querySelector('#itemsContainer .item-card');
      if (!card) { then(); return; }
      card.classList.remove('inspect-in-left', 'inspect-in-right');
      void card.offsetWidth;
      card.classList.add(dir === 'next' ? 'inspect-out-left' : 'inspect-out-right');
      let done = false;
      const finish = () => { if (done) return; done = true; then(); };
      card.addEventListener('transitionend', finish, { once: true });
      setTimeout(finish, 560);
    }
    function goToNextInspectItem() {
      if (inspectListMode) {
        inspectListMode = false;
        saveCurrentDraft();
        renderSection(false);
        return;
      }
      const items = currentSectionItems();
      animateInspectOut('next', () => {
        inspectSlideDir = 'next';
        if (currentItemIndex < items.length - 1) {
          currentItemIndex += 1;
          saveCurrentDraft();
          renderSection(false);
          window.scrollTo(0, 0);
          return;
        }
        if (currentSectionIndex < APP_DATA.sections.length - 1) {
          currentSectionIndex += 1;
          currentItemIndex = 0;
          saveCurrentDraft();
          renderSection(true);
          window.scrollTo(0, 0);
          return;
        }
        updateFindings();
        saveCurrentDraft();
        showFindings();
      });
    }

    let inspectSwipeX = 0, inspectSwipeY = 0, inspectSwipeOn = false;
    function bindInspectSwipe(container) {
      if (!container || container.dataset.swipeBound === '1') return;
      container.dataset.swipeBound = '1';
      const start = (x, y) => { inspectSwipeOn = true; inspectSwipeX = x; inspectSwipeY = y; };
      const end = (x, y) => {
        if (!inspectSwipeOn) return;
        inspectSwipeOn = false;
        const dx = x - inspectSwipeX;
        const dy = y - inspectSwipeY;
        if (inspectListMode) return;
        if (Math.abs(dx) < 56) return;
        if (Math.abs(dx) < Math.abs(dy) * 1.15) return;
        if (dx < 0) goToNextInspectItem();
        else goToPrevInspectItem();
      };
      container.addEventListener('touchstart', (e) => {
        if (!e.changedTouches || !e.changedTouches[0]) return;
        start(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
      }, { passive: true });
      container.addEventListener('touchend', (e) => {
        if (!e.changedTouches || !e.changedTouches[0]) return;
        end(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
      }, { passive: true });
      container.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        start(e.clientX, e.clientY);
      });
      container.addEventListener('pointerup', (e) => end(e.clientX, e.clientY));
    }
    function goToPrevInspectItem() {
      if (inspectListMode) {
        inspectListMode = false;
        saveCurrentDraft();
        renderSection(false);
        return;
      }
      animateInspectOut('prev', () => {
        inspectSlideDir = 'prev';
        if (currentItemIndex > 0) {
          currentItemIndex -= 1;
          saveCurrentDraft();
          renderSection(false);
          window.scrollTo(0, 0);
          return;
        }
        if (currentSectionIndex > 0) {
          currentSectionIndex -= 1;
          const prevItems = currentSectionItems();
          currentItemIndex = Math.max(0, prevItems.length - 1);
          saveCurrentDraft();
          renderSection(true);
          window.scrollTo(0, 0);
        }
      });
    }

    function choiceTone(value) {
      const v = (value || '').toLowerCase();
      if (v === 'n/a') return 'na';
      if (v === 'good' || v === 'pass' || v === 'within spec') return 'good';
      if (v === 'fair') return 'fair';
      if (v === 'poor' || v === 'fail' || v === 'out of spec' || v === 'damaged') return 'bad';
      return '';
    }

    function renderSection(isSectionChange) {
      if (!APP_DATA || !APP_DATA.sections || !APP_DATA.sections.length) {
        toast('Inspection data not loaded');
        return;
      }
      if (currentSectionIndex < 0) currentSectionIndex = 0;
      if (currentSectionIndex >= APP_DATA.sections.length) {
        currentSectionIndex = APP_DATA.sections.length - 1;
      }
      const section = APP_DATA.sections[currentSectionIndex];
      if (!section) return;
      document.getElementById('sectionCounter').textContent = `Section ${currentSectionIndex + 1} of ${APP_DATA.sections.length}`;
      document.getElementById('sectionName').textContent = section.section;
      renderSectionDots(!!isSectionChange);

      const items = getItemsForSection(section.section_id);
      const answered = items.filter(i => results[i.item_id]?.condition).length;
      if (currentItemIndex >= items.length) currentItemIndex = Math.max(0, items.length - 1);
      if (currentItemIndex < 0) currentItemIndex = 0;
      const progressEl = document.getElementById('itemProgress');
      if (progressEl) {
        progressEl.textContent = items.length
          ? `${currentItemIndex + 1} / ${items.length} · ${answered} done`
          : '0 / 0';
      }

      const container = document.getElementById('itemsContainer');
      const visible = inspectListMode ? items : (items[currentItemIndex] ? [items[currentItemIndex]] : []);
      container.classList.toggle('inspect-list-mode', !!inspectListMode);
      container.innerHTML = visible.map(item => {
        const res = results[item.item_id] || {};
        const isAnswered = !!res.condition;
        const isFinding = isBadResult(item, res.condition);
        const isFair = isFairResult(res.condition);
        let cardClass = 'item-card';
        if (isFinding) cardClass += ' finding';
        else if (isFair) cardClass += ' fair';
        else if (res.condition === 'N/A') cardClass += ' na';
        else if (isAnswered) cardClass += ' answered';
        const compact = inspectListMode && isAnswered && isCleanResult(item, res.condition);

        const choices = (item.choices || '').split('|').filter(Boolean);
        const choiceHtml = choices.map(c => {
          const sel = res.condition === c ? 'selected' : '';
          return `<button class="choice-btn ${choiceTone(c)} ${sel}" data-item="${item.item_id}" data-value="${c}">${c}</button>`;
        }).join('');

        let findingHtml = '';
        if (showsFindingPanel(item, res.condition)) {
          const impacts = res.impacts || [];
          const impactBtns = (APP_DATA.lists.impact || ['Downtime','Performance','Safety']).map(imp => {
            const sel = impacts.includes(imp) ? 'selected' : '';
            return `<span class="impact-tag ${sel}" data-item="${item.item_id}" data-impact="${imp}">${imp}</span>`;
          }).join('');
          const sevs = APP_DATA.lists.severity || ['1 - Monitor','2 - Repair','3 - Critical'];
          const curSev = res.severity ? String(res.severity) : '';
          const sevOpts = ['<option value=""' + (curSev ? '' : ' selected') + '>Select</option>'].concat(sevs.map(s => {
            const val = s.charAt(0);
            const selected = curSev === val ? 'selected' : '';
            return `<option value="${val}" ${selected}>${s}</option>`;
          })).join('');

          findingHtml = `
            <div class="finding-panel show">
              <div class="finding-heading"><span class="ico">${ICO.warn}</span>Finding Details</div>
              <div class="form-group" style="margin-bottom:8px">
                <label>Impact</label>
                <div class="impact-tags">${impactBtns}</div>
              </div>
              <div class="form-group severity-select">
                <label>Severity</label>
                <select class="sev-select" data-item="${item.item_id}">${sevOpts}</select>
              </div>
              <div class="form-group">
                <label>Notes</label>
                <textarea class="notes-input" data-item="${item.item_id}" placeholder="Describe the issue...">${res.notes || ''}</textarea>
              </div>
            </div>`;
        }

        const photoHtml = res.photoDataUrl
          ? `<div class="photo-area has-photo"><img class="photo-preview" src="${res.photoDataUrl}" alt="" /></div>`
          : '';

        return `
          <div class="${cardClass}" id="item-${item.item_id}">
            <button type="button" class="item-card-cam-btn" data-item="${item.item_id}" title="Add photo" aria-label="Add photo"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4.8 8.2h2.1l1.15-1.7h7.9l1.15 1.7H19.2A1.8 1.8 0 0 1 21 10v8.2A1.8 1.8 0 0 1 19.2 20H4.8A1.8 1.8 0 0 1 3 18.2V10a1.8 1.8 0 0 1 1.8-1.8z" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="14.1" r="3.05" stroke="currentColor" stroke-width="1.8"/></svg></button>
            <div class="item-title" data-answer="${compact ? (res.condition || '') : ''}">${item.inspection_item}</div>
            ${photoHtml}
            <div class="choice-grid">${choiceHtml}</div>
            ${findingHtml}
          </div>`;
      }).join('');
      if (!inspectListMode && inspectSlideDir) {
        const card = container.querySelector('.item-card');
        if (card) {
          card.classList.add(inspectSlideDir === 'next' ? 'inspect-in-right' : 'inspect-in-left');
          card.addEventListener('animationend', () => {
            card.classList.remove('inspect-in-right', 'inspect-in-left');
          }, { once: true });
        }
        inspectSlideDir = null;
      }

      container.querySelectorAll('.item-card .photo-preview').forEach(img => {
        img.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const card = img.closest('.item-card');
          const raw = card && card.id ? String(card.id).replace(/^item-/, '') : '';
          if (typeof openPhotoViewer === 'function') openPhotoViewer(img.src, 'inspect', raw);
          else if (typeof openPunchlistPhoto === 'function') openPunchlistPhoto(e, img.src);
        });
      });
      container.querySelectorAll('.item-card-cam-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          window.__inspectCamItemId = btn.getAttribute('data-item');
          const input = document.getElementById('inspectCamInput');
          if (!input) { toast('Camera not ready'); return; }
          input.value = '';
          input.click();
        });
      });

      // Bind choice buttons
      container.querySelectorAll('.choice-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const itemId = parseInt(btn.dataset.item);
          const value = btn.dataset.value;
          if (!results[itemId]) results[itemId] = {};
          results[itemId].condition = value;
          const item = APP_DATA.items.find(i => i.item_id === itemId);
          if (!showsFindingPanel(item, value)) {
            delete results[itemId].impacts;
            delete results[itemId].notes;
            delete results[itemId].photoDataUrl;
            delete results[itemId].severity;
          }
          updateFindings();
          saveCurrentDraft();
          const clean = isCleanResult(item, value);
          renderSection(false);
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (clean) scrollToNextOpenItem(itemId);
              else {
                const el = document.getElementById('item-' + itemId);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            });
          });
        });
      });
      container.querySelectorAll('.item-card.compact .item-title').forEach(title => {
        title.addEventListener('click', () => {
          title.closest('.item-card').classList.toggle('expanded');
        });
      });
      if (inspectListMode) {
        container.querySelectorAll('.item-card').forEach(card => {
          card.addEventListener('click', (e) => {
            if (e.target.closest('.choice-btn, .finding-panel, button, textarea, select, input')) return;
            const id = parseInt(String(card.id || '').replace('item-', ''), 10);
            const itemsNow = currentSectionItems();
            const idx = itemsNow.findIndex(it => it.item_id === id);
            if (idx < 0) return;
            inspectListMode = false;
            currentItemIndex = idx;
            saveCurrentDraft();
            inspectSlideDir = 'next';
            renderSection(false);
          });
        });
      }
      const markBtn = document.getElementById('btnMarkRestGood');
      if (markBtn && !markBtn.dataset.bound) {
        markBtn.dataset.bound = '1';
        markBtn.addEventListener('click', markRestOfSectionGood);
      }

      // Bind impact tags
      container.querySelectorAll('.impact-tag').forEach(tag => {
        tag.addEventListener('click', () => {
          const itemId = parseInt(tag.dataset.item, 10);
          const impact = tag.dataset.impact;
          if (!results[itemId]) results[itemId] = {};
          if (!results[itemId].impacts) results[itemId].impacts = [];
          const idx = results[itemId].impacts.indexOf(impact);
          if (idx >= 0) results[itemId].impacts.splice(idx, 1);
          else results[itemId].impacts.push(impact);
          updateFindings();
          saveCurrentDraft();
          tag.classList.toggle('selected');
        });
      });

      // Bind severity
      container.querySelectorAll('.sev-select').forEach(sel => {
        sel.addEventListener('change', () => {
          const itemId = parseInt(sel.dataset.item, 10);
          if (!results[itemId]) results[itemId] = {};
          results[itemId].severity = sel.value ? parseInt(sel.value, 10) : '';
          updateFindings();
          saveCurrentDraft();
        });
      });

      // Bind notes
      container.querySelectorAll('.notes-input').forEach(ta => {
        ta.addEventListener('input', () => {
          const itemId = parseInt(ta.dataset.item, 10);
          if (!results[itemId]) results[itemId] = {};
          results[itemId].notes = ta.value;
          updateFindings();
          saveCurrentDraft();
        });
      });

      // Bind photo
      container.querySelectorAll('.photo-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const itemId = btn.dataset.item;
          const input = container.querySelector(`.photo-input[data-item="${itemId}"]`);
          if (input) input.click();
        });
      });
      container.querySelectorAll('.photo-input').forEach(inp => {
        inp.addEventListener('change', (e) => {
          const file = e.target.files && e.target.files[0];
          if (!file) return;
          if (!file.type || !file.type.startsWith('image/')) {
            toast('Please choose an image');
            return;
          }
          const itemId = parseInt(inp.dataset.item, 10);
          if (!results[itemId]) results[itemId] = {};
          (async () => {
            try {
              const blob = await compressImageFile(file, 1600, 0.72);
              const id = 'ins_' + ((currentInspection && currentInspection.id) || 'draft') + '_' + itemId + '_' + Date.now();
              await idbPutPhoto({ id, blob: blob || file, caption: '', createdAt: Date.now() });
              results[itemId].photoId = id;
              results[itemId].photoDataUrl = blobToObjectUrl(blob || file);
            } catch (err) {
              const reader = new FileReader();
              await new Promise((resolve, reject) => {
                reader.onload = resolve;
                reader.onerror = reject;
                reader.readAsDataURL(file);
              });
              results[itemId].photoDataUrl = reader.result;
            }
            updateFindings();
            saveCurrentDraft();
            const scrollY = window.scrollY || window.pageYOffset;
            renderSection(false);
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                window.scrollTo(0, scrollY);
              });
            });
            toast('Photo attached');
          })();
        });
      });

      bindInspectSwipe(container);

      // Update next button text
      const lastItem = currentItemIndex >= items.length - 1;
      const lastSection = currentSectionIndex === APP_DATA.sections.length - 1;
      const nextBtn = document.getElementById('btnNextSection');
      if (nextBtn) nextBtn.textContent = (lastItem && lastSection) ? 'Finish inspection' : 'Next →';
      const prevBtn = document.getElementById('btnPrevSection');
      if (prevBtn) prevBtn.style.visibility = (currentSectionIndex === 0 && currentItemIndex === 0) ? 'hidden' : 'visible';
    }

    function updateFindings() {
      findings = [];
      if (!APP_DATA || !APP_DATA.items) return;
      Object.keys(results).forEach(idStr => {
        const itemId = parseInt(idStr, 10);
        const item = APP_DATA.items.find(i => i.item_id === itemId);
        if (!item) return;
        const r = results[itemId];
        if (!r) return;
        if (showsFindingPanel(item, r.condition)) {
          findings.push({
            item_id: itemId,
            section: item.section,
            item_name: item.inspection_item,
            condition: r.condition,
            severity: r.severity ? Math.min(parseInt(r.severity, 10) || 0, 3) : '',
            impacts: r.impacts || [],
            notes: r.notes || '',
            photoDataUrl: r.photoDataUrl || null,
            ai_category: item.ai_finding_category,
            status: 'Open'
          });
        }
      });
    }

    document.getElementById('btnNextSection').addEventListener('click', () => {
      if (!APP_DATA || !APP_DATA.sections) return;
      goToNextInspectItem();
    });

    document.getElementById('btnPrevSection').addEventListener('click', () => {
      goToPrevInspectItem();
    });

    // ========== SUMMARY ==========
    function collectCoverCards() {
      const cards = [];
      for (let n = 1; n <= 3; n++) {
        const tag = (document.getElementById('cover' + n + 'tag') || {}).value || '';
        const title = (document.getElementById('cover' + n + 'title') || {}).value || '';
        const body = (document.getElementById('cover' + n + 'body') || {}).value || '';
        if (title.trim() || body.trim()) cards.push({ tag: tag.trim(), title: title.trim(), body: body.trim() });
      }
      return cards;
    }
    function saveCoverCards() {
      if (!currentInspection) return;
      currentInspection.coverCards = collectCoverCards();
      currentInspection.summaryNotes = (document.getElementById('summaryNotes') || {}).value || '';
      currentInspection.overallCondition = (document.getElementById('overallCondition') || {}).value || '';
    }
    function fillCoverCards(list) {
      for (let n = 1; n <= 3; n++) {
        const c = (list || [])[n - 1] || {};
        const tag = document.getElementById('cover' + n + 'tag');
        const title = document.getElementById('cover' + n + 'title');
        const body = document.getElementById('cover' + n + 'body');
        if (tag) tag.value = c.tag || '';
        if (title) title.value = c.title || '';
        if (body) body.value = c.body || '';
      }
    }


    window.filterInspectHome = function(next) {
      inspectHomeFilter = inspectHomeFilter === next ? '' : next;
      document.querySelectorAll('.inspect-count-tile').forEach(b => {
        b.classList.toggle('on', b.getAttribute('data-filter') === inspectHomeFilter);
      });
      renderInspectHomeFilter();
    };
    window.startInspectFromHome = function() {
      extraSectionTab = null;
      inspectListMode = false;
      currentSectionIndex = 0;
      currentItemIndex = 0;
      showScreen('screenInspect');
      setHeader('Inspecting');
      renderSection(true);
    };
    function bindInspectHomeTiles() {
      const startInspectBtn = document.getElementById('btnInspectHomeStart');
      if (startInspectBtn && startInspectBtn.dataset.bound !== '1') {
        startInspectBtn.dataset.bound = '1';
        startInspectBtn.addEventListener('click', () => window.startInspectFromHome());
      }
      document.querySelectorAll('.inspect-count-tile').forEach(btn => {
        if (btn.dataset.bound === '1') return;
        btn.dataset.bound = '1';
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          window.filterInspectHome(btn.getAttribute('data-filter') || '');
        });
      });
      const wrap = document.getElementById('inspectPreviewWrap');
      if (wrap && wrap.dataset.bound !== '1') {
        wrap.dataset.bound = '1';
        wrap.addEventListener('click', () => wrap.classList.toggle('expanded'));
      }
    }
    let inspectHomeFilter = '';
    function conditionBucket(value) {
      const c = String(value || '').toLowerCase();
      if (!c || c === 'n/a') return '';
      if (c === 'poor' || c === 'fail' || c === 'out of spec') return 'poor';
      if (c === 'fair') return 'fair';
      return 'good';
    }
    function inspectConditionCounts() {
      let good = 0, fair = 0, poor = 0;
      Object.keys(results || {}).forEach(id => {
        const b = conditionBucket(results[id] && results[id].condition);
        if (b === 'good') good++;
        else if (b === 'fair') fair++;
        else if (b === 'poor') poor++;
      });
      return { good, fair, poor };
    }
    function renderInspectHomeFilter() {
      const listEl = document.getElementById('findingsList');
      const title = document.getElementById('inspectFilterTitle');
      if (!listEl) return;
      if (!inspectHomeFilter) {
        listEl.innerHTML = '';
        if (title) title.textContent = '';
        return;
      }
      const rows = [];
      ((APP_DATA && APP_DATA.items) || []).forEach(item => {
        const r = results[item.item_id] || results[String(item.item_id)];
        if (!r || conditionBucket(r.condition) !== inspectHomeFilter) return;
        rows.push({ item, r });
      });
      if (title) title.textContent = inspectHomeFilter.charAt(0).toUpperCase() + inspectHomeFilter.slice(1);
      if (!rows.length) {
        listEl.innerHTML = `<div class="empty-state" style="padding:16px"><p>No ${inspectHomeFilter} items</p></div>`;
        return;
      }
      const badgeFor = (cond) => {
        const b = conditionBucket(cond);
        if (b === 'poor') return 'badge-findings';
        if (b === 'fair') return 'badge-draft';
        return 'badge-complete';
      };
      listEl.innerHTML = rows.map(({ item, r }) => {
        const src = r.photoDataUrl || '';
        const impacts = Array.isArray(r.impacts) ? r.impacts : [];
        const extra = [r.condition, impacts.join(', '), r.notes].filter(Boolean).join(' · ');
        const bucket = conditionBucket(r.condition);
        const tone = bucket === 'poor' ? 'finding' : bucket === 'fair' ? 'fair' : bucket === 'good' ? 'answered' : '';
        return `<div class="pl-item finding-pl-card ${tone}" data-open-item="${item.item_id}">
            <div class="list-item-main">
              <div class="title">${item.inspection_item || ''}</div>
              <div class="sub">${item.section || ''}</div>
              ${extra ? `<div class="action-line">${extra}</div>` : ''}
            </div>
            <div class="list-item-actions">
              <span class="badge ${badgeFor(r.condition)}">${r.condition || inspectHomeFilter}</span>
              ${src ? `<img class="list-item-photo" src="${src}" alt="">` : ''}
            </div>
          </div>`;
      }).join('');
      listEl.querySelectorAll('[data-open-item]').forEach(card => {
        card.addEventListener('click', () => {
          const id = parseInt(card.getAttribute('data-open-item'), 10);
          const items = (APP_DATA && APP_DATA.items) || [];
          const item = items.find(it => it.item_id === id);
          if (!item) return;
          const sections = APP_DATA.sections || [];
          const sidx = sections.findIndex(s => s.section === item.section || s.section_id === item.section_id);
          extraSectionTab = null;
          inspectListMode = false;
          if (sidx >= 0) currentSectionIndex = sidx;
          const secItems = currentSectionItems();
          const iidx = secItems.findIndex(it => it.item_id === id);
          currentItemIndex = iidx >= 0 ? iidx : 0;
          showScreen('screenInspect');
          renderSection(true);
        });
      });
    }
    function showFindings() {
      if (!currentInspection) {
        toast('No active inspection');
        showScreen('screenHome');
        return;
      }
      extraSectionTab = 'findings';
      updateFindings();
      (function fillInspectInfoCard() {
        const job = (currentInspection && currentInspection.jobId)
          ? (loadJobs().find(j => j.id === currentInspection.jobId) || null)
          : (typeof getActiveCurrentJob === 'function' ? getActiveCurrentJob() : null);
        const customer = (currentInspection && currentInspection.customer) || (job && job.customer) || 'Inspection';
        const date = (currentInspection && currentInspection.date) || (job && (job.startDate || job.date)) || '';
        const model = (currentInspection && currentInspection.model) || (job && job.machine) || '';
        const serial = (currentInspection && currentInspection.serial) || '';
        const site = (job && job.site) || '';
        const tech = (currentInspection && currentInspection.technician) || (job && job.technician) || '';
        const elC = document.getElementById('inspectInfoCustomer');
        const elD = document.getElementById('inspectInfoDate');
        const elM = document.getElementById('inspectInfoMachine');
        if (elC) elC.textContent = customer;
        if (elD) elD.textContent = date;
        const serialBit = serial ? ('S/N ' + serial) : '';
        const machineLine = [model, serialBit].filter(Boolean).join(' · ');
        if (elM) elM.textContent = machineLine;
      })();
      const counts = inspectConditionCounts();
      const g = document.getElementById('sumGood');
      const f = document.getElementById('sumFair');
      const p = document.getElementById('sumPoor');
      if (g) g.textContent = counts.good;
      if (f) f.textContent = counts.fair;
      if (p) p.textContent = counts.poor;
      const totalAnswered = Object.keys(results).length;
      const tot = document.getElementById('sumTotalItems');
      const findN = document.getElementById('sumFindings');
      if (tot) tot.textContent = totalAnswered;
      if (findN) findN.textContent = findings.length;

      document.getElementById('summaryMeta').innerHTML = `
        <div class="review-customer">${currentInspection.customer || 'Inspection'}</div>
        <div class="review-line">${currentInspection.model || ''} · S/N ${currentInspection.serial || ''}</div>
        <div class="review-line">${currentInspection.technician || ''} · ${currentInspection.date || ''}${currentInspection.po ? ' · PO ' + currentInspection.po : ''}</div>
      `;

      if (currentInspection.summaryNotes && !document.getElementById('summaryNotes').value) {
        setNotesContent(currentInspection.summaryNotes);
      }
      if (currentInspection.overallCondition) {
        document.getElementById('overallCondition').value = currentInspection.overallCondition;
      }
      // list rendered on tile tap only

      const meta = document.getElementById('summaryMeta');
      if (meta) {
        meta.innerHTML = `
          <div class="review-customer">${currentInspection.customer || 'Inspection'}</div>
          <div class="review-line">${currentInspection.model || ''} · S/N ${currentInspection.serial || ''}</div>
          <div class="review-line">${currentInspection.date || ''}</div>`;
      }
      renderInspectHomeFilter();
      try { closeSearch(); } catch (e) {}
      const scrim = document.getElementById('searchScrim');
      if (scrim) { scrim.classList.remove('show'); scrim.hidden = true; }
      showScreen('screenFindings');
      setHeader('Inspection');
      renderSectionDots(false);
      bindInspectHomeTiles();

    }

    function renderInspectPreview(force) {
      if (!force) return;
      saveCoverCards();
      updateFindings();
      const items = (APP_DATA && APP_DATA.items) || [];
      let nGood = 0, nFair = 0, nPoor = 0, nAns = 0;
      items.forEach(it => {
        const c = String((results[it.item_id] && results[it.item_id].condition) || '').toLowerCase();
        if (!c) return;
        nAns++;
        if (c === 'poor' || c === 'fail' || c === 'out of spec') nPoor++;
        else if (c === 'fair') nFair++;
        else if (c !== 'n/a') nGood++;
      });
      const photos = [];
      findings.forEach(f => {
        const r = results[f.item_id] || {};
        const src = f.photoDataUrl || r.photoDataUrl;
        if (src) photos.push({ src, cap: f.item_name || '', notes: f.notes || '' });
      });
      const logo = (document.querySelector('.header-logo-img') || {}).src || '';
      const esc = s => String(s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
      const cards = collectCoverCards();
      const feat = photos.slice(0, 2).map(p =>
        `<div><img src="${p.src}" alt=""><p>${esc(p.cap)}${p.notes ? ' · ' + esc(p.notes) : ''}</p></div>`
      ).join('');
      const moves = cards.map(c => `
        <div class="move">
          <div class="t">${esc(c.tag || 'REPAIR')}</div>
          <b>${esc(c.title)}</b>
          <div>${esc(c.body)}</div>
        </div>`).join('');
      document.getElementById('irPreviewSheet').innerHTML = `
        <div class="hero">
          <div class="k">FIELD SERVICE TRIP REPORT</div>
          <div class="visit-logo-pill">${logo ? `<img src="${logo}" alt="LeMatic">` : ''}</div>
          <h2>${esc(currentInspection.customer || 'Inspection')}</h2>
          <div class="s">${esc(currentInspection.model || '')}${currentInspection.serial ? ' · S/N ' + esc(currentInspection.serial) : ''}</div>
          <div class="s">${esc(currentInspection.technician || '')}${currentInspection.date ? ' · ' + esc(currentInspection.date) : ''}</div>
        </div>
        <div class="tiles">
          <div class="tile" style="background:#2a3036"><b>${nAns}</b><span>ITEMS CHECKED</span></div>
          <div class="tile" style="background:#c62828"><b>${nPoor}</b><span>POOR</span></div>
          <div class="tile" style="background:#b8860b"><b>${nFair}</b><span>FAIR</span></div>
          <div class="tile" style="background:#1f4e3a"><b>${nGood}</b><span>GOOD</span></div>
        </div>
        ${feat ? `<div class="feat">${feat}</div>` : ''}
        ${moves || '<div class="body">Add cover items on Review to show them here.</div>'}
        <div class="h">On site</div>
        <div class="body">${esc(getNotesPlain() || '—')}</div>
      `;
      showFindings();
    }

    document.getElementById('btnFindingsBack').addEventListener('click', () => {
      renderSection();
      showScreen('screenInspect');
      setHeader('Inspecting');
    });
    const startInspectBtn = document.getElementById('btnInspectHomeStart');
    if (startInspectBtn) startInspectBtn.addEventListener('click', () => {
      extraSectionTab = null;
      inspectListMode = false;
      const items = currentSectionItems();
      const open = items.findIndex(it => !results[it.item_id] || !results[it.item_id].condition);
      if (open >= 0) currentItemIndex = open;
      showScreen('screenInspect');
      setHeader('Inspecting');
      renderSection(true);
    });
    document.querySelectorAll('.inspect-count-tile').forEach(btn => {
      btn.addEventListener('click', () => {
        const next = btn.getAttribute('data-filter') || '';
        inspectHomeFilter = inspectHomeFilter === next ? '' : next;
        document.querySelectorAll('.inspect-count-tile').forEach(b => b.classList.toggle('on', b.getAttribute('data-filter') === inspectHomeFilter));
        renderInspectHomeFilter();
      });
    });

    document.getElementById('btnFindingsNext').addEventListener('click', () => {
      if (typeof syncNotesField === 'function') syncNotesField();
      if (currentInspection) {
        currentInspection.summaryNotes = (document.getElementById('summaryNotes') || {}).value || currentInspection.summaryNotes;
        saveCurrentDraft();
      }
      if (typeof openSaveSheet === 'function') openSaveSheet();
    });
    function notesLooksHTML(s) {
      return /<(p|div|h1|h2|h3|ul|ol|li|b|i|u|strong|em|br|span)[>\s/]/i.test(s || '');
    }
    function syncNotesField() {
      const ed = document.getElementById('notesEditor');
      const ta = document.getElementById('summaryNotes');
      if (ed && ta) ta.value = ed.innerHTML === '<br>' ? '' : ed.innerHTML;
    }
    function setNotesContent(val) {
      const ed = document.getElementById('notesEditor');
      const ta = document.getElementById('summaryNotes');
      val = String(val || '').replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
      if (!ed || !ta) return;
      if (!val) {
        ed.innerHTML = '';
        ta.value = '';
        return;
      }
      if (notesLooksHTML(val)) ed.innerHTML = val;
      else ed.textContent = val;
      syncNotesField();
    }
    function getNotesPlain() {
      const ed = document.getElementById('notesEditor');
      if (!ed) return (document.getElementById('summaryNotes') || {}).value || '';
      const clone = ed.cloneNode(true);
      clone.querySelectorAll('li').forEach(li => { li.prepend('• '); });
      return String(clone.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    }
    function placeNotesFormatBar() {
      const bar = document.getElementById('notesFormatBar');
      if (!bar || !document.body.classList.contains('on-notes')) return;
      const vv = window.visualViewport;
      const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
      const typing = kb > 80;
      document.body.classList.toggle('notes-typing', typing);
      const dock = document.getElementById('bottomBar');
      const dockUp = !typing && notesSource !== 'visit-letter' && dock && !dock.classList.contains('hidden');
      const dockH = dockUp ? dock.getBoundingClientRect().height : 0;
      bar.style.bottom = (kb + dockH + 10) + 'px';
    }
    function initNotesEditor() {
      const ed = document.getElementById('notesEditor');
      const bar = document.getElementById('notesFormatBar');
      if (!ed || !bar || bar.dataset.ready) return;
      bar.dataset.ready = '1';
      ed.addEventListener('input', syncNotesField);
      ed.addEventListener('focus', () => {
        document.body.classList.add('notes-focus');
        placeNotesFormatBar();
      });
      ed.addEventListener('blur', () => {
        setTimeout(() => {
          if (!bar.contains(document.activeElement)) document.body.classList.remove('notes-focus');
        }, 80);
      });
      bar.addEventListener('mousedown', (e) => e.preventDefault());
      bar.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        ed.focus();
        const cmd = btn.dataset.notesCmd;
        const block = btn.dataset.notesBlock;
        const size = btn.dataset.notesSize;
        if (cmd) document.execCommand(cmd, false, null);
        else if (block) document.execCommand('formatBlock', false, block);
        else if (size) document.execCommand('fontSize', false, size === 'inc' ? '5' : '2');
        syncNotesField();
      });
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', placeNotesFormatBar);
        window.visualViewport.addEventListener('scroll', placeNotesFormatBar);
      }
      window.addEventListener('resize', placeNotesFormatBar);
    }

    function openFullNotes(source, value) {
      notesSource = source || 'inspection';
      setNotesContent(value || '');
      showFindings();
      setHeader(source === 'visit-letter' ? 'On Site' : 'Notes');
      initNotesEditor();
      requestAnimationFrame(() => {
        const ed = document.getElementById('notesEditor');
        if (ed) ed.focus();
        placeNotesFormatBar();
      });
    }
    function closeFullNotes() {
      syncNotesField();
      const html = (document.getElementById('summaryNotes') || {}).value || '';
      const plain = getNotesPlain();
      if (false) {
        vrWriteNotesBack();
        showTripSection(vrSection || 'site');
        setHeader('Trip Report');
        return;
      }
      if (currentInspection) currentInspection.summaryNotes = html;
      showFindings();
    }
    function leaveNotesToFindings() {
      closeFullNotes();
    }
    document.getElementById('btnNotesBack').addEventListener('click', leaveNotesToFindings);
    function closeOpenOverlaysForBack() {
      let closed = false;
      const has = (id, selector = '.show') => {
        const el = document.getElementById(id);
        return !!(el && el.classList.contains(selector.replace('.', '')));
      };
      try {
        if (has('pl-modal')) { closeModal(); closed = true; }
        if (has('deleteModal')) { closeDeleteModal(); closed = true; }
        if (has('machineModal')) { closeMachineModal(); closed = true; }
        if (has('jobDatesModal')) { closeHomeJobDatesEditor(); closed = true; }
        if (has('jobPickerModal')) { closeJobPicker(); closed = true; }
        if (has('plExportSheet')) { closePlExportSheet(); closed = true; }
        if (has('saveSheet')) { closeSaveSheet(); closed = true; }
        if (has('tcWeekPickSheet')) { tcCloseWeekPick(); closed = true; }
        if (has('tcExportSheet')) { tcCloseExportSheet(); closed = true; }
        if (has('plLinkJobSheet')) { closePunchlistLinkSheet(); closed = true; }
        if (has('tcNameSheet')) {
          const el = document.getElementById('tcNameSheet');
          el.classList.remove('show'); el.hidden = true; el.setAttribute('hidden','');
          closed = true;
        }
        const ir = document.getElementById('irPreviewSheet');
        if (ir && !ir.hidden) { ir.hidden = true; ir.classList.remove('show'); closed = true; }
        const qr = document.getElementById('profileQrViewer');
        if (qr && !qr.hidden) { closeProfileQrViewer(); closed = true; }
        if (document.body.classList.contains('search-open')) { closeSearch(); closed = true; }
      } catch (e) {}
      return closed;
    }

    document.getElementById('btnHeaderBack').addEventListener('click', () => {
      // Back first dismisses any open sheet, dialog, modal, or search UI.
      // A second tap then navigates to the previous page.
      if (closeOpenOverlaysForBack()) return;

      const active = document.querySelector('.screen.active');
      const activeId = active ? active.id : '';

      // Preserve any unsaved inspection work before leaving its flow.
      if (document.body.classList.contains('inspect-active') ||
          document.body.classList.contains('on-findings') ||
          document.body.classList.contains('on-inspect-notes') ||
          document.body.classList.contains('on-inspect-preview')) {
        try { if (typeof saveCurrentDraft === 'function') saveCurrentDraft(); } catch (e) {}
      }

      // Punchlist edit needs its existing cleanup, but the destination is
      // still determined by the actual navigation history.
      if (document.body.classList.contains('on-pl-edit') || activeId === 'screenPunchlistEdit') {
        const previousId = navHistory.pop() || 'screenPunchlistList';
        navGoingBack = true;
        try { cancelPunchlistEdit(); } catch (e) {}
        try {
          showScreen(previousId);
        } finally {
          navGoingBack = false;
        }
        return;
      }

      let previousId = navHistory.pop();
      if (!previousId) {
        previousId = 'screenHome';
      }

      navGoingBack = true;
      try {
        showScreen(previousId);
      } finally {
        navGoingBack = false;
      }

      if (previousId === 'screenHome') {
        setHeader('LeMatic Inspection');
        if (typeof refreshHome === 'function') refreshHome();
      } else if (previousId === 'screenInspectList') {
        setHeader('Inspections');
        if (typeof refreshHome === 'function') refreshHome();
      } else if (previousId === 'screenPunchlistList') {
        setHeader('Punchlist');
        if (typeof refreshPunchlistHome === 'function') refreshPunchlistHome();
      } else if (previousId === 'screenTime') {
        setHeader('Time Cards');
        if (typeof tcRefresh === 'function') tcRefresh();
      } else if (previousId === 'screenTimeWeek') {
        if (typeof tcRenderWeekDetail === 'function') tcRenderWeekDetail();
      } else if (previousId === 'screenTimePeriod') {
        if (typeof tcRenderPeriodDetail === 'function') tcRenderPeriodDetail();
      }
    });
    document.getElementById('btnNotesNext').addEventListener('click', () => {
      if (false) {
        closeFullNotes();
        return;
      }
      if (currentInspection) {
        syncNotesField();
        currentInspection.summaryNotes = document.getElementById('summaryNotes').value;
      }
      renderInspectPreview(true);
    });

        document.getElementById('btnPreviewBack').addEventListener('click', () => {
      notesSource = 'inspection';
      showFindings();
    });
    function openSaveSheet() {
      const scrim = document.getElementById('saveSheetScrim');
      const sheet = document.getElementById('saveSheet');
      scrim.hidden = false;
      sheet.hidden = false;
      requestAnimationFrame(() => {
        scrim.classList.add('show');
        sheet.classList.add('show');
      });
    }
    function closeSaveSheet() {
      const scrim = document.getElementById('saveSheetScrim');
      const sheet = document.getElementById('saveSheet');
      scrim.classList.remove('show');
      sheet.classList.remove('show');
      setTimeout(() => {
        if (!sheet.classList.contains('show')) {
          scrim.hidden = true;
          sheet.hidden = true;
        }
      }, 380);
    }
    document.getElementById('btnSaveInspect').addEventListener('click', openSaveSheet);
    document.getElementById('saveSheetScrim').addEventListener('click', closeSaveSheet);
    document.getElementById('saveSheetCancel').addEventListener('click', closeSaveSheet);
    document.getElementById('saveSheetPdf').addEventListener('click', () => {
      closeSaveSheet();
      generatePDFReport();
    });
    document.getElementById('saveSheetDocx').addEventListener('click', () => {
      closeSaveSheet();
      generateWordReport();
    });
    document.getElementById('saveSheetXlsx').addEventListener('click', () => {
      closeSaveSheet();
      generateInspectionExcel().catch(err => {
        console.warn(err);
        toast('Could not build Excel file');
      });
    });
    document.getElementById('btnCompleteInspect').addEventListener('click', () => {
      if (!currentInspection) {
        toast('No active inspection');
        return;
      }
      syncNotesField();
      currentInspection.summaryNotes = (document.getElementById('summaryNotes') || {}).value || currentInspection.summaryNotes || '';
      updateFindings();
      currentInspection.findings = findings;
      currentInspection.results = results;
      currentInspection.status = 'Complete';
      currentInspection.updatedAt = new Date().toISOString();
      saveCurrentDraft();
      toast('Inspection completed');
      showScreen('screenInspectList');
      setHeader('Inspections');
      refreshHome();
    });


    // ========== PDF REPORT ==========
    function findRelatedVisit(ins) { return null; }
    const LEMATIC_LOGO_JPG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAcFBQYFBAcGBgYIBwcICxILCwoKCxYPEA0SGhYbGhkWGRgcICgiHB4mHhgZIzAkJiorLS4tGyIyNTEsNSgsLSz/2wBDAQcICAsJCxULCxUsHRkdLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCz/wAARCABuAUcDASIAAhEBAxEB/8QAHQAAAgICAwEAAAAAAAAAAAAAAAgGBwQFAQIDCf/EAFYQAAEDAwIDAgYLCQ0HBAMAAAECAwQABREGEgchMRNBCBQiUWFxFRYyNnSBkaGys9IYIzdCUnJ1lLEXJDQ1VFViY3OCk8LRJTNDRFaSokVGU8GEo8P/xAAbAQEAAwEBAQEAAAAAAAAAAAAABAUGAwcBAv/EADMRAAIBAgIGCAYCAwAAAAAAAAABAgMRBCEFEiIxQVEGExQyYXGBsRYzQlORwSRSodHw/9oADAMBAAIRAxEAPwBkKKKKAKM1ANX8VoGn5K7da4r15uaFdm6GELUxFOP+M4hKtpH5IBV6BVX3bVEnWiy1P1ZdG7SpvtHp0G3yWYaU96GUITvcIwcuOqCR+SaAve6at09ZCRdL5boKh1S/JQg/ITmqm4nTo3EZVvGj3kX42/tPGfEzv7Lfjbn17VY9RqF2bSvDB+VNuVwj3pizNtFDCDHlKcmJHlGQ44EYSDjyUpwMc1dcCTaAQ0zEt5s5d7e7BSrmZ4UkNKPON2fbY37PJB2ZztGe6udVKUbMsdGVp4fExq07XV9+7cyvp2nb1bAVTrTNjAfjOMKA+XGK1vqq9rZqPXkiG7DlPW1FzZWVNZeYUiUehZWkKyk/kkY8x89a+5WVvUyO2lafgmYtW16NGlstSmj3rbWk7XEjvSsAjzmoLop5xZ6BS07OEtWvFecZX9+HqUzRUs1HoOXZ46p0CQ1c7elO9a2lpU7HH9YlJOPzgSPVUTqPKLi7M0OHxNLEw16Tujg9D6qbjRnvHsvwJr6IpRz0PqpuNGe8ey/AmvoipWF7zMj0u+TS837G7oooqwPOwooooAooooAooooAooooAooooAooooAooooAooooAooooAooooAooooAooooAooooAooooAJwKq7W2u0y7+rTNufuUaGySm53K3wnZC2zy/e7RbSoJcIPlKPuR08o8pZrq+S7RYm49q2m8XR5MGACMhLq85cI/JQkKWfzfTXXsrdw24dvraStxi2RlvKUo5XIc6lSj3rWs/KqgK4map05LEbR1jhXe3abjDddDFtcoOudCI/JG8Fedy1nmU8s+UaztV67sd1Ztek4MW7xbe+oKntt2mShSYbY/3aUBGdq1BLZIGACqp9oexvWLSzKJpK7nLJmT3O9chzyl/EOSR6EitdpNJumuNV3xeVJbkItMcn8VDKdy8et1xf/bQEa4gcRbRI4eXS3QY14adlsiGjfaZLSQHFBBAJQAOSjgd/QVpeIUxrVSrIqwodYFpJP+0W1QMe527O2Cd3uOe3OOWetWDxF++M6biHJEq/Q0kecIUXf/51BPCEAPsCFdCHxz/uVxrdxlzoOMp46EYuzd/HgyJ6p0ZcU6yuEmG7bmkOSDIaJnstqTuwsHBUCOZ5VkX3TF1kXCFqS3vW+NKkJC31NzmUBuUn3RSrdg7uSuX5RzUe1oUO3G3SfJzJtkVw57z2e0/Rrm0bJ2iL5bztUqGWri0PNg9m5/4qT8lQrrWasbtQrKhTquaysns8HZZ5552JRIsF47djU9ket0G5AlM9pmaz2SVnlv8Adbdjneg9+fPWq1VpYLtfs9BaiMLT/DoMWSh5LBzjtUbScNknofcn0VptHzo8a+iHLKfELkkwpI5Y2r5BXrSrar4q8oMyVo/VDm5CFORHFx5DJ9y8jJStB9BH/wBGvjlGS3bz7ChXo1bRmm4q6y7y/q3fhw32y8TT9x9VNxoz3j2X4E19AUr2prSzabuUxFlyBJbTJiOHqppYynPpHNJ9KTTQ6M949l+BNfRFdcMrSaZU9KasauGozjub/RHdfcX9PcOrpFgXhie47JZ7ZBjtpUNu4p55UOeRUV+6i0Pj+B3n/AR9uq98K7362T4AfrFVQwqeYA+jNunN3O2RZzIUGpLSHkBQwQFJChn04NZNafSXvLsnwBj6tNbigCiijNAFFFGaAjut9a23QOnTebq3IcjB1LOI6QpWVZxyJHLlVc/dRaH/AJHef8BH26yfCZ/BCfh7P+ak8oBuvuotD/yO8/4CPt1cMGY1cLfHmMHLMhtLqD50qAI+Y185R1509fB66ezHB/Tkgq3KTEDCj6WyUf5aA1WseO2ldE6mkWK5MXB2VHShSzHaSpI3JCgMlQ54IrRfdRaH/kd5/wABH26XLipdReuKuo5qTuQqa42k+dKDsHzJqJUA7uh+Nmmtf6hNmtMe4NyQyp7MhpKU7U4zzCjz51YtJ/4MX4XFfo979qKcCgCijNcBSVdCD6udAc1rdQ3+DpewS7zc1rbhxEhbqkIKiBkDkB15kVss1A+Nv4FtSfB0/WJoDSfdI8O/5fM/U11MdF6/sWvoUmXYnnnmorgacLjRbwojPf6KQM9aaXwUAfajfTg48dR9XQFg674v6b4eXaPb7y3PU9IZ7dBjshadu4p5kqHPINRlHhOaEWtKAxeMqOB+9k/bqL+EToDVGrdZWyXYrLIuDDMHslra24SrtFHHMjuIqpmOC3EREhtR0rNACgTzR5/zqAeJJ3JB89c11QMIGeoArtmgCiuMjOM865zQBRRRQFeXSyW/XPFKRCu0cSrdYICNrSlKSPGH1ElXIjmG2wP75rUa14b6SYkadt0SzNNrud1aacw65ktISp1Y5q7wjHx1l2fUsi1a11opGm71dS5dEI7aE02pCQiM0AklS0nI5np31h6i1jKka80g8rSGom/FnpTgZWw1vdJjlI2gOYOMknJHKgJT+5RonGTYmvTl537VRfhvw20ndtCQrlNszbr8xx58q7VweSp1e0cldydo+KpM9r2YWFgaG1SDtPPxdnzf2tR3hzrKTA4bWCMjR+o5QbhNjtmWGihzlncklwHB9QoDy1Vw30lG1VpCGxZm0Il3BwOgOueUlMdxWPdefB+KtRxPhR+HhtntWb9i/He07fYSvtNu3bnfnGNx6eetvqPWUl/Xej31aQ1E0Y78pQaWw1vdJjqGEAOYJGcnJHIVqOKElWrfY3xmO9pnxbtNvs0A12+7bnZsK84wM5x1Fca19R2LjQvV9uh1qus+F+D4Eb1BrPUDVs0++1c1pMi3hTn3tHlKDi059z5gPkrvo/WWoJ96ehv3Na0vQ5ASC2jksNKUk+57imul807HdsenUK1HZW+zhrQFKeXhz78s5T5HTnj1iudGacYjavguJ1FZZBy4OzaeWVKy2ocsoHnz8VQ9vXWfI238Psc9lX2vp8XbgaIa91PtBF3cyRkHs2/s1vtX6yv7F4jvxbkttmbCjykpDaMAqQN34v5QVWhTpWN5ONU2HH9u59it7qLTzEi36fKtR2VsotyW9y3lgOAOLwpPkdOePir8rXs8/wDJJqPBKtTagrZp7Phfl4Guu1xlam0I3cJzpfm2uX2CnCACWXU7k9AOikqHx0xejPePZfgTX0RS+RrO1A0XqUIvFtnhTLC9kVxSlJKXhgnKR+UaYPRnvHsvwNr6IqRh73u+RmdPyh1KhT7qm7cN6T92xcfCu9+tk+AH6xVUMOtXz4V3v1snwA/WKqhh1qYY4+hWkfeVZPgDH1aa3FafSPvKsnwBj6tNbigIVxS4ixuG+kzcltJkTX1djEjk4C14zk/0QOZ+Id9J5qPiXq/VUtb1zvsxSVEkMtOFppI8wQnA/wDurG8KW7uSuIVvtm49lBhBYH9NxRJPyJTVR6ZTBXqu1Iua20QDLa8YU57kN7xuz6MZoDzE67QSh9MqbHLg3IWHFo3ekHvq0+F/Hu/6dvMaFqKe9dLK6oNuKkK3uxweW9KzzIHeDnl051YPHPWehdS8LJEO2Xq2zJ0Z1pyK0yrKk4UAdvLkNpNK4OtAOB4Sy0ucHd6FBSVTmCCOhGFUn3U0yvEW5O3XwStOS3lFbijFQpR6kpC05/8AGlqHUUBs7zaVWoQFEkpmw25SfUrIPzpNM14O2o0R+Ct2U6r+Jn33SM9EdmHP27qpriNaey4c8PLslHKRbXI6lAd6HSofMs/JXfh3qdVm4XcQ4PaYMqEz2Y9KnOyV8znzUBXTi3ZsxTisqdfWVH0qUf8AU1k322+w9/nW4kkxH1sknzpOD84rbcO7V7N8SdP28jKHpzW8f0QoKV8wNeWvjniNqMjoblIP/wCxVAWF4MX4XFfo979qKuTjjxde4fQY9ss6W1XqckuBbg3Jjt5xv295JyADy5En0014MX4XFfo979qKtXifwFncQtbPX1GoWYba2m2kMrjqWUhI58wodSSfjoBY7vqzUWoZanrpeZ85xZ/4jyiPUE5wPUBWF4zcrXIGHpUR4c/dKbUPT3GmU0ZwNgcNtYw9Q3/VdrdYiBaktPoDPlFJAVlascs5qHeElrPTOqblZ49jlMz5EJLofks804Vt2oCvxuhPmGfTQGNwm46X+yagh2vUFwdudnkuJZUuQre5HJOAsLPMgHGQc8ulYvH3U18RxSv1nRd5qbYQ0kxA+rsiOzQcbc4686qRolLqCDggg04vGPSlhd4UXy/uWeEu7+KNK8cLQ7XOUDO7r05UAnFbaz6pv1iZWxabzOt7Tity0R31NhR6ZIB64rUnrTH+DXpHT2o9JXd682WDcHWpoQhchkLKU9mDgE92aAxPCJ1Vf7JqextWu9T4LbtsQ4tLEhSApW9XM4PM1UcfiHrJUloHVN4IKwMeOL8/rqzPCqSlGurMlICUptoAA7h2iqpCL/C2vzx+2gPoLqXUkHSWlpl8uSymNEa3qA90s9AkekkgD10m2teNGsNZTnVKuT1tgE/e4cNwtoSP6RGCs+k/IKuXwp7y5F0ZZLShe1M2Sp5wDvDaeQ9WV5+KlZHWgMkzZi1dqqS+Tn3RcUefrqU6T4raw0hObdgXmQ6wlQK4slZdZWPMUk8vWMGmp0xoy1/uCw7KqAytEu0hx0dmCpbq29xV59248j6BShe0XVv/AEvev1F37NAPLojVkTW+joF+hpLaJSPLbJyW1g4Uk+og+sYoqt/Boh3i16FuUC7QJkEtzitpEllTZIUhOcBQHLIooCaaWxD4iazt6uXbPRrigHvS4yGyR/eZNca0xG1doieQAhF0cjE/2sdxI+cCtbxDhz7bqix6ht92XZ231exM+UhhD21DissqIXywHfJz3dpWBrvSerk6Qk3AaxkT3rUU3Fln2PYQStk7+RAznAPLv6d9AWkpKVoIOOYxUR4UKCuFtkQerDSmD623FIP0ax4Vk1TcYEebG4hyHI8htLzahbI2FJUAoHp5jUd0Pp/U6BfLTH1q/D9i7o80Wxb2FZDmHgvmOW7tM46daAk+rgEa/wBDO93jslv/ALoq/wDSoR4QPurDj+u/yVsNZae1REuWlZD+tX5C/ZhDLazb2E9ipbTqd/Ic/Ng8vK9FafiezIsHsZ7Y5J1V23adj2yBE8Xxt3Y7L3Wcjr028uprjXzpsutBSccfTaV9+Xo+ZAdRkpsOmEZOfY9SvlecrtoPKdWNPEnEePIeP91ldbrU93ssdNmZc0yy7ttjK0gzHU9mFblbeXXr1PPnXbTt3srVsv1yb0yywI0ItHEx1W/tVBGzJ6ZGeY58qgqK173N468+xOPVvavy+p+fiV+kkJTknkKkmsQWRYovQsWljcPMV7l/sUK97bMst1usa3saRYLsl1LKf3891JxWVqbU1gl6kmrGmmZLbS+wbdMx1O5DY2JOByHJIr8JJR3/APfglTrzliILqnspvfHyXHzNbbf3toC/SVf809HiI9JBLivmSKZXRnvHsvwJr6IpddayI8SDbLHFgogdi2ZcphDil7XnAMJJVzyEBPqyaYrRnvHsvwJr6IqVh8pNcjJ9IG6mHhWatrSb9LJL2uLj4V3v1snwA/WKqhh1q+fCu9+tk+AH6xVUMKmmLPoVpH3lWT4Ax9WmtxSpWzwobxa7RDgI07AWiKyhkKLy8qCUhOfmrK+6wvZ/9t2//HcoCMeEln92SXnp4qxj1bKrSzWx+9XuFbIxQl+Y8hhsrOEhSiAMnzc6trwkoLzmqbHqFTWxu7WxtRxzAcTzIz6lpqrNMXJFm1Zarm6CW4Utp9YAySlKwTj4hQFp/cv66PLxqzn/APIX9igeC7rrP8Js/wCsL+xVjca+LWnZPDRcXTeo237jOcbLfiTxDjaAoKUVEYKeQxg4PP10tg1hqYnlqG7frrn2qAYHinp6ZpPwXrRY7gppUuFKaQ4WlFSM7nDyJA7iKWQdRTR8YYcuB4MdijXBxx2Y2qGH1OqKlFexRVknmTk0rg6igL/13afHPBO0fPSPKgLQSfMlZWk/Ptqg0vONtrQhakocACgDyUAcjPx02LVqN58DtMYI3KRai+keltZX/lpSz1oC2vBstPsjxgjyFIym3xnZBPmJAQPp1Bde/hF1F+kZH1iqvHwT7Vz1Fd1D/wCGKg/KtX+WqO17+EXUX6RkfWKoCwfBi/C2r9HvftRUn468a7zF1JK0tpqWuAzD+9ypTRw645jJSlX4oHTlzJzUZ8GH8Lqv0e99JFQHiIh5HEzUqX89p7JyM5/tFY+bFAYNst941hqBiBEQ/crnLVtQFLKlKPUkqUeQAySSeVSLXvCu9cPLXbZN7fi9tcFOJSwwsrLYSE9VYx+N0Ga9uC+rbZoviVDul3UpuEW3GVupSVFrcnAVgc8Z647jUo8IXiTZdc3G0w7C+ZcW3pcUuRsKErWvbyAUAeQT1x30BTaP94n1inc4v/gFvnwJv6SKSNH+8T6xTu8XUlfAa+BIz+8UH5FINAJAeppqPBR95d7+Hp+qFKuepq8+AnFbTegrFdLffXJLS5EhLzSmmS4CNoSRy5g8qA7+Fb7/AGz/AKOH1i6o6L/C2vzx+2ru8KhxLuuLK4nO1dtChnzFxVUjF/hbX56f20AwvhYhXb6VPPb2Uj5ct0uo601PhS2R2Zoez3dtG5MCSW3CPxUuJGD6tyQPjpVh1oD6DaTdQzoGyuuKCUItzClK8wDScmtB+7Xw6/6rh/Iv7NQbT/G7SkXgjHbk3NCbvEtvihhbT2i3Uo2Jxyxg8jnOOdKlknvoD6D6b1dYtXRnpFhuTVwZYWG3FN5wlRGccwO6iqy8GC0uweGD851JHshNW43kdUJSEZ+UKooC2rxaYd9s0u1z2Q9FltlpxHTII7j3HvB7iKgVs1rdrBKOj7zYbre7rDaKkSYiWimbGB2pdwtafK6JWBnCvQRVlVo9T6WjaliM5echXCGvtoU9jHaxXMY3JzyII5KSeShyNAV/o7WVw0wpzST+j9QOdgVv21sJY7TxMq5JOXMeQpWzkTy25xXLer59m4nPylaN1A21qCKhCWFIY7RchgKyU/fcY7JQzzz5Hf3YustR3GKm226+2eXF1RGeK7VdrehCor7mMY8tacBY8lTSjnzZ5Gi9a0nastPsWjSN7g6utJanoaS22pLD6fcnJWCppXlJJA6KI60BmcQNYTnbDDluaO1BDTbrlEmF15DG0BDycjk6TkgkDl1Nabii+5qtNu8cjuaX8X7UI9mSlHb7tvuOyK+mBnOOoxmtve9au644d3iBE0fqASHWHYysNNFLEhI9yrywfJWB3Zxz761F/mniUdJOrjuWZLmFg3DCfGwrYVdlsKs4APutvUenHKsrwaLXRE1TxcZuVrXz38GR3WOnor2oS2dS2dgxo7Ebs3XHApOxtI54QR6a7O6djW/QzcM6kszbl0kiSXC45tWy2ClIHkZ92VZyO6vGVplrVGq7jNRqW0dg485KeUhxZLLO7mr3IHIY7+tZdw01Ev8AcFXd3UNrh6eiqREQtDiyWmkjCUJykArIyTjoSSahat22kbdV1GFOlKq7JJvZ48Fuzd8/Q87Bp2PYYUi+L1JZu0cbcjQHO0c2B4jClZ2Z8lKjjA6kVhQNOwtPxEaknXK33OJHWUx2I6lnxh8c0pO5I8kdVEebHfWx1FZYrD0S43yfGYtDTWy32yEtRecbB5AbkjbuPNTh693dUNvd8kXuWhxxDbEdhHZR4zXJthvuSkfOT1J5mvkrQysSMLGti7yU3aXedlu4RT582slmYM2W/Pmvy5LhdffWpxxZ6qUeZNNloz3j2X4E19AUo56Gm40b7x7L8Ca+gK6YXvMrelsVGhSS5/oqDj5wu1VrzU9smWGC3JYjxC04pchDeFbycYUR3Gqp+5z4kfzPH/XWvtU6FFTzz0S/7nPiR/NEf9da+1QPB04kD/0eP+utfap0KKAg2q+G8LXHDuHYLrmPKjMtlqQjClMOpQEkjzjqCO8fFS0X3weNf2eUtEW2t3VgHyXojyeY/NUQoU6FBGaARhjgvxEkO9mnSs5JPe5tQPlJq1+GPg3TIN5j3jWK4+yMoON29lfab1DmO0UOWAe4Zz3mmPwPNXNAVzxv0jeda8PPYqxx0yJfjbTuxTqWxtAVk5UQO8Uuv3OnEgH+J4/6619qnQooCH6C01LtXCe2adu7KWpDcNUd9sLCwM7gRkcjyNLC54OXEUOqCLTHUgEhJ8ca5juPuqc6igK44IaHuOhOH5t92YQxcH5Tkh1CFpWADhKeY5dE/PVGar4B8QLrrG8XCLamFx5U155pRmNAlKlkg4J5cjTdUUAuvA/hFrDRPEJV1vlvajxDDdZ3pkocO4lOBhJz3GvfjTwHuWpL+9qbS4adkSQDKhLWEFSwMb0E8uYAyDjnz76YOigEbj8EuIr8oR06XltqJxucUhKB/eKsVPrv4NF8iaFg+x6WLhqFySVykh4IQ20UckpKsA4PU9+eXIU0uB5q5oBL/udOJGf4nj/rrX2qa9Nmcv8Aw9TZ79GMd2ZAEaW0lYVsUUbVYUORweYNSGigE6vfg2a7t01xu3x4t1jg+Q80+lskd2UrIIPy+utex4PvElbg/wBgJRg9Vy2gPpU6tFAL9xy4U6t1vqK0y7HAakMxoCWHFKkIbwsKJxhRHnqs2PB24jtyG1Gzx8JUCf3615/zqc2igNbe7HB1Fp+VZ7mx20SW12TqM45ecHuIOCD3EUqurPBq1faJrqrElq9wSSWylxLbwHmUlRAz6QfkpvKKARb9xniH2mz2qXDPqTj5c4qY6P8ABo1VdZzTmouyssAEFwdolx9Q8yQnIB9JPLzGm32jzVzQGFaLTDsdmi2u3sJYiRGw002PxUjp6z6aKzaKAKKKKAxbjbYd2gOwrhEZlxXhtcZeQFoUPSDVdai4RyXmGzpnUMi2OxfKhplAyBEP9S7kONpPencpJ/Jqz6KAX96xcbbDepl2it26fMfaQ26uF2QRK28gt1te3KwOQUOeORyOnOm0SbOytjWLa7U3C7RNo8fSmNhL2e32lor3bdxA8wKcdTi/6pXwghtVYcf1/wDkrlVlqwbLXRGH7TjIUr2vfNeTMZ648LLTaXbay7MmR1Oh1bcYuZfx0S4tWMpB6AHHf1qMXviEw/KSuyWZqEGRtjuSCHjHT/VI9wg+nBPpqD5zRVdKrJ5LI9Lo6FoU5a1SUpvxf6yPaXLkz5TkmW+5IfcOVuOKKlK9ZNeNFGK5FzGKirRWRwenxU3GjPePZfgTX0RSjnpTcaM949l+BNfRFS8L3mYrpf8AJpeb9jNvV0astllXF4FSI7ZXtBwVHoE+snA+OsS0X/2T04q4rjGO+yHEvxyvJbcQSFIJ9Y61rtXRp15uNps0QqZbLpmPyFMlxtIawUJI5A5WRyz+LWLabdcrZqK722W6ZTN2YMtElDBbbS7js1pIyQCRtV1586sDzs2itTlOgPbN4r/yQmdhv/o527sfPisfUWpLtZbcq5MWdiTBbZS6tapexYJ7gnac9RzzUbM99fDgaSFquPsyYggFrxZWwHG3f2mNm3HPOak2tobznDy4RI7S33ewShKUJKlKwU9APVQHd/Uc61WZ+derYhhwOIajx40jtlPrVySkcgASeXz15HU11tr8Y36zNwokp1LKX2JXbditRwkODaMAnlkZGa9tXQJcu0w5MJkyJFtltTAwCAXQj3SRnlnBOPSK1N7untwgs2W2QZ6VPPtKkuyIq2UxkIWFqyVgZV5OABnrQG2Z1UlzXcnTjkUthpkOIkb8hxWAooxjkQDnr3UQ9VJm64mafbinZEY7Qyd/JSspykDHduHPNR+8QprOor7eo8N9123vw5bKUIJL6UtqS6hHnJQpQ5d+K72OBMtGo482Yw8tRtD0iQtLZOXVv9opHLqrngDryoDe+2xv26+wPiyuzx2fjW7ye32b+yx59nPOfRXlqXUd4sBU+3Zo8qFvbaS6ZmxZUtQSPJ2nA3Hz1GDpvUitKey/jaBNL/sz4l4r987XO7ZvznO3yMY9FSTWHa3TR8dyNHeUp2TEdDYbO9I7VBOR1GB182KA95eoLla7J47c7Uyy8ZTUdLTUntAUrWlO7dtHTceWO6u90v8ALbvPsPaLemfNS0Hni692TTCCSE7lYJJODgAd1eeuY70nT7SGGnHVidFVtQkqOA8kk8vMKxJL7mmda3C5yYkl63XRlkF+Oyp0sONgjapKcnBBBBA60BmwtTuOIuUefAMO5W5nt3GO03ocQQSlaF45glJHTINYkLXbM3QcrULcRSXojRW9EUvBQrAIGcdCCCDjmDWK2iTe7neb6iHJjxDbDBipebKHHz5S1L2HmBkgDPM860V8sFxj6AizrdEdcfk2pqDPiBJClDYAhe3ruQeX5pPmoC0m1b20qxjcAaisXUmoLkuWq3afivR48l2MFuT9hUUKKScbDjpUoYyI7YIwQkcviqFac0nGlG4S5qbgy+bnIWkJkuspKe1JSdoIBB8+OdAbm5agmNXNq02y3Jm3FTIfdC3uzZYSTgblYJJJBAAHPBNFs1G9IkTYFxg+I3KG125aDvaIdbOcLQvAyMgg5GQawZrjmm9ay7s/Ekv2+5Rmm1PR2lOlhxsq5KSnJ2kK6gdRzrzhCRfdSzr8iHJjQWreqFH7dsoXIJVvUsIPMJGABnrzoDza1reva0jUL+nWRbCyJKlNzgpwN4ySElIBIHdmpkw6l9hDqDlC0hST5wRkVV7WjXm+HtrnNNTpMqOy29Itkl9wtvpHNTfZ5wD3gdMjBBqzYb6JUJl9pK0NuoC0pWkoUAR0IPQ+igIorWF4VHuc1iwNPwLc8804sTQlwhoncQkpx3Zxmt1cdQMwtLm8ttqeQtpC2W/cqcUvAQn0ElQFV6q2Wx1m+sXG3X5ya9OkqaTFbf2LBWSgjH3s59PLz1vpUK/Xg6btT6xGkxGEz5kgsb2w6kBKEY5JJ3EnGfxc0BIIuo0y9HOXwRylTTDjjkcr5pW3ncgn0FJGaxTq1Ug2uLboPjdxnMtyXGg5hEVpQBK3F45dcAYyo1pmIFztLOqrRI3zUzIrk5h5qOUIUtaFJcQAMgHcAcZ57jXjabRI0ZEtV3hMS32JbDTV1YIU46FFI2vAdcpJ2kD8X1UBv5OobwrUc21WuzMSxCbaW467L7L3YJAA2nzGu1x1Bc7TYGZcu1MpmvSm4yYyJWUeWvak79vp81Ry7RbeNfXaRdot3U06xHDDkJEjarCVbslr1jrWVeoke46Jt8W2R7l4sm5R0kOpdD6U9qCpWVeWAM53d1AbdvUlziXeDCvVnbhouDimmXmJXbDeElW1Q2pIyAefOvSPq2O2i7i6oEB20kqeTv3BTRGUOJOBkKHLHn5VqFWAad1nbpyWpdyhP7o4W+4uQ5BcI5LSSThKh5JOOXLng1laosrU/WGmpC4inUB5xL6gDtKEoK0BeORAcAIz30BIbPLlT7SxLmQ/Ennk7ywV7igHoCcDnjGR3HlRWcOlFAFFFFAFFFFAFVBx2tdwuZsniEGTL7Ptt3YtKXtzsxnA5Vb9cd9ficNeOqTcDjJYKvGvFXa/1YUP2q6h/mK5fqq/9KParqD+Yrl+qr/0pvQciio3ZY8zU/F9b7a/LFC9quof5iuX6qv/AErn2q6h/mK5fqq/9KbyivnZY8x8X1vtr8sUL2q6gx/EVy/VV/6U0ukWnGNG2hp1tbbiIjSVIWMFJCRkEd1beua7UqKpu6ZT6V01PSUIwnBK3IKKKK7lCFFFFAFFFFAFFFFAFFFFAFFFFAFFFFAFFFFAFFFFAFFFFAFFFFAFFFFAFFFFAFFFFAFFFFAf/9k=';
    async function generatePDFReport() {
      if (!currentInspection) {
        toast('No inspection data');
        return;
      }
      try { await ensureExcelLibs(); } catch (e) {}
      if (typeof window.jspdf === 'undefined') {
        toast('PDF library not available');
        return;
      }

      updateFindings();

      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'letter' });
      const W = doc.internal.pageSize.getWidth();
      const H = doc.internal.pageSize.getHeight();
      const L = 14;
      const R = W - 14;
      const usable = R - L;
      const footerY = H - 10;
      let y = 20;

      const INK = [20, 20, 24];
      const MUTED = [92, 101, 112];
      const LINE = [228, 230, 234];
      const PAPER = [244, 245, 247];
      const RED = [212, 34, 59];
      const POORC = [198, 40, 40];
      const FAIRC = [184, 134, 11];
      const GOODC = [27, 122, 74];

      const customer = currentInspection.customer || 'Customer';
      const model = currentInspection.model || 'LX-8';
      const serial = currentInspection.serial || '';
      const tech = currentInspection.technician || '';
      const date = currentInspection.date || '';
      const notes = (getNotesPlain() || String(currentInspection.summaryNotes || '').replace(/<[^>]+>/g, ' ')).trim();
      let visit = findRelatedVisit(currentInspection);
      if (!visit) {
        try {
          const live = collectVisit();
          const same = String(live.customer || '').toLowerCase().trim() === String(currentInspection.customer || '').toLowerCase().trim();
          if (same && (live.summary || live.scopeText || live.arrival || (live.findings||[]).length || (live.parts||[]).length)) visit = live;
        } catch (e) {}
      }
      const combined = !!visit;

      function condOf(id) {
        return (results[id] && results[id].condition) || '';
      }
      let nGood = 0, nFair = 0, nPoor = 0, nNa = 0, nAns = 0;
      const items = (APP_DATA && APP_DATA.items) || [];
      items.forEach(it => {
        const c = String(condOf(it.item_id)).toLowerCase();
        if (!c) return;
        nAns++;
        if (c === 'poor' || c === 'fail' || c === 'out of spec') nPoor++;
        else if (c === 'fair') nFair++;
        else if (c === 'n/a') nNa++;
        else nGood++;
      });

      const photoFindings = [];
      findings.forEach(f => {
        const r = results[f.item_id] || f;
        const src = r.photoDataUrl || f.photoDataUrl;
        if (src) photoFindings.push({ src, cap: (f.item_name || '') + (f.notes ? '  ·  ' + f.notes : ''), finding: f });
      });

      function rankScore(f) {
        const im = (f.impacts || []).join(' ').toLowerCase();
        let s = 0;
        if (im.includes('safety')) s += 100;
        if (im.includes('downtime')) s += 50;
        if (im.includes('performance')) s += 20;
        const c = String(f.condition || '').toLowerCase();
        if (c === 'poor' || c === 'fail' || c === 'out of spec') s += 30;
        s += Number(f.severity || 0);
        return s;
      }
      const ranked = findings.slice().sort((a, b) => rankScore(b) - rankScore(a));
      const coverCards = (typeof collectCoverCards === "function" ? collectCoverCards() : []) || currentInspection.coverCards || [];
      const poorList = ranked.filter(f => {
        const c = String(f.condition || '').toLowerCase();
        return c === 'poor' || c === 'fail' || c === 'out of spec';
      });

      function runningHeader() {
        doc.setFillColor(20, 20, 24);
        doc.rect(0, 0, W, 10, 'F');
        doc.setFillColor(212, 34, 59);
        doc.rect(0, 0, 3.2, 10, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.text('LeMatic  ·  Field Service Report', 8, 6.6);
        doc.setFont('helvetica', 'normal');
        const right = (customer + (date ? '  ·  ' + date : (serial ? '  ·  ' + serial : ''))).substring(0, 48);
        doc.text(right, W - 8, 6.6, { align: 'right' });
      }
      function runningFooter() {
        const page = doc.internal.getCurrentPageInfo().pageNumber;
        doc.setFillColor(244, 245, 247);
        doc.rect(0, H - 12, W, 12, 'F');
        doc.setTextColor(92, 101, 112);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7);
        doc.text(combined ? 'Visit report + inspection  ·  Customer copy' : 'Inspection checklist  ·  Customer copy', 8, H - 5);
        doc.text('Page ' + page, W - 8, H - 5, { align: 'right' });
      }
      function paintChrome() {
        runningHeader();
        runningFooter();
      }
      function newPage() {
        doc.addPage();
        paintChrome();
        y = 16;
      }
      function need(h) {
        if (y + h > H - 16) newPage();
      }
      function wrap(text, width, fontSize) {
        doc.setFontSize(fontSize || 9);
        return doc.splitTextToSize(String(text || ''), width);
      }

      paintChrome();
      y = 14;

      // Hero
      doc.setFillColor(20, 20, 24);
      doc.rect(L, y, usable, 36, 'F');
      doc.setTextColor(243, 179, 188);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.text('FIELD SERVICE TRIP REPORT', L + 6, y + 8);
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(18);
      doc.text(customer, L + 6, y + 17);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(208, 213, 219);
      const line2 = [model, serial].filter(Boolean).join('  ·  ');
      const line3 = [date, tech].filter(Boolean).join('  ·  ');
      if (line2) doc.text(line2, L + 6, y + 24);
      if (line3) doc.text(line3, L + 6, y + 29.5);
      try {
        const lw = 34, lh = 11.5;
        const logoTop = y + 6;
        doc.setFillColor(255, 255, 255);
        doc.rect(R - 8 - lw, logoTop, lw, lh, 'F');
        doc.addImage('data:image/jpeg;base64,' + LEMATIC_LOGO_JPG, 'JPEG', R - 8 - lw + 1.1, logoTop + 0.9, lw - 2.2, lh - 1.8);
      } catch (e) {}
      y += 40;

      // Tiles
      const tiles = [
        [String(nAns || items.length), 'ITEMS CHECKED', [42, 48, 54]],
        [String(nPoor), 'POOR', [198, 40, 40]],
        [String(nFair), 'FAIR', [184, 134, 11]],
        [String(nGood), 'GOOD', [31, 78, 58]]
      ];
      const tw = (usable - 9) / 4;
      tiles.forEach((tile, i) => {
        const x = L + i * (tw + 3);
        doc.setFillColor(tile[2][0], tile[2][1], tile[2][2]);
        doc.rect(x, y, tw, 18, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(16);
        doc.text(tile[0], x + tw / 2, y + 9, { align: 'center' });
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(6.5);
        doc.text(tile[1], x + tw / 2, y + 15, { align: 'center' });
      });
      y += 22;

      // Impact graphics
      const impactCount = (name) => findings.filter(f =>
        (f.impacts || []).some(x => String(x).toLowerCase().includes(name))
      ).length;
      const nSafety = impactCount('safety');
      const nDown = impactCount('downtime') + impactCount('down-time');
      const nPerf = impactCount('performance');
      const impacts = [
        { n: nSafety, label: 'SAFETY', color: [198, 40, 40], icon: 'safety' },
        { n: nDown, label: 'DOWNTIME', color: [184, 134, 11], icon: 'down' },
        { n: nPerf, label: 'PERFORMANCE', color: [37, 99, 180], icon: 'perf' }
      ];
      doc.setTextColor(92, 101, 112);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.text('IMPACT', L, y);
      y += 3;
      const iw = (usable - 6) / 3;
      impacts.forEach((imp, i) => {
        const x = L + i * (iw + 3);
        doc.setFillColor(248, 249, 251);
        doc.roundedRect(x, y, iw, 20, 1.2, 1.2, 'F');
        const cx = x + 10;
        const cy = y + 10;
        doc.setFillColor(imp.color[0], imp.color[1], imp.color[2]);
        if (imp.icon === 'safety') {
          doc.triangle(cx, cy - 5, cx - 5, cy + 4.2, cx + 5, cy + 4.2, 'F');
          doc.setTextColor(255, 255, 255);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(7);
          doc.text('!', cx, cy + 2.4, { align: 'center' });
        } else if (imp.icon === 'down') {
          doc.circle(cx, cy, 5.1, 'F');
          doc.setFillColor(248, 249, 251);
          doc.rect(cx - 1.8, cy - 2.6, 1.2, 5.2, 'F');
          doc.rect(cx + 0.6, cy - 2.6, 1.2, 5.2, 'F');
        } else {
          doc.rect(cx - 4.2, cy + 1.6, 2.2, 3.2, 'F');
          doc.rect(cx - 1.1, cy - 0.6, 2.2, 5.4, 'F');
          doc.rect(cx + 2.0, cy - 3.4, 2.2, 8.2, 'F');
        }
        doc.setTextColor(20, 20, 24);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(14);
        doc.text(String(imp.n), x + 20, y + 9);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(6.4);
        doc.setTextColor(92, 101, 112);
        doc.text(imp.label, x + 20, y + 15);
      });
      y += 24;

      // Featured photos
      const feat = photoFindings.slice(0, 2);
      if (feat.length) {
        const pw = (usable - 4) / 2;
        const ph = 42;
        feat.forEach((p, i) => {
          const x = L + i * (pw + 4);
          doc.setFillColor(244, 245, 247);
          doc.rect(x, y, pw, ph + 10, 'F');
          try {
            doc.addImage(p.src, 'JPEG', x + 1.5, y + 1.5, pw - 3, ph);
          } catch (e) {
            try { doc.addImage(p.src, 'PNG', x + 1.5, y + 1.5, pw - 3, ph); } catch (e2) {}
          }
          doc.setTextColor(92, 101, 112);
          doc.setFontSize(6.5);
          const cap = wrap(p.cap, pw - 4, 6.5);
          doc.text(cap.slice(0, 2), x + 2, y + ph + 5);
        });
        y += ph + 14;
      }

      // Three cover action cards
      if (coverCards.length) {
        const cw = (usable - 8) / 3;
        const ch = 28;
        coverCards.forEach((f, i) => {
          const x = L + i * (cw + 4);
          doc.setFillColor(255, 255, 255);
          doc.setDrawColor(228, 230, 234);
          doc.rect(x, y, cw, ch, 'FD');
          doc.setFillColor(198, 40, 40);
          doc.rect(x, y, 1.6, ch, 'F');
          const tag = (f.tag || f.condition || 'REPAIR').toUpperCase();
          doc.setTextColor(198, 40, 40);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(6.5);
          doc.text(String(tag).substring(0, 16), x + 4, y + 6);
          doc.setTextColor(20, 20, 24);
          doc.setFontSize(8);
          const title = wrap(f.title || f.item_name || '', cw - 7, 8);
          doc.text(title.slice(0, 2), x + 4, y + 12);
          doc.setTextColor(92, 101, 112);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(6.5);
          const body = wrap(f.body || f.notes || '', cw - 7, 6.5);
          doc.text(body.slice(0, 2), x + 4, y + 21);
        });
        y += 32;
      }

      doc.setTextColor(92, 101, 112);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.text('Primary findings, photos, and the full checklist start on the next page.', L, y);

      // On site / notes
      newPage();
      doc.setTextColor(212, 34, 59);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.text('ON SITE', L, y);
      y += 6;
      doc.setTextColor(20, 20, 24);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(16);
      doc.text('On site', L, y);
      y += 6;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(92, 101, 112);
      doc.text([date, tech].filter(Boolean).join('  ·  ') || '', L, y);
      y += 8;
      if (notes) {
        doc.setTextColor(20, 20, 24);
        doc.setFontSize(9.5);
        const lines = wrap(notes, usable, 9.5);
        lines.forEach(line => {
          need(6);
          doc.text(line, L, y);
          y += 5;
        });
      } else {
        doc.setTextColor(92, 101, 112);
        doc.setFontSize(9);
        doc.text('No summary notes recorded for this inspection.', L, y);
        y += 8;
      }

      if (combined) {
        function writePara(titleKicker, title, body) {
          if (!body) return;
          need(20);
          doc.setTextColor(212, 34, 59);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8);
          doc.text(titleKicker, L, y);
          y += 6;
          doc.setTextColor(20, 20, 24);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(16);
          doc.text(title, L, y);
          y += 8;
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(9.5);
          String(body).split('\n').forEach(para => {
            if (!para.trim()) { y += 3; return; }
            wrap(para, usable, 9.5).forEach(line => {
              need(6);
              doc.text(line, L, y);
              y += 5;
            });
            y += 2;
          });
          y += 4;
        }
        newPage();
                const letter = visit.letter || visit.arrival || visitNarrative(visit);
        const done = visit.done || [visit.inspectIntro, tripPlainBlocks(visit.inspectBlocks), visit.prodIntro, tripPlainBlocks(visit.prodBlocks)].filter(Boolean).join('\n\n');
        const order = visit.order || visitPartsText(visit);
        const close = visit.close || visit.summary || '';
        writePara('VISIT LETTER', 'What happened on site', String(letter || '').replace(/<[^>]+>/g, ' ').trim());
        if (done) writePara('ON SITE', 'Completed on site', done);
        if (order) writePara('ORDER NOW', 'Parts to order', order);
        if (close) writePara('CONCLUSION', 'Conclusion', close);
        const vphotos = (visit.photos || []).map(ph => (typeof ph === 'string' ? ph : (ph && ph.url) || '')).filter(Boolean);
        if (vphotos.length) {
          need(56);
          doc.setTextColor(212, 34, 59);
          doc.setFontSize(8);
          doc.text('TRIP PHOTOS', L, y);
          y += 6;
          const pw = (usable - 4) / 2;
          const ph = 42;
          vphotos.slice(0, 4).forEach((src, i) => {
            if (i === 2) { y += ph + 8; }
            need(ph + 8);
            const x = L + (i % 2) * (pw + 4);
            try { doc.addImage(src, 'JPEG', x, y, pw, ph); }
            catch (e) { try { doc.addImage(src, 'PNG', x, y, pw, ph); } catch (e2) {} }
          });
          y += ph + 10;
        }
      }

      // Primary findings
      newPage();
      doc.setTextColor(20, 20, 24);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(16);
      doc.text('Primary findings', L, y);
      y += 6;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(92, 101, 112);
      doc.text('Poor and fail items, ranked by safety, then downtime, then performance.', L, y);
      y += 8;

      function chip(label, x, yy, tone) {
        const bg = tone === 'poor' ? [253, 236, 234] : [255, 246, 217];
        const fg = tone === 'poor' ? [198, 40, 40] : [184, 134, 11];
        doc.setFillColor(bg[0], bg[1], bg[2]);
        doc.roundedRect(x, yy - 4, 16, 6, 1, 1, 'F');
        doc.setTextColor(fg[0], fg[1], fg[2]);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(6.5);
        doc.text(String(label || '').toUpperCase().substring(0, 8), x + 8, yy, { align: 'center' });
      }

      function findingCard(f) {
        const r = results[f.item_id] || f;
        const src = r.photoDataUrl || f.photoDataUrl;
        const bodyLines = wrap(f.notes || 'No note recorded.', usable - 10, 9);
        const photoH = src ? 48 : 0;
        const h = 16 + bodyLines.length * 4.2 + photoH + (src ? 8 : 4);
        need(Math.min(h, 70));
        const boxH = Math.min(h, H - 16 - y);
        doc.setDrawColor(228, 230, 234);
        doc.setFillColor(255, 255, 255);
        doc.rect(L, y, usable, h, 'FD');
        doc.setFillColor(198, 40, 40);
        doc.rect(L, y, 1.8, h, 'F');
        doc.setTextColor(20, 20, 24);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.text(String(f.item_name || '').substring(0, 62), L + 5, y + 7);
        const c = String(f.condition || 'Poor');
        chip(c, R - 22, y + 7, /poor|fail|out/i.test(c) ? 'poor' : 'fair');
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.setTextColor(92, 101, 112);
        const meta = [f.section, (f.impacts || []).join('  ·  ')].filter(Boolean).join('  ·  ');
        doc.text(meta.substring(0, 90), L + 5, y + 13);
        doc.setTextColor(20, 20, 24);
        doc.setFontSize(9);
        let yy = y + 19;
        bodyLines.forEach(line => {
          doc.text(line, L + 5, yy);
          yy += 4.2;
        });
        if (src) {
          try {
            doc.addImage(src, 'JPEG', L + 5, yy, 70, 42);
          } catch (e) {
            try { doc.addImage(src, 'PNG', L + 5, yy, 70, 42); } catch (e2) {}
          }
        }
        y += h + 4;
      }

      if (!poorList.length) {
        doc.setTextColor(27, 122, 74);
        doc.setFontSize(9);
        doc.text('No Poor items on this inspection.', L, y);
        y += 8;
      } else {
        poorList.forEach(findingCard);
      }


      // Checklist appendix — match customer example
      newPage();
      doc.setTextColor(20, 20, 24);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(16);
      doc.text('Point-by-point inspection', L, y);
      y += 6;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(92, 101, 112);
      doc.text((model || 'Machine') + (serial ? '  ·  S/N ' + serial : ''), L, y);
      y += 5;
      const intro = wrap('Every checkpoint on this machine, with result and notes.', usable, 8);
      intro.forEach(line => { doc.text(line, L, y); y += 4; });
      y += 3;

      function resultStyle(raw) {
        const v = String(raw || '').trim().toLowerCase();
        if (v === 'good' || v === 'pass' || v === 'within spec') {
          return { label: v === 'pass' ? 'PASS' : (v === 'within spec' ? 'IN SPEC' : 'GOOD'), bg: [229, 246, 238], fg: [27, 122, 74] };
        }
        if (v === 'fair') return { label: 'FAIR', bg: [255, 246, 217], fg: [184, 134, 11] };
        if (v === 'poor' || v === 'fail' || v === 'out of spec' || v === 'damaged') {
          return { label: v === 'fail' ? 'FAIL' : (v === 'out of spec' ? 'OUT OF SPEC' : 'POOR'), bg: [253, 236, 234], fg: [198, 40, 40] };
        }
        if (v === 'n/a' || v === 'na') return { label: 'N/A', bg: [244, 245, 247], fg: [113, 128, 150] };
        if (!v || v === '—') return { label: '—', bg: [255, 255, 255], fg: [160, 174, 192] };
        return { label: String(raw).toUpperCase().substring(0, 10), bg: [244, 245, 247], fg: [20, 20, 24] };
      }

      const sections = (APP_DATA && APP_DATA.sections) || [];
      sections.forEach(sec => {
        const secItems = items.filter(i => {
          if (i.section_id !== sec.section_id) return false;
          const r = results[i.item_id] || {};
          const name = String(i.inspection_item || '');
          if (/^other:?$/i.test(name.trim()) && !r.condition && !r.notes) return false;
          return true;
        });
        if (!secItems.length) return;
        need(22);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(20, 20, 24);
        doc.text(sec.section.replace(/ Section$/,'') , L, y);
        y += 3;
        const body = secItems.map(it => {
          const r = results[it.item_id] || {};
          return [it.inspection_item, r.condition || '', r.notes || '—'];
        });
        doc.autoTable({
          startY: y,
          margin: { left: L, right: 14, bottom: 16 },
          head: [['Item', 'Result', 'Notes']],
          body,
          theme: 'plain',
          styles: {
            fontSize: 8,
            cellPadding: { top: 2.2, bottom: 2.2, left: 2.4, right: 2.4 },
            valign: 'middle',
            textColor: [20, 20, 24],
            lineColor: [228, 230, 234],
            lineWidth: 0.15
          },
          headStyles: {
            fillColor: [244, 245, 247],
            textColor: [92, 101, 112],
            fontStyle: 'bold',
            fontSize: 7.5
          },
          columnStyles: {
            0: { cellWidth: 62 },
            1: { cellWidth: 32, halign: 'center', valign: 'middle', fontStyle: 'bold', fontSize: 6.4, overflow: 'linebreak' },
            2: { cellWidth: 'auto' }
          },
          didParseCell: function(data) {
            if (data.section === 'head' && data.column.index === 1) {
              data.cell.styles.halign = 'center';
              return;
            }
            if (data.section !== 'body' || data.column.index !== 1) return;
            const st = resultStyle(data.cell.raw);
            data.cell.styles.fillColor = st.bg;
            data.cell.styles.textColor = st.fg;
            data.cell.styles.fontStyle = 'bold';
            data.cell.styles.halign = 'center';
            data.cell.styles.valign = 'middle';
            data.cell.styles.fontSize = st.label.length > 6 ? 6.2 : 7;
            data.cell.styles.overflow = 'linebreak';
            data.cell.styles.cellPadding = { top: 2.4, bottom: 2.4, left: 1.2, right: 1.2 };
            data.cell.text = [st.label];
          }
        });
        y = doc.lastAutoTable.finalY + 8;
      });

      const pageCount = doc.internal.getNumberOfPages();
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        runningFooter();
      }

      const safeName = (customer || 'Inspection').replace(/[^a-z0-9]/gi, '_').substring(0, 30);
      doc.save((combined ? 'LeMatic_Visit_Inspection_' : 'LeMatic_Inspection_') + safeName + '_' + (date || 'report') + '.pdf');
      toast(combined ? 'Combined visit + inspection PDF downloaded' : 'PDF report downloaded');
    }





    async function generateInspectionExcel() {
      if (!currentInspection) { toast('No inspection data'); return; }
      if (typeof updateFindings === 'function') updateFindings();
      await ensureExcelLibs();
      if (typeof ExcelJS === 'undefined') { toast('Excel library not available'); return; }
      const customer = currentInspection.customer || 'Customer';
      const model = currentInspection.model || '';
      const serial = currentInspection.serial || '';
      const tech = currentInspection.technician || '';
      const date = currentInspection.date || '';
      const job = currentInspection.jobId ? (loadJobs().find(j => j.id === currentInspection.jobId) || null) : null;
      const items = (APP_DATA && APP_DATA.items) || [];
      const sections = (APP_DATA && APP_DATA.sections) || [];
      const sectionName = (id) => {
        const s = sections.find(x => x.section_id === id);
        return s ? (s.name || s.title || '') : '';
      };
      const wb = new ExcelJS.Workbook();
      wb.creator = 'LeMatic Field Service';
      const ws = wb.addWorksheet('Inspection', { views: [{ state: 'frozen', ySplit: 8 }] });
      ws.columns = [
        { width: 22 }, { width: 36 }, { width: 14 }, { width: 28 }, { width: 36 }
      ];
      const title = ws.getRow(1);
      title.getCell(1).value = 'LeMatic Field Service Inspection';
      title.getCell(1).font = { bold: true, size: 16, color: { argb: 'FF141418' } };
      ws.mergeCells('A1:E1');
      const meta = [
        ['Customer', customer],
        ['Machine', model],
        ['Serial', serial],
        ['Technician', tech],
        ['Date', date],
        ['Sales order', job && job.so ? job.so : (currentInspection.so || '')],
        ['Job site', job && job.site ? job.site : '']
      ];
      meta.forEach((pair, i) => {
        const row = ws.getRow(2 + i);
        row.getCell(1).value = pair[0];
        row.getCell(1).font = { bold: true, color: { argb: 'FF5C656F' } };
        row.getCell(2).value = pair[1] || '—';
        ws.mergeCells(2 + i, 2, 2 + i, 5);
      });
      const head = ws.getRow(10);
      ['Section', 'Item', 'Condition', 'Notes', 'Finding'].forEach((h, i) => {
        const c = head.getCell(i + 1);
        c.value = h;
        c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF141418' } };
      });
      const condOf = (id) => (results[id] && results[id].condition) || '';
      const notesOf = (id) => (results[id] && (results[id].notes || results[id].comment)) || '';
      items.forEach((it, idx) => {
        const row = ws.getRow(11 + idx);
        row.getCell(1).value = sectionName(it.section_id);
        row.getCell(2).value = it.name || it.title || it.item_id;
        row.getCell(3).value = condOf(it.item_id) || '';
        row.getCell(4).value = notesOf(it.item_id);
        const f = (findings || []).find(x => x.item_id === it.item_id);
        row.getCell(5).value = f ? (f.notes || f.item_name || '') : '';
      });
      const safe = String(customer).replace(/[\\/:*?"<>|]/g, '-').trim() || 'Inspection';
      for (let r = firstDataRow + items.length; r <= lastTemplateRow; r++) {
        clearUnusedRow(ws.getRow(r));
      }

      const out = await wb.xlsx.writeBuffer();
      const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'LeMatic_Inspection_' + safe + '_' + (date || 'report') + '.xlsx';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      toast('Excel report downloaded');
    }

    async function generateWordReport() {
      if (!currentInspection) { toast('No inspection data'); return; }
      updateFindings();
      generateWordHtmlDoc();
    }

    function crc32Bytes(u8) {
      let c = ~0;
      for (let i = 0; i < u8.length; i++) {
        c ^= u8[i];
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
      }
      return (~c) >>> 0;
    }
    function zipStore(files) {
      window.zipStore = zipStore;
      window.crc32Bytes = crc32Bytes;
      const enc = new TextEncoder();
      const parts = [];
      const central = [];
      let offset = 0;
      files.forEach(f => {
        const name = enc.encode(f.name);
        const data = (typeof f.data === 'string') ? enc.encode(f.data) : f.data;
        const crc = crc32Bytes(data);
        const local = new Uint8Array(30 + name.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, data.length, true);
        lv.setUint32(22, data.length, true);
        lv.setUint16(26, name.length, true);
        local.set(name, 30);
        parts.push(local, data);
        const cen = new Uint8Array(46 + name.length);
        const cv = new DataView(cen.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, data.length, true);
        cv.setUint32(24, data.length, true);
        cv.setUint16(28, name.length, true);
        cv.setUint32(42, offset, true);
        cen.set(name, 46);
        central.push(cen);
        offset += local.length + data.length;
      });
      const cenStart = offset;
      let cenSize = 0;
      central.forEach(c => { parts.push(c); cenSize += c.length; });
      const end = new Uint8Array(22);
      const ev = new DataView(end.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, files.length, true);
      ev.setUint16(10, files.length, true);
      ev.setUint32(12, cenSize, true);
      ev.setUint32(16, cenStart, true);
      parts.push(end);
      let total = 0;
      parts.forEach(p => total += p.length);
      const out = new Uint8Array(total);
      let o = 0;
      parts.forEach(p => { out.set(p, o); o += p.length; });
      return out;
    }
    function generateWordHtmlDoc() {
      if (!currentInspection) return;
      const customer = currentInspection.customer || 'Customer';
      const model = currentInspection.model || 'LX-8';
      const serial = currentInspection.serial || '';
      const tech = currentInspection.technician || '';
      const date = currentInspection.date || '';
      const notes = (typeof getNotesPlain === 'function' ? getNotesPlain() : '') || String(currentInspection.summaryNotes || '').replace(/<[^>]+>/g, ' ').trim();
      const items = (APP_DATA && APP_DATA.items) || [];
      const sections = (APP_DATA && APP_DATA.sections) || [];
      const ICON_B64 = {
        safety: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABa0lEQVR4nO1auw7CMBBrET/TASGx8f8DGxJi6K+AGGA6CVWkzePunBB7pO2dYzupOBgfz9d76Bg7NAE0KACaABoUAE0ADbgA1+MB2h8qgCweKQI8AWjABFi6jkoBE4BoGnIbkQImwLvhlsveKWACPJvFuuuZAibAq1Gqq14pYAI8muS66ZECcwFKF2EtQvdbYLScCofcO89z8JnLNP38/HS7q3BaovsEmAmgvXetzgImwKKolVsWdZkA7YLW723t+kyAZjGvLzCafdQE8J7kaPXjFtAogprpa/RlAkoLoH/cLO3PBJQ8jHZfUMKj+wRkD0Rqcf8bOUOT7hOQJUCN7g9DHq+9AY9N5MwErZCcgFrdF6TySxKg9sULUnjyEIy9sRX3BbF8mYCYm1pzXxDDG/Ia9H7VrWEzAa26L9jizzNg7WLr7gvW1sEEhC78i/uC0HpM/yDRArgF0ATQoABoAmhQADQBNCgAmgAaH1wjVlChn5+sAAAAAElFTkSuQmCC',
        down: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABY0lEQVR4nO2bSw4CIRBEHeMBPJJ38hzeySO51LjQFYkhZugfVBPqrRGqa4pPRmZ7vt6fw8Ic0QLQ0AC0ADQ0AC0ADQ1AC0BzGj3g/XZutrlcH911FLbeByFJwS16GtLNgIjCa3oYEW5Aj8JrIo0IXQRHFB89TkgCRhX+D28a3AlAFh8xvssAdPEFjw6zAVmKL1j1mAzIVnzBomv5o7DagKxPv6DVp9oGNZ3vbU97/Vh/p+nnF04BacPs0a+R6mUCJI1me/oFiW4mAC0ADQ1oNZh1/hda+pkAtAA0NAAtAA0NQAtAQwPQAtA0DRj5R2UPWvqZALQANDRA0mjWdUCimwmQNpwtBXwtLkR9P2CGFySatKoTkH0qaPUtPwVMBmRNgUWXOQHZTLDqcU2BLCZ4dLjXALQJ3vFDL0qO3CKjjA/dBUalIXIc3hXmbfHB3w0u971AdngURgtAQwPQAtDQALQANF9eD4x7xDKd6AAAAABJRU5ErkJggg==',
        perf: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAyUlEQVR4nO3bsQlCQRAAURXbsQ57sSB7sQ6bUQy0BP0f9Ak7E9/BMGywF9z2dn88N4PZaQFNAbSApgBaQFMALaApgBbQFEALaAqgBTR7LfCOw+my+M71fPz47PgJKIAW0BRAC2gKoAU0BdACmgJoAc3P3gLf3unXMn4CCqAFNAXQApoCaAFNAbSAZvEm+K8b3VrGT0ABtICmAFpAUwAtoCmAFtAUQAtoCqAFNAXQApoCaAHN+ADbvs0NpwBaQFMALaApgBbQjA/wAv4sEVtu4y33AAAAAElFTkSuQmCC'
      };
      function condOf(id) { return (results[id] && results[id].condition) || ''; }
      function xml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
      function iconDrawing(rid, name) {
        const cx = 365760, cy = 365760;
        return '<w:r><w:rPr><w:noProof/></w:rPr><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="' + rid.replace('rId','') + '" name="' + name + '"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="' + name + '.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
      }
      function resultLabel(raw) {
        const v = String(raw || '').trim().toLowerCase();
        if (v === 'pass') return 'PASS';
        if (v === 'within spec') return 'IN SPEC';
        if (v === 'out of spec') return 'OUT OF SPEC';
        if (v === 'good') return 'GOOD';
        if (v === 'fair') return 'FAIR';
        if (v === 'poor') return 'POOR';
        if (v === 'fail') return 'FAIL';
        if (v === 'n/a' || v === 'na') return 'N/A';
        if (!v) return '—';
        return String(raw).toUpperCase();
      }
      function resultFill(raw) {
        const v = String(raw || '').trim().toLowerCase();
        if (v === 'good' || v === 'pass' || v === 'within spec') return 'E5F6EE';
        if (v === 'fair') return 'FFF6D9';
        if (v === 'poor' || v === 'fail' || v === 'out of spec') return 'FDECEA';
        return 'F4F5F7';
      }
      function resultColor(raw) {
        const v = String(raw || '').trim().toLowerCase();
        if (v === 'good' || v === 'pass' || v === 'within spec') return '1B7A4A';
        if (v === 'fair') return 'B8860B';
        if (v === 'poor' || v === 'fail' || v === 'out of spec') return 'C62828';
        return '718096';
      }
      let nGood = 0, nFair = 0, nPoor = 0, nAns = 0;
      items.forEach(it => {
        const c = String(condOf(it.item_id)).toLowerCase();
        if (!c) return;
        nAns++;
        if (c === 'poor' || c === 'fail' || c === 'out of spec') nPoor++;
        else if (c === 'fair') nFair++;
        else if (c !== 'n/a' && c !== 'na') nGood++;
      });
      const impactCount = (name) => (findings || []).filter(f => (f.impacts || []).some(x => String(x).toLowerCase().includes(name))).length;
      const ranked = (findings || []).filter(f => {
        const c = String(f.condition || '').toLowerCase();
        return c === 'poor' || c === 'fail' || c === 'out of spec';
      });

      function run(text, o) {
        o = o || {};
        return '<w:r><w:rPr><w:noProof/>' + (o.bold ? '<w:b/>' : '') + '<w:sz w:val="' + (o.size || 22) + '"/><w:szCs w:val="' + (o.size || 22) + '"/>' + (o.color ? '<w:color w:val="' + o.color + '"/>' : '<w:color w:val="141418"/>') + '<w:u w:val="none"/><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr><w:t xml:space="preserve">' + xml(text) + '</w:t></w:r>';
      }
      function para(runsXml, o) {
        o = o || {};
        return '<w:p><w:pPr><w:keepNext w:val="0"/><w:spacing w:before="' + (o.before || 0) + '" w:after="' + (o.after || 60) + '"/>' + (o.center ? '<w:jc w:val="center"/>' : '') + (o.right ? '<w:jc w:val="right"/>' : '') + '</w:pPr>' + (runsXml || '') + '</w:p>';
      }
      function p(text, o) { return para(run(text, o), o); }
      function emptyP() { return '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>'; }
      function strut(color) {
        return para(run(new Array(92).join('\u00A0'), { size: 4, color: color || 'FFFFFF' }), { after: 0 });
      }
      function tc(inner, dxa, fill, extra) {
        return '<w:tc><w:tcPr><w:tcW w:w="' + dxa + '" w:type="dxa"/>' + (fill ? '<w:shd w:val="clear" w:color="auto" w:fill="' + fill + '"/>' : '') + (extra || '') + '<w:vAlign w:val="center"/><w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tcMar></w:tcPr>' + (inner || emptyP()) + '</w:tc>';
      }
      function resultCell(label, raw, dxa) {
        const fill = resultFill(raw);
        const color = resultColor(raw);
        const inner = '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="60" w:after="60" w:line="276" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="' + fill + '"/></w:pPr>' + run(label, { size: 16, bold: true, color: color }) + '</w:p>';
        return '<w:tc><w:tcPr><w:tcW w:w="' + dxa + '" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="' + fill + '"/><w:vAlign w:val="center"/><w:tcBorders><w:top w:val="single" w:sz="12" w:color="' + fill + '"/><w:left w:val="single" w:sz="4" w:color="D0D4DA"/><w:bottom w:val="single" w:sz="12" w:color="' + fill + '"/><w:right w:val="single" w:sz="4" w:color="D0D4DA"/></w:tcBorders><w:tcMar><w:top w:w="0" w:type="dxa"/><w:left w:w="40" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="40" w:type="dxa"/></w:tcMar></w:tcPr>' + inner + '</w:tc>';
      }
      function makeTbl(widths, rowsXml, bordered) {
        const total = widths.reduce(function(a, b) { return a + b; }, 0);
        const borders = bordered
          ? '<w:top w:val="single" w:sz="4" w:space="0" w:color="D0D4DA"/><w:left w:val="single" w:sz="4" w:space="0" w:color="D0D4DA"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="D0D4DA"/><w:right w:val="single" w:sz="4" w:space="0" w:color="D0D4DA"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="D0D4DA"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="D0D4DA"/>'
          : '<w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/>';
        return '<w:tbl><w:tblPr><w:tblW w:w="' + total + '" w:type="dxa"/><w:tblW w:w="5000" w:type="pct"/><w:tblLayout w:type="fixed"/><w:tblBorders>' + borders + '</w:tblBorders></w:tblPr><w:tblGrid>' + widths.map(function(w) { return '<w:gridCol w:w="' + w + '"/>'; }).join('') + '</w:tblGrid>' + rowsXml + '</w:tbl>';
      }

      const FULL = 10800;
      let body = '';

      body += makeTbl([7600, 3200], '<w:tr>' +
        tc(
          strut('141418') +
          p('FIELD SERVICE INSPECTION', { size: 16, color: 'F3B3BC', after: 40 }) +
          p(customer, { size: 36, bold: true, color: 'FFFFFF', after: 40 }) +
          p([model.replace('-', '\u2011'), serial ? 'S/N ' + serial : ''].filter(Boolean).join('   '), { size: 18, color: 'D0D5DB', after: 20 }) +
          p([tech, date].filter(Boolean).join('   '), { size: 18, color: 'D0D5DB', after: 20 }),
          7600, '141418') +
        tc('<w:p><w:pPr><w:jc w:val="right"/><w:spacing w:before="120" w:after="0"/></w:pPr>' + (function(){
          const cx=1371600, cy=457200;
          return '<w:r><w:rPr><w:noProof/></w:rPr><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:docPr id="21" name="LeMatic logo"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="lematic-logo.jpg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdLogoDoc"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
        })() + '</w:p>', 3200, '141418') +
      '</w:tr>');
      body += p('', { after: 160 });

      const tiles = [
        [String(nAns), 'ITEMS CHECKED', '2A3036'],
        [String(nPoor), 'POOR', 'C62828'],
        [String(nFair), 'FAIR', 'B8860B'],
        [String(nGood), 'GOOD', '1F4E3A']
      ];
      const tw = 2700;
      body += makeTbl([tw, tw, tw, tw], '<w:tr>' + tiles.map(function(tile) {
        return tc(strut(tile[2]) + p(tile[0], { size: 32, bold: true, color: 'FFFFFF', center: true, after: 40 }) + p(tile[1], { size: 13, color: 'FFFFFF', center: true, after: 20 }), tw, tile[2]);
      }).join('') + '</w:tr>');
      body += p('', { after: 160 });

      body += p('IMPACT', { size: 16, bold: true, color: '5C6570', after: 80 });
      const impacts = [
        [String(impactCount('safety')), 'SAFETY', 'C62828', 'rId5', 'safety'],
        [String(impactCount('downtime') + impactCount('down-time')), 'DOWNTIME', 'B8860B', 'rId6', 'down'],
        [String(impactCount('performance')), 'PERFORMANCE', '2563B4', 'rId7', 'perf']
      ];
      const iw = 3600;
      body += makeTbl([iw, iw, iw], '<w:tr>' + impacts.map(function(imp) {
        const iconP = '<w:p><w:pPr><w:spacing w:after="40"/><w:jc w:val="left"/></w:pPr>' + iconDrawing(imp[3], imp[4]) + run('  ' + imp[0], { size: 28, bold: true, color: imp[2] }) + '</w:p>';
        return tc(strut('F8F9FB') + iconP + p(imp[1], { size: 14, color: '5C6570', after: 20 }), iw, 'F8F9FB');
      }).join('') + '</w:tr>');
      body += p('', { after: 200 });

      if (notes) {
        body += p('SUMMARY NOTES', { size: 16, bold: true, color: '5C6570', after: 80 });
        notes.split(/\n+/).forEach(function(line) { body += p(line, { size: 22, after: 80 }); });
        body += p('', { after: 120 });
      }

      body += p('Primary findings', { size: 32, bold: true, after: 40 });
      body += p('Poor and fail items, ranked by safety, then downtime, then performance.', { size: 18, color: '5C6570', after: 160 });
      if (!ranked.length) {
        body += p('No Poor items on this inspection.', { size: 22, color: '1B7A4A' });
      } else {
        ranked.forEach(function(f) {
          const label = resultLabel(f.condition);
          const fill = resultFill(f.condition);
          const color = resultColor(f.condition);
          const titleP = '<w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="10080"/></w:tabs><w:spacing w:after="40"/></w:pPr>' +
            run(f.item_name || '', { size: 22, bold: true }) +
            '<w:r><w:tab/></w:r>' +
            run(label, { size: 16, bold: true, color: color }) +
          '</w:p>';
          const metaP = p([f.section, (f.impacts || []).join('  |  ')].filter(Boolean).join('   '), { size: 16, color: '5C6570', after: 40 });
          const noteP = p(f.notes || 'No note recorded.', { size: 20, after: 40 });
          const cell = '<w:tc><w:tcPr><w:tcW w:w="' + FULL + '" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="FFFFFF"/><w:tcBorders><w:top w:val="nil"/><w:left w:val="single" w:sz="48" w:space="0" w:color="C62828"/><w:bottom w:val="nil"/><w:right w:val="nil"/></w:tcBorders><w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="160" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar></w:tcPr>' + titleP + metaP + noteP + '</w:tc>';
          body += makeTbl([FULL], '<w:tr>' + cell + '</w:tr>');
          body += p('', { after: 80 });
        });
      }

      body += p('Point-by-point inspection', { size: 32, bold: true, before: 200, after: 40 });
      body += p([model.replace('-', '\u2011'), serial ? 'S/N ' + serial : ''].filter(Boolean).join('   '), { size: 18, color: '5C6570', after: 160 });
      const cItem = 4800, cRes = 1800, cNote = 4200;
      sections.forEach(function(sec) {
        const secItems = items.filter(function(it) { return it.section_id === sec.section_id; });
        if (!secItems.length) return;
        body += p(sec.section, { size: 26, bold: true, before: 160, after: 80 });
        let rows = '<w:tr>' +
          tc(strut('F4F5F7') + p('Item', { size: 16, bold: true, color: '5C6570', after: 20 }), cItem, 'F4F5F7') +
          tc(p('Result', { size: 16, bold: true, color: '5C6570', center: true, after: 20 }), cRes, 'F4F5F7') +
          tc(p('Notes', { size: 16, bold: true, color: '5C6570', after: 20 }), cNote, 'F4F5F7') +
        '</w:tr>';
        secItems.forEach(function(it) {
          const r = results[it.item_id] || {};
          rows += '<w:tr>' +
            tc(p(it.inspection_item, { size: 18, after: 20 }), cItem, 'FFFFFF') +
            resultCell(resultLabel(r.condition), r.condition, cRes) +
            tc(p(r.notes || '', { size: 18, after: 20 }), cNote, 'FFFFFF') +
          '</w:tr>';
        });
        body += makeTbl([cItem, cRes, cNote], rows, true);
      });

      body += '<w:sectPr><w:headerReference w:type="default" r:id="rId1"/><w:footerReference w:type="default" r:id="rId2"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360"/></w:sectPr>';

      const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>' + body + '</w:body></w:document>';
      const headerInner = '<w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="10080"/></w:tabs><w:spacing w:before="40" w:after="40"/></w:pPr>' +
        run('LeMatic  ·  Field Service Report', { size: 16, bold: true, color: 'FFFFFF' }) +
        '<w:r><w:tab/></w:r>' +
        run((customer + (date ? '  ·  ' + date : (serial ? '  ·  ' + serial : ''))).substring(0, 48), { size: 16, color: 'D0D5DB' }) +
      '</w:p>';
      const headerCell = '<w:tc><w:tcPr><w:tcW w:w="' + FULL + '" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="141418"/><w:tcBorders><w:top w:val="nil"/><w:left w:val="single" w:sz="48" w:space="0" w:color="D4223B"/><w:bottom w:val="nil"/><w:right w:val="nil"/></w:tcBorders><w:tcMar><w:top w:w="40" w:type="dxa"/><w:left w:w="160" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar></w:tcPr>' + headerInner + '</w:tc>';
      const headerXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        makeTbl([FULL], '<w:tr>' + headerCell + '</w:tr>') +
      '</w:hdr>';
      const footerXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        makeTbl([FULL], '<w:tr>' + tc(strut('F4F5F7') + p('Inspection checklist   Customer copy', { size: 14, color: '5C6570', after: 20 }), FULL, 'F4F5F7') + '</w:tr>') +
      '</w:ftr>';
      const stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/><w:noProof/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>';
      const settingsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:hideSpellingErrors w:val="true"/><w:hideGrammaticalErrors w:val="true"/><w:proofState w:spelling="clean" w:grammar="clean"/><w:zoom w:percent="100"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>';
      const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>';
      const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
      const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/icon-safety.png"/><Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/icon-down.png"/><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/icon-perf.png"/><Relationship Id="rIdLogoDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/lematic-logo.jpg"/></Relationships>';
      const bytes = zipStore([
        { name: '[Content_Types].xml', data: contentTypes },
        { name: '_rels/.rels', data: rels },
        { name: 'word/document.xml', data: documentXml },
        { name: 'word/_rels/document.xml.rels', data: docRels },
        { name: 'word/header1.xml', data: headerXml },
        { name: 'word/footer1.xml', data: footerXml },
        { name: 'word/styles.xml', data: stylesXml },
        { name: 'word/settings.xml', data: settingsXml },
        { name: 'word/media/icon-safety.png', data: Uint8Array.from(atob(ICON_B64.safety), function(c) { return c.charCodeAt(0); }) },
        { name: 'word/media/icon-down.png', data: Uint8Array.from(atob(ICON_B64.down), function(c) { return c.charCodeAt(0); }) },
        { name: 'word/media/icon-perf.png', data: Uint8Array.from(atob(ICON_B64.perf), function(c) { return c.charCodeAt(0); }) },
        { name: 'word/media/lematic-logo.jpg', data: Uint8Array.from(atob(LEMATIC_LOGO_JPG), function(c) { return c.charCodeAt(0); }) },
      ]);
      const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      const a = document.createElement('a');
      const safe = (customer || 'Inspection').replace(/[^a-z0-9]/gi, '_').substring(0, 30);
      a.href = URL.createObjectURL(blob);
      a.download = safe + '_' + (model || 'machine') + '_' + (date || 'report') + '.docx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('Word document downloaded');
    }

    // ========== NAV ==========
    document.getElementById('btnInspectHome').addEventListener('click', () => {
      if (currentInspection && currentInspection.status !== 'Complete') {
        saveCurrentDraft();
      }
      if (document.body.classList.contains('on-notes')) syncNotesField();
      closeSearch();
      showScreen('screenInspectList');
      setHeader('Inspections');
      refreshHome();
    });

    const btnSettings = document.getElementById('btnSettings');
    if (btnSettings) btnSettings.addEventListener('click', () => {
      closeSearch();
      showScreen('screenSettings');
      setHeader('Settings');
      if (typeof fillProfileForm === 'function') fillProfileForm();
      if (typeof bindProfileForm === 'function') bindProfileForm();
      if (typeof refreshStorageCard === 'function') refreshStorageCard();
    });
    document.getElementById('btnHome').addEventListener('click', () => {
      navHistory.length = 0;
      if (currentInspection && currentInspection.status !== 'Complete') {
        saveCurrentDraft();
      }
      try { closeModal(); } catch (e) {}
      try { closeSearch(); } catch (e) {}
      document.body.classList.remove('chrome-hidden', 'inspect-active', 'on-inspect-flow');
      const overlay = document.getElementById('pl-modal');
      if (overlay) overlay.classList.remove('show');
      showScreen('screenHome');
      setHeader('LeMatic Inspection');
      refreshHome();
      measureHeaderHeight();
      hydrateStoredPhotosInBackground();
      requestAnimationFrame(() => {
        measureHeaderHeight();
        window.scrollTo(0, 0);
        resetChrome();
      });
    });

    document.getElementById('btnSearch').addEventListener('click', () => {
      const bar = document.getElementById('searchBar');
      const isOpen = bar.classList.toggle('show');
      if (isOpen) {
        document.body.classList.add('search-open');
        const inp = document.getElementById('inpSearch');
        inp.focus();
        renderSearchResults();
      } else {
        closeSearch();
      }
    });

    function syncSearchClear() {
      const bar = document.getElementById('searchBar');
      const inp = document.getElementById('inpSearch');
      bar.classList.toggle('has-query', !!(inp.value || '').trim());
    }

    function hideSearchResults() {
      const panel = document.getElementById('searchResults');
      const scrim = document.getElementById('searchScrim');
      panel.classList.remove('show');
      panel.hidden = true;
      panel.innerHTML = '';
      if (scrim) {
        scrim.classList.remove('show');
        scrim.hidden = true;
      }
    }

    function positionSearchResults() {
      const bar = document.getElementById('searchBar');
      const panel = document.getElementById('searchResults');
      if (!bar.classList.contains('show') || !panel.classList.contains('show')) return;
      const rect = bar.getBoundingClientRect();
      const vv = window.visualViewport;
      const viewBottom = vv ? (vv.offsetTop + vv.height) : window.innerHeight;
      panel.style.top = Math.round(rect.bottom + 8) + 'px';
      panel.style.maxHeight = Math.max(120, Math.round(viewBottom - rect.bottom - 16)) + 'px';
    }


    function searchDateHay(v) {
      if (v == null || v === '') return '';
      let d = null;
      if (v instanceof Date && !isNaN(v.getTime())) d = v;
      else if (typeof v === 'number') d = new Date(v);
      else {
        const s = String(v).trim();
        const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (m) d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        else {
          const t = Date.parse(s);
          if (!isNaN(t)) d = new Date(t);
        }
      }
      if (!d || isNaN(d.getTime())) return String(v).toLowerCase();
      const y = d.getFullYear();
      const yy = String(y).slice(-2);
      const mo = d.getMonth() + 1;
      const da = d.getDate();
      const mo2 = String(mo).padStart(2, '0');
      const da2 = String(da).padStart(2, '0');
      const shortM = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'][d.getMonth()];
      const longM = ['january','february','march','april','may','june','july','august','september','october','november','december'][d.getMonth()];
      return [
        y + '-' + mo2 + '-' + da2,
        y + '-' + mo + '-' + da,
        mo + '/' + da + '/' + y,
        mo2 + '/' + da2 + '/' + y,
        mo + '/' + da + '/' + yy,
        mo + '-' + da + '-' + y,
        mo2 + '-' + da2 + '-' + y,
        shortM + ' ' + da,
        shortM + ' ' + da + ', ' + y,
        shortM + ' ' + da + ' ' + y,
        longM + ' ' + da,
        longM + ' ' + da + ', ' + y,
        da + ' ' + shortM,
        da + ' ' + shortM + ' ' + y
      ].join(' ').toLowerCase();
    }
    function searchHay(parts) {
      return (parts || []).map(x => String(x == null ? '' : x).toLowerCase()).join(' ');
    }

    function renderSearchResults() {
      const panel = document.getElementById('searchResults');
      const bar = document.getElementById('searchBar');
      const q = (searchQuery || '').trim().toLowerCase();
      if (!bar.classList.contains('show') || !q) {
        hideSearchResults();
        return;
      }
      const rows = [];
      loadJobs().forEach(job => {
        const hay = searchHay([
          job.customer, job.site, job.contact, job.technician, job.po, job.salesOrder, job.status, job.scope,
          formatJobDateRange(job),
          searchDateHay(job.startDate || job.start),
          searchDateHay(job.endDate || job.end)
        ]);
        if (hay.includes(q)) {
          rows.push({
            kind: 'job',
            id: job.id,
            kicker: 'Job',
            title: job.customer || 'Untitled job',
            sub: [job.site, formatJobDateRange(job), job.status].filter(Boolean).join(' · ')
          });
        }
      });
      loadInspections().forEach(ins => {
        const extraBits = [];
        if (ins.notes) extraBits.push(ins.notes);
        if (ins.summaryNotes) extraBits.push(ins.summaryNotes);
        if (ins.results) {
          Object.keys(ins.results).forEach(k => {
            const r = ins.results[k] || {};
            extraBits.push(r.notes, r.condition, r.action, k);
          });
        }
        (ins.findings || []).forEach(f => {
          extraBits.push(f.item, f.notes, f.condition, f.section, f.action);
        });
        const hay = searchHay([
          ins.customer, ins.serial, ins.technician, ins.model, ins.po, ins.date, ins.status, ins.site,
          searchDateHay(ins.date), searchDateHay(ins.createdAt), searchDateHay(ins.updatedAt)
        ].concat(extraBits));
        if (hay.includes(q)) {
          rows.push({
            kind: 'inspection',
            id: ins.id,
            kicker: 'Inspection',
            title: (ins.customer || 'Unknown') + ' – ' + (ins.model || 'LX-8') + ' – ' + (ins.serial || 'No S/N'),
            sub: [ins.technician, ins.date, ins.status].filter(Boolean).join(' · ')
          });
        }
        (ins.findings || []).forEach(f => {
          const fh = [f.item, f.notes, f.condition, f.section, f.action].map(x => String(x || '').toLowerCase()).join(' ');
          if (fh.includes(q)) {
            rows.push({
              kind: 'inspection',
              id: ins.id,
              kicker: 'Finding',
              title: f.item || 'Finding',
              sub: [ins.customer, f.condition, f.section].filter(Boolean).join(' · ')
            });
          }
        });
      });
      try {
        if (typeof tcLoad === 'function') tcLoad();
        const entries = (typeof tcState !== 'undefined' && tcState && tcState.entries) ? tcState.entries : [];
        entries.forEach(en => {
          const hay = searchHay([
            en.bakeryName, en.notes, en.type, en.date, en.jobId,
            searchDateHay(en.date),
            searchDateHay(en.clockIn),
            searchDateHay(en.clockOut)
          ]);
          if (hay.includes(q)) {
            const hours = (typeof tcEntryHours === 'function') ? tcEntryHours(en) : '';
            rows.push({
              kind: 'timecard',
              id: en.id,
              kicker: 'Time card',
              title: en.bakeryName || (en.type || 'Hours'),
              sub: [en.date, en.type, hours ? (Math.round(hours*100)/100 + 'h') : '', en.notes].filter(Boolean).join(' · ')
            });
          }
        });
      } catch (e) {}
      try {
        const punch = (typeof window.getPunchlistSummaries === 'function') ? null : null;
      } catch (e) {}
      const punchNames = [];
      try {
        if (window.__plData && window.__plData.jobs) {
          Object.keys(window.__plData.jobs).forEach(name => punchNames.push(name));
        }
      } catch (e) {}
      // punchlist internal data
      try {
        if (typeof window.getPunchlistSummaries === 'function') {
          /* summaries filled async below */
        }
      } catch (e) {}

      function paint(extraPunch) {
        const all = rows.concat(extraPunch || []).slice(0, 40);
        if (!all.length) {
          panel.innerHTML = `<div class="search-empty">No matches</div>`;
        } else {
          panel.innerHTML = all.map(row => `
            <div class="list-item" data-kind="${row.kind}" data-id="${String(row.id || row.name || '').replace(/"/g,'')}" data-job="${String(row.job || '').replace(/"/g,'')}">
              <div class="list-item-main" data-action="open">
                <div class="search-result-kicker">${row.kicker}</div>
                <div class="title">${row.title}</div>
                <div class="sub">${row.sub || ''}</div>
              </div>
            </div>
          `).join('');
          panel.querySelectorAll('.list-item').forEach(el => {
            el.addEventListener('click', () => {
              const kind = el.dataset.kind;
              const id = el.dataset.id;
              closeSearch();
              if (kind === 'job') {
                const job = loadJobs().find(j => j.id === id);
                if (job && typeof openJobDetail === 'function') openJobDetail(job.id);
                else if (job) { showScreen('screenJobsList'); refreshJobsList(); }
              } else if (kind === 'inspection') {
                openInspection(id);
              } else if (kind === 'punchlist') {
                if (typeof window.openPunchlistByName === 'function') {
                  window.openPunchlistByName(id).then(() => {
                    showScreen('screenPunchlist');
                    setHeader('Punchlist');
                    if (typeof window.renderList === 'function') window.renderList();
                  }).catch(() => toast('Could not open punchlist'));
                }
              } else if (kind === 'punchitem') {
                const job = el.dataset.job || el.getAttribute('data-job');
                if (typeof window.openPunchlistItem === 'function') {
                  window.openPunchlistItem(job, Number(id) || id).then(() => {
                    showScreen('screenPunchlist');
                    setHeader('Punchlist');
                  }).catch(() => toast('Could not open item'));
                }
              } else if (kind === 'timecard') {
                if (typeof openTimeCards === 'function') openTimeCards();
              }
            });
          });
        }
        panel.hidden = false;
        panel.classList.add('show');
        const scrim = document.getElementById('searchScrim');
        if (scrim) {
          scrim.hidden = false;
          scrim.classList.add('show');
        }
        positionSearchResults();
      }

      if (typeof window.getPunchlistSummaries === 'function') {
        Promise.all([
          window.getPunchlistSummaries(),
          window.searchPunchlistItems ? window.searchPunchlistItems(q) : Promise.resolve([])
        ]).then(([list, items]) => {
          const extra = (list || []).filter(r => String(r.name || '').toLowerCase().includes(q)).map(r => ({
            kind: 'punchlist',
            id: r.key || r.name,
            name: r.name,
            kicker: 'Punchlist',
            title: r.name,
            sub: (r.total || 0) + ' item' + ((r.total || 0) !== 1 ? 's' : '') + ' · ' + (r.complete || 0) + ' complete'
          }));
          (items || []).forEach(it => extra.push({
            kind: 'punchitem',
            id: String(it.id),
            job: it.job,
            kicker: 'Punchlist item',
            title: it.description || 'Item',
            sub: [it.job, it.status, it.line, it.location].filter(Boolean).join(' · ')
          }));
          paint(extra);
        }).catch(() => paint([]));
      } else {
        paint([]);
      }
    }

    function closeSearch() {
      const bar = document.getElementById('searchBar');
      if (bar) bar.classList.remove('show', 'has-query');
      document.body.classList.remove('search-open');
      searchQuery = '';
      const inp = document.getElementById('inpSearch');
      if (inp) inp.value = '';
      if (typeof hideSearchResults === 'function') hideSearchResults();
    }

    document.getElementById('inpSearch').addEventListener('input', (e) => {
      searchQuery = e.target.value;
      syncSearchClear();
      renderSearchResults();
    });

    document.getElementById('btnSearchClear').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const inp = document.getElementById('inpSearch');
      inp.value = '';
      searchQuery = '';
      syncSearchClear();
      inp.focus();
      hideSearchResults();
    });

    document.getElementById('btnSearchCancel').addEventListener('click', (e) => {
      e.preventDefault();
      closeSearch();
    });

    window.addEventListener('resize', positionSearchResults);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', positionSearchResults);
      window.visualViewport.addEventListener('scroll', positionSearchResults);
    }

    // ========== NATIVE iOS-STYLE SCROLL CHROME ==========
    // Let the browser own scrolling. JavaScript only changes chrome state.
    let lastY = window.scrollY || 0;
    let chromeHidden = false;
    let chromeTicking = false;

    function setChrome(hidden) {
      if (chromeHidden === hidden) return;
      chromeHidden = hidden;

      document.body.classList.toggle('chrome-hidden', hidden);

      const header = document.getElementById('appHeader');
      const search = document.getElementById('searchBar');
      const dots = document.getElementById('sectionDots');
      const headerHeight = header ? header.offsetHeight : 96;
      const dotsHeight = dots && dots.offsetHeight ? dots.offsetHeight : 52;
      const searchHeight = search && search.offsetHeight ? search.offsetHeight : 56;
      // Extra clears the Dynamic Island after the bar reaches y = 0
      const extra = 20;
      const headerOffset = hidden ? -(headerHeight + extra) : 0;
      const dotsOffset = hidden ? -(headerHeight + dotsHeight + extra) : 0;
      const searchOffset = hidden ? -(headerHeight + searchHeight + extra) : 0;

      if (header) header.style.transform = `translate3d(0, ${headerOffset}px, 0)`;
      if (search && search.classList.contains('show')) {
        search.style.transform = `translate3d(0, ${searchOffset}px, 0)`;
      }
      if (dots) dots.style.transform = `translate3d(0, ${dotsOffset}px, 0)`;
    }

    function handleScroll() {
      const y = window.scrollY || document.documentElement.scrollTop || 0;
      const delta = y - lastY;

      if (y <= 8) {
        setChrome(false);
      } else if (delta > 8) {
        setChrome(true);
      } else if (delta < -8) {
        setChrome(false);
      }

      lastY = y;
      chromeTicking = false;
    }

    window.addEventListener('scroll', () => {
      if (!chromeTicking) {
        chromeTicking = true;
        requestAnimationFrame(handleScroll);
      }
    }, { passive: true });

    function measureHeaderHeight() {
      const header = document.getElementById('appHeader');
      if (header) {
        const h = Math.max(header.offsetHeight || 0, 81);
        document.documentElement.style.setProperty('--header-h', h + 'px');
      }
      const dots = document.getElementById('sectionDots');
      if (dots && dots.offsetHeight) {
        document.documentElement.style.setProperty('--section-bar-h', dots.offsetHeight + 'px');
      }
    }

    function resetChrome() {
      lastY = window.scrollY || 0;
      chromeHidden = false;
      chromeTicking = false;
      document.body.classList.remove('chrome-hidden');

      const header = document.getElementById('appHeader');
      const search = document.getElementById('searchBar');
      const dots = document.getElementById('sectionDots');

      if (header) header.style.transform = 'translate3d(0, 0, 0)';
      if (search) search.style.transform = '';
      if (dots) dots.style.transform = 'translate3d(0, 0, 0)';
    }

    // ========== INIT ==========
    function initApp() {
      document.addEventListener('gesturestart', e => e.preventDefault());
      window.addEventListener('resize', measureHeaderHeight);
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', measureHeaderHeight);
      }
      initNotesEditor();
      // Same path as tapping Home — avoids first-paint jumble
      showScreen('screenHome');
      setHeader('LeMatic Inspection');
      refreshHome();
      measureHeaderHeight();
      requestAnimationFrame(() => {
        measureHeaderHeight();
        window.scrollTo(0, 0);
        resetChrome();
      });
    }

    // Fast first paint: the LX-8 template is already bundled, so there is no
    // reason to hold the initial screen while IndexedDB is opened and hydrated.
    // Storage hydration continues in the background and refreshes the home screen
    // when it is ready. This preserves the existing data behavior while making
    // cold starts much more responsive, especially on iPhone.
    if (window.MACHINE_TEMPLATES && window.MACHINE_TEMPLATES['LX-8']) {
      setActiveMachine('LX-8');
    } else if (window.EMBEDDED_DATA && window.EMBEDDED_DATA.sections && window.EMBEDDED_DATA.sections.length) {
      APP_DATA = window.EMBEDDED_DATA;
    }
    initApp();
    bootStorage().then(() => {
      try { refreshHome(); } catch (e) {}
      const later = window.requestIdleCallback || function(fn){ setTimeout(fn, 1800); };
      later(() => { warmExcelLibs(); });
    }).catch(() => {});

    // Register service worker (PWA) and keep drafts on device
    
    function syncViewportVars() {
      const vv = window.visualViewport;
      const h = (vv && vv.height) ? vv.height : window.innerHeight;
      const w = (vv && vv.width) ? vv.width : window.innerWidth;
      document.documentElement.style.setProperty('--app-vh', h + 'px');
      document.documentElement.style.setProperty('--app-vw', w + 'px');
      document.documentElement.classList.toggle('is-tablet', w >= 768);
      document.documentElement.classList.toggle('is-short', h < 700);
    }
    syncViewportVars();
    window.addEventListener('resize', syncViewportVars);
    window.addEventListener('orientationchange', () => setTimeout(syncViewportVars, 200));
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncViewportVars);
    }
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js?v=flat-v62', { updateViaCache: 'none' }).then((reg) => {
          const check = () => { try { reg.update(); } catch (e) {} };
          check();
          document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') check();
          });
        }).catch((err) => {
          console.warn('Service worker registration failed:', err);
        });
      });
    }
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    function syncOfflineBanner() {
      let bar = document.getElementById('offlineBanner');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'offlineBanner';
        bar.setAttribute('role', 'status');
        bar.style.cssText = 'display:none;position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:80;padding:10px 14px;border-radius:12px;background:#2a3036;color:#e8eef2;font-size:0.82rem;text-align:center;border:1px solid rgba(249,253,255,0.12)';
        bar.textContent = 'Offline — reports and photos stay on this device.';
        document.body.appendChild(bar);
      }
      const offline = (typeof navigator.onLine === 'boolean') ? !navigator.onLine : false;
      bar.style.display = offline ? 'block' : 'none';
    }
    window.addEventListener('online', syncOfflineBanner);
    window.addEventListener('offline', syncOfflineBanner);
    syncOfflineBanner();
    window.addEventListener('pagehide', () => { persistAllStores().catch(() => {}); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') persistAllStores().catch(() => {});
    });

  
    // ========== PUNCHLIST ==========
    (function punchlistModule() {
const IDB_NAME = "FieldPunchlistDB";
    const IDB_VERSION = 1;
    const STORE_NAME = "appdata";
    const LEGACY_KEY = "field_punchlist_v3";

    const defaultData = {
      currentJob: "Aryzta Australia",
      jobs: {
        "Aryzta Australia": [
          { id:1, line:"LH", location:"Seal Unit", description:"Bad center seal heater", action:"Send new heater for warranty", department:"Service", responsible:"", dueDate:"", priority:"Normal", comments:"", status:"Not Started", photo:null },
          { id:2, line:"Rh", location:"Basket loader", description:"Leaking regulator (through spring/screw)", action:"Send new regulator for warranty", department:"Service", responsible:"", dueDate:"", priority:"High", comments:"", status:"In Progress", photo:null },
          { id:3, line:"LH", location:"Band slicer", description:"Missing complete set of band blade guides", action:"Send new blade guides", department:"Bakery", responsible:"", dueDate:"", priority:"Normal", comments:"Looked all over bakery – can't find.", status:"Not Started", photo:null },
          { id:4, line:"both", location:"Band slicer", description:"Missing top conveyor and upper band adjust handles", action:"Send new handles (x4)", department:"Bakery", responsible:"", dueDate:"", priority:"Normal", comments:"Cannot find handles in bakery.", status:"Not Started", photo:null },
          { id:5, line:"both", location:"Basket feed conveyors", description:"Infeed basket gate cycles too much", action:"Add timer to basket gate close", department:"Programming", responsible:"", dueDate:"", priority:"Normal", comments:"", status:"Complete", photo:null },
          { id:6, line:"both", location:"Grouper", description:"Not enough lane coverage with grouper hold downs", action:"Need two more assemblies per machine", department:"Service", responsible:"", dueDate:"", priority:"High", comments:"", status:"Not Started", photo:null }
        ],
        "Epi": [
          { id:1, line:"Epi", location:"Non-op vacuum header", description:"Very bent non-op vacuum header", action:"Repair or replace", department:"Engineering", responsible:"", dueDate:"", priority:"High", comments:"Film sucked into op vacuum header causing no seal on op side", status:"Not Started", photo:null },
          { id:2, line:"Epi", location:"Air system", description:"Heavy water in airlines", action:"Inspect filters, drains, dryer; correct moisture source", department:"Maintenance", responsible:"", dueDate:"", priority:"High", comments:"Caused stuck Airbar solenoid", status:"Not Started", photo:null },
          { id:3, line:"Epi", location:"X-ray interlock", description:"Auto-starts after safety reset; requires code entry", action:"Change logic so operator must manually start after reset", department:"Controls", responsible:"", dueDate:"", priority:"High", comments:"~2 min recovery + 2 people currently", status:"In Progress", photo:null },
          { id:4, line:"Epi", location:"Top heater assembly", description:"Not level and binding", action:"Verify level and spring tension", department:"Engineering", responsible:"", dueDate:"", priority:"Normal", comments:"Re-leveled this visit; springs at 12 lbs with binding", status:"Complete", photo:null }
        ]
      }
    };

    let data = null;
    let db = null;
    let editingId = null;
    let tempPhoto = null;
    let filterField = "any";
    let filterQuery = "";
    let plStatusFilters = [];
    let filterChipValue = "";

    const CARD_FIELDS = ["description","line","location","action","department","status","priority","responsible","dueDate","createdAt","comments"];
    const CHIP_FIELDS = {
      status: ["Not Started", "In Progress", "Complete", "Waiting Parts"],
      priority: ["High", "Normal", "Low"],
      department: ["Service", "Bakery", "Programming", "Engineering", "Sales", "Other"],
      line: null,
      createdAt: null
    };

    function nowStamp() {
      const d = new Date();
      const pad = n => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
    }
    function stampDate(v) {
      if (!v) return "";
      const s = String(v);
      return s.slice(0, 10);
    }

    function openDB() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = (e) => {
          const database = e.target.result;
          if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
        };
        req.onsuccess = (e) => { db = e.target.result; resolve(db); };
        req.onerror = (e) => reject(e.target.error);
      });
    }

    function idbGet(key) {
      return new Promise((resolve, reject) => {
        if (!db) return reject(new Error("DB not open"));
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    function idbSet(key, value) {
      return new Promise((resolve, reject) => {
        if (!db) return reject(new Error("DB not open"));
        const tx = db.transaction(STORE_NAME, "readwrite");
        const req = tx.objectStore(STORE_NAME).put(value, key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    }

    async function plLoadData() {
      try {
        await openDB();
        let saved = await idbGet("main");
        if (!saved) {
          try {
            const legacy = localStorage.getItem(LEGACY_KEY);
            if (legacy) {
              saved = JSON.parse(legacy);
              await idbSet("main", saved);
              toast("Data upgraded to larger storage");
            }
          } catch (e) {}
        }
        if (saved && saved.jobs && saved.currentJob) data = saved;
        else { data = JSON.parse(JSON.stringify(defaultData)); await plSaveData(); }
        try { migratePunchlistJobKeys(); } catch (e) {}
      } catch (e) {
        data = JSON.parse(JSON.stringify(defaultData));
        try { await openDB(); } catch (_) {}
      }
    }

    async function plSaveData() {
      try {
        if (!db) await openDB();
        await idbSet("main", data);
        return true;
      } catch (e) {
        try {
          localStorage.setItem(LEGACY_KEY, JSON.stringify(data));
          toast("Saved (fallback mode)");
          return true;
        } catch (e2) {
          toast("Storage full – remove photos or old jobs");
          return false;
        }
      }
    }

    function updateOnlineStatus() {
      const offline = !navigator.onLine;
      const offEl = document.getElementById("offline-badge");
      if (offEl) offEl.classList.toggle("show", offline);
      const onEl = document.getElementById("online-badge");
      if (onEl) onEl.style.display = "none";
      if (offline) toast("You are offline – changes still save on this device");
    }

    window.addEventListener("online", () => { updateOnlineStatus(); toast("Back online"); });
    window.addEventListener("offline", updateOnlineStatus);

    function getItems() { return data.jobs[data.currentJob] || []; }
    function setItems(items) { data.jobs[data.currentJob] = items; plSaveData(); }

    function punchlistShowToast(msg) {
      const t = document.getElementById("toast");
      t.textContent = msg;
      t.classList.add("show");
      setTimeout(() => t.classList.remove("show"), 2200);
    }

    function statusBadgeClass(s) {
      if (s === "Not Started") return "badge-notstarted";
      if (s === "In Progress") return "badge-inprogress";
      if (s === "Complete") return "badge-complete";
      return "badge-waiting";
    }

    function deptClass(d) {
      const map = {
        "Service": "dept-Service",
        "Bakery": "dept-Bakery",
        "Programming": "dept-Programming",
        "Engineering": "dept-Engineering",
        "Sales": "dept-Sales"
      };
      return map[d] || "dept-Other";
    }

    function escapeHtml(str) {
      if (!str) return "";
      return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    }

    function populateJobSelect() {
      const sel = document.getElementById("job-select");
      if (!sel || !data) return;
      // Prefer field-service jobs as the source of punchlist buckets
      try {
        const fieldJobs = (typeof loadJobs === "function" ? loadJobs() : []) || [];
        fieldJobs.forEach(job => {
          if (!job || !job.id) return;
          if (!data.listNames) data.listNames = {};
          Object.keys(data.jobs || {}).forEach(key => {
            if (data.jobIdByKey && data.jobIdByKey[key] === job.id && !data.listNames[key]) {
              data.listNames[key] = (typeof jobDisplayName === 'function') ? jobDisplayName(job) : (job.customer || 'Punchlist');
            }
          });
        });
      } catch (e) {}
      const jobs = Object.keys(data.jobs);
      if (!jobs.length) {
        data.jobs["Default"] = [];
        data.currentJob = "Default";
        jobs.push("Default");
      }
      if (!data.currentJob || !data.jobs[data.currentJob]) data.currentJob = jobs[0];
      sel.innerHTML = jobs.map(j => {
        const label = (typeof punchlistDisplayName === 'function') ? punchlistDisplayName(j) : j;
        return `<option value="${escapeHtml(j)}" ${j === data.currentJob ? "selected" : ""}>${escapeHtml(label)}</option>`;
      }).join("");
    }

    function itemMatchesFilter(item) {
      if (plStatusFilters && plStatusFilters.length) {
        const st = String(item.status || "Not Started");
        if (!plStatusFilters.includes(st)) return false;
      }
      const q = (filterQuery || "").trim().toLowerCase();
      const chip = (filterChipValue || "").trim().toLowerCase();
      if (!q && !chip) return true;

      function fieldText(key) {
        if (key === "createdAt") {
          const raw = String(item.createdAt || "");
          return (raw + " " + stampDate(raw)).toLowerCase();
        }
        return String(item[key] == null ? "" : item[key]).toLowerCase();
      }

      if (filterField === "any") {
        const hay = CARD_FIELDS.map(fieldText).join(" ");
        return (!q || hay.includes(q)) && (!chip || hay.includes(chip));
      }

      const value = fieldText(filterField);
      if (chip && value !== chip) return false;
      if (q && !value.includes(q)) return false;
      return true;
    }

    function uniqueFieldValues(items, field) {
      const seen = new Set();
      const out = [];
      items.forEach(item => {
        const v = String(item[field] || "").trim();
        if (!v) return;
        const key = v.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(v);
      });
      return out.sort((a, b) => a.localeCompare(b));
    }

    function chipValuesForField(field) {
      const items = getItems();
      let values = CHIP_FIELDS[field];
      if (field === "line") values = uniqueFieldValues(items, "line");
      else if (field === "createdAt") {
        const seen = new Set();
        values = [];
        items.forEach(item => {
          const d = stampDate(item.createdAt);
          if (d && !seen.has(d)) { seen.add(d); values.push(d); }
        });
        values.sort().reverse();
      }
      else if (field === "department") {
        values = (CHIP_FIELDS.department || []).slice();
        uniqueFieldValues(items, "department").forEach(v => {
          if (!values.includes(v)) values.push(v);
        });
      }
      return values || [];
    }

    function updateFilterButton() {
      const active = !!(filterQuery.trim() || filterChipValue);
      document.getElementById("btn-filter").classList.toggle("active", active);
      const countEl = document.getElementById("filter-count");
      const items = getItems();
      const filtered = items.filter(itemMatchesFilter);
      if (active) {
        countEl.classList.add("show");
        countEl.textContent = filtered.length + " of " + items.length + " items";
      } else {
        countEl.classList.remove("show");
        countEl.textContent = "";
      }
    }

    function openFilterSheet() {
      const tb = document.getElementById("modal-trash");
      if (tb) tb.style.display = "none";
      const cam = document.getElementById("modal-camera");
      if (cam) cam.style.display = "none";
      document.getElementById("modal-title").textContent = "Filter";
      const chips = chipValuesForField(filterField);
      document.getElementById("modal-body").innerHTML = `
        <div class="form-group">
          <label>Field</label>
          <select id="f-filter-field">
            <option value="any"${filterField === "any" ? " selected" : ""}>Any field</option>
            <option value="description"${filterField === "description" ? " selected" : ""}>Description</option>
            <option value="line"${filterField === "line" ? " selected" : ""}>Line</option>
            <option value="location"${filterField === "location" ? " selected" : ""}>Location</option>
            <option value="action"${filterField === "action" ? " selected" : ""}>Action</option>
            <option value="department"${filterField === "department" ? " selected" : ""}>Department</option>
            <option value="status"${filterField === "status" ? " selected" : ""}>Status</option>
            <option value="priority"${filterField === "priority" ? " selected" : ""}>Priority</option>
            <option value="responsible"${filterField === "responsible" ? " selected" : ""}>Responsible</option>
            <option value="dueDate"${filterField === "dueDate" ? " selected" : ""}>Due date</option>
            <option value="createdAt"${filterField === "createdAt" ? " selected" : ""}>Created date</option>
            <option value="comments"${filterField === "comments" ? " selected" : ""}>Comments</option>
          </select>
        </div>
        <div class="form-group">
          <label>Contains</label>
          <input type="text" id="f-filter-query" value="${escapeHtml(filterQuery)}" placeholder="Type to filter">
        </div>
        <div class="filter-chips" id="filter-chips">${chips.map(v =>
          `<button type="button" class="filter-chip${filterChipValue === v ? " active" : ""}" data-value="${escapeHtml(v)}">${escapeHtml(v)}</button>`
        ).join("")}</div>
        <div class="btn-row">
          <button class="btn btn-outline" type="button" id="btn-filter-reset">Clear</button>
          <button class="btn btn-primary" type="button" id="btn-filter-apply">Apply</button>
        </div>
      `;
      document.getElementById("pl-modal").classList.add("show");
      if (typeof pinPlModalBar === 'function') pinPlModalBar();
      const fieldSel = document.getElementById("f-filter-field");
      fieldSel.addEventListener("change", () => {
        filterField = fieldSel.value;
        filterChipValue = "";
        openFilterSheet();
      });
      document.getElementById("filter-chips").querySelectorAll(".filter-chip").forEach(btn => {
        btn.addEventListener("click", () => {
          const val = btn.dataset.value;
          filterChipValue = filterChipValue === val ? "" : val;
          document.querySelectorAll("#filter-chips .filter-chip").forEach(b => b.classList.toggle("active", b.dataset.value === filterChipValue));
        });
      });
      document.getElementById("btn-filter-apply").addEventListener("click", () => {
        filterField = document.getElementById("f-filter-field").value;
        filterQuery = document.getElementById("f-filter-query").value;
        closeModal();
        renderList();
      });
      document.getElementById("btn-filter-reset").addEventListener("click", () => {
        filterField = "any";
        filterQuery = "";
        filterChipValue = "";
        closeModal();
        renderList();
      });
    }

    function syncStatusChips() {
      const map = {
        "stat-open": "Not Started",
        "stat-progress": "In Progress",
        "stat-done": "Complete"
      };
      Object.keys(map).forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle("on", plStatusFilters.indexOf(map[id]) >= 0);
      });
    }
    function onStatusChipTap(status) {
      const i = plStatusFilters.indexOf(status);
      if (i >= 0) plStatusFilters.splice(i, 1);
      else plStatusFilters.push(status);
      syncStatusChips();
      renderList();
    }
    ["stat-open","stat-progress","stat-done"].forEach(id => {
      const el = document.getElementById(id);
      if (!el || el.dataset.bound === "1") return;
      el.dataset.bound = "1";
      el.addEventListener("click", () => onStatusChipTap(el.getAttribute("data-filter") || ""));
    });
    function renderList() {
      const items = getItems();
      const list = document.getElementById("item-list");
      const filtered = items.filter(itemMatchesFilter).slice().sort((a, b) => {
        const rank = (item) => {
          if (String(item.status || "") === "Complete") return 2;
          if (String(item.priority || "") === "High") return 0;
          return 1;
        };
        return rank(a) - rank(b);
      });

      document.getElementById("stat-open").innerHTML = `<strong>${items.filter(i => i.status === "Not Started").length}</strong> Open`;
      document.getElementById("stat-progress").innerHTML = `<strong>${items.filter(i => i.status === "In Progress").length}</strong> In Progress`;
      document.getElementById("stat-done").innerHTML = `<strong>${items.filter(i => i.status === "Complete").length}</strong> Done`;
      if (typeof syncStatusChips === "function") syncStatusChips();
      updateFilterButton();

      if (items.length === 0) {
        list.innerHTML = `<div class="empty"><div class="empty-icon" style="display:flex;justify-content:center;margin-bottom:8px;color:var(--muted);opacity:0.85"><svg viewBox="0 0 24 24" width="40" height="40" fill="none" aria-hidden="true"><rect x="4.2" y="3.2" width="15.6" height="17.6" rx="2.2" stroke="currentColor" stroke-width="0.9"/><path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" stroke-width="0.9" stroke-linecap="round"/></svg></div><div>No items for this job</div></div>`;
        return;
      }

      if (filtered.length === 0) {
        list.innerHTML = `<div class="empty"><div class="empty-icon" style="display:flex;justify-content:center;margin-bottom:8px;color:var(--muted);opacity:0.85"><svg viewBox="0 0 24 24" width="40" height="40" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="6.2" stroke="currentColor" stroke-width="1.4"/><path d="M20 20l-3.6-3.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></div><div>No items match this filter</div><div style="margin-top:8px;font-size:13px;opacity:0.8">Clear the filter or pick another field</div></div>`;
        return;
      }

      list.innerHTML = filtered.map(item => {
        const classes = ["pl-item"];
        const st = String(item.status || "").toLowerCase();
        const pri = String(item.priority || "").toLowerCase();
        if (st === "complete" || st === "done" || st === "completed") classes.push("list-complete");
        else if (pri === "high" || pri === "critical") classes.push("priority-high");
        return `
        <div class="${classes.join(" ")}" data-id="${item.id}" onclick="toggleItem(${item.id}, event)">
          <div class="list-item-main">
            <div class="title">${escapeHtml(item.description)}</div>
            <div class="sub">${escapeHtml(item.line)} · ${escapeHtml(item.location)}${item.dueDate ? " · " + item.dueDate : ""}${item.responsible ? " · " + escapeHtml(item.responsible) : ""}</div>
            <div class="action-line">→ ${escapeHtml(item.action)}</div>
            <span class="dept ${deptClass(item.department)}">${escapeHtml(item.department)}</span>
          </div>
          <div class="list-item-actions">
            <span class="badge ${statusBadgeClass(item.status)}">${item.status}</span>
            ${item.photo ? `<img class="list-item-photo" src="${item.photo}" alt="Item photo" onclick="openPunchlistPhoto(event, this.src)">` : ""}
          </div>
          <div class="list-item-detail">
            ${item.comments ? `<div class="detail-row"><strong>Comments</strong>${escapeHtml(item.comments)}</div>` : ""}
            ${item.responsible ? `<div class="detail-row"><strong>Responsible</strong>${escapeHtml(item.responsible)}</div>` : ""}
            ${item.dueDate ? `<div class="detail-row"><strong>Due</strong>${escapeHtml(item.dueDate)}</div>` : ""}
            ${item.photo ? `<img class="list-item-photo" src="${item.photo}" alt="Item photo" onclick="openPunchlistPhoto(event, this.src)">` : ""}

          </div>
        </div>
      `}).join("");
    }

    function toggleItem(id, ev) {
      if (ev && ev.target.closest("button, a, input, select, textarea, img.list-item-photo, .pl-photo-viewer")) return;
      openDetail(id);
    }


    let photoViewerMode = 'punchlist';
    let photoViewerItemId = null;
    function openPhotoViewer(src, mode, itemId) {
      if (!src) return;
      photoViewerMode = mode || 'punchlist';
      photoViewerItemId = itemId || null;
      const viewer = document.getElementById('pl-photo-viewer');
      const img = document.getElementById('pl-photo-viewer-img');
      if (!viewer || !img) return;
      img.src = src;
      viewer.hidden = false;
      viewer.setAttribute('aria-hidden', 'false');
    }
    function requestDeleteViewerPhoto(ev) {
      if (ev) ev.stopPropagation();
      if (photoViewerMode === 'inspect') {
        requestDeleteInspectPhoto(ev);
        return;
      }
      if (typeof requestDeletePunchlistPhoto === 'function') requestDeletePunchlistPhoto(ev);
    }
    function requestDeleteInspectPhoto(ev) {
      if (ev) ev.stopPropagation();
      const id = photoViewerItemId || 'inspect-photo';
      if (typeof showDeleteConfirm === 'function') {
        showDeleteConfirm(id, 'inspect-photo', 'Delete photo?', 'This photo will be removed from the inspection item.');
      } else {
        pendingDeleteId = id;
        pendingDeleteKind = 'inspect-photo';
        const modal = document.getElementById('deleteModal');
        if (modal) {
          document.getElementById('deleteModalTitle').textContent = 'Delete photo?';
          document.getElementById('deleteModalLabel').textContent = 'This photo will be removed from the inspection item.';
          modal.classList.remove('hidden');
          modal.classList.add('show');
        }
      }
    }
    function performDeleteInspectPhoto() {
      const itemId = photoViewerItemId;
      if (itemId != null && results) {
        const key = Object.keys(results).find(k => String(k) === String(itemId)) || itemId;
        if (results[key]) {
          delete results[key].photoDataUrl;
          delete results[key].photoId;
        }
      }
      try { if (typeof saveCurrentDraft === 'function') saveCurrentDraft(); } catch (e) {}
      try { if (typeof closePunchlistPhoto === 'function') closePunchlistPhoto(); } catch (e) {}
      const viewer = document.getElementById('pl-photo-viewer');
      if (viewer) {
        viewer.hidden = true;
        viewer.setAttribute('aria-hidden', 'true');
      }
      const img = document.getElementById('pl-photo-viewer-img');
      if (img) img.removeAttribute('src');
      photoViewerItemId = null;
      try { if (typeof renderSection === 'function') renderSection(false); } catch (e) {}
      if (typeof closeDeleteModal === 'function') closeDeleteModal();
      toast('Photo deleted');
    }
    window.requestDeleteViewerPhoto = requestDeleteViewerPhoto;
    window.openPhotoViewer = openPhotoViewer;
    window.performDeleteInspectPhoto = performDeleteInspectPhoto;
    function openPunchlistPhoto(ev, src) {
      if (ev) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      photoViewerMode = 'punchlist';
      photoViewerItemId = null;
      if (!src) return;
      const viewer = document.getElementById("pl-photo-viewer");
      const img = document.getElementById("pl-photo-viewer-img");
      if (!viewer || !img) return;
      img.src = src;
      viewer.hidden = false;
      viewer.setAttribute("aria-hidden", "false");
    }

    function closePunchlistPhoto(ev) {
      if (ev) ev.stopPropagation();
      const viewer = document.getElementById("pl-photo-viewer");
      const img = document.getElementById("pl-photo-viewer-img");
      if (img) img.removeAttribute("src");
      if (viewer) {
        viewer.hidden = true;
        viewer.setAttribute("aria-hidden", "true");
      }
    }

    document.getElementById("job-select").addEventListener("change", (e) => {
      data.currentJob = e.target.value;
      plSaveData();
      filterChipValue = "";
      renderList();
      try {
        if (typeof window.setLastPunchlistName === "function") window.setLastPunchlistName(data.currentJob);
        else localStorage.setItem("lx8_last_punchlist", data.currentJob);
      } catch (err) {}
      toast("Switched to " + ((typeof punchlistDisplayName === "function") ? punchlistDisplayName(data.currentJob) : data.currentJob));
    });

    document.getElementById("btn-filter").addEventListener("click", openFilterSheet);

    function openDetail(id) {
      const item = getItems().find(i => i.id === id);
      if (!item) return;
      editingId = id;
      tempPhoto = null;
      showForm(item, false);
    }

    function showForm(item, isNew) {
      document.getElementById("modal-title").textContent = isNew ? "New Item" : (item.description || "Item");
      const trashBtn = document.getElementById("modal-trash");
      if (trashBtn) {
        trashBtn.style.display = "none";
        trashBtn.onclick = null;
      }
      const camBtn = document.getElementById("modal-camera");
      if (camBtn) camBtn.style.display = "grid";
      document.getElementById("modal-body").innerHTML = `
        <div class="pl-photo-block">
          <div id="photo-preview-wrap" class="pl-photo-preview-wrap ${(item.photo || tempPhoto) ? '' : 'hidden'}">
            <img id="photo-preview" class="photo-preview" src="${tempPhoto || item.photo || ''}" alt="preview" onclick="if (this.src) openPunchlistPhoto(event, this.src)">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Line</label>
            <div class="line-chip-row" id="f-line-chips"></div>
            <input type="hidden" id="f-line" value="${escapeHtml(item.line || '')}">
            <input type="hidden" id="f-serial" value="${escapeHtml(item.serial || '')}">
          </div>
          <div class="form-group">
            <label>Priority</label>
            <select id="f-priority">
              <option ${item.priority === "Normal" ? "selected" : ""}>Normal</option>
              <option ${item.priority === "High" ? "selected" : ""}>High</option>
              <option ${item.priority === "Low" ? "selected" : ""}>Low</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>Location</label>
          <input type="text" id="f-location" value="${escapeHtml(item.location || '')}" placeholder="e.g. Seal Unit">
        </div>
        <div class="form-group">
          <label>Description *</label>
          <textarea id="f-description" placeholder="What is the problem?">${escapeHtml(item.description || '')}</textarea>
        </div>
        <div class="form-group">
          <label>Action</label>
          <textarea id="f-action" placeholder="What needs to be done?">${escapeHtml(item.action || '')}</textarea>
        </div>
        <div class="form-group">
          <label>Department</label>
          <select id="f-department">
            <option ${item.department === "Service" ? "selected" : ""}>Service</option>
            <option ${item.department === "Bakery" ? "selected" : ""}>Bakery</option>
            <option ${item.department === "Programming" ? "selected" : ""}>Programming</option>
            <option ${item.department === "Engineering" ? "selected" : ""}>Engineering</option>
            <option ${item.department === "Sales" ? "selected" : ""}>Sales</option>
            <option ${item.department === "Other" ? "selected" : ""}>Other</option>
          </select>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Responsible</label>
            <input type="text" id="f-responsible" value="${escapeHtml(item.responsible || '')}" placeholder="Name">
          </div>
          <div class="form-group">
            <label>Created</label>
            <input type="date" id="f-createdAt" value="${escapeHtml(stampDate(item.createdAt || nowStamp()))}">
          </div>
        </div>
        <div class="form-group pl-status-full">
          <label>Status</label>
          <select id="f-status">
            <option ${item.status === "Not Started" ? "selected" : ""}>Not Started</option>
            <option ${item.status === "In Progress" ? "selected" : ""}>In Progress</option>
            <option ${item.status === "Complete" ? "selected" : ""}>Complete</option>
            <option ${item.status === "Waiting Parts" ? "selected" : ""}>Waiting Parts</option>
          </select>
        </div>
        <div class="form-group">
          <label>Comments</label>
          <textarea id="f-comments" rows="4" placeholder="Notes">${escapeHtml(item.comments || '')}</textarea>
        </div>
        <button type="button" class="btn btn-outline pl-item-delete" id="btn-delete-item">Delete item</button>
        <div class="btn-row pl-item-bar">
          <button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="saveItem()">${isNew ? 'Add Item' : 'Save'}</button>
        </div>
      `;
      document.getElementById("pl-modal").classList.add("show");
      if (typeof bindPunchlistLineChips === 'function') bindPunchlistLineChips();
      if (typeof pinPlModalBar === 'function') pinPlModalBar();
      const delBtn = document.getElementById("btn-delete-item");
      if (delBtn) {
        delBtn.addEventListener("click", function(e) {
          e.preventDefault();
          e.stopPropagation();
          const idToDelete = (item && item.id != null) ? item.id : editingId;
          if (typeof window.deleteItem === 'function') window.deleteItem(idToDelete);
          else deleteItem(idToDelete);
        });
      }
    }

    function handlePhoto(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        tempPhoto = ev.target.result;
        const preview = document.getElementById("photo-preview");
        const wrap = document.getElementById("photo-preview-wrap");
        if (preview) {
          preview.src = tempPhoto;
          preview.classList.remove("hidden");
        }
        if (wrap) wrap.classList.remove("hidden");
        try { e.target.value = ''; } catch (err) {}
        try { e.target.blur(); } catch (err) {}
        if (typeof showPlActionBars === 'function') showPlActionBars();
      };
      reader.readAsDataURL(file);
    }


    function requestDeletePunchlistPhoto(ev) {
      if (ev) ev.stopPropagation();
      pendingDeleteId = editingId || 'photo';
      pendingDeleteKind = 'punchlist-photo';
      document.getElementById('deleteModalTitle').textContent = 'Delete photo?';
      document.getElementById('deleteModalLabel').textContent = 'This photo will be removed from the item.';
      const modal = document.getElementById('deleteModal');
      modal.classList.remove('hidden');
      modal.classList.add('show');
    }
    function removePhoto() {
      tempPhoto = null;
      const preview = document.getElementById("photo-preview");
      const wrap = document.getElementById("photo-preview-wrap");
      if (preview) {
        preview.src = "";
        preview.classList.add("hidden");
      }
      if (wrap) wrap.classList.add("hidden");
      if (editingId) {
        const items = getItems();
        const idx = items.findIndex(i => String(i.id) === String(editingId));
        if (idx >= 0) {
          items[idx] = { ...items[idx], photo: null };
          setItems(items);
        }
      }
    }

    document.getElementById("fab-add").addEventListener("click", () => {
      if (document.body.classList.contains("on-jobs-list")) {
        if (typeof openNewJob === "function") openNewJob();
        return;
      }
      editingId = null;
      tempPhoto = null;
      showForm({ line:"", location:"", description:"", action:"", department:"Service", responsible:"", dueDate:"", createdAt: nowStamp(), priority:"Normal", comments:"", status:"Not Started", photo:null }, true);
    });


    function punchlistLinkedJob() {
      try {
        const load = (typeof loadJobs === 'function') ? loadJobs : window.loadJobs;
        const jobs = (typeof load === 'function' ? load() : []) || [];
        const key = data && data.currentJob;
        const jid = (data && data.jobIdByKey && key) ? data.jobIdByKey[key] : '';
        if (jid) {
          const byId = jobs.find(j => j && String(j.id) === String(jid));
          if (byId) return byId;
        }
        if (key) {
          const name = (typeof punchlistDisplayName === 'function') ? punchlistDisplayName(key) : '';
          const byName = jobs.find(j => j && (j.customer === name || ((typeof jobDisplayName === 'function') && jobDisplayName(j) === name)));
          if (byName) return byName;
        }
        if (typeof currentJob === 'function') {
          const cur = currentJob();
          if (cur) return cur;
        }
      } catch (e) {}
      return null;
    }
    function serialForLine(line, job) {
      const tagged = (typeof taggedJobSerials === 'function') ? taggedJobSerials(job && job.serials) : [];
      const hit = tagged.find(t => String(t.line) === String(line));
      return hit ? String(hit.serial) : '';
    }
    function bindPunchlistLineChips() {
      const row = document.getElementById('f-line-chips');
      const hidden = document.getElementById('f-line');
      const hiddenSerial = document.getElementById('f-serial');
      if (!row || !hidden) return;
      const job = punchlistLinkedJob();
      const tagged = (typeof taggedJobSerials === 'function') ? taggedJobSerials(job && job.serials) : [];
      const lines = ['1','2','3','4'];
      let selected = String(hidden.value || '').trim();
      if (selected && !lines.includes(selected)) selected = '';
      function serialOf(line) {
        const hit = tagged.find(t => t.line === line);
        return hit ? String(hit.serial) : '';
      }
      if (hiddenSerial) hiddenSerial.value = selected ? serialOf(selected) : '';
      function paint() {
        row.innerHTML = lines.map(line => {
          const serial = serialOf(line);
          const label = serial ? (line + ' · ' + serial) : line;
          return '<button type="button" class="chip line-chip' + (line === selected ? ' on' : '') + '" data-line="' + line + '" data-serial="' + serial.replace(/"/g,'&quot;') + '">' + label + '</button>';
        }).join('');
        row.querySelectorAll('.line-chip').forEach(btn => {
          btn.addEventListener('click', () => {
            const line = btn.getAttribute('data-line');
            selected = (selected === line) ? '' : line;
            hidden.value = selected;
            if (hiddenSerial) hiddenSerial.value = selected ? serialOf(selected) : '';
            paint();
          });
        });
      }
      paint();
    }

    function saveItem() {
      const formData = {
        line: document.getElementById("f-line").value.trim(),
        serial: (document.getElementById("f-serial") && document.getElementById("f-serial").value.trim()) || serialForLine(document.getElementById("f-line").value.trim(), punchlistLinkedJob()) || "",
        location: document.getElementById("f-location").value.trim(),
        description: document.getElementById("f-description").value.trim(),
        action: document.getElementById("f-action").value.trim(),
        department: document.getElementById("f-department").value,
        responsible: document.getElementById("f-responsible").value.trim(),
        dueDate: editingId ? ((getItems().find(i => i.id === editingId) || {}).dueDate || "") : "",
        priority: document.getElementById("f-priority").value,
        comments: document.getElementById("f-comments").value.trim(),
        createdAt: (document.getElementById("f-createdAt") && document.getElementById("f-createdAt").value) || nowStamp(),
        status: document.getElementById("f-status").value,
        photo: tempPhoto !== null ? tempPhoto : (editingId ? (getItems().find(i => i.id === editingId)?.photo || null) : null)
      };
      if (!formData.description) { alert("Description is required"); return; }

      let items = getItems();
      if (editingId) {
        const idx = items.findIndex(i => i.id === editingId);
        items[idx] = { ...items[idx], ...formData };
        toast("Item updated");
      } else {
        const newId = items.length ? Math.max(...items.map(i => i.id)) + 1 : 1;
        items.push({ id: newId, ...formData });
        toast("Item added");
      }
      setItems(items);
      closeModal();
      renderList();
    }

    function deleteItem(id) {
      const targetId = (id !== undefined && id !== null && id !== "") ? id : editingId;
      if (targetId === undefined || targetId === null || targetId === "") {
        closeModal();
        toast("Item discarded");
        return;
      }
      pendingDeleteId = targetId;
      pendingDeleteKind = "punchlist-item";
      document.getElementById("deleteModalTitle").textContent = "Delete item?";
      document.getElementById("deleteModalLabel").textContent =
        "This punchlist item will be permanently deleted.";
      const modal = document.getElementById("deleteModal");
      modal.classList.remove("hidden");
      modal.classList.add("show");
      modal.setAttribute("aria-hidden", "false");
    }

    function performDeletePunchlistItem(id) {
      const targetId = (id !== undefined && id !== null && id !== "") ? id : editingId;
      if (targetId === undefined || targetId === null || targetId === "") {
        closeDeleteModal();
        return;
      }
      const items = getItems();
      const next = items.filter(i => String(i.id) !== String(targetId));
      setItems(next);
      closeDeleteModal();
      closeModal();
      renderList();
      toast("Item deleted");
    }
    window.performDeletePunchlistItem = performDeletePunchlistItem;
    window.deleteItem = deleteItem;

    function closeModal() {
      const overlay = document.getElementById("pl-modal");
      const sheet = document.getElementById("modal-sheet");
      overlay.classList.remove("show");
      if (sheet) {
        sheet.style.transform = "";
        sheet.classList.remove("dragging");
      }
      overlay.style.background = "";
      editingId = null;
      tempPhoto = null;
      const tb = document.getElementById("modal-trash");
      if (tb) tb.style.display = "none";
    }

    document.getElementById("pl-modal").addEventListener("click", (e) => { if (e.target.id === "pl-modal") closeModal(); });

    // Trash button uses onclick set in showForm (avoids double-binding)

    // Swipe down to close modal sheet
    (function setupSwipeClose() {
      const sheet = document.getElementById("modal-sheet");
      const overlay = document.getElementById("pl-modal");
      if (!sheet || !overlay) return;

      let startY = 0;
      let currentY = 0;
      let dragging = false;

      function onStart(y) {
        // Only start drag near the top of the sheet (handle / header area)
        startY = y;
        currentY = 0;
        dragging = true;
        sheet.classList.add("dragging");
      }

      function onMove(y) {
        if (!dragging) return;
        currentY = Math.max(0, y - startY);
        sheet.style.transform = `translateY(${currentY}px)`;
        overlay.style.background = `rgba(0,0,0,${Math.max(0.25, 0.72 - currentY / 600)})`;
      }

      function onEnd() {
        if (!dragging) return;
        dragging = false;
        sheet.classList.remove("dragging");
        if (currentY > 120) {
          sheet.style.transform = "translateY(100%)";
          setTimeout(() => {
            closeModal();
            sheet.style.transform = "";
            overlay.style.background = "";
          }, 180);
        } else {
          sheet.style.transform = "";
          overlay.style.background = "";
        }
        currentY = 0;
      }

      sheet.addEventListener("touchstart", (e) => {
        const t = e.touches[0];
        const rect = sheet.getBoundingClientRect();
        // Allow swipe from top 80px of sheet
        if (t.clientY - rect.top < 80) onStart(t.clientY);
      }, { passive: true });

      sheet.addEventListener("touchmove", (e) => {
        if (!dragging) return;
        onMove(e.touches[0].clientY);
      }, { passive: true });

      sheet.addEventListener("touchend", onEnd);
      sheet.addEventListener("touchcancel", onEnd);
    })();

    const btnJobs = document.getElementById("btn-jobs");
    if (btnJobs) btnJobs.addEventListener("click", () => {
      const jobNames = Object.keys(data.jobs);
      document.getElementById("modal-title").textContent = "Manage Jobs";
      const tb = document.getElementById("modal-trash"); if (tb) tb.style.display = "none";
      const cam = document.getElementById("modal-camera"); if (cam) cam.style.display = "none";
      document.getElementById("modal-body").innerHTML = `
        <div class="job-manage-list">
          ${jobNames.map(j => `
            <div class="job-manage-item">
              <span>${escapeHtml((typeof punchlistDisplayName === "function") ? punchlistDisplayName(j) : j)} ${j === data.currentJob ? "(current)" : ""}</span>
              ${jobNames.length > 1 ? `
                <button type="button" class="icon-btn danger" data-job="${escapeHtml(j)}" title="Delete job">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M10 11v6M14 11v6"/></svg>
                </button>` : ''}
            </div>
          `).join("")}
        </div>
        <div class="form-group">
          <label>New Job Name</label>
          <input type="text" id="new-job-name" placeholder="e.g. Customer / Line name">
        </div>
        <div class="btn-row">
          <button type="button" class="btn btn-outline" onclick="closeModal()">Close</button>
          <button class="btn btn-primary" onclick="addJob()">Add Job</button>
        </div>
      `;
      document.getElementById("pl-modal").classList.add("show");
      document.querySelectorAll("#modal-body [data-job]").forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const name = btn.getAttribute("data-job");
          if (name) deleteJob(name);
        });
      });
    });

    function addJob() {
      const name = document.getElementById("new-job-name").value.trim();
      if (!name) { alert("Enter a job name"); return; }
      if (data.jobs[name]) { alert("A job with that name already exists"); return; }
      data.jobs[name] = [];
      data.currentJob = name;
      plSaveData();
      populateJobSelect();
      closeModal();
      renderList();
      toast("Punchlist created: " + name);
    }

    function deleteJob(name) {
      if (!name || !data.jobs[name]) {
        toast("Job not found");
        return;
      }
      if (!confirm("Delete job \"" + name + "\" and all its items?")) return;
      delete data.jobs[name];
      if (data.currentJob === name) {
        const remaining = Object.keys(data.jobs);
        data.currentJob = remaining[0] || "";
      }
      plSaveData();
      populateJobSelect();
      closeModal();
      renderList();
      toast("Job deleted");
    }
    window.deleteJob = deleteJob;
    window.deleteItem = deleteItem;
    window.handlePhoto = handlePhoto;
    window.removePhoto = removePhoto;
    window.requestDeletePunchlistPhoto = requestDeletePunchlistPhoto;
    window.openPunchlistPhoto = openPunchlistPhoto;
    window.closePunchlistPhoto = closePunchlistPhoto;
    window.closeModal = closeModal;
    window.saveItem = saveItem;
    window.openDetail = openDetail;
    window.addJob = addJob;
    window.toggleItem = toggleItem;
    window.renderList = renderList;
    window.plRenderList = renderList;
    window.plLoadData = plLoadData;
    window.plSaveData = plSaveData;
    window.populateJobSelect = populateJobSelect;

    window.getPunchlistName = function(key) {
      if (!key) return 'Punchlist';
      if (data && data.listNames && data.listNames[key]) return data.listNames[key];
      if (!isInternalId(key)) return String(key);
      return 'Punchlist';
    };
    window.getPunchlistJobId = function(key) {
      if (!data || !data.jobIdByKey) return '';
      return data.jobIdByKey[key] || '';
    };
    window.getCurrentPunchlistKey = function() {
      return (data && data.currentJob) || '';
    };
    window.updatePunchlistMeta = async function(key, name, jobId) {
      await plLoadData();
      if (!data) data = { jobs: {}, currentJob: '' };
      if (!data.jobs) data.jobs = {};
      if (!data.jobs[key]) data.jobs[key] = [];
      if (!data.listNames) data.listNames = {};
      if (!data.jobIdByKey) data.jobIdByKey = {};
      if (!data.keyByJobId) data.keyByJobId = {};
      data.listNames[key] = String(name || '').trim() || 'Punchlist';
      const prev = data.jobIdByKey[key];
      if (jobId) {
        data.jobIdByKey[key] = jobId;
        data.keyByJobId[jobId] = key;
      } else {
        delete data.jobIdByKey[key];
        if (prev && data.keyByJobId[prev] === key) delete data.keyByJobId[prev];
      }
      data.currentJob = key;
      await plSaveData();
      return true;
    };

    window.performDeletePunchlist = async function(key) {
      await plLoadData();
      if (!data || !data.jobs || !key || !data.jobs[key]) {
        toast('Punchlist not found');
        if (typeof closeDeleteModal === 'function') closeDeleteModal();
        return;
      }
      delete data.jobs[key];
      if (data.listNames) delete data.listNames[key];
      if (data.jobIdByKey) delete data.jobIdByKey[key];
      if (data.currentJob === key) {
        const left = Object.keys(data.jobs);
        data.currentJob = left[0] || '';
      }
      await plSaveData();
      if (typeof closeDeleteModal === 'function') closeDeleteModal();
      toast('Punchlist deleted');
      if (typeof populateJobSelect === 'function') populateJobSelect();
      if (typeof openPunchlistRecentList === 'function') openPunchlistRecentList();
      else if (typeof refreshPunchlistHome === 'function') refreshPunchlistHome();
    };
    window.createPunchlistForJob = async function(job) {
      await plLoadData();
      if (!data) data = { jobs: {}, currentJob: '' };
      if (!data.jobs) data.jobs = {};
      if (!data.listNames) data.listNames = {};
      if (!data.jobIdByKey) data.jobIdByKey = {};
      if (!data.keyByJobId) data.keyByJobId = {};
      const key = (typeof newEntityId === 'function') ? newEntityId('pl') : ('pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
      data.jobs[key] = [];
      const label = 'Punchlist';
      data.listNames[key] = label;
      if (job && job.id) {
        try { if (typeof ensureJobIdentity === 'function') ensureJobIdentity(job); } catch (e) {}
        data.jobIdByKey[key] = job.id;
        data.keyByJobId[job.id] = key;
      }
      data.currentJob = key;
      await plSaveData();
      populateJobSelect();
      renderList();
      try {
        if (typeof window.setLastPunchlistName === 'function') window.setLastPunchlistName(key);
      } catch (e) {}
      return key;
    };
    window.openPunchlistForJob = async function(job) {
      return window.createPunchlistForJob(job);
    };
    window.getPunchlistStatsForJob = async function(jobOrName) {
      await plLoadData();
      if (!data || !data.jobs) return { total: 0, open: 0, complete: 0 };
      const jobId = (jobOrName && typeof jobOrName === 'object') ? jobOrName.id : '';
      const name = typeof jobOrName === 'string' ? jobOrName : '';
      const keys = Object.keys(data.jobs).filter(k => {
        if (jobId && data.jobIdByKey && data.jobIdByKey[k] === jobId) return true;
        if (name && (k === name || (data.listNames && data.listNames[k] === name))) return true;
        return false;
      });
      let total = 0, complete = 0;
      keys.forEach(k => {
        const items = data.jobs[k] || [];
        total += items.length;
        complete += items.filter(it => it && it.status === 'Complete').length;
      });
      return { total, complete, open: Math.max(0, total - complete) };
    };
    window.searchPunchlistItems = async function(q) {
      await plLoadData();
      const needle = String(q || "").trim().toLowerCase();
      if (!needle || !data || !data.jobs) return [];
      const out = [];
      Object.keys(data.jobs).forEach(name => {
        (data.jobs[name] || []).forEach(item => {
          if (!item) return;
          const hay = [item.description, item.action, item.location, item.line, item.comments, item.department, item.status, name,
            item.dueDate, item.createdAt,
            (typeof searchDateHay === "function" ? searchDateHay(item.dueDate) : ""),
            (typeof searchDateHay === "function" ? searchDateHay(item.createdAt) : "")]
            .map(x => String(x || "").toLowerCase()).join(" ");
          if (hay.indexOf(needle) >= 0) {
            out.push({
              job: (typeof punchlistDisplayName === 'function') ? punchlistDisplayName(name) : name,
              jobKey: name,
              id: item.id,
              description: item.description || "Punchlist item",
              status: item.status || "",
              location: item.location || "",
              line: item.line || ""
            });
          }
        });
      });
      return out.slice(0, 30);
    };
    window.openPunchlistItem = async function(jobName, itemId) {
      await window.openPunchlistByName(jobName);
      if (typeof openDetail === "function") openDetail(itemId);
    };
    window.getPunchlistSummaries = async function() {
      await plLoadData();
      if (!data || !data.jobs) return [];
      const links = data.jobIdByKey || {};
      const fieldJobs = (typeof loadJobs === 'function' ? loadJobs() : []) || [];
      return Object.keys(data.jobs).map(name => {
        const items = data.jobs[name] || [];
        const complete = items.filter(i => i && i.status === 'Complete').length;
        const jobId = links[name] || '';
        const job = fieldJobs.find(j => j && j.id === jobId);
        const jobLabel = job
          ? ((typeof jobDisplayName === 'function') ? jobDisplayName(job) : (job.customer || ''))
          : '';
        const displayName = (typeof punchlistDisplayName === 'function') ? punchlistDisplayName(name) : name;
        return { name: displayName, key: name, total: items.length, complete, jobId, jobLabel: jobLabel || displayName };
      }).sort((a, b) => {
        // Prefer non-empty, then alpha
        if ((b.total > 0) !== (a.total > 0)) return b.total > 0 ? 1 : -1;
        return String(a.name).localeCompare(String(b.name));
      });
    };
    window.setPunchlistJobLink = async function(name, jobId) {
      await plLoadData();
      if (!data) data = { jobs: {}, currentJob: '' };
      if (!data.jobs) data.jobs = {};
      if (!data.jobs[name]) data.jobs[name] = [];
      if (!data.jobIdByKey) data.jobIdByKey = {};
      if (!data.keyByJobId) data.keyByJobId = {};
      if (jobId) {
        data.jobIdByKey[name] = jobId;
        data.keyByJobId[jobId] = name;
      } else {
        const prev = data.jobIdByKey[name];
        delete data.jobIdByKey[name];
        if (prev && data.keyByJobId[prev] === name) delete data.keyByJobId[prev];
      }
      await plSaveData();
      return true;
    };
    window.openPunchlistByName = async function(name) {
      await plLoadData();
      if (!data) data = { jobs: {}, currentJob: '' };
      if (!data.jobs) data.jobs = {};
      let key = name;
      if (!data.jobs[key]) {
        if (data.keyByJobId && data.keyByJobId[name]) key = data.keyByJobId[name];
        else if (data.jobIdByKey && data.jobIdByKey[name] && data.jobs[data.jobIdByKey[name]]) key = data.jobIdByKey[name];
        else if (data.listNames) {
          const found = Object.keys(data.listNames).find(k => data.listNames[k] === name && data.jobs[k]);
          if (found) key = found;
        }
      }
      if (!data.jobs[key]) data.jobs[key] = [];
      data.currentJob = key;
      name = key;
      await plSaveData();
      populateJobSelect();
      renderList();
      try {
        if (typeof window.setLastPunchlistName === 'function') window.setLastPunchlistName(name);
        else localStorage.setItem('lx8_last_punchlist', name);
      } catch (e) {}
      return name;
    };
    window.getPunchlistBackup = function() {
      return JSON.parse(JSON.stringify(data));
    };
    window.setPunchlistBackup = async function(saved) {
      if (!saved || !saved.jobs) throw new Error('bad-punchlist');
      data = saved;
      if (!data.currentJob || !data.jobs[data.currentJob]) {
        const names = Object.keys(data.jobs);
        data.currentJob = names[0] || "Default";
        if (!data.jobs[data.currentJob]) data.jobs[data.currentJob] = [];
      }
      await plSaveData();
      populateJobSelect();
      renderList();
      return true;
    };

    

    async function loadWorkbookTemplate(fileName, cacheKey) {
      const key = cacheKey || fileName;
      try {
        const cached = await idbGetKv(key);
        if (cached && (cached.byteLength || (cached.buffer && cached.byteLength !== 0))) {
          return cached.buffer ? cached : cached;
        }
      } catch (e) {}
      const names = [fileName, './' + fileName, fileName.split('/').pop()];
      let lastErr = null;
      for (const name of names) {
        try {
          const res = await fetch(name, { cache: 'reload' });
          if (!res.ok) { lastErr = new Error('HTTP ' + res.status + ' ' + name); continue; }
          const buf = await res.arrayBuffer();
          if (!buf || buf.byteLength < 100) { lastErr = new Error('Empty template ' + name); continue; }
          const head = new Uint8Array(buf.slice(0, 2));
          if (head[0] !== 0x50 || head[1] !== 0x4B) { lastErr = new Error('Not an xlsx: ' + name); continue; }
          try { await idbSetKv(key, buf); } catch (e) {}
          return buf;
        } catch (e) { lastErr = e; }
      }
      try {
        const cached = await idbGetKv(key);
        if (cached) return cached.buffer ? cached : cached;
      } catch (e) {}
      throw lastErr || new Error('Could not load ' + fileName);
    }
    async function getStoredTemplateBuffer() {
      return loadWorkbookTemplate('Punchlist-Template.xlsx', 'templateXlsx');
    }
    async function getTimecardTemplateBuffer() {
      return loadWorkbookTemplate('timecard-template.xlsx', 'timecardTemplateXlsx');
    }

    function loadScriptOnce(src) {
      return new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-lib-src="' + src + '"]');
        if (existing) {
          if (existing.getAttribute('data-loaded') === '1') return resolve();
          existing.addEventListener('load', () => resolve());
          existing.addEventListener('error', () => reject(new Error('Failed ' + src)));
          return;
        }
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.setAttribute('data-lib-src', src);
        s.onload = () => { s.setAttribute('data-loaded', '1'); resolve(); };
        s.onerror = () => reject(new Error('Failed ' + src));
        document.head.appendChild(s);
      });
    }


    const EXPORT_LIB_BTNS = ['tcExportContinue','saveSheetXlsx','plExportXlsx'];
    function excelLibsReady() { return typeof ExcelJS !== 'undefined'; }
    function setExportButtonsReady(ready) {
      EXPORT_LIB_BTNS.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.disabled = !ready;
        el.setAttribute('aria-disabled', ready ? 'false' : 'true');
        el.classList.toggle('is-waiting-lib', !ready);
        if (!el.dataset.readyLabel) el.dataset.readyLabel = el.textContent;
        if (!ready) el.textContent = 'Loading Excel…';
        else el.textContent = el.dataset.readyLabel;
      });
    }
    let excelWarm;
    function warmExcelLibs() {
      if (excelLibsReady()) { setExportButtonsReady(true); return Promise.resolve(true); }
      if (excelWarm) return excelWarm;
      setExportButtonsReady(false);
      excelWarm = ensureExcelLibs().then(() => {
        const ok = excelLibsReady();
        setExportButtonsReady(ok);
        return ok;
      }).catch((err) => {
        console.warn(err);
        setExportButtonsReady(false);
        EXPORT_LIB_BTNS.forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.textContent = 'Excel unavailable';
        });
        return false;
      });
      return excelWarm;
    }
    async function ensureExportLibs() {
      return ensureExcelLibs();
    }
    async function ensureExcelLibs() {
      if (typeof ExcelJS === 'undefined') {
        const urls = [
          'exceljs.min.js',
          'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js'
        ];
        for (const url of urls) {
          try {
            await loadScriptOnce(url);
            if (typeof ExcelJS !== 'undefined') break;
          } catch (e) {}
        }
      }
      if (typeof window.jspdf === 'undefined') {
        const pdfUrls = [
          'jspdf.umd.min.js',
          'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js'
        ];
        for (const url of pdfUrls) {
          try {
            await loadScriptOnce(url);
            if (typeof window.jspdf !== 'undefined') break;
          } catch (e) {}
        }
        if (typeof window.jspdf !== 'undefined' && typeof window.jspdf.jsPDF.API.autoTable === 'undefined') {
          try { await loadScriptOnce('jspdf.plugin.autotable.min.js'); } catch (e) {}
        }
      }
    }

    async function downloadBlob(blob, filename) {
      const type = blob.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      const file = new File([blob], filename, { type });
      try {
        if (navigator.share) {
          if (!navigator.canShare || navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: filename });
            return true;
          }
        }
      } catch (e) {
        if (e && e.name === "AbortError") return true;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.target = "_blank";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} a.remove(); }, 4000);
      return true;
    }


    async function exportPunchlistPdf() {
      try { await ensureExcelLibs(); } catch (e) {}
      if (typeof window.jspdf === 'undefined') {
        toast('PDF library not available');
        return;
      }
      const rawItems = (typeof getItems === 'function' ? getItems() : []) || [];
      const jobKey = data.currentJob || '';
      const jobName = (typeof punchlistDisplayName === 'function') ? punchlistDisplayName(jobKey) : (jobKey || 'Punchlist');
      const jobs = (typeof loadJobs === 'function') ? loadJobs() : [];
      const job = jobs.find(j => j && (j.id === jobKey || (typeof jobDisplayName === 'function' && jobDisplayName(j) === jobName) || j.customer === jobName)) || null;
      const customer = (job && job.customer) || (isInternalId(jobName) ? 'Customer' : jobName) || 'Customer';
      const site = (job && job.site) || '';
      const tech = (job && job.technician) || '';
      const dateRange = (typeof formatJobDateRange === 'function' && job) ? formatJobDateRange(job) : '';
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'letter' });
      const W = doc.internal.pageSize.getWidth();
      const H = doc.internal.pageSize.getHeight();
      const L = 10;

      function paintChrome() {
        doc.setFillColor(20, 20, 24);
        doc.rect(0, 0, W, 8, 'F');
        doc.setFillColor(212, 34, 59);
        doc.rect(0, 0, 2.6, 8, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.text('LeMatic  ·  Field Service Report', 8, 5.4);
        doc.setFont('helvetica', 'normal');
        doc.text((customer + (dateRange ? '  ·  ' + dateRange : '')).substring(0, 70), W - 8, 5.4, { align: 'right' });
        doc.setFillColor(244, 245, 247);
        doc.rect(0, H - 8, W, 8, 'F');
        doc.setTextColor(92, 101, 112);
        doc.setFontSize(7);
        doc.text('Punchlist  ·  Customer copy', 8, H - 3.2);
        const page = doc.internal.getCurrentPageInfo().pageNumber;
        doc.text('Page ' + page, W - 8, H - 3.2, { align: 'right' });
      }
      paintChrome();

      doc.setFillColor(20, 20, 24);
      doc.rect(L, 12, W - 20, 18, 'F');
      doc.setTextColor(243, 179, 188);
      doc.setFontSize(7);
      doc.text('PUNCHLIST', L + 4, 17.5);
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.text(String(customer).substring(0, 48), L + 4, 24);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(208, 213, 219);
      const sub = [site, dateRange, tech].filter(Boolean).join('  ·  ');
      if (sub) doc.text(sub, L + 70, 24);
      try {
        if (typeof LEMATIC_LOGO_JPG === 'string' && LEMATIC_LOGO_JPG) {
          doc.setFillColor(255, 255, 255);
          doc.roundedRect(W - 10 - 32, 14.2, 30, 10, 1, 1, 'F');
          doc.addImage('data:image/jpeg;base64,' + LEMATIC_LOGO_JPG, 'JPEG', W - 10 - 30.6, 15, 27.2, 8.4);
        }
      } catch (e) {}

      function normStatus(s) {
        const v = String(s || '').trim().toLowerCase();
        if (v === 'complete' || v === 'done' || v === 'completed') return 'Complete';
        if (v === 'in progress' || v === 'progress') return 'In Progress';
        if (v.indexOf('waiting') >= 0) return 'Waiting Parts';
        return 'Not Started';
      }
      function statusRank(s) {
        const n = normStatus(s);
        if (n === 'Complete') return 4;
        if (n === 'In Progress') return 2;
        if (n === 'Waiting Parts') return 1;
        return 0;
      }

      const items = rawItems.slice().sort(function (a, b) {
        const ra = statusRank(a && a.status);
        const rb = statusRank(b && b.status);
        if (ra !== rb) return ra - rb;
        return 0;
      });

      const head = [['#', 'Line', 'Location', 'Description', 'Action', 'Department', 'Comments', 'Status']];
      const body = (items.length ? items : [{}]).map(function (item, idx) {
        return [
          idx + 1,
          item.line || '',
          item.location || '',
          item.description || '',
          item.action || '',
          item.department || '',
          item.comments || '',
          normStatus(item.status)
        ];
      });

      if (typeof doc.autoTable === 'function') {
        doc.autoTable({
          head: head,
          body: body,
          startY: 34,
          theme: 'grid',
          styles: {
            font: 'helvetica',
            fontSize: 8,
            cellPadding: 1.6,
            valign: 'middle',
            textColor: [20, 20, 24],
            lineColor: [200, 204, 210],
            lineWidth: 0.2,
            overflow: 'linebreak'
          },
          headStyles: {
            fillColor: [20, 20, 24],
            textColor: [255, 255, 255],
            fontStyle: 'bold',
            fontSize: 8
          },
          columnStyles: {
            0: { cellWidth: 12, halign: 'center' },
            1: { cellWidth: 22 },
            2: { cellWidth: 28 },
            3: { cellWidth: 58 },
            4: { cellWidth: 50 },
            5: { cellWidth: 26 },
            6: { cellWidth: 50 },
            7: { cellWidth: 24 }
          },
          didParseCell: function (data) {
            if (data.section !== 'body') return;
            const status = String(data.row.raw[7] || '');
            const sl = status.toLowerCase();
            if (data.column.index === 7) {
              data.cell.styles.fontStyle = 'bold';
              if (sl === 'complete') data.cell.styles.textColor = [27, 122, 74];
              else if (sl === 'in progress') data.cell.styles.textColor = [10, 132, 255];
              else if (sl.indexOf('waiting') >= 0) data.cell.styles.textColor = [184, 134, 11];
              else data.cell.styles.textColor = [196, 57, 57];
            }
            const pri = String((items[data.row.index] || {}).priority || '').toLowerCase();
            if (sl !== 'complete' && (pri === 'high' || pri === 'critical')) {
              data.cell.styles.fillColor = [252, 232, 234];
            }
          },
          didDrawPage: function () { paintChrome(); }
        });
      } else {
        doc.setTextColor(20, 20, 24);
        doc.setFontSize(10);
        doc.text('Punchlist table requires the PDF table plugin.', L, 40);
      }

      const photos = items.map(function (item, idx) {
        return { item: item, num: idx + 1, src: item && item.photo };
      }).filter(function (p) { return p.src && String(p.src).indexOf('data:image') === 0; });

      if (photos.length) {
        doc.addPage('letter', 'landscape');
        paintChrome();
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        doc.setTextColor(20, 20, 24);
        doc.text('Photos', L, 16);
        let x = L;
        let y = 20;
        const boxW = 88;
        const boxH = 62;
        const gap = 6;
        photos.forEach(function (p, i) {
          if (y + boxH + 12 > H - 10) {
            doc.addPage('letter', 'landscape');
            paintChrome();
            x = L;
            y = 16;
          }
          if (x + boxW > W - 8) {
            x = L;
            y += boxH + 14;
            if (y + boxH + 12 > H - 10) {
              doc.addPage('letter', 'landscape');
              paintChrome();
              x = L;
              y = 16;
            }
          }
          doc.setDrawColor(200, 204, 210);
          doc.setFillColor(248, 249, 251);
          doc.roundedRect(x, y, boxW, boxH, 1.5, 1.5, 'FD');
          try {
            const fmt = (String(p.src).indexOf('image/png') >= 0) ? 'PNG' : 'JPEG';
            doc.addImage(p.src, fmt, x + 2, y + 2, boxW - 4, boxH - 12, undefined, 'FAST');
          } catch (e) {}
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(7.5);
          doc.setTextColor(20, 20, 24);
          const cap = '#' + p.num + '  ' + String((p.item && (p.item.description || p.item.location || p.item.line)) || 'Photo').substring(0, 42);
          doc.text(cap, x + 2, y + boxH - 3);
          x += boxW + gap;
        });
      }

      const safe = String(jobName).replace(/[\\/:*?"<>|]/g, '-').trim() || 'Punchlist';
      doc.save(safe + ' Punchlist.pdf');
      toast('Punchlist PDF downloaded');
    }


    
    


    async function exportPunchlistExcel() {
      const items = getItems();
      const jobName = data.currentJob || "Punchlist";
      const safeName = jobName.replace(/[\\/:*?"<>|]/g, "-").trim() || "Punchlist";
      const filename = safeName + " Punchlist.xlsx";

      function normStatus(s) {
        const v = String(s || "").trim().toLowerCase();
        if (v === "complete" || v === "done" || v === "completed") return "Complete";
        if (v === "in progress" || v === "progress") return "In Progress";
        if (v === "waiting parts" || v === "waiting part" || v === "parts") return "Waiting Parts";
        return "Not Started";
      }
      function solid(argb) {
        return { type: "pattern", pattern: "solid", fgColor: { argb: argb } };
      }

      await ensureExcelLibs();
      if (typeof ExcelJS === "undefined") { toast("Excel library not available"); return; }

      const templateBuf = await getStoredTemplateBuffer();
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(templateBuf);
      const ws = wb.worksheets[0];
      const firstDataRow = 6;
      const lastTemplateRow = 50;
      const used = Math.max(items.length, 1);

      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const row = ws.getRow(firstDataRow + idx);
        const status = normStatus(item.status);
        const dept = String(item.department || "").trim();
        row.getCell(1).value = idx + 1;
        row.getCell(2).value = item.line || "";
        row.getCell(3).value = item.location || "";
        row.getCell(4).value = item.description || "";
        row.getCell(5).value = item.action || "";
        row.getCell(6).value = dept;
        row.getCell(7).value = item.comments || "";
        row.getCell(8).value = status;
        for (let c = 2; c <= 7; c++) {
          const cell = row.getCell(c);
          cell.alignment = Object.assign({}, cell.alignment || {}, { wrapText: true, vertical: "top" });
        }
        const text = [item.description, item.action, item.comments].join(" ");
        const lines = Math.max(1, Math.ceil(String(text).length / 42));
        row.height = Math.min(72, Math.max(row.height || 18, 18 + lines * 12));
      }

      if (!items.length) {
        const row = ws.getRow(firstDataRow);
        row.getCell(1).value = 1;
        for (let c = 2; c <= 8; c++) row.getCell(c).value = "";
      }

      const deleteFrom = firstDataRow + used;
      const deleteCount = lastTemplateRow - deleteFrom + 1;
      if (deleteCount > 0 && typeof ws.spliceRows === "function") {
        ws.spliceRows(deleteFrom, deleteCount);
      }

      if (ws.conditionalFormattings && ws.conditionalFormattings.length) {
        const last = firstDataRow + used - 1;
        ws.conditionalFormattings.forEach((cf) => {
          if (!cf || !cf.ref) return;
          const ref = String(cf.ref);
          if (ref.indexOf("F6") === 0) cf.ref = "F6:F" + last;
          if (ref.indexOf("H6") === 0) cf.ref = "H6:H" + last;
        });
      }

      const photoItems = items.map((item, idx) => ({ item, num: idx + 1 })).filter(p => p.item && p.item.photo && String(p.item.photo).indexOf('data:image') === 0);
      if (photoItems.length) {
        const pws = wb.addWorksheet('Photos', { properties: { tabColor: { argb: 'FFD4223B' } } });
        pws.getColumn(1).width = 12;
        pws.getColumn(2).width = 48;
        pws.getColumn(3).width = 48;
        pws.getCell('A1').value = 'Item';
        pws.getCell('B1').value = 'Description';
        pws.getCell('C1').value = 'Photo';
        ['A1','B1','C1'].forEach(addr => {
          pws.getCell(addr).font = { bold: true, color: { argb: 'FFFFFFFF' } };
          pws.getCell(addr).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF141418' } };
        });
        photoItems.forEach((p, i) => {
          const rowIdx = i + 2;
          const row = pws.getRow(rowIdx);
          row.height = 120;
          row.getCell(1).value = p.num;
          row.getCell(2).value = p.item.description || p.item.location || p.item.line || '';
          row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
          try {
            const src = String(p.item.photo);
            const isPng = src.indexOf('image/png') >= 0;
            const base64 = src.replace(/^data:image\/[^;]+;base64,/, '');
            const imgId = wb.addImage({ base64: base64, extension: isPng ? 'png' : 'jpeg' });
            pws.addImage(imgId, {
              tl: { col: 2, row: rowIdx - 1 },
              ext: { width: 220, height: 150 },
              editAs: 'oneCell'
            });
          } catch (e) {}
        });
      }

      const out = await wb.xlsx.writeBuffer();
      const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
      toast("Excel ready — use Save to Files if asked");
    }


    function openPlExportSheet() {
      const sheet = document.getElementById('plExportSheet');
      if (!sheet) return;
      sheet.hidden = false;
      sheet.removeAttribute('hidden');
      sheet.classList.add('show');
      setExportButtonsReady(excelLibsReady());
      warmExcelLibs();
    }
    function closePlExportSheet() {
      const sheet = document.getElementById('plExportSheet');
      if (!sheet) return;
      sheet.classList.remove('show');
      sheet.hidden = true;
      sheet.setAttribute('hidden', '');
    }
    document.getElementById("btn-export").addEventListener("click", () => {
      openPlExportSheet();
    });
    const plExportPdf = document.getElementById('plExportPdf');
    if (plExportPdf) plExportPdf.addEventListener('click', () => {
      closePlExportSheet();
      exportPunchlistPdf();
    });
    const plExportXlsx = document.getElementById('plExportXlsx');
    if (plExportXlsx) plExportXlsx.addEventListener('click', () => {
      closePlExportSheet();
      exportPunchlistExcel().catch(err => {
        console.warn(err);
        toast("Could not build Excel file");
      });
    });
    const plExportCancel = document.getElementById('plExportCancel');
    if (plExportCancel) plExportCancel.addEventListener('click', closePlExportSheet);

    function prefetchExportLibs() {
      const run = function() {
        try {
          if (typeof ensureExcelLibs === 'function') ensureExcelLibs();
          else if (typeof loadScriptOnce === 'function') {
            loadScriptOnce('exceljs.min.js');
            loadScriptOnce('jspdf.umd.min.js');
          }
        } catch (e) {}
      };
      if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 4000 });
      else setTimeout(run, 1800);
    }
    async function initPunchlist() {
      await plLoadData();
      populateJobSelect();
      renderList();
      updateOnlineStatus();
      try {
        if (data && data.currentJob) {
          if (typeof window.setLastPunchlistName === 'function') window.setLastPunchlistName(data.currentJob);
          else localStorage.setItem('lx8_last_punchlist', JSON.stringify(data.currentJob));
        }
      } catch (e) {}
    }
    window.initPunchlist = initPunchlist;

    // ========== TIME CARDS ==========
    const TC_MAX_MS = 24 * 60 * 60 * 1000;
    

    let tcState = {
      entries: [],
      active: null,
      weekOffset: 0,
      periodOffset: 0,
      editId: null,
      selectedType: 'bakery',
      tickTimer: null
    };
    window.tcState = tcState;


    function tcNormText(s) {
      return String(s || '').toLowerCase().replace(/[–—−]/g, '-').replace(/[^a-z0-9]+/g, ' ').trim();
    }
    function tcJobLabelSet(job) {
      const set = new Set();
      if (!job) return set;
      const display = (typeof jobDisplayName === 'function') ? jobDisplayName(job) : '';
      const joined = [job.customer, job.site].filter(Boolean).join(' ');
      [job.id, job.customer, job.site, job.bakeryName, job.name, display, joined,
        [job.customer, job.site].filter(Boolean).join(' - ')]
        .map(tcNormText)
        .filter(Boolean)
        .forEach(v => set.add(v));
      return set;
    }
    function tcLiveJobIdSet(jobs) {
      const set = new Set();
      (jobs || []).forEach(j => { if (j && j.id) set.add(String(j.id)); });
      return set;
    }
    function tcEntryMatchesJob(en, job, jobsList) {
      if (!en || !job) return false;
      if (en.jobId && job.id && String(en.jobId) === String(job.id)) return true;
      const jobs = jobsList || ((typeof loadJobs === 'function' ? loadJobs() : []) || []);
      if (en.jobId && tcLiveJobIdSet(jobs).has(String(en.jobId)) && String(en.jobId) !== String(job.id)) {
        return false;
      }
      const labels = tcJobLabelSet(job);
      const bits = [en.jobId, en.bakeryName, en.jobName, en.job, en.customer, en.site, en.bakery];
      for (let i = 0; i < bits.length; i++) {
        const n = tcNormText(bits[i]);
        if (!n) continue;
        if (labels.has(n)) return true;
        for (const lab of labels) {
          if (!lab || lab.length < 4) continue;
          if (n.indexOf(lab) !== -1 || lab.indexOf(n) !== -1) return true;
        }
      }
      return false;
    }
    function tcNormalizeEntryJobs() {
      let jobs = [];
      try { jobs = (typeof loadJobs === 'function' ? loadJobs() : []) || []; } catch (e) {}
      if (!jobs.length) return;
      const live = tcLiveJobIdSet(jobs);
      let changed = false;
      (tcState.entries || []).forEach(en => {
        if (!en) return;
        if (en.jobId && live.has(String(en.jobId))) return;
        const match = jobs.find(j => tcEntryMatchesJob(Object.assign({}, en, { jobId: '' }), j, jobs));
        if (match && match.id) {
          en.jobId = match.id;
          if (!en.bakeryName) {
            en.bakeryName = (typeof jobDisplayName === 'function') ? jobDisplayName(match) : (match.customer || '');
          }
          changed = true;
        }
      });
      if (changed) {
        try { tcSave(); } catch (e) {}
      }
    }
    window.tcNormText = tcNormText;
    window.tcJobLabelSet = tcJobLabelSet;
    window.tcEntryMatchesJob = tcEntryMatchesJob;
    window.tcNormalizeEntryJobs = tcNormalizeEntryJobs;
    function tcEntriesForJob(jobOrId) {
      try { tcLoad(); } catch (e) {}
      const job = (jobOrId && typeof jobOrId === 'object')
        ? jobOrId
        : ((typeof loadJobs === 'function' ? loadJobs() : []) || []).find(j => j && j.id === jobOrId);
      if (!job) return [];
      return (tcState.entries || []).filter(en => tcEntryMatchesJob(en, job));
    }
    window.tcEntriesForJob = tcEntriesForJob;
    function tcHoursForJob(jobId) {
      if (!jobId) return 0;
      try { tcLoad(); } catch (e) {}
      const job = ((typeof loadJobs === 'function' ? loadJobs() : []) || []).find(j => j && j.id === jobId);
      let total = 0;
      (job ? tcEntriesForJob(job) : (tcState.entries || []).filter(en => en && en.jobId === jobId))
        .forEach(en => { total += tcEntryHours(en); });
      return Math.round(total * 100) / 100;
    }
    window.tcHoursForJob = tcHoursForJob;
    window.tcEntriesForJob = tcEntriesForJob;
    window.tcEntryHours = tcEntryHours;
    window.tcLoad = tcLoad;

    function tcUid() {
      return 'tc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }
    function tcLoad() {
      try {
        const raw = lsRead('lx8_timecards', null);
        if (raw && typeof raw === 'object') {
          tcState.entries = Array.isArray(raw.entries) ? raw.entries : [];
          tcState.active = raw.active || null;
        }
      } catch (e) { tcState.entries = []; tcState.active = null; }
      try { tcNormalizeEntryJobs(); } catch (e) {}
      tcEnsureSampleWeek();
    }
    function tcSave() {
      try { lsWrite('lx8_timecards', { entries: tcState.entries, active: tcState.active }); } catch (e) {}
    }

    function tcResolveExportName(entries) {
      const jobs = (typeof loadJobs === 'function') ? loadJobs() : [];
      // Prefer technician from a linked job on this week's entries
      for (const en of entries) {
        if (!en || !en.jobId) continue;
        const j = jobs.find(x => x && x.id === en.jobId);
        if (j && j.technician && String(j.technician).trim()) return String(j.technician).trim();
      }
      const fromProfile = profileName();
      if (fromProfile) return fromProfile;
      // Any job with technician
      for (const j of jobs) {
        if (j && j.technician && String(j.technician).trim() && j.id !== (typeof SAMPLE_JOB_ID !== 'undefined' ? SAMPLE_JOB_ID : '')) {
          return String(j.technician).trim();
        }
      }
      // Sample job tech as last auto fallback only if entries are for sample
      const sample = jobs.find(j => j && j.id === (typeof SAMPLE_JOB_ID !== 'undefined' ? SAMPLE_JOB_ID : 'job_sample_demo'));
      if (sample && sample.technician) {
        const usesSample = entries.some(e => e && e.jobId === sample.id);
        if (usesSample) return String(sample.technician).trim();
      }
      try {
        const fromProf = profileName();
        if (fromProf) return fromProf;
        const saved = lsRead('lx8_tc_name', '');
        if (saved && String(saved).trim()) return String(saved).trim();
      } catch (e) {}
      return '';
    }

    function tcEnsureSampleWeek() {
      try {
        if (lsRead('lx8_tc_sample_seeded', false)) return;
      } catch (e) {}
      const jobId = (typeof SAMPLE_JOB_ID !== 'undefined') ? SAMPLE_JOB_ID : 'job_sample_demo';
      let bakeryName = 'BBU Sample Bakery – Orangeburg';
      try {
        const jobs = (typeof loadJobs === 'function') ? loadJobs() : [];
        const j = jobs.find(x => x && x.id === jobId);
        if (j && typeof jobDisplayName === 'function') bakeryName = jobDisplayName(j);
        else if (j) bakeryName = (j.customer || bakeryName) + (j.site ? ' – ' + j.site : '');
      } catch (e) {}
      // Build Mon–Fri of current week + one travel day
      const { start } = tcWeekBounds(0);
      const mk = (dayOffset, type, hours, startHour) => {
        const d = new Date(start);
        d.setDate(d.getDate() + dayOffset);
        d.setHours(startHour, 0, 0, 0);
        const cin = d.getTime();
        const cout = cin + Math.round(hours * 3600000);
        return {
          id: 'tc_sample_' + dayOffset + '_' + type,
          clockIn: cin,
          clockOut: cout,
          type: type,
          jobId: jobId,
          bakeryName: bakeryName,
          date: tcDateKey(cin),
          notes: '',
          manualHours: hours,
          autoCapped: false
        };
      };
      // Only seed if no real entries yet
      if (tcState.entries && tcState.entries.length) {
        try { lsWrite('lx8_tc_sample_seeded', true); } catch (e) {}
        return;
      }
      const sample = [
        mk(0, 'travel', 2.5, 7),   // Mon travel
        mk(0, 'bakery', 6, 10),    // Mon bakery
        mk(1, 'bakery', 8, 8),     // Tue
        mk(2, 'bakery', 8, 8),     // Wed
        mk(3, 'bakery', 7.5, 8),   // Thu
        mk(3, 'shop', 1.5, 16),    // Thu shop
        mk(4, 'bakery', 8, 8)      // Fri
      ];
      tcState.entries = sample;
      try { lsWrite('lx8_tc_sample_seeded', true); } catch (e) {}
      tcSave();
    }

    function tcPad(n) { return n < 10 ? '0' + n : '' + n; }
    function tcDateKey(d) {
      const x = d instanceof Date ? d : new Date(d);
      return x.getFullYear() + '-' + tcPad(x.getMonth() + 1) + '-' + tcPad(x.getDate());
    }

    function tcFormatLongDate(v) {
      let d;
      if (v instanceof Date) d = v;
      else if (typeof v === 'number') d = new Date(v);
      else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
        const p = v.slice(0, 10).split('-').map(Number);
        d = new Date(p[0], p[1] - 1, p[2]);
      } else d = new Date(v);
      if (!d || isNaN(d.getTime())) return '';
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
    }

    function tcFormatTime(ms) {
      const d = new Date(ms);
      let h = d.getHours(), m = d.getMinutes();
      const am = h < 12;
      const h12 = h % 12 || 12;
      return h12 + ':' + tcPad(m) + (am ? ' AM' : ' PM');
    }
    function tcFormatDur(ms) {
      if (ms < 0) ms = 0;
      if (ms > TC_MAX_MS) ms = TC_MAX_MS;
      const totalMin = Math.floor(ms / 60000);
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      return h + 'h ' + tcPad(m) + 'm';
    }
    function tcHoursFromMs(ms) {
      if (ms < 0) ms = 0;
      if (ms > TC_MAX_MS) ms = TC_MAX_MS;
      return Math.round((ms / 3600000) * 100) / 100;
    }
    function tcEffectiveOut(entry) {
      if (entry.clockOut) return entry.clockOut;
      const now = Date.now();
      const cap = entry.clockIn + TC_MAX_MS;
      return Math.min(now, cap);
    }
    function tcEntryHours(entry) {
      if (entry.manualHours != null && entry.manualHours !== '') {
        const n = parseFloat(entry.manualHours);
        if (!isNaN(n)) return Math.max(0, Math.min(24, n));
      }
      if (!entry.clockIn) return 0;
      return tcHoursFromMs(tcEffectiveOut(entry) - entry.clockIn);
    }
    function tcWasAutoCapped(entry) {
      if (entry.clockOut) return entry.clockOut >= entry.clockIn + TC_MAX_MS - 1000;
      if (!entry.clockIn) return false;
      return Date.now() >= entry.clockIn + TC_MAX_MS;
    }
    function tcWeekBounds(offset) {
      const now = new Date();
      const day = now.getDay();
      const mondayOffset = day === 0 ? -6 : 1 - day;
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset + offset * 7);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      return { start, end };
    }
    function tcEntriesForWeek(offset) {
      const { start, end } = tcWeekBounds(offset);
      const s = start.getTime(), e = end.getTime();
      return tcState.entries.filter(en => {
        const t = en.clockIn || (en.date ? new Date(en.date + 'T12:00:00').getTime() : 0);
        return t >= s && t < e;
      }).sort((a, b) => (a.clockIn || 0) - (b.clockIn || 0));
    }
    function tcJobOptionsHtml(selectedId) {
      const jobs = (typeof loadJobs === 'function') ? loadJobs() : [];
      let html = '<option value="">— No job —</option>';
      jobs.forEach(j => {
        if (!j || !j.id) return;
        const label = (typeof jobDisplayName === 'function') ? jobDisplayName(j) : (j.customer || 'Job');
        const sel = selectedId && selectedId === j.id ? ' selected' : '';
        html += '<option value="' + String(j.id).replace(/"/g, '&quot;') + '"' + sel + '>' + String(label).replace(/</g, '&lt;') + '</option>';
      });
      return html;
    }
    function tcFindJobForToday() {
      try {
        const current = (typeof getActiveCurrentJob === 'function') ? getActiveCurrentJob() : null;
        if (current && current.id) return current;
      } catch (e) {}
      const jobs = (typeof loadJobs === 'function') ? loadJobs() : [];
      const today = tcDateKey(new Date());
      const matches = [];
      jobs.forEach(j => {
        if (!j) return;
        let start = j.date || j.startDate || j.dateStart || j.begin || '';
        let end = j.endDate || j.dateEnd || j.end || start;
        if (start) {
          const s = String(start).slice(0, 10);
          const e = String(end || start).slice(0, 10);
          if (s <= today && today <= e) matches.push(j);
        }
      });
      if (matches.length === 1) return matches[0];
      const active = jobs.find(j => j && String(j.status || '').toLowerCase().indexOf('progress') >= 0);
      if (active) return active;
      return matches[0] || null;
    }
    function tcBakeryNameForJob(jobId) {
      if (!jobId) return '';
      const jobs = (typeof loadJobs === 'function') ? loadJobs() : [];
      const j = jobs.find(x => x && x.id === jobId);
      if (!j) return '';
      return (typeof jobDisplayName === 'function') ? jobDisplayName(j) : (j.customer || '');
    }
    function tcPopulateJobSelects() {
      const sel = document.getElementById('tcJobSelect');
      if (sel) {
        let currentId = '';
        try {
          const current = (typeof getActiveCurrentJob === 'function') ? getActiveCurrentJob() : null;
          if (current && current.id) currentId = current.id;
        } catch (e) {}
        const cur = sel.value;
        sel.innerHTML = tcJobOptionsHtml(cur || (tcState.active && tcState.active.jobId) || currentId || '');
      }
    }
    function tcEnsureActiveClosedIfNeeded() {
      if (!tcState.active || !tcState.active.clockIn) return false;
      if (Date.now() - tcState.active.clockIn < TC_MAX_MS) return false;
      const entry = tcState.entries.find(e => e.id === tcState.active.id);
      const out = tcState.active.clockIn + TC_MAX_MS;
      if (entry) {
        entry.clockOut = out;
        entry.autoCapped = true;
      } else {
        tcState.entries.push({
          id: tcState.active.id,
          clockIn: tcState.active.clockIn,
          clockOut: out,
          type: tcState.active.type || 'bakery',
          jobId: tcState.active.jobId || '',
          bakeryName: tcState.active.bakeryName || '',
          date: tcDateKey(tcState.active.clockIn),
          notes: '',
          autoCapped: true
        });
      }
      tcState.active = null;
      tcSave();
      return true;
    }
    function tcRenderStatus() {
      tcEnsureActiveClosedIfNeeded();
      const kicker = document.getElementById('tcStatusKicker');
      const timeEl = document.getElementById('tcStatusTime');
      const meta = document.getElementById('tcStatusMeta');
      const btnIn = document.getElementById('btnTcClockIn');
      const btnOut = document.getElementById('btnTcClockOut');
      const typeRow = document.getElementById('tcTypeRow');
      const jobSel = document.getElementById('tcJobSelect');
      if (tcState.active && tcState.active.clockIn) {
        const elapsed = Math.min(Date.now() - tcState.active.clockIn, TC_MAX_MS);
        if (kicker) {
          kicker.textContent = 'Clocked in · ' + String(tcState.active.type || 'bakery').toUpperCase();
          kicker.classList.add('is-in');
        }
        if (timeEl) {
          timeEl.textContent = tcFormatDur(elapsed);
          timeEl.classList.add('is-in');
        }
        const bn = tcState.active.bakeryName || 'No job';
        if (meta) meta.textContent = 'Since ' + tcFormatTime(tcState.active.clockIn) + ' · ' + bn;
        if (btnIn) btnIn.disabled = true;
        if (btnOut) btnOut.disabled = false;
        if (typeRow) typeRow.querySelectorAll('.tc-type-chip').forEach(b => { b.disabled = true; });
        if (jobSel) jobSel.disabled = true;
      } else {
        if (kicker) {
          kicker.textContent = 'Not clocked in';
          kicker.classList.remove('is-in');
        }
        if (timeEl) {
          timeEl.textContent = '0h 00m';
          timeEl.classList.remove('is-in');
        }
        if (meta) meta.textContent = 'Select type and job, then clock in';
        if (btnIn) btnIn.disabled = false;
        if (btnOut) btnOut.disabled = true;
        if (typeRow) typeRow.querySelectorAll('.tc-type-chip').forEach(b => { b.disabled = false; });
        if (jobSel) jobSel.disabled = false;
      }
      if (typeRow) {
        typeRow.querySelectorAll('.tc-type-chip').forEach(b => {
          b.classList.toggle('on', b.getAttribute('data-type') === tcState.selectedType);
        });
      }
    }
    function tcRenderWeek() {
      tcRenderWeekStrip();
      if (document.getElementById('screenTimeWeek') && document.getElementById('screenTimeWeek').classList.contains('active')) {
        tcRenderWeekDetail();
      }
    }
    function tcWeekLabelText(offset) {
      const { start, end } = tcWeekBounds(offset);
      const opts = { month: 'short', day: 'numeric' };
      return start.toLocaleDateString(undefined, opts) + ' – ' + new Date(end - 1).toLocaleDateString(undefined, opts);
    }
    function tcWeekTotals(offset) {
      const entries = tcEntriesForWeek(offset);
      let bakery = 0, travel = 0, shop = 0;
      entries.forEach(en => {
        const h = tcEntryHours(en);
        if (en.type === 'travel') travel += h;
        else if (en.type === 'shop') shop += h;
        else bakery += h;
      });
      return { bakery, travel, shop, total: bakery + travel + shop, count: entries.length };
    }
    function tcRenderWeekStrip() {
      const strip = document.getElementById('tcWeekStrip');
      if (!strip) return;
      const fmt = n => (Math.round(n * 100) / 100).toFixed(2);
      const off = tcState.weekOffset || 0;
      const t = tcWeekTotals(off);
      const label = tcWeekLabelText(off);
      const kicker = off === 0 ? 'This week' : (off === -1 ? 'Last week' : (off === 1 ? 'Next week' : 'Week'));
      strip.innerHTML =
        '<div class="tc-week-card" id="tcWeekCardMain" data-offset="' + off + '">' +
          '<div class="tc-week-kicker">' + kicker + '</div>' +
          '<div class="tc-week-label">' + label + '</div>' +
          '<div class="tc-week-totals">' +
            '<span>Bakery<strong>' + fmt(t.bakery) + '</strong></span>' +
            '<span>Travel<strong>' + fmt(t.travel) + '</strong></span>' +
            '<span>Shop<strong>' + fmt(t.shop) + '</strong></span>' +
            '<span>Total<strong>' + fmt(t.total) + '</strong></span>' +
          '</div>' +
          '<div class="tc-week-hint">' + (t.count ? (t.count + ' entr' + (t.count === 1 ? 'y' : 'ies')) : 'No entries') + '</div>' +
        '</div>';
      const card = document.getElementById('tcWeekCardMain');
      if (!card) return;
      card.addEventListener('click', () => {
        // Always open the week actually displayed on this card. Do not use the
        // mutable global weekOffset here because it can be changed by the picker
        // without the card having been re-rendered yet.
        const displayedOffset = parseInt(card.getAttribute('data-offset'), 10);
        tcOpenWeek(Number.isFinite(displayedOffset) ? displayedOffset : (tcState.weekOffset || 0));
      });
      let sx = 0, sy = 0, tracking = false;
      const onStart = (x, y) => { sx = x; sy = y; tracking = true; };
      const onEnd = (x, y) => {
        if (!tracking) return;
        tracking = false;
        const dx = x - sx, dy = y - sy;
        if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;
        if (dx < 0) tcState.weekOffset = (tcState.weekOffset || 0) + 1;
        else tcState.weekOffset = (tcState.weekOffset || 0) - 1;
        tcRenderWeekStrip();
      };
      card.addEventListener('touchstart', (e) => {
        if (!e.changedTouches || !e.changedTouches[0]) return;
        onStart(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
      }, { passive: true });
      card.addEventListener('touchend', (e) => {
        if (!e.changedTouches || !e.changedTouches[0]) return;
        onEnd(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
      }, { passive: true });
    }
function tcRenderEntryList(listEl, offset) {
      if (!listEl) return;
      const entries = tcEntriesForWeek(offset);
      if (!entries.length) {
        listEl.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);">No time entries this week</div>';
        return;
      }
      listEl.innerHTML = entries.map(en => {
        const h = tcEntryHours(en);
        const open = tcState.active && tcState.active.id === en.id && !en.clockOut;
        const capped = tcWasAutoCapped(en);
        const typeLabel = (en.type || 'bakery').charAt(0).toUpperCase() + (en.type || 'bakery').slice(1);
        const dateStr = tcFormatLongDate(en.date || en.clockIn);
        return '<div class="tc-entry' + (open ? ' open-shift' : '') + '" data-id="' + en.id + '">' +
          '<div class="tc-entry-main"><div class="tc-entry-title">' + String(dateStr).replace(/</g,'&lt;') + '</div>' +
          '<div class="tc-entry-sub">' + typeLabel + '</div></div>' +
          '<div class="tc-entry-hours">' + h.toFixed(2) + '</div></div>';
      }).join('');
      listEl.querySelectorAll('.tc-entry').forEach(el => {
        el.addEventListener('click', () => tcOpenEdit(el.getAttribute('data-id')));
      });
    }
    function tcRenderWeekDetail() {
      const title = document.getElementById('tcWeekDetailTitle');
      if (title) title.textContent = tcWeekLabelText(tcState.weekOffset);
      const sel = document.getElementById('tcWeekSelect');
      if (sel) {
        const cur = String(tcState.weekOffset || 0);
        let opts = '';
        for (let off = -8; off <= 4; off++) {
          const label = tcWeekLabelText(off);
          const kicker = off === 0 ? 'This week' : (off === -1 ? 'Last week' : (off === 1 ? 'Next week' : 'Week'));
          opts += '<option value="' + off + '"' + (String(off) === cur ? ' selected' : '') + '>' +
            kicker + ' · ' + label + '</option>';
        }
        sel.innerHTML = opts;
        sel.value = cur;
      }
      const t = tcWeekTotals(tcState.weekOffset);
      const fmt = n => (Math.round(n * 100) / 100).toFixed(2);
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = fmt(v); };
      set('tcDetBakery', t.bakery);
      set('tcDetTravel', t.travel);
      set('tcDetShop', t.shop);
      set('tcDetAll', t.total);
      tcRenderEntryList(document.getElementById('tcEntryList'), tcState.weekOffset);
    }

    function tcCloseWeekPick() {
      const sheet = document.getElementById('tcWeekPickSheet');
      const scrim = document.getElementById('tcWeekPickScrim');
      if (sheet) {
        sheet.classList.remove('show');
        sheet.hidden = true;
        sheet.setAttribute('hidden', '');
      }
      if (scrim) {
        scrim.classList.remove('show');
        scrim.hidden = true;
        scrim.setAttribute('hidden', '');
      }
    }
    function tcOpenWeekPick() {
      const sheet = document.getElementById('tcWeekPickSheet');
      const list = document.getElementById('tcWeekPickList');
      const scrim = document.getElementById('tcWeekPickScrim');
      if (!sheet || !list) return;
      let html = '';
      for (let off = -8; off <= 4; off++) {
        const label = tcWeekLabelText(off);
        const kicker = off === 0 ? 'This week' : (off === -1 ? 'Last week' : (off === 1 ? 'Next week' : 'Week'));
        const on = off === (tcState.weekOffset || 0) ? ' on' : '';
        html += '<button type="button" class="tc-week-pick-item' + on + '" data-offset="' + off + '">' +
          kicker + '<span class="sub">' + label + '</span></button>';
      }
      list.innerHTML = html;
      list.querySelectorAll('.tc-week-pick-item').forEach(btn => {
        btn.addEventListener('click', () => {
          tcState.weekOffset = parseInt(btn.getAttribute('data-offset'), 10) || 0;
          tcCloseWeekPick();
          tcRenderWeekDetail();
        });
      });
      if (scrim) {
        scrim.hidden = false;
        scrim.removeAttribute('hidden');
        scrim.classList.add('show');
      }
      sheet.hidden = false;
      sheet.removeAttribute('hidden');
      sheet.classList.add('show');
    }

    function tcOpenWeek(offset) {
      tcState.weekOffset = offset;
      showScreen('screenTimeWeek');
      document.body.classList.add('on-time-week');
      document.body.classList.remove('on-time', 'on-home');
      tcRenderWeekDetail();
    }

    function tcRefresh() {
      tcPopulateJobSelects();
      tcRenderStatus();
      tcRenderWeek();
      tcRenderPeriodSummary();
      if (document.getElementById('screenTimePeriod') && document.getElementById('screenTimePeriod').classList.contains('active')) tcRenderPeriodDetail();
    }
    function tcStartTick() {
      if (tcState.tickTimer) clearInterval(tcState.tickTimer);
      tcState.tickTimer = setInterval(() => {
        const sc = document.getElementById('screenTime');
        if (sc && sc.classList.contains('active')) {
          tcRenderStatus();
          if (tcState.active) tcRenderWeek();
        }
      }, 15000);
    }
    function tcClockIn() {
      tcEnsureActiveClosedIfNeeded();
      if (tcState.active) { toast('Already clocked in'); return; }
      const jobSel = document.getElementById('tcJobSelect');
      let jobId = jobSel ? jobSel.value : '';
      if (!jobId) {
        const auto = tcFindJobForToday();
        if (auto) {
          jobId = auto.id;
          if (jobSel) jobSel.value = jobId;
        }
      }
      const bakeryName = tcBakeryNameForJob(jobId);
      const id = tcUid();
      const clockIn = Date.now();
      const entry = {
        id, clockIn, clockOut: null,
        type: tcState.selectedType || 'bakery',
        jobId: jobId || '',
        bakeryName: bakeryName || '',
        date: tcDateKey(clockIn),
        notes: '',
        manualHours: null,
        autoCapped: false
      };
      tcState.entries.push(entry);
      tcState.active = { id, clockIn, type: entry.type, jobId: entry.jobId, bakeryName: entry.bakeryName };
      tcSave();
      tcRefresh();
      toast('Clocked in');
    }
    function tcClockOut() {
      if (!tcState.active) { toast('Not clocked in'); return; }
      const entry = tcState.entries.find(e => e.id === tcState.active.id);
      const out = Math.min(Date.now(), tcState.active.clockIn + TC_MAX_MS);
      if (entry) {
        entry.clockOut = out;
        if (out >= tcState.active.clockIn + TC_MAX_MS - 1000) entry.autoCapped = true;
      }
      tcState.active = null;
      tcSave();
      tcRefresh();
      toast('Clocked out');
    }

    let tcHoursManualOverride = false;
    function tcRecalcHoursFromTimes() {
      if (tcHoursManualOverride) return;
      const cin = document.getElementById('tcEditClockIn');
      const cout = document.getElementById('tcEditClockOut');
      const hoursEl = document.getElementById('tcEditHours');
      const hint = document.getElementById('tcHoursHint');
      if (!cin || !cout || !hoursEl) return;
      if (!cin.value || !cout.value) {
        if (hint) hint.textContent = 'Enter clock in and out to calculate hours, or type hours directly';
        return;
      }
      const dateEl = document.getElementById('tcEditDate');
      const baseDate = (dateEl && dateEl.value) ? dateEl.value : tcDateKey(Date.now());
      const parseTime = (value) => {
        const m = String(value || '').match(/^(\d{2}):(\d{2})$/);
        if (!m) return NaN;
        return new Date(baseDate + 'T' + m[1] + ':' + m[2] + ':00').getTime();
      };
      const a = parseTime(cin.value);
      let b = parseTime(cout.value);
      if (!isNaN(a) && !isNaN(b) && b < a) b += 24 * 3600000;
      if (isNaN(a) || isNaN(b) || b <= a) {
        if (hint) hint.textContent = 'Clock out must be after clock in';
        return;
      }
      let ms = b - a;
      if (ms > TC_MAX_MS) ms = TC_MAX_MS;
      const h = Math.round((ms / 3600000) * 100) / 100;
      hoursEl.value = h;
      if (hint) {
        hint.textContent = ms >= TC_MAX_MS
          ? 'Capped at 24 hours — you can still override'
          : 'Calculated from clock in / out — you can override';
      }
    }

    function tcOpenEdit(id) {
      const entry = tcState.entries.find(e => e.id === id);
      if (!entry) return;
      tcState.editId = id;
      tcHoursManualOverride = false;
      try {
        const del = document.getElementById('btnTcEditDelete');
        if (del && del.dataset.delBound !== '1') {
          del.dataset.delBound = '1';
          del.addEventListener('click', (e) => { e.preventDefault(); tcDeleteEdit(e); });
        }
      } catch (e) {}
      document.getElementById('tcEditTitle').textContent = 'Edit hours';
      const editScreen = document.getElementById('screenTimeEdit');
      if (editScreen) editScreen.classList.remove('add-mode');
      document.getElementById('tcEditDate').value = entry.date || tcDateKey(entry.clockIn || Date.now());
      document.getElementById('tcEditType').value = entry.type || 'bakery';
      document.getElementById('tcEditJob').innerHTML = tcJobOptionsHtml(entry.jobId || '');
      document.getElementById('tcEditHours').value = tcEntryHours(entry);
      const toTime = (ms) => {
        if (!ms) return '';
        const d = new Date(ms);
        return tcPad(d.getHours()) + ':' + tcPad(d.getMinutes());
      };
      document.getElementById('tcEditClockIn').value = toTime(entry.clockIn);
      document.getElementById('tcEditClockOut').value = toTime(entry.clockOut);
      document.getElementById('tcEditNotes').value = entry.notes || '';
      showScreen('screenTimeEdit');
      document.body.classList.add('on-time-edit');
      document.body.classList.remove('on-time', 'on-time-week');
    }
    function tcOpenManual() {
      tcState.editId = null;
      tcHoursManualOverride = false;
      document.getElementById('tcEditTitle').textContent = 'Add hours';
      const editScreen = document.getElementById('screenTimeEdit');
      if (editScreen) editScreen.classList.add('add-mode');
      document.getElementById('tcEditDate').value = tcDateKey(new Date());
      document.getElementById('tcEditType').value = tcState.selectedType || 'bakery';
      const auto = tcFindJobForToday();
      document.getElementById('tcEditJob').innerHTML = tcJobOptionsHtml(auto ? auto.id : '');
      document.getElementById('tcEditHours').value = '8';
      // Default workday times for new entries. These are time-only controls;
      // the Date field remains the single calendar-date source of truth.
      document.getElementById('tcEditClockIn').value = '08:00';
      document.getElementById('tcEditClockOut').value = '18:00';
      document.getElementById('tcEditHours').value = '10';
      document.getElementById('tcEditNotes').value = '';
      showScreen('screenTimeEdit');
      document.body.classList.add('on-time-edit');
      document.body.classList.remove('on-time', 'on-time-week');
    }
    function tcSaveEdit() {
      const date = document.getElementById('tcEditDate').value;
      const type = document.getElementById('tcEditType').value || 'bakery';
      const jobId = document.getElementById('tcEditJob').value || '';
      const bakeryName = jobId ? tcBakeryNameForJob(jobId) : '';
      const hoursVal = parseFloat(document.getElementById('tcEditHours').value);
      const notes = document.getElementById('tcEditNotes').value || '';
      const cinStr = document.getElementById('tcEditClockIn').value;
      const coutStr = document.getElementById('tcEditClockOut').value;
      const manualHours = (!isNaN(hoursVal)) ? Math.max(0, Math.min(24, hoursVal)) : null;
      let clockIn = null;
      let clockOut = null;
      // The entry Date is the single source of truth for the calendar date.
      // Clock in/out fields contain time only, so changing a time can never
      // silently change the entry's date.
      const baseDate = date || tcDateKey(Date.now());
      const timeOnDate = (timeStr, fallbackHour) => {
        if (!timeStr) return null;
        const m = String(timeStr).match(/^(\d{2}):(\d{2})$/);
        if (!m) return null;
        const d = new Date(baseDate + 'T' + m[1] + ':' + m[2] + ':00');
        return isNaN(d.getTime()) ? null : d.getTime();
      };
      if (cinStr) clockIn = timeOnDate(cinStr, 8);
      if (coutStr) clockOut = timeOnDate(coutStr, 0);
      // If clock-out is earlier than clock-in, treat it as the following day.
      // This keeps overnight entries possible while still having one displayed Date.
      if (clockIn && clockOut && clockOut < clockIn) clockOut += 24 * 3600000;
      // Manual hours only (no clock times): store hours without fabricating clock range
      if (manualHours != null && tcHoursManualOverride && !cinStr && !coutStr) {
        clockIn = date ? new Date(date + 'T12:00:00').getTime() : Date.now();
        clockOut = null;
      } else {
        if (!clockIn) clockIn = date ? new Date(date + 'T08:00:00').getTime() : Date.now();
        if (clockOut && clockOut - clockIn > TC_MAX_MS) clockOut = clockIn + TC_MAX_MS;
        if (manualHours != null && !coutStr && !tcHoursManualOverride) {
          clockOut = clockIn + Math.round(manualHours * 3600000);
          if (clockOut - clockIn > TC_MAX_MS) clockOut = clockIn + TC_MAX_MS;
        }
      }
      if (tcState.editId) {
        const entry = tcState.entries.find(e => e.id === tcState.editId);
        if (entry) {
          entry.date = date || tcDateKey(clockIn);
          entry.type = type;
          entry.jobId = jobId;
          entry.bakeryName = bakeryName;
          entry.notes = notes;
          entry.clockIn = clockIn;
          entry.clockOut = clockOut;
          entry.manualHours = manualHours;
          if (tcState.active && tcState.active.id === entry.id) {
            if (clockOut) tcState.active = null;
            else tcState.active = { id: entry.id, clockIn: entry.clockIn, type: entry.type, jobId: entry.jobId, bakeryName: entry.bakeryName };
          }
        }
      } else {
        const id = tcUid();
        tcState.entries.push({
          id, date: date || tcDateKey(clockIn), type, jobId, bakeryName, notes,
          clockIn, clockOut: clockOut || (clockIn + (manualHours != null ? Math.round(manualHours * 3600000) : 0)),
          manualHours, autoCapped: false
        });
      }
      tcSave();
      showScreen('screenTimeWeek');
      document.body.classList.add('on-time-week');
      document.body.classList.remove('on-time-edit');
      tcRenderWeekDetail();
      toast('Saved');
      try { if (typeof refreshJobDetail === 'function' && detailJobId) refreshJobDetail(); } catch (e) {}
    }
    function tcDeleteEdit(ev) {
      if (ev) { ev.preventDefault(); ev.stopPropagation(); }
      const id = tcState.editId || (tcState.active && tcState.active.id) || '';
      if (!id) {
        toast('No time entry to delete');
        return;
      }
      if (typeof showDeleteConfirm === 'function') {
        showDeleteConfirm(id, 'timecard', 'Delete time entry?', 'This time entry will be permanently deleted.');
      } else {
        pendingDeleteId = id;
        pendingDeleteKind = 'timecard';
        const modal = document.getElementById('deleteModal');
        if (modal) {
          document.getElementById('deleteModalTitle').textContent = 'Delete time entry?';
          document.getElementById('deleteModalLabel').textContent = 'This time entry will be permanently deleted.';
          modal.classList.remove('hidden');
          modal.classList.add('show');
          modal.style.display = 'flex';
          modal.style.zIndex = '30000';
        }
      }
    }
    function performDeleteTimecard(id) {
      if (!id) { closeDeleteModal(); return; }
      const sid = String(id);
      tcState.entries = (tcState.entries || []).filter(e => String(e.id) !== sid);
      if (tcState.active && tcState.active.id === id) tcState.active = null;
      if (tcState.editId === id) tcState.editId = null;
      tcSave();
      closeDeleteModal();
      showScreen('screenTimeWeek');
      document.body.classList.add('on-time-week');
      document.body.classList.remove('on-time-edit');
      tcRenderWeekDetail();
      toast('Deleted');
    }
    window.performDeleteTimecard = performDeleteTimecard;
    window.tcDeleteEdit = tcDeleteEdit;

    function tcCloseNameSheet() {
      const sheet = document.getElementById('tcNameSheet');
      if (!sheet) return;
      sheet.classList.remove('show');
      sheet.hidden = true;
      sheet.setAttribute('hidden', '');
    }
    function tcOpenNameSheet(defaultName) {
      return new Promise((resolve) => {
        const sheet = document.getElementById('tcNameSheet');
        const input = document.getElementById('tcExportNameInput');
        const ok = document.getElementById('tcNameSheetOk');
        const cancel = document.getElementById('tcNameSheetCancel');
        if (!sheet || !input || !ok) { resolve(defaultName || ''); return; }
        input.value = defaultName || '';
        sheet.hidden = false;
        sheet.removeAttribute('hidden');
        sheet.classList.add('show');
        setTimeout(() => { try { input.focus(); input.select(); } catch (e) {} }, 80);
        const cleanup = () => {
          ok.removeEventListener('click', onOk);
          cancel && cancel.removeEventListener('click', onCancel);
          tcCloseNameSheet();
        };
        const onOk = () => {
          const v = (input.value || '').trim();
          cleanup();
          if (v) { try { lsWrite('lx8_tc_name', v); } catch (e) {} }
          resolve(v);
        };
        const onCancel = () => { cleanup(); resolve(null); };
        ok.addEventListener('click', onOk);
        if (cancel) cancel.addEventListener('click', onCancel);
      });
    }

    let tcExportSelection = { mode: 'weeks', weeks: new Set(), days: new Set() };

    function tcExportDateLabel(dateKey) {
      if (!dateKey) return '';
      const parts = String(dateKey).split('-').map(Number);
      if (parts.length !== 3 || parts.some(isNaN)) return String(dateKey);
      const d = new Date(parts[0], parts[1] - 1, parts[2]);
      return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    }

    function tcExportWeekDateKey(offset) {
      const b = tcWeekBounds(offset).start;
      return tcDateKey(b);
    }

    function tcExportAvailableWeekOffsets() {
      const offsets = new Set();
      // Keep the picker useful even when a technician has not entered hours yet.
      for (let i = -12; i <= 4; i++) offsets.add(i);
      (tcState.entries || []).forEach(en => {
        const key = en.date || tcDateKey(en.clockIn);
        if (!key) return;
        const d = new Date(key + 'T12:00:00');
        if (isNaN(d.getTime())) return;
        const nowStart = tcWeekBounds(0).start.getTime();
        const weekStart = (() => {
          const day = d.getDay();
          const mo = day === 0 ? -6 : 1 - day;
          const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + mo);
          x.setHours(0,0,0,0); return x;
        })().getTime();
        offsets.add(Math.round((weekStart - nowStart) / (7 * 86400000)));
      });
      return Array.from(offsets).filter(n => n >= -104 && n <= 104).sort((a,b) => b-a);
    }

    function tcExportEntriesForSelectedDays(days) {
      const set = days instanceof Set ? days : new Set(days || []);
      return (tcState.entries || []).filter(en => {
        const d = en.date || tcDateKey(en.clockIn);
        return d && set.has(d);
      }).sort((a,b) => (a.clockIn || 0) - (b.clockIn || 0));
    }

    function tcExportEntriesForSelectedWeeks(weeks) {
      const set = weeks instanceof Set ? weeks : new Set(weeks || []);
      const all = [];
      set.forEach(off => all.push(...tcEntriesForWeek(Number(off))));
      return all.sort((a,b) => (a.clockIn || 0) - (b.clockIn || 0));
    }

    function tcExportGroupByWeek(entries) {
      const groups = new Map();
      entries.forEach(en => {
        const dkey = en.date || tcDateKey(en.clockIn);
        if (!dkey) return;
        const d = new Date(dkey + 'T12:00:00');
        if (isNaN(d.getTime())) return;
        const day = d.getDay();
        const mo = day === 0 ? -6 : 1 - day;
        const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() + mo);
        start.setHours(0,0,0,0);
        const wk = tcDateKey(start);
        if (!groups.has(wk)) groups.set(wk, []);
        groups.get(wk).push(en);
      });
      return groups;
    }

    function tcExportRowChunks(entries, size) {
      const rows = tcExportGroupRows(entries || []);
      const n = Math.max(1, size || 14);
      const chunks = [];
      for (let i = 0; i < rows.length; i += n) chunks.push(rows.slice(i, i + n));
      return chunks.length ? chunks : [[]];
    }
    function tcExportEntriesFromRows(rows) {
      return (rows || []).map(r => ({
        date: r.date,
        bakeryName: r.bakeryName,
        type: 'bakery',
        hours: r.bakery,
        bakery: r.bakery,
        travel: r.travel,
        shop: r.shop
      }));
    }
    function tcExportGroupRows(entries) {
      const byKey = {};
      entries.forEach(en => {
        const d = en.date || tcDateKey(en.clockIn);
        const bn = en.bakeryName || '';
        const key = d + '||' + bn;
        if (!byKey[key]) byKey[key] = { date: d, bakeryName: bn, bakery: 0, travel: 0, shop: 0 };
        const h = tcEntryHours(en);
        if (en.type === 'travel') byKey[key].travel += h;
        else if (en.type === 'shop') byKey[key].shop += h;
        else byKey[key].bakery += h;
      });
      return Object.keys(byKey).sort().map(k => byKey[k]);
    }

    function tcExportFormatWeekBegin(dateKey) {
      const parts = String(dateKey || '').split('-');
      if (parts.length !== 3) return dateKey || '';
      return Number(parts[1]) + '/' + Number(parts[2]) + '/' + parts[0].slice(-2);
    }

    function tcExportSheetName(dateKey, index) {
      const parts = String(dateKey || '').split('-');
      const base = parts.length === 3 ? ('Week ' + parts[1] + '-' + parts[2] + '-' + parts[0].slice(-2)) : ('Week ' + (index + 1));
      return base.slice(0,31);
    }

    function tcCloneWorksheetFromTemplate(wb, sourceWs, name, idHint) {
      const model = JSON.parse(JSON.stringify(sourceWs.model));
      model.name = name;
      model.id = idHint || (wb.worksheets.length + 1);
      const ws = wb.addWorksheet('TEMP_' + Math.random().toString(36).slice(2,7));
      ws.model = model;
      return ws;
    }

    function tcPopulateExportSheet(ws, techName, weekKey, entries, preRows) {
      try {
        ws.mergeCells('B9:F9');
        const banner = ws.getCell('B9');
        banner.value = 'Service Hours Weekly Report';
        banner.font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
        banner.alignment = { horizontal: 'center', vertical: 'middle' };
        banner.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2A3132' } };
        for (const col of ['B','C','D','E','F']) {
          const c = ws.getCell(col + '9');
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2A3132' } };
          c.font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
          c.alignment = { horizontal: 'center', vertical: 'middle' };
        }
        ws.getCell('A9').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD4223B' } };
        ws.getRow(9).height = 22;
        if (!ws.getRow(8).height) ws.getRow(8).height = 10;
      } catch (e) { console.warn('banner', e); }

      ws.getCell('B12').value = 'Name: ' + techName;
      ws.getCell('C12').value = 'Week Beginning:';
      ws.getCell('D12').value = tcExportFormatWeekBegin(weekKey);
      const rows = Array.isArray(preRows) ? preRows : tcExportGroupRows(entries);
      const first = 17, maxRows = 14;
      const thin = { style: 'thin', color: { argb: 'FF000000' } };
      const box = { top: thin, left: thin, bottom: thin, right: thin };
      for (let i = 0; i < maxRows; i++) {
        const row = ws.getRow(first + i), data = rows[i];
        row.getCell(2).value = data ? tcExportFormatWeekBegin(data.date) : null;
        row.getCell(3).value = data ? (data.bakeryName || '') : null;
        row.getCell(4).value = data && data.bakery ? Math.round(data.bakery * 100) / 100 : null;
        row.getCell(5).value = data && data.travel ? Math.round(data.travel * 100) / 100 : null;
        row.getCell(6).value = data && data.shop ? Math.round(data.shop * 100) / 100 : null;
        for (let c = 2; c <= 6; c++) row.getCell(c).border = box;
      }
      try { for (const ref of ['E32','F32','E33','F33','E34','F34','E35','F35']) ws.getCell(ref).border = box; } catch (e) {}
    }

    function tcPeriodOffsets() {
      const po = Number(tcState.periodOffset || 0);
      return [po * 2 - 1, po * 2];
    }
    function tcPeriodLabel() {
      const offs = tcPeriodOffsets();
      const a = tcWeekBounds(offs[0]).start;
      const b = tcWeekBounds(offs[1]).end;
      const end = new Date(b.getTime() - 1);
      const sameYear = a.getFullYear() === end.getFullYear();
      const optsA = { month:'short', day:'numeric' };
      const optsB = { month:'short', day:'numeric', year:'numeric' };
      return a.toLocaleDateString(undefined, optsA) + ' – ' + end.toLocaleDateString(undefined, optsB);
    }
    function tcPeriodEntries() {
      const offs = tcPeriodOffsets();
      return tcExportEntriesForSelectedWeeks(new Set(offs));
    }
    function tcPeriodTotals() {
      const entries = tcPeriodEntries();
      let bakery=0, travel=0, shop=0;
      entries.forEach(en => {
        const h = tcEntryHours(en);
        if (en.type === 'travel') travel += h;
        else if (en.type === 'shop') shop += h;
        else bakery += h;
      });
      return { bakery, travel, shop, total: bakery+travel+shop, entries };
    }
    function tcPeriodJobGroups(entries) {
      const groups = new Map();
      (entries || []).forEach(en => {
        const key = en.jobId || ('name:' + (en.bakeryName || 'No job'));
        const name = en.bakeryName || 'No job';
        if (!groups.has(key)) groups.set(key, { name, hours:0, count:0 });
        const g = groups.get(key); g.hours += tcEntryHours(en); g.count++;
      });
      return Array.from(groups.values()).sort((a,b)=>b.hours-a.hours);
    }
    function tcRenderPeriodSummary() {
      const title=document.getElementById('tcPeriodTitle'), total=document.getElementById('tcPeriodTotal'), meta=document.getElementById('tcPeriodMeta'), jobsEl=document.getElementById('tcPeriodJobs');
      const entries=tcPeriodEntries(), t=tcPeriodTotals(), jobs=tcPeriodJobGroups(entries);
      if (title) title.textContent=tcPeriodLabel();
      if (total) total.textContent=t.total.toFixed(2)+' h';
      if (meta) meta.textContent=entries.length ? (entries.length+' time entr'+(entries.length===1?'y':'ies')+' · '+jobs.length+' '+(jobs.length===1?'job':'jobs')) : 'No time entered for this 2-week period';
      if (jobsEl) jobsEl.innerHTML=jobs.length ? jobs.slice(0,4).map(g=>'<div class="tc-period-job"><span class="tc-period-job-name">'+jobEsc(g.name)+'</span><span class="tc-period-job-hours">'+g.hours.toFixed(2)+' h</span></div>').join('') : '';
    }
    function tcRenderPeriodDetail() {
      const title=document.getElementById('tcPeriodDetailTitle'), nav=document.getElementById('tcPeriodNavLabel');
      const t=tcPeriodTotals(), entries=t.entries;
      if (title) title.textContent=tcPeriodLabel();
      if (nav) nav.textContent=(Number(tcState.periodOffset||0)===0?'Current period':(Number(tcState.periodOffset||0)<0?'Previous period':'Next period'));
      const set=(id,v)=>{const el=document.getElementById(id); if(el) el.textContent=v.toFixed(2);};
      set('tcPeriodBakery',t.bakery); set('tcPeriodTravel',t.travel); set('tcPeriodShop',t.shop); set('tcPeriodAll',t.total);
      const check=document.getElementById('tcPeriodCheck');
      const active=!!tcState.active;
      const noJob=entries.filter(e=>!e.jobId && (e.bakeryName||'')==='').length;
      if(check){
        const issues=[];
        if(active) issues.push('A clock is currently running.');
        if(!entries.length) issues.push('No time entries have been recorded.');
        if(noJob) issues.push(noJob+' entr'+(noJob===1?'y has':'ies have')+' no job assigned.');
        check.innerHTML=issues.length
          ? '<div class="tc-period-check-card warn"><strong>Review needed</strong><div style="margin-top:4px;">'+issues.map(jobEsc).join('<br>')+'</div></div>'
          : '<div class="tc-period-check-card good"><strong>Ready to review</strong><div style="margin-top:4px;">All '+entries.length+' entries are included in this period.</div></div>';
      }
      const list=document.getElementById('tcPeriodEntryList');
      if(!list) return;
      if(!entries.length){ list.innerHTML='<div style="padding:24px;text-align:center;color:var(--muted);">No time entries in this pay period</div>'; return; }
      const byDay=new Map();
      entries.forEach(en=>{ const d=en.date||tcDateKey(en.clockIn); if(!byDay.has(d)) byDay.set(d,[]); byDay.get(d).push(en); });
      const days=Array.from(byDay.keys()).sort();
      list.innerHTML=days.map(d=>{
        const es=byDay.get(d); const hrs=es.reduce((a,e)=>a+tcEntryHours(e),0); const jobs=[...new Set(es.map(e=>e.bakeryName||'No job'))];
        return '<div class="tc-period-day" data-period-date="'+d+'"><div class="tc-period-day-main"><div class="tc-period-day-title">'+jobEsc(tcFormatLongDate(d))+'</div><div class="tc-period-day-sub">'+jobEsc(jobs.join(' · '))+' · '+es.length+' entr'+(es.length===1?'y':'ies')+'</div></div><div class="tc-period-day-hours">'+hrs.toFixed(2)+' h</div></div>';
      }).join('');
      list.querySelectorAll('.tc-period-day').forEach(el=>el.addEventListener('click',()=>{
        const d=el.getAttribute('data-period-date'); const en=entries.find(e=>(e.date||tcDateKey(e.clockIn))===d); if(en) tcOpenEdit(en.id);
      }));
    }
    function tcOpenPeriod() {
      tcLoad();
      showScreen('screenTimePeriod');
      document.body.classList.add('on-time-period');
      document.body.classList.remove('on-time-week','on-time-edit');
      tcRenderPeriodDetail();
    }
    function tcOpenPeriodExport() {
      const offs=tcPeriodOffsets();
      tcOpenExportSheet(offs);
    }

    function tcCloseExportSheet() {
      const sheet = document.getElementById('tcExportSheet'), scrim = document.getElementById('tcExportScrim');
      if (sheet) { sheet.classList.remove('show'); sheet.hidden = true; sheet.setAttribute('hidden',''); }
      if (scrim) { scrim.classList.remove('show'); scrim.hidden = true; scrim.setAttribute('hidden',''); }
    }

    function tcExportSummary() {
      const list = document.getElementById('tcExportSummary');
      if (!list) return;
      let entries = tcExportSelection.mode === 'days'
        ? tcExportEntriesForSelectedDays(tcExportSelection.days)
        : tcExportEntriesForSelectedWeeks(tcExportSelection.weeks);
      const total = entries.reduce((sum,e) => sum + tcEntryHours(e), 0);
      const jobs = new Set(entries.map(e => e.bakeryName || 'No job').filter(Boolean));
      const count = tcExportSelection.mode === 'days' ? tcExportSelection.days.size : tcExportSelection.weeks.size;
      const label = tcExportSelection.mode === 'days' ? (count === 1 ? 'day' : 'days') : (count === 1 ? 'week' : 'weeks');
      const sheets = tcExportRowChunks(entries, 14).length;
      list.innerHTML = '<strong>' + count + ' ' + label + ' selected</strong><span>' + sheets + ' Excel ' + (sheets === 1 ? 'sheet' : 'sheets') + ' · ' + total.toFixed(2) + ' hours · ' + jobs.size + ' ' + (jobs.size === 1 ? 'job' : 'jobs') + '</span>';
    }

    function tcRenderExportList() {
      const list = document.getElementById('tcExportList');
      if (!list) return;
      if (tcExportSelection.mode === 'weeks') {
        const offsets = tcExportAvailableWeekOffsets();
        list.innerHTML = offsets.map(off => {
          const t = tcWeekTotals(off);
          const checked = tcExportSelection.weeks.has(off) ? ' checked' : '';
          const kicker = off === 0 ? 'This week' : (off === -1 ? 'Last week' : (off === 1 ? 'Next week' : 'Week'));
          const jobs = new Set(tcEntriesForWeek(off).map(e => e.bakeryName || '').filter(Boolean)).size;
          return '<label class="tc-export-row"><input type="checkbox" class="tc-export-check" data-offset="' + off + '"' + checked + '><span class="tc-export-checkmark" aria-hidden="true"></span><span class="tc-export-row-main"><span class="tc-export-row-title">' + kicker + ' · ' + tcWeekLabelText(off) + '</span><span class="tc-export-row-sub">' + t.total.toFixed(2) + ' hours · ' + t.count + ' entries · ' + jobs + ' ' + (jobs === 1 ? 'job' : 'jobs') + '</span></span></label>';
        }).join('');
        list.querySelectorAll('.tc-export-check').forEach(cb => cb.addEventListener('change', () => {
          const off = Number(cb.dataset.offset);
          if (cb.checked) tcExportSelection.weeks.add(off); else tcExportSelection.weeks.delete(off);
          tcExportSummary();
        }));
      } else {
        const dates = Array.from(new Set((tcState.entries || []).map(e => e.date || tcDateKey(e.clockIn)).filter(Boolean))).sort().reverse();
        if (!dates.length) {
          list.innerHTML = '<div class="tc-export-empty">No time-entry days are available yet.</div>';
        } else {
          list.innerHTML = dates.map(d => {
            const entries = (tcState.entries || []).filter(e => (e.date || tcDateKey(e.clockIn)) === d);
            const total = entries.reduce((sum,e) => sum + tcEntryHours(e), 0);
            const jobs = new Set(entries.map(e => e.bakeryName || '').filter(Boolean)).size;
            const checked = tcExportSelection.days.has(d) ? ' checked' : '';
            return '<label class="tc-export-row"><input type="checkbox" class="tc-export-check" data-date="' + d + '"' + checked + '><span class="tc-export-checkmark" aria-hidden="true"></span><span class="tc-export-row-main"><span class="tc-export-row-title">' + tcExportDateLabel(d) + '</span><span class="tc-export-row-sub">' + total.toFixed(2) + ' hours · ' + entries.length + ' entries · ' + jobs + ' ' + (jobs === 1 ? 'job' : 'jobs') + '</span></span></label>';
          }).join('');
          list.querySelectorAll('.tc-export-check').forEach(cb => cb.addEventListener('change', () => {
            const d = cb.dataset.date;
            if (cb.checked) tcExportSelection.days.add(d); else tcExportSelection.days.delete(d);
            tcExportSummary();
          }));
        }
      }
      tcExportSummary();
    }

    function tcOpenExportSheet(initialWeeks) {
      tcLoad();
      const current = tcState.weekOffset || 0;
      const seed = Array.isArray(initialWeeks) && initialWeeks.length ? initialWeeks.map(Number) : [current];
      tcExportSelection = { mode: 'weeks', weeks: new Set(seed), days: new Set() };
      const sheet = document.getElementById('tcExportSheet'), scrim = document.getElementById('tcExportScrim');
      if (!sheet || !scrim) return;
      sheet.hidden = false; sheet.removeAttribute('hidden');
      scrim.hidden = false; scrim.removeAttribute('hidden');
      const seg = document.getElementById('tcExportSeg');
      if (seg) seg.setAttribute('data-mode', tcExportSelection.mode || 'weeks');
      requestAnimationFrame(() => { sheet.classList.add('show'); scrim.classList.add('show'); });
      tcRenderExportList();
      setExportButtonsReady(excelLibsReady());
      warmExcelLibs();
    }

    async function tcContinueExport() {
      let entries = tcExportSelection.mode === 'days'
        ? tcExportEntriesForSelectedDays(tcExportSelection.days)
        : tcExportEntriesForSelectedWeeks(tcExportSelection.weeks);
      if (!entries.length) { toast('Select at least one day or week with time'); return; }
      tcCloseExportSheet();
      let techName = tcResolveExportName(entries);
      if (!techName) {
        const entered = await tcOpenNameSheet('');
        if (entered === null) return;
        if (!entered) { toast('Name required for export'); return; }
        techName = entered;
      }
      setExportButtonsReady(false);
      const ok = await warmExcelLibs();
      if (!ok || typeof ExcelJS === 'undefined') { toast('Excel is still loading. Try again in a moment'); setExportButtonsReady(excelLibsReady()); return; }

      const chunks = tcExportRowChunks(entries, 14);
      let buf;
      try {
        buf = await getTimecardTemplateBuffer();
      } catch (e) {
        console.warn(e);
        toast('Time card template missing. Re-upload timecard-template.xlsx');
        return;
      }
      const wb = new ExcelJS.Workbook();
      try {
        await wb.xlsx.load(buf);
      } catch (e) {
        console.warn(e);
        toast('Time card template could not be read');
        return;
      }
      if (!wb.worksheets || !wb.worksheets[0]) {
        toast('Time card template has no sheet');
        return;
      }
      const templateWs = wb.worksheets[0];
      function chunkWeekKey(rows) {
        const firstDate = (rows && rows[0] && rows[0].date) || '';
        if (!firstDate) return tcDateKey(Date.now());
        const d = new Date(firstDate + 'T12:00:00');
        const day = d.getDay();
        const mo = day === 0 ? -6 : 1 - day;
        const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() + mo);
        return tcDateKey(start);
      }
      const firstKey = chunkWeekKey(chunks[0]);
      templateWs.name = tcExportSheetName(firstKey, 0);
      tcPopulateExportSheet(templateWs, techName, firstKey, entries, chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        const key = chunkWeekKey(chunks[i]);
        const ws = tcCloneWorksheetFromTemplate(wb, templateWs, tcExportSheetName(key, i), i + 1);
        tcPopulateExportSheet(ws, techName, key, entries, chunks[i]);
      }
      const weekKeys = [firstKey];
      const out = await wb.xlsx.writeBuffer();
      const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const safe = String(techName).replace(/[\\/:*?"<>|]/g, '-').trim() || 'TimeCard';
      const firstBegin = tcExportFormatWeekBegin(firstKey).replace(/\//g, '-');
      const suffix = chunks.length === 1 ? firstBegin : (chunks.length + '-Sheets');
      const fname = safe + ' Time Card ' + suffix + '.xlsx';
      try {
        toast('Saving time card…');
        if (typeof downloadBlob === 'function') await downloadBlob(blob, fname);
        else {
          const url = URL.createObjectURL(blob), a = document.createElement('a');
          a.href = url; a.download = fname; document.body.appendChild(a); a.click();
          setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
        }
      } catch (e) {
        const url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = fname; document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
      }
      toast(weekKeys.length === 1 ? 'Time card Excel ready' : ('Time card Excel ready · ' + weekKeys.length + ' weeks'));
    }

    function bindTcExportPicker() {
      const on = (id, fn) => { const el = document.getElementById(id); if (el && el.dataset.tcExportBound !== '1') { el.dataset.tcExportBound = '1'; el.addEventListener('click', fn); } };
      on('tcExportClose', tcCloseExportSheet);
      on('tcExportCancel', tcCloseExportSheet);
      on('tcExportScrim', tcCloseExportSheet);
      on('tcExportTabWeeks', () => { tcExportSelection.mode = 'weeks'; document.getElementById('tcExportTabWeeks').classList.add('on'); document.getElementById('tcExportTabDays').classList.remove('on'); document.getElementById('tcExportTabWeeks').setAttribute('aria-selected','true'); document.getElementById('tcExportTabDays').setAttribute('aria-selected','false'); const seg = document.getElementById('tcExportSeg'); if (seg) seg.setAttribute('data-mode','weeks'); tcRenderExportList(); });
      on('tcExportTabDays', () => { tcExportSelection.mode = 'days'; document.getElementById('tcExportTabDays').classList.add('on'); document.getElementById('tcExportTabWeeks').classList.remove('on'); document.getElementById('tcExportTabDays').setAttribute('aria-selected','true'); document.getElementById('tcExportTabWeeks').setAttribute('aria-selected','false'); const seg = document.getElementById('tcExportSeg'); if (seg) seg.setAttribute('data-mode','days'); tcRenderExportList(); });
      on('tcExportSelectAll', () => {
        if (tcExportSelection.mode === 'weeks') tcExportAvailableWeekOffsets().forEach(o => tcExportSelection.weeks.add(o));
        else Array.from(new Set((tcState.entries || []).map(e => e.date || tcDateKey(e.clockIn)).filter(Boolean))).forEach(d => tcExportSelection.days.add(d));
        tcRenderExportList();
      });
      on('tcExportClearAll', () => { tcExportSelection.weeks.clear(); tcExportSelection.days.clear(); tcRenderExportList(); });
      on('tcExportContinue', () => { tcContinueExport().catch(err => { console.warn(err); toast((err && err.message) ? ('Export failed: ' + err.message) : 'Could not export time card'); }); });
    }

    function openTimeCards() {
      try { if (typeof closeSearch === 'function') closeSearch(); } catch (e) {}
      tcLoad();
      tcEnsureActiveClosedIfNeeded();
      tcPopulateJobSelects();
      if (!tcState.active) {
        const auto = tcFindJobForToday();
        const sel = document.getElementById('tcJobSelect');
        if (auto && sel && !sel.value) sel.value = auto.id;
      }
      showScreen('screenTime');
      document.body.classList.add('on-time');
      document.body.classList.remove('on-home', 'on-time-week', 'on-time-edit');
      tcRefresh();
      tcStartTick();
    }

    function bindTimeCards() {
      const tile = document.getElementById('homeTileTime');
      if (tile && tile.dataset.tcBound !== '1') {
        tile.dataset.tcBound = '1';
        tile.addEventListener('click', openTimeCards);
      }
      const once = (id, fn) => {
        const el = document.getElementById(id);
        if (el && el.dataset.tcBound !== '1') {
          el.dataset.tcBound = '1';
          el.addEventListener('click', fn);
        }
      };
      once('btnTcClockIn', tcClockIn);
      once('btnTcClockOut', tcClockOut);
      
      once('btnTcExport', tcOpenExportSheet);
      once('btnTcAddManual', tcOpenManual);
      once('btnTcAddManualWeek', tcOpenManual);
      once('btnTcWeekExport', tcOpenExportSheet);
      once('btnTcReviewPeriod', tcOpenPeriod);
      once('btnTcPeriodExport', tcOpenPeriodExport);
      once('btnTcPeriodAdd', tcOpenManual);
      once('btnTcPeriodPrev', () => { tcState.periodOffset = (tcState.periodOffset || 0) - 1; tcRenderPeriodDetail(); });
      once('btnTcPeriodNext', () => { tcState.periodOffset = (tcState.periodOffset || 0) + 1; tcRenderPeriodDetail(); });
      bindTcExportPicker();
      const weekHead = document.getElementById('tcWeekDetailHead');
      if (weekHead && weekHead.dataset.tcBound !== '1') {
        weekHead.dataset.tcBound = '1';
        weekHead.addEventListener('click', tcOpenWeekPick);
      }
      const weekPickCancel = document.getElementById('tcWeekPickCancel');
      if (weekPickCancel && weekPickCancel.dataset.tcBound !== '1') {
        weekPickCancel.dataset.tcBound = '1';
        weekPickCancel.addEventListener('click', tcCloseWeekPick);
      }
      const weekScrim = document.getElementById('tcWeekPickScrim');
      if (weekScrim && weekScrim.dataset.tcBound !== '1') {
        weekScrim.dataset.tcBound = '1';
        weekScrim.addEventListener('click', tcCloseWeekPick);
      }
      const hoursTile = document.getElementById('jdHoursTile');
      if (hoursTile && hoursTile.dataset.tcBound !== '1') {
        hoursTile.dataset.tcBound = '1';
        hoursTile.addEventListener('click', () => {
          openTimeCards();
        });
      }
      once('btnTcEditSave', tcSaveEdit);
      once('btnTcEditCancel', () => {
        showScreen('screenTimeWeek');
        document.body.classList.add('on-time-week');
        document.body.classList.remove('on-time-edit');
        tcRenderWeekDetail();
      });
      once('btnTcEditDelete', tcDeleteEdit);
      const typeRow = document.getElementById('tcTypeRow');
      if (typeRow && typeRow.dataset.tcBound !== '1') {
        typeRow.dataset.tcBound = '1';
        typeRow.querySelectorAll('.tc-type-chip').forEach(btn => {
          btn.addEventListener('click', () => {
            if (tcState.active) return;
            tcState.selectedType = btn.getAttribute('data-type') || 'bakery';
            tcRenderStatus();
          });
        });
      }
      const editJob = document.getElementById('tcEditJob');
      if (editJob && editJob.dataset.tcBound !== '1') {
        editJob.dataset.tcBound = '1';
      }

      const cin = document.getElementById('tcEditClockIn');
      const cout = document.getElementById('tcEditClockOut');
      const hoursEl = document.getElementById('tcEditHours');
      if (cin && cin.dataset.tcBound2 !== '1') {
        cin.dataset.tcBound2 = '1';
        cin.addEventListener('change', () => { tcHoursManualOverride = false; tcRecalcHoursFromTimes(); });
        cin.addEventListener('input', () => { tcHoursManualOverride = false; tcRecalcHoursFromTimes(); });
      }
      if (cout && cout.dataset.tcBound2 !== '1') {
        cout.dataset.tcBound2 = '1';
        cout.addEventListener('change', () => { tcHoursManualOverride = false; tcRecalcHoursFromTimes(); });
        cout.addEventListener('input', () => { tcHoursManualOverride = false; tcRecalcHoursFromTimes(); });
      }
      if (hoursEl && hoursEl.dataset.tcBound2 !== '1') {
        hoursEl.dataset.tcBound2 = '1';
        const clearClocks = () => {
          tcHoursManualOverride = true;
          const cin = document.getElementById('tcEditClockIn');
          const cout = document.getElementById('tcEditClockOut');
          if (cin) cin.value = '';
          if (cout) cout.value = '';
          const hint = document.getElementById('tcHoursHint');
          if (hint) hint.textContent = 'Manual hours — clock times cleared';
        };
        hoursEl.addEventListener('input', clearClocks);
        hoursEl.addEventListener('change', clearClocks);
      }

    }

    tcLoad();

    (function bindTcDeleteBtn() {
      const btn = document.getElementById('btnTcEditDelete');
      if (!btn || btn.dataset.delBound === '1') return;
      btn.dataset.delBound = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof tcDeleteEdit === 'function') tcDeleteEdit(e);
        else if (typeof window.tcDeleteEdit === 'function') window.tcDeleteEdit(e);
      });
    })();
    bindTimeCards();
    setTimeout(bindTimeCards, 300);

    prefetchExportLibs(); initPunchlist().catch(err => console.warn('Punchlist init', err));
  

  

    function readFileDataUrl(file) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(file);
      });
    }
    window.attachInspectCameraPhoto = async function(file) {
      if (!file) return;
      const items = currentSectionItems();
      let item = null;
      const wanted = window.__inspectCamItemId;
      if (wanted != null && wanted !== '') {
        item = (APP_DATA.items || []).find(i => String(i.item_id) === String(wanted))
          || items.find(i => String(i.item_id) === String(wanted));
      }
      if (!item) item = items[currentItemIndex];
      window.__inspectCamItemId = null;
      if (!item) { toast('No item to attach to'); return; }
      const itemId = item.item_id;
      if (!results[itemId]) results[itemId] = {};
      try {
        let dataUrl = '';
        try { dataUrl = await readFileDataUrl(file); } catch (e) { dataUrl = ''; }
        try {
          const blob = await compressImageFile(file, 1600, 0.72);
          const id = 'ins_' + ((currentInspection && currentInspection.id) || 'draft') + '_' + itemId + '_' + Date.now();
          await idbPutPhoto({ id, blob: blob || file, caption: '', createdAt: Date.now() });
          results[itemId].photoId = id;
          if (blob) dataUrl = await readFileDataUrl(blob).catch(() => dataUrl);
        } catch (e) {}
        if (!dataUrl) { toast('Could not attach photo'); return; }
        results[itemId].photoDataUrl = dataUrl;
        updateFindings();
        saveCurrentDraft();
        renderSection(false);
        toast('Photo attached');
      } catch (err) {
        toast('Could not attach photo');
      }
    };
    window.bindInspectCamFab = function() {
      const fab = document.getElementById('fab-inspect-cam');
      const input = document.getElementById('inspectCamInput');
      if (fab) fab.style.display = 'none';
      if (!input) return;
      if (input.dataset.bound === '1') return;
      input.dataset.bound = '1';
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        input.value = '';
        if (file) window.attachInspectCameraPhoto(file);
      });
    };
    window.bindInspectCamFab();
    


    

    function pinPlModalBar() {
      const overlay = document.getElementById('pl-modal');
      const sheet = document.getElementById('modal-sheet');
      const body = document.getElementById('modal-body');
      if (!overlay) return;
      const bars = Array.from(overlay.querySelectorAll('.btn-row'));
      const keep = (body && body.querySelector('.btn-row')) || bars[bars.length - 1];
      bars.forEach(bar => {
        if (bar !== keep) bar.remove();
      });
      if (keep && keep.parentElement !== overlay) overlay.appendChild(keep);
      if (typeof showPlActionBars === 'function') showPlActionBars();
    }
    function showPlActionBars() {
      const hide = document.body.classList.contains('kb-open');
      document.querySelectorAll('#pl-modal .btn-row, #pl-modal .pl-item-bar').forEach((bar) => {
        bar.style.setProperty('display', hide ? 'none' : 'flex', 'important');
        bar.style.setProperty('visibility', hide ? 'hidden' : 'visible', 'important');
        bar.style.setProperty('opacity', hide ? '0' : '1', 'important');
        bar.style.setProperty('pointer-events', hide ? 'none' : 'auto', 'important');
      });
    }

    (function bindKeyboardPin() {
      if (window.__kbPinBound) return;
      window.__kbPinBound = true;
      const SEL = '#screenJobForm .btn-row, #screenStart .btn-row, .btn-row.tc-edit-bar';
      const field = (el) => {
        if (!el || el === document.body) return false;
        /* punchlist item fields should hide action bars behind the keyboard */
        const tag = (el.tagName || '').toLowerCase();
        if (tag === 'select') return false;
        if (tag === 'input') {
          const type = String(el.type || 'text').toLowerCase();
          if (['file', 'button', 'checkbox', 'radio', 'hidden', 'submit', 'reset', 'range', 'color'].includes(type)) return false;
          return true;
        }
        if (tag === 'textarea' || el.isContentEditable) return true;
        return !!(el.closest && el.closest('textarea, input[type="text"], input[type="search"], input[type="number"], input[type="tel"], input[type="email"], input[type="date"], [contenteditable="true"]'));
      };
      const apply = (hide) => {
        document.body.classList.toggle('kb-open', !!hide);
        document.querySelectorAll(SEL).forEach((bar) => {
          bar.style.setProperty('display', hide ? 'none' : 'flex', 'important');
          bar.style.setProperty('visibility', hide ? 'hidden' : 'visible', 'important');
        });
        if (!hide && typeof showPlActionBars === 'function') showPlActionBars();
        else if (hide) {
          document.querySelectorAll('#pl-modal .btn-row, #pl-modal .pl-item-bar').forEach((bar) => {
            bar.style.setProperty('display', 'none', 'important');
            bar.style.setProperty('visibility', 'hidden', 'important');
            bar.style.setProperty('opacity', '0', 'important');
            bar.style.setProperty('pointer-events', 'none', 'important');
          });
        }
      };
      document.addEventListener('focusin', (e) => {
        if (field(e.target)) apply(true);
        else if (e.target && e.target.closest && e.target.closest('#pl-modal')) showPlActionBars();
      }, true);
      document.addEventListener('focusout', (e) => {
        setTimeout(() => {
          apply(field(document.activeElement));
        }, 60);
      }, true);
      const syncKb = () => {
        const modal = document.getElementById('pl-modal');
        const modalOpen = !!(modal && (modal.classList.contains('show') || !modal.classList.contains('hidden')));
        const active = document.activeElement;
        const typingField = field(active) || !!(modalOpen && active && active.closest && active.closest('#pl-modal') && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName || ''));
        const vv = window.visualViewport;
        const kb = vv ? Math.max(0, window.innerHeight - vv.height - (vv.offsetTop || 0)) : 0;
        const hide = typingField || (modalOpen && kb > 60);
        apply(hide);
      };
      window.addEventListener('resize', syncKb);
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', syncKb);
        window.visualViewport.addEventListener('scroll', syncKb);
      }

    })();

    


    function qrGfMul(a, b) {
      let p = 0;
      for (let i = 0; i < 8; i++) {
        if (b & 1) p ^= a;
        const hi = a & 0x80;
        a = (a << 1) & 0xff;
        if (hi) a ^= 0x1d;
        b >>= 1;
      }
      return p;
    }
    const QR_EXP = new Uint8Array(256);
    const QR_LOG = new Uint8Array(256);
    (function initQrGf() {
      let x = 1;
      for (let i = 0; i < 255; i++) {
        QR_EXP[i] = x;
        QR_LOG[x] = i;
        x = qrGfMul(x, 2);
      }
      QR_EXP[255] = QR_EXP[0];
    })();
    function qrRsGen(ec) {
      const gen = new Uint8Array(ec + 1);
      gen[0] = 1;
      for (let i = 0; i < ec; i++) {
        for (let j = i; j >= 0; j--) {
          gen[j + 1] ^= qrGfMul(gen[j], QR_EXP[i]);
        }
      }
      return gen;
    }
    function qrRs(data, ec) {
      const gen = qrRsGen(ec);
      const out = new Uint8Array(ec);
      for (let i = 0; i < data.length; i++) {
        const factor = data[i] ^ out[0];
        out.copyWithin(0, 1);
        out[ec - 1] = 0;
        if (!factor) continue;
        const logF = QR_LOG[factor];
        for (let j = 0; j < ec; j++) {
          out[j] ^= QR_EXP[(QR_LOG[gen[j + 1]] + logF) % 255];
        }
      }
      return out;
    }
    // version -> [total data bytes EC-M, ec bytes per block, blocks]
    const QR_M = {
      1: [16, 10, 1], 2: [28, 16, 1], 3: [44, 26, 1], 4: [64, 18, 2],
      5: [86, 24, 2], 6: [108, 16, 4], 7: [124, 18, 4], 8: [154, 22, 4],
      9: [182, 22, 5], 10: [216, 26, 5]
    };
    function qrSize(ver) { return 17 + 4 * ver; }
    function qrReserve(size, ver) {
      const m = Array.from({ length: size }, () => Array(size).fill(null));
      const fillRect = (x, y, w, h, v) => {
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) m[y + j][x + i] = v;
      };
      const finder = (x, y) => {
        fillRect(x, y, 7, 7, true);
        fillRect(x + 1, y + 1, 5, 5, false);
        fillRect(x + 2, y + 2, 3, 3, true);
        for (let i = -1; i < 8; i++) {
          if (x + i >= 0 && x + i < size) {
            if (y - 1 >= 0) m[y - 1][x + i] = false;
            if (y + 7 < size) m[y + 7][x + i] = false;
          }
          if (y + i >= 0 && y + i < size) {
            if (x - 1 >= 0) m[y + i][x - 1] = false;
            if (x + 7 < size) m[y + i][x + 7] = false;
          }
        }
      };
      finder(0, 0); finder(size - 7, 0); finder(0, size - 7);
      // timing
      for (let i = 8; i < size - 8; i++) {
        m[6][i] = i % 2 === 0;
        m[i][6] = i % 2 === 0;
      }
      // dark module
      m[size - 8][8] = true;
      // format placeholders
      for (let i = 0; i < 9; i++) {
        if (m[8][i] == null) m[8][i] = false;
        if (m[i][8] == null) m[i][8] = false;
      }
      for (let i = 0; i < 8; i++) {
        if (m[8][size - 1 - i] == null) m[8][size - 1 - i] = false;
        if (m[size - 1 - i][8] == null) m[size - 1 - i][8] = false;
      }
      if (ver >= 2) {
        const align = ver === 2 ? [6, 18] : ver === 3 ? [6, 22] : ver === 4 ? [6, 26]
          : ver === 5 ? [6, 30] : ver === 6 ? [6, 34] : ver === 7 ? [6, 22, 38]
          : ver === 8 ? [6, 24, 42] : ver === 9 ? [6, 26, 46] : [6, 28, 50];
        for (const y of align) for (const x of align) {
          if ((x < 9 && y < 9) || (x > size - 10 && y < 9) || (x < 9 && y > size - 10)) continue;
          fillRect(x - 2, y - 2, 5, 5, true);
          fillRect(x - 1, y - 1, 3, 3, false);
          m[y][x] = true;
        }
      }
      return m;
    }
    function qrPlaceFormat(m, mask) {
      // EC level M = 00, format = ecBits(2) + mask(3)
      const data = (0b00 << 3) | mask;
      let bits = data << 10;
      const gen = 0b10100110111;
      for (let i = 14; i >= 10; i--) if ((bits >> i) & 1) bits ^= gen << (i - 10);
      const format = (data << 10 | bits) ^ 0b101010000010010;
      const size = m.length;
      const put = (i, bit) => {
        const v = !!(bit);
        if (i < 6) m[8][i] = v;
        else if (i === 6) m[8][7] = v;
        else if (i === 7) m[8][8] = v;
        else m[7 - (i - 8)][8] = v;
        if (i < 8) m[size - 1 - i][8] = v;
        else m[8][size - 15 + i] = v;
      };
      for (let i = 0; i < 15; i++) put(i, (format >> i) & 1);
    }
    function qrMaskFn(mask, x, y) {
      if (mask === 0) return (x + y) % 2 === 0;
      if (mask === 1) return y % 2 === 0;
      if (mask === 2) return x % 3 === 0;
      if (mask === 3) return (x + y) % 3 === 0;
      if (mask === 4) return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    }
    function qrBuild(text) {
      const bytes = [];
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c < 128) bytes.push(c);
        else {
          const enc = unescape(encodeURIComponent(text[i]));
          for (let k = 0; k < enc.length; k++) bytes.push(enc.charCodeAt(k));
        }
      }
      let ver = 1;
      while (ver <= 10 && QR_M[ver][0] < bytes.length + 3) ver++;
      if (ver > 10) ver = 10;
      const [dataBytes, ecPer, blocks] = QR_M[ver];
      const bits = [];
      const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
      put(0b0100, 4);
      put(bytes.length, ver < 10 ? 8 : 16);
      bytes.forEach((b) => put(b, 8));
      put(0, Math.min(4, dataBytes * 8 - bits.length));
      while (bits.length % 8) bits.push(0);
      const data = [];
      for (let i = 0; i < bits.length; i += 8) {
        let v = 0;
        for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
        data.push(v);
      }
      const pads = [0xec, 0x11];
      let p = 0;
      while (data.length < dataBytes) data.push(pads[(p++) % 2]);
      data.length = dataBytes;
      const blockLen = Math.floor(dataBytes / blocks);
      const shortBlocks = blocks - (dataBytes % blocks);
      const groups = [];
      let off = 0;
      for (let b = 0; b < blocks; b++) {
        const len = blockLen + (b < shortBlocks ? 0 : 1);
        const chunk = data.slice(off, off + len);
        off += len;
        groups.push({ d: chunk, e: Array.from(qrRs(Uint8Array.from(chunk), ecPer)) });
      }
      const inter = [];
      const maxD = Math.max(...groups.map(g => g.d.length));
      for (let i = 0; i < maxD; i++) groups.forEach(g => { if (i < g.d.length) inter.push(g.d[i]); });
      for (let i = 0; i < ecPer; i++) groups.forEach(g => inter.push(g.e[i]));
      const size = qrSize(ver);
      const reserved = qrReserve(size, ver);
      const matrix = reserved.map(row => row.slice());
      let bitStr = '';
      inter.forEach((v) => { bitStr += v.toString(2).padStart(8, '0'); });
      let bi = 0;
      let dir = -1;
      for (let x = size - 1; x > 0; x -= 2) {
        if (x === 6) x--;
        for (let y = dir < 0 ? size - 1 : 0; dir < 0 ? y >= 0 : y < size; y += dir) {
          for (let dx = 0; dx < 2; dx++) {
            const xx = x - dx;
            if (reserved[y][xx] != null) continue;
            const bit = bi < bitStr.length ? bitStr[bi++] === '1' : false;
            matrix[y][xx] = bit;
          }
        }
        dir *= -1;
      }
      const mask = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if (reserved[y][x] != null) continue;
        if (qrMaskFn(mask, x, y)) matrix[y][x] = !matrix[y][x];
      }
      qrPlaceFormat(matrix, mask);
      return matrix;
    }
    function qrDrawCanvas(canvas, text) {
      const m = qrBuild(text);
      const n = m.length;
      const pad = 3;
      const scale = Math.max(4, Math.floor(200 / (n + pad * 2)));
      const dim = (n + pad * 2) * scale;
      canvas.width = dim;
      canvas.height = dim;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, dim, dim);
      ctx.fillStyle = '#111111';
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        if (m[y][x]) ctx.fillRect((x + pad) * scale, (y + pad) * scale, scale, scale);
      }
    }

    function getProfile() {
      try {
        const raw = localStorage.getItem('lx8_profile');
        if (raw) {
          const p = JSON.parse(raw);
          if (p && typeof p === 'object') return p;
        }
      } catch (e) {}
      return { name: '', phone: '', email: '', company: '', companyPhone: '', companyAddress: '', website: '' };
    }
    function profileName() {
      return String((getProfile().name || '')).trim();
    }
    function saveProfile(next) {
      const p = Object.assign({ name: '', phone: '', email: '', company: '', companyPhone: '', companyAddress: '', website: '' }, getProfile(), next || {});
      try { localStorage.setItem('lx8_profile', JSON.stringify(p)); } catch (e) {}
      if (p.name) {
        try { lsWrite('lx8_last_tech', p.name); } catch (e) {}
        try { lsWrite('lx8_tc_name', p.name); } catch (e) {}
      }
      return p;
    }


    function profileVCard() {
      const p = getProfile();
      const name = String(p.name || '').trim();
      const phone = String(p.phone || '').trim();
      const email = String(p.email || '').trim();
      const company = String(p.company || '').trim();
      const companyPhone = String(p.companyPhone || '').trim();
      const companyAddress = String(p.companyAddress || '').trim();
      let website = String(p.website || '').trim();
      if (website && !/^https?:\/\//i.test(website)) website = 'https://' + website;
      if (!name && !phone && !email && !company && !companyPhone && !companyAddress && !website) return '';
      const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
      if (name) {
        lines.push('FN:' + name);
        const parts = name.split(/\s+/);
        const last = parts.length > 1 ? parts.pop() : '';
        const first = parts.join(' ');
        lines.push('N:' + last + ';' + first + ';;;');
      }
      if (company) lines.push('ORG:' + company);
      if (phone) lines.push('TEL;TYPE=CELL:' + phone);
      if (companyPhone) lines.push('TEL;TYPE=WORK:' + companyPhone);
      if (email) lines.push('EMAIL:' + email);
      if (companyAddress) {
        const adr = companyAddress.replace(/\r?\n/g, ', ');
        lines.push('ADR;TYPE=WORK:;;' + adr + ';;;;');
      }
      if (website) lines.push('URL:' + website);
      lines.push('END:VCARD');
      return lines.join('\r\n');
    }
    let profileQrObj = null;

    function profileVcfFile() {
      const card = profileVCard();
      if (!card) return null;
      const p = getProfile();
      const fname = ((p.name || 'contact').replace(/[\\/:*?"<>|]/g, '-').trim() || 'contact') + '.vcf';
      return new File([card], fname, { type: 'text/vcard' });
    }
    async function shareProfileContact(e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      const card = profileVCard();
      if (!card) return;
      const file = profileVcfFile();
      const p = getProfile();
      try {
        if ('NDEFWriter' in window || 'NDEFReader' in window) {
          const writer = new NDEFReader();
          await writer.write({
            records: [{ recordType: 'mime', mediaType: 'text/vcard', data: card }]
          });
          if (typeof showToast === 'function') showToast('Ready — hold phones together');
          else if (typeof toast === 'function') toast('Ready — hold phones together');
          return;
        }
      } catch (err) {
        console.warn('NFC write failed', err);
      }
      try {
        if (navigator.share) {
          const data = { title: p.name || 'Contact', text: p.name || 'Contact' };
          if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
            data.files = [file];
          } else {
            data.text = card;
          }
          await navigator.share(data);
          return;
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
      try {
        const blob = new Blob([card], { type: 'text/vcard' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (file && file.name) || 'contact.vcf';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
      } catch (err) {}
    }
    window.shareProfileContact = shareProfileContact;

    function renderProfileQr() {
      const box = document.getElementById('profileQr');
      const wrap = document.getElementById('profileQrWrap');
      const thumb = document.getElementById('profileQrThumb');
      const card = profileVCard();
      const can = typeof QRCode !== 'undefined';
      if (!card || !can) {
        if (wrap) { wrap.hidden = true; }
        if (box) box.innerHTML = '';
        if (thumb) { thumb.hidden = true; thumb.innerHTML = ''; }
        profileQrObj = null;
        return;
      }
      if (wrap) wrap.hidden = false;
      if (box) {
        box.innerHTML = '';
        profileQrObj = new QRCode(box, {
          text: card,
          width: 168,
          height: 168,
          colorDark: '#000000',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.M
        });
      }
      if (thumb) {
        thumb.hidden = false;
        thumb.innerHTML = '';
        new QRCode(thumb, {
          text: card,
          width: 44,
          height: 44,
          colorDark: '#000000',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.M
        });
      }
    }
    function openProfileQrViewer() {
      const ov = document.getElementById('profileQrViewer');
      const dest = document.getElementById('profileQrViewerCanvas');
      const box = document.getElementById('profileQr');
      if (!ov || !dest || !box) return;
      const img = box.querySelector('img');
      const srcCanvas = box.querySelector('canvas');
      const ctx = dest.getContext('2d');
      const size = 360;
      dest.width = size;
      dest.height = size;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
      const draw = (el) => {
        try { ctx.drawImage(el, 16, 16, size - 32, size - 32); } catch (e) {}
      };
      if (img && img.src) {
        const pic = new Image();
        pic.onload = () => draw(pic);
        pic.src = img.src;
      } else if (srcCanvas) {
        draw(srcCanvas);
      }
      ov.hidden = false;
    }
    function closeProfileQrViewer() {
      const ov = document.getElementById('profileQrViewer');
      if (ov) ov.hidden = true;
    }
    window.closeProfileQrViewer = closeProfileQrViewer;

    function fillProfileForm() {
      const p = getProfile();
      const n = document.getElementById('profileName');
      const ph = document.getElementById('profilePhone');
      const em = document.getElementById('profileEmail');
      if (n) n.value = p.name || '';
      if (ph) ph.value = p.phone || '';
      if (em) em.value = p.email || '';
      const co = document.getElementById('profileCompany');
      const cph = document.getElementById('profileCompanyPhone');
      const cad = document.getElementById('profileCompanyAddress');
      if (co) co.value = p.company || '';
      if (cph) cph.value = p.companyPhone || '';
      if (cad) cad.value = p.companyAddress || '';
      const web = document.getElementById('profileWebsite');
      if (web) web.value = p.website || '';
      const sum = document.getElementById('profileToggleName');
      if (sum) sum.textContent = p.name || '';
      renderProfileQr();
    }

    function setProfileOpen(open) {
      const card = document.getElementById('profileCard');
      const body = document.getElementById('profileBody');
      const btn = document.getElementById('profileToggle');
      if (!card || !body || !btn) return;
      card.classList.toggle('open', !!open);
      body.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    function bindProfileToggle() {
      const btn = document.getElementById('profileToggle');
      if (!btn || btn.dataset.bound === '1') return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', (e) => {
        if (e.target && e.target.closest && e.target.closest('#profileQrThumb')) return;
        const open = btn.getAttribute('aria-expanded') !== 'true';
        setProfileOpen(open);
        if (open) renderProfileQr();
      });
      const thumb = document.getElementById('profileQrThumb');
      if (thumb && thumb.dataset.bound !== '1') {
        thumb.dataset.bound = '1';
        thumb.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openProfileQrViewer();
        });
      }
    }

    function bindProfileForm() {
      ['profileName','profilePhone','profileEmail','profileCompany','profileCompanyPhone','profileCompanyAddress','profileWebsite'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el || el.dataset.profileBound === '1') return;
        el.dataset.profileBound = '1';
        const write = () => {
          saveProfile({
            name: (document.getElementById('profileName') || {}).value || '',
            phone: (document.getElementById('profilePhone') || {}).value || '',
            email: (document.getElementById('profileEmail') || {}).value || '',
            company: (document.getElementById('profileCompany') || {}).value || '',
            companyPhone: (document.getElementById('profileCompanyPhone') || {}).value || '',
            companyAddress: (document.getElementById('profileCompanyAddress') || {}).value || '',
            website: (document.getElementById('profileWebsite') || {}).value || ''
          });
        };
        el.addEventListener('input', () => { write(); renderProfileQr(); });
        el.addEventListener('change', write);
        el.addEventListener('blur', write);
      });
      const qrWrap = document.getElementById('profileQrWrap');
      if (qrWrap && qrWrap.dataset.qrBound !== '1') {
        qrWrap.dataset.qrBound = '1';
        qrWrap.addEventListener('click', (e) => { e.stopPropagation(); openProfileQrViewer(); });
      }
      const shareBtn = document.getElementById('profileShareBtn');
      if (shareBtn && shareBtn.dataset.bound !== '1') {
        shareBtn.dataset.bound = '1';
        shareBtn.addEventListener('click', shareProfileContact);
      }
      bindProfileToggle();
      setProfileOpen(false);
    }
    window.getProfile = getProfile;
    window.openProfileQrViewer = openProfileQrViewer;
    window.profileName = profileName;

    function applyTheme(mode) {
      const light = mode === 'light';
      document.documentElement.classList.toggle('theme-light', light);
      document.body.classList.toggle('theme-light', light);
      try { localStorage.setItem('lx8_theme', light ? 'light' : 'dark'); } catch (e) {}
      const darkBtn = document.getElementById('themeDark');
      const lightBtn = document.getElementById('themeLight');
      if (darkBtn) darkBtn.classList.toggle('on', !light);
      if (lightBtn) lightBtn.classList.toggle('on', light);
      try {
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', light ? '#e8eaee' : '#000000');
      } catch (e) {}
    }
    function bootTheme() {
      let mode = 'dark';
      try { mode = localStorage.getItem('lx8_theme') || 'dark'; } catch (e) {}
      applyTheme(mode);
      const darkBtn = document.getElementById('themeDark');
      const lightBtn = document.getElementById('themeLight');
      if (darkBtn && darkBtn.dataset.themeBound !== '1') {
        darkBtn.dataset.themeBound = '1';
        darkBtn.addEventListener('click', () => applyTheme('dark'));
      }
      if (lightBtn && lightBtn.dataset.themeBound !== '1') {
        lightBtn.dataset.themeBound = '1';
        lightBtn.addEventListener('click', () => applyTheme('light'));
      }
    }
    bootTheme();
    bindProfileForm();
    fillProfileForm();

    })();
