
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
    const inspectListMode = true; // list view is the only inspection view now
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
        // templates.js (loaded before this script) always provides
        // window.MACHINE_TEMPLATES in the shipped app, so this is a
        // last-resort empty state rather than a real data source.
        console.warn('No machine template data found');
        APP_DATA = { sections: [], items: [], lists: {} };
      }
      if (init) initApp();
      return APP_DATA;
    }

    // ========== STORE (IndexedDB + localStorage fallback) ==========
    // Phase 14: single storage section. Every persisted record kind (jobs,
    // inspections, visits, customers, sites, serials, parts requests, time
    // cards, punchlists) and photos is read/written ONLY from inside this
    // section — via the primitives below (lsRead/lsWrite/idb*) and the
    // STORE.load(kind)/STORE.save(kind, value)/STORE.getPhoto/STORE.putPhoto/
    // STORE.getAllPhotos/STORE.deletePhotos dispatcher further down. Every
    // existing load*/save* function elsewhere in the file (loadJobs,
    // saveJobs, tcLoad, tcSave, plLoadData, plSaveData, etc.) keeps its
    // existing name and signature and calls into STORE for the actual
    // persistence step; the business logic each of those functions also
    // does (identity resolution, sample seeding, debounced durable-persist
    // scheduling, ...) stays exactly where it already was. This is a pure
    // reorganization: every localStorage key, IndexedDB database/store
    // name, and record shape below is unchanged from before Phase 14, so a
    // future sync layer (Phase 16) has one place to plug into.
    //
    // Three narrow, deliberate exceptions are NOT routed through STORE,
    // and are left exactly as they were (see the Phase 14 report for the
    // full search proving this): the `lx8_last_punchlist`, `lx8_profile`
    // and `lx8_theme` keys, which are not persisted record data (they're
    // small UI-state/preference values, not one of the nine data kinds),
    // and the one-time legacy `FieldPunchlistDB` migration read
    // (openDB/idbGet below, used only by plMigrateFromOldDatabase), kept
    // as its own isolated, already-self-contained fallback.
    //
    // Inspections and visits don't route their durable IndexedDB step
    // through a STORE.save/STORE.load call at all (only their immediate
    // localStorage mirror does, via STORE.save('inspections', ...) /
    // STORE.load('inspections')) — their real durable write is the shared,
    // debounced persistAllStores() below, and their real boot-time read is
    // bootStorage() below. Both functions live inside this same STORE
    // section (they are not "outside STORE" in the sense the rest of this
    // comment means), read/write the same `kv` object store as everything
    // else here, and were already correlated/combined for visits+
    // inspections before Phase 14 — untouched by this reorganization.
    const LX_DB_NAME = 'lematic-lx8';
    const LX_DB_VER = 1;
    const storeMem = {
      inspections: null,
      visits: null,
      jobs: null,
      partsRequests: null,
      customers: null,
      sites: null,
      serials: null,
      machines: null,
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
      // v170 (Phase 16A): once the new storage is active, the old data keys
      // are frozen as the safety net — never written again.
      if (lxsBlocksLegacyWrite(key)) return false;
      try { localStorage.setItem(key, JSON.stringify(value)); return true; }
      catch (e) { return false; }
    }
    function lxsBlocksLegacyWrite(key) {
      try {
        if ((LXS.isV2() || LXS.oldStorageClosed()) && LXS.LEGACY_LS_DATA_KEYS.indexOf(key) >= 0) {
          console.warn('[storage] blocked write to frozen old key', key);
          return true;
        }
      } catch (e) {}
      return false;
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
      // v170: non-data cache entries (xlsx templates) live in the new database.
      if (lxsIsV2Safe() && LXS.LEGACY_KV_DATA_KEYS.indexOf(key) < 0) return LXS.metaGet('kvcache:' + key);
      if (lxsOldClosedSafe()) return Promise.resolve(undefined);
      return idbOpen().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readonly');
        const req = tx.objectStore('kv').get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }));
    }
    function idbSetKv(key, value) {
      if (lxsIsV2Safe()) {
        if (LXS.LEGACY_KV_DATA_KEYS.indexOf(key) >= 0) {
          console.warn('[storage] blocked write to frozen old kv key', key);
          return Promise.resolve(false);
        }
        return LXS.metaPut('kvcache:' + key, value).then(() => true);
      }
      if (lxsOldClosedSafe()) return Promise.resolve(false);
      return idbOpen().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      }));
    }
    function lxsIsV2Safe() {
      try { return LXS.isV2(); } catch (e) { return false; }
    }
    // v170: an upgraded phone that can't open the new storage never falls
    // back to the old storage — no reads, no writes.
    function lxsOldClosedSafe() {
      try { return LXS.oldStorageClosed(); } catch (e) { return false; }
    }
    function idbPutPhoto(rec) {
      if (lxsIsV2Safe()) return Promise.resolve(LXS.stagePhotoPut(rec || {}));
      if (lxsOldClosedSafe()) return Promise.resolve(false);
      return idbOpen().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction('photos', 'readwrite');
        tx.objectStore('photos').put(rec);
        tx.oncomplete = () => resolve(rec.id);
        tx.onerror = () => reject(tx.error);
      }));
    }
    function idbGetPhoto(id) {
      if (!id) return Promise.resolve(null);
      if (lxsIsV2Safe()) return LXS.getPhoto(id);
      if (lxsOldClosedSafe()) return Promise.resolve(null);
      return idbOpen().then(db => new Promise((resolve, reject) => {
        const req = db.transaction('photos', 'readonly').objectStore('photos').get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      }));
    }
    function idbDeletePhotos(ids) {
      const list = (ids || []).filter(Boolean);
      if (!list.length) return Promise.resolve();
      // v170: a deleted photo keeps its bytes and gets deletedAt instead.
      if (lxsIsV2Safe()) { LXS.deletePhotosExplicit(list); return Promise.resolve(); }
      if (lxsOldClosedSafe()) return Promise.resolve();
      return idbOpen().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction('photos', 'readwrite');
        const st = tx.objectStore('photos');
        list.forEach(id => st.delete(id));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }));
    }
    function idbGetAllPhotos() {
      if (lxsIsV2Safe()) return LXS.getAllLivePhotos().catch(() => []);
      if (lxsOldClosedSafe()) return Promise.resolve([]);
      return idbOpen().then(db => new Promise((resolve, reject) => {
        const req = db.transaction('photos', 'readonly').objectStore('photos').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      })).catch(() => []);
    }

    // ----- STORE: single load(kind)/save(kind, value) dispatcher -----
    // Each case below reproduces — unchanged — exactly the read/write steps
    // that kind's own load*/save* function (elsewhere in the file) used to
    // perform directly. Nothing here is "unified" or "improved": the
    // per-kind quirks (localStorage-only vs. localStorage+kv-mirror,
    // time cards' object shape instead of an array, punchlist's own
    // load/save pair, jobs' write-retry) are preserved exactly as they
    // were, because changing any of them would be a behavior change this
    // phase is explicitly not allowed to make.
    const STORE = {
      load(kind, opts) {
        if (LXS.st.mode === 'v2') return lxsStoreLoad(kind, opts);
        if (LXS.oldStorageClosed()) return lxsClosedLoad(kind);
        if (LXS.st.mode === 'pending') console.warn('[storage] load before storage ready', kind, new Error().stack);
        switch (kind) {
          case 'jobs': {
            const fromLs = lsRead('lx8_jobs', []);
            const mem = Array.isArray(storeMem.jobs) ? storeMem.jobs : [];
            return mem.length ? mem : (Array.isArray(fromLs) ? fromLs : []);
          }
          case 'customers': {
            const fromLs = lsRead('lx8_customers', []);
            const mem = Array.isArray(storeMem.customers) ? storeMem.customers : [];
            return mem.length ? mem : (Array.isArray(fromLs) ? fromLs : []);
          }
          case 'sites': {
            const fromLs = lsRead('lx8_sites', []);
            const mem = Array.isArray(storeMem.sites) ? storeMem.sites : [];
            return mem.length ? mem : (Array.isArray(fromLs) ? fromLs : []);
          }
          case 'serials': {
            const fromLs = lsRead('lx8_serials', []);
            const mem = Array.isArray(storeMem.serials) ? storeMem.serials : [];
            return mem.length ? mem : (Array.isArray(fromLs) ? fromLs : []);
          }
          case 'machines': {
            // Phase 15A: new kind, same localStorage-mirror + write-only kv
            // pattern as customers/sites/serials directly above.
            const fromLs = lsRead('lx8_machines', []);
            const mem = Array.isArray(storeMem.machines) ? storeMem.machines : [];
            return mem.length ? mem : (Array.isArray(fromLs) ? fromLs : []);
          }
          case 'partsRequests': {
            const fromLs = lsRead('lx8_parts_requests', []);
            const mem = Array.isArray(storeMem.partsRequests) ? storeMem.partsRequests : [];
            return mem.length ? mem : (Array.isArray(fromLs) ? fromLs : []);
          }
          case 'inspections':
            // loadInspections() only ever calls this before boot has
            // populated storeMem.inspections; after that it returns the
            // in-memory copy itself and never reaches this case. Matches
            // today's loadInspections() exactly (it doesn't check kv
            // either — only bootStorage does, on its own, see below).
            return lsRead('lx8_inspections', []);
          case 'timecards':
            // {entries, active} object, not an array — unlike every kind
            // above. No IndexedDB mirror. Known gap, not fixed here — see
            // STORE.save('timecards') below.
            return lsRead('lx8_timecards', null);
          case 'visits':
            // The old standalone "Visit" flow was already removed before
            // Phase 14; nothing calls this today (loadVisits() is a fixed
            // stub kept only for old-backup-zip compatibility — see below).
            // bootStorage() does its own correlated kv+localStorage read
            // together with inspections, for one shared IndexedDB round
            // trip; that logic is untouched and lives where it always has.
            // Provided here only so the STORE.load(kind) contract is
            // complete for all nine kinds.
            return Array.isArray(storeMem.visits) ? storeMem.visits : lsRead('lx8_visits', []);
          case 'punchlist': {
            // The actual kv 'punchlist_main' read + localStorage LEGACY_KEY
            // ('field_punchlist_v3') fallback, upgrade-write and toast —
            // exactly what plLoadData() used to do directly. The Punchlist
            // module's own migration chain from the legacy FieldPunchlistDB
            // database (openDB/idbGet, plMigrateFromOldDatabase) stays where
            // it is and is untouched; it calls this with
            // { skipLegacyFallback: true } for its own internal
            // "already migrated?" kv-only check, so that check never races
            // ahead of the FieldPunchlistDB migration it's guarding (this
            // fallback must only run *after* that migration has already
            // been tried and found nothing).
            const skipLegacy = !!(opts && opts.skipLegacyFallback);
            return (async () => {
              const kv = await idbGetKv('punchlist_main').catch(() => null);
              if (kv) return kv;
              if (skipLegacy) return null;
              const legacy = lsRead('field_punchlist_v3', null);
              if (legacy) {
                try { await idbSetKv('punchlist_main', legacy); } catch (e) {}
                toast('Data upgraded to larger storage');
              }
              return legacy;
            })();
          }
          case 'editLog': {
            const fromLs = lsRead('lx8_edit_log', []);
            const mem = Array.isArray(storeMem.editLog) ? storeMem.editLog : [];
            return mem.length ? mem : (Array.isArray(fromLs) ? fromLs : []);
          }
          case 'editorSettings': {
            const fromLs = lsRead('lx8_editor_settings', { pin: '' });
            return (fromLs && typeof fromLs === 'object') ? fromLs : { pin: '' };
          }
          default:
            throw new Error('STORE.load: unknown kind "' + kind + '"');
        }
      },
      save(kind, value, opts) {
        if (LXS.st.mode === 'v2') return lxsStoreSave(kind, value, opts);
        if (LXS.oldStorageClosed()) { console.warn('[storage] save refused, storage not open', kind); return kind === 'punchlist' ? Promise.resolve(false) : false; }
        if (LXS.st.mode === 'pending') console.warn('[storage] save before storage ready', kind, new Error().stack);
        switch (kind) {
          case 'jobs': {
            // Preserves the existing retry-then-return-early quirk: if the
            // first write fails but an immediate retry succeeds, this
            // returns true WITHOUT mirroring to kv that time — exactly as
            // saveJobs() already did before this phase.
            const ok = lsWrite('lx8_jobs', value);
            if (!ok) {
              try {
                if (lsWrite('lx8_jobs', value)) return true;
              } catch (e) {}
            }
            try { idbSetKv('jobs', value); } catch (e) {}
            // Known gap (Phase 16): idbSetKv above is a write-only mirror.
            // STORE.load('jobs') above never reads it back — if
            // localStorage fails or is cleared, that IndexedDB copy is
            // currently unreachable. Same for customers/sites/serials/
            // partsRequests below. Not fixed in this phase; preserved
            // exactly as it already behaved.
            return ok;
          }
          case 'customers': {
            const ok = lsWrite('lx8_customers', value);
            try { idbSetKv('customers', value); } catch (e) {}
            return ok;
          }
          case 'sites': {
            const ok = lsWrite('lx8_sites', value);
            try { idbSetKv('sites', value); } catch (e) {}
            return ok;
          }
          case 'serials': {
            const ok = lsWrite('lx8_serials', value);
            try { idbSetKv('serials', value); } catch (e) {}
            return ok;
          }
          case 'machines': {
            const ok = lsWrite('lx8_machines', value);
            try { idbSetKv('machines', value); } catch (e) {}
            return ok;
          }
          case 'partsRequests': {
            const ok = lsWrite('lx8_parts_requests', value);
            try { idbSetKv('parts_requests', value); } catch (e) {}
            return ok;
          }
          case 'inspections':
            // saveInspections() also schedules the debounced durable
            // IndexedDB persist (schedulePersist -> persistAllStores,
            // which writes visits+inspections together); that orchestration
            // is untouched and lives where it always has. This case is
            // only the same immediate localStorage mirror write
            // saveInspections() already did directly.
            return lsWrite('lx8_inspections', value);
          case 'timecards':
            // No IndexedDB mirror for time cards today, unlike the other
            // kinds above. Known gap (Phase 16): preserved exactly as-is,
            // not added here.
            return lsWrite('lx8_timecards', value);
          case 'visits':
            // See STORE.load('visits') above — provided for contract
            // completeness; the real, correlated write path visits share
            // with inspections is persistAllStores(), untouched.
            return lsWrite('lx8_visits', value);
          case 'punchlist': {
            // The actual kv 'punchlist_main' write + localStorage LEGACY_KEY
            // fallback-on-failure-with-toast — exactly what plSaveData() used
            // to do directly (its body is now just `return
            // STORE.save('punchlist', data);`).
            //
            // { rawKvOnly: true } is used only by the Punchlist module's own
            // FieldPunchlistDB-migration write inside plMigrateFromOldDatabase:
            // that write must still throw on failure exactly like the raw
            // idbSetKv() call it replaces (its own surrounding try/catch is
            // what decides whether the migration succeeded), not silently
            // fall back to localStorage the way a normal user-triggered save
            // does below.
            if (opts && opts.rawKvOnly) return idbSetKv('punchlist_main', value);
            return (async () => {
              try {
                await idbSetKv('punchlist_main', value);
                return true;
              } catch (e) {
                if (lsWrite('field_punchlist_v3', value)) {
                  toast('Saved (fallback mode)');
                  return true;
                }
                toast('Storage full – remove photos or old jobs');
                return false;
              }
            })();
          }
          case 'editLog': {
            storeMem.editLog = Array.isArray(value) ? value : [];
            const ok = lsWrite('lx8_edit_log', storeMem.editLog);
            try { idbSetKv('edit_log', storeMem.editLog); } catch (e) {}
            return ok;
          }
          case 'editorSettings': {
            const ok = lsWrite('lx8_editor_settings', value || { pin: '' });
            try { idbSetKv('editor_settings', value || { pin: '' }); } catch (e) {}
            return ok;
          }
          default:
            throw new Error('STORE.save: unknown kind "' + kind + '"');
        }
      },
      getPhoto(id) { return idbGetPhoto(id); },
      putPhoto(rec) { return idbPutPhoto(rec); },
      getAllPhotos() { return idbGetAllPhotos(); },
      deletePhotos(ids) { return idbDeletePhotos(ids); }
    };

    // ========== STORAGE v2 (Phase 16A) ==========
    // Sync-ready storage. After the one-time upgrade below has finished and
    // verified, every record of every kind is its own entry in a separate
    // IndexedDB database (`lematic-fs`), wrapped in an "envelope" that carries
    // its sync information beside — never inside — the record itself:
    //
    //   { kind, id, createdAt, updatedAt, updatedBy, deviceId, deletedAt,
    //     changeSource, changeRef, json: '<the record exactly as the app uses it>' , ...extras }
    //
    // The app keeps working on the same in-memory arrays/objects it always
    // has; every existing save function still passes its whole list, and this
    // layer works out what actually changed by comparing each record's text
    // with the cached text it last stored (a hint lets the busiest paths skip
    // records they know they didn't touch). New ids → created, different text
    // → updated, missing from the list → deletedAt set (never erased).
    //
    // The old storage (localStorage data keys, `lematic-lx8` kv + photos,
    // FieldPunchlistDB) is never written again once this is active; it stays
    // frozen as the safety net. If the upgrade cannot finish, LXS stays in
    // 'legacy' mode and every v169 storage path below runs unchanged.
    const LXS = (function () {
      const DB_NAME = 'lematic-fs';
      const DB_VER = 1;
      const KINDS = ['jobs', 'inspections', 'partsRequests', 'customers', 'sites', 'machines', 'serials',
        'timeEntries', 'punchlistLists', 'punchlistItems', 'editLog'];
      // Kinds whose screens put a NEW record at the front of the list today
      // (unshift); the rest add new records at the end (push). Used only to
      // place records this device has no stored order for (e.g. records that
      // will arrive from other phones in Phase 16C).
      const FRONT_KINDS = new Set(['jobs', 'inspections', 'partsRequests', 'editLog']);
      // localStorage keys that hold v169 data. Frozen once v2 is active.
      const LEGACY_LS_DATA_KEYS = ['lx8_jobs', 'lx8_inspections', 'lx8_parts_requests', 'lx8_customers', 'lx8_sites',
        'lx8_machines', 'lx8_serials', 'lx8_timecards', 'lx8_edit_log', 'lx8_visits', 'lx8_visits_meta', 'field_punchlist_v3'];
      const LEGACY_KV_DATA_KEYS = ['jobs', 'customers', 'sites', 'serials', 'machines', 'parts_requests', 'inspections',
        'visits', 'punchlist_main', 'edit_log', 'editor_settings'];
      const CHANGE_SOURCES = ['user', 'restore', 'sampleRemoval', 'editor', 'undo', 'backfill', 'upgrade', 'housekeeping'];

      const st = {
        mode: 'pending',          // 'pending' | 'v2' | 'legacy' | 'blocked'
        db: null,
        deviceId: '',
        tabId: 'tab_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        arrays: {},               // kind -> live array the app uses
        known: {},                // kind -> Map(id -> { env, json, obj, deleted })
        orderCache: {},           // kind -> joined id order last written
        photos: new Map(),        // photoId -> meta (no blob)
        pending: new Map(),       // key -> op   (records, photos, meta)
        pendingFailures: 0,
        lastFailureAt: 0,
        flushTimer: null,
        flushing: null,
        flushAgain: false,
        sourceStack: [],
        sweepTimers: {},
        restoreMeta: null,        // during a restore: kind -> id -> sync meta from sync_meta.json
        plLegacy: { lists: {}, items: {} }, // id -> legacy info, consumed when a record is first created
        meta: {},                 // cached small meta values
        upgradeFailed: null,
        rollbackWarning: false,
        stale: new Set(),
        readyResolve: null,
        upgradeReport: null,
        bc: null,
        stats: { saves: 0, recordsWritten: 0, multiDeletes: [] }
      };
      KINDS.forEach(k => { st.arrays[k] = []; st.known[k] = new Map(); });
      const ready = new Promise(res => { st.readyResolve = res; });

      // ---------- "this phone has been upgraded" marker ----------
      // Written in localStorage right after the switch to the new storage.
      // It holds no data (device id and time only) and is not part of the
      // old-storage fingerprint. A phone with this marker never goes back
      // to the old storage.
      const MARKER_KEY = 'lx8_storage_v2';
      function markerRead() {
        try {
          const raw = localStorage.getItem(MARKER_KEY);
          if (!raw) return null;
          try { const v = JSON.parse(raw); return (v && typeof v === 'object') ? v : { raw }; } catch (e) { return { raw }; }
        } catch (e) { return null; }
      }
      function markerWrite(deviceId) {
        try { localStorage.setItem(MARKER_KEY, JSON.stringify({ deviceId: deviceId || st.deviceId || '', at: new Date().toISOString() })); return true; }
        catch (e) { return false; }
      }
      st.upgradedDevice = !!markerRead();
      // The old storage is closed for reading and writing once this phone
      // counts as upgraded, unless the app is running on the new storage.
      function oldStorageClosed() {
        return st.mode === 'blocked' || (st.mode === 'pending' && st.upgradedDevice);
      }

      // ---------- small utils ----------
      function iso(v) {
        if (v == null || v === '') return new Date().toISOString();
        const d = new Date(v);
        return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
      }
      function rand6() {
        try {
          const a = new Uint32Array(2);
          crypto.getRandomValues(a);
          return (a[0].toString(36) + a[1].toString(36) + '000000').slice(0, 6);
        } catch (e) {
          return Math.random().toString(36).slice(2, 8);
        }
      }
      function uuid() {
        try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
        const a = new Uint8Array(16);
        try { crypto.getRandomValues(a); } catch (e) { for (let i = 0; i < 16; i++) a[i] = Math.floor(Math.random() * 256); }
        a[6] = (a[6] & 0x0f) | 0x40; a[8] = (a[8] & 0x3f) | 0x80;
        const h = Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
        return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
      }
      // cyrb53: fast 53-bit string hash (content fingerprints for sync_meta.json
      // and the old-storage rollback check). Not cryptographic.
      function hash(str, seed) {
        str = String(str == null ? '' : str);
        let h1 = 0xdeadbeef ^ (seed || 0), h2 = 0x41c6ce57 ^ (seed || 0);
        for (let i = 0, ch; i < str.length; i++) {
          ch = str.charCodeAt(i);
          h1 = Math.imul(h1 ^ ch, 2654435761);
          h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
      }
      // Content fingerprint used in sync_meta.json (and checked on restore).
      // Punchlist items leave out the photo id: a restored photo gets a new
      // photo id on another phone, but it is still the same item.
      function syncFp(kind, json) {
        if (kind === 'punchlistItems') json = String(json).replace(/"@photo:[^"]*"/, '"@photo"');
        return hash(json);
      }
      function techName() {
        try {
          const raw = localStorage.getItem('lx8_profile');
          const p = raw ? JSON.parse(raw) : null;
          return (p && p.name) ? String(p.name).trim() : '';
        } catch (e) { return ''; }
      }
      function isBase64DataUrl(s) {
        return typeof s === 'string' && s.length > 5 && s.charCodeAt(0) === 100 /* d */ && /^data:[^,]{0,120};base64,/.test(s.slice(0, 140));
      }
      function dataUrlParts(s) {
        const comma = s.indexOf(',');
        return { prefix: s.slice(0, comma + 1), b64: s.slice(comma + 1) };
      }
      function b64ToBlob(prefix, b64) {
        const mime = (prefix.match(/^data:([^;,]+)/) || [])[1] || 'image/jpeg';
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new Blob([arr], { type: mime });
      }
      function blobToB64(blob) {
        return new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => {
            const s = String(fr.result || '');
            resolve(s.slice(s.indexOf(',') + 1));
          };
          fr.onerror = () => reject(fr.error || new Error('read-failed'));
          fr.readAsDataURL(blob);
        });
      }
      function isV2() { return st.mode === 'v2'; }

      // ---------- change source ----------
      function currentSource() {
        return st.sourceStack.length ? st.sourceStack[st.sourceStack.length - 1] : { s: 'user', ref: '' };
      }
      function pushSource(s, ref) {
        const e = { s: CHANGE_SOURCES.indexOf(s) >= 0 ? s : 'user', ref: ref || '' };
        st.sourceStack.push(e);
        return e;
      }
      function popSource(e) {
        const i = st.sourceStack.lastIndexOf(e);
        if (i >= 0) st.sourceStack.splice(i, 1);
      }
      async function withSource(s, ref, fn) {
        const e = pushSource(s, ref);
        try { return await fn(); } finally { popSource(e); }
      }
      function withSourceSync(s, ref, fn) {
        const e = pushSource(s, ref);
        try { return fn(); } finally { popSource(e); }
      }

      // ---------- IndexedDB ----------
      function reqP(r) {
        return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      }
      function txDone(tx) {
        return new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error || new Error('tx-error'));
          tx.onabort = () => reject(tx.error || new Error('tx-abort'));
        });
      }
      function openFs() {
        if (st.db) return Promise.resolve(st.db);
        if (!('indexedDB' in window)) return Promise.reject(new Error('no-idb'));
        return new Promise((resolve, reject) => {
          const req = indexedDB.open(DB_NAME, DB_VER);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('records')) {
              const s = db.createObjectStore('records', { keyPath: ['kind', 'id'] });
              s.createIndex('kind', 'kind', { unique: false });
              s.createIndex('updatedAt', 'updatedAt', { unique: false });
            }
            if (!db.objectStoreNames.contains('photos')) {
              const p = db.createObjectStore('photos', { keyPath: 'id' });
              p.createIndex('updatedAt', 'updatedAt', { unique: false });
            }
            if (!db.objectStoreNames.contains('photoData')) db.createObjectStore('photoData', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
          };
          req.onsuccess = () => {
            st.db = req.result;
            st.db.onversionchange = () => { try { st.db.close(); } catch (e) {} st.db = null; };
            resolve(st.db);
          };
          req.onerror = () => reject(req.error || new Error('fs-open-failed'));
          req.onblocked = () => reject(new Error('fs-open-blocked'));
        });
      }
      async function metaGet(key) {
        const db = await openFs();
        return reqP(db.transaction('meta', 'readonly').objectStore('meta').get(key));
      }
      async function metaPut(key, value) {
        const db = await openFs();
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put(value, key);
        await txDone(tx);
        st.meta[key] = value;
      }

      // ---------- envelopes ----------
      function newEnv(kind, id, k, opts) {
        const src = currentSource();
        const now = new Date().toISOString();
        const env = {
          kind, id,
          createdAt: k ? k.env.createdAt : now,
          updatedAt: now,
          updatedBy: techName(),
          deviceId: st.deviceId,
          deletedAt: null,
          changeSource: src.s,
          changeRef: src.ref || ''
        };
        if (k && k.env) {
          ['listId', 'position', 'legacyId', 'legacyKey', 'legacyHadListName', 'photoId', 'sample'].forEach(f => {
            if (k.env[f] !== undefined) env[f] = k.env[f];
          });
        }
        if (opts && opts.extras) Object.assign(env, opts.extras);
        return env;
      }
      function stageRecord(kind, id, json, obj, opts) {
        const known = st.known[kind];
        const k = known.get(id);
        const env = newEnv(kind, id, k, opts);
        if (!k) {
          // First time this device stores this record.
          const rm = st.restoreMeta && st.restoreMeta[kind] && st.restoreMeta[kind][id];
          if (rm && rm.fp === syncFp(kind, json)) {
            ['createdAt', 'updatedAt', 'updatedBy', 'deviceId'].forEach(f => { if (rm[f]) env[f] = rm[f]; });
          } else if (opts && opts.createdAt) {
            env.createdAt = opts.createdAt;
          }
          if (kind === 'jobs' && id === 'job_sample_demo') env.sample = true;
          if (kind === 'inspections' && id === 'ins_example_orangeburg') env.sample = true;
          if (kind === 'timeEntries' && String(id).indexOf('tc_sample_') === 0) env.sample = true;
        }
        known.set(id, { env, json, obj, deleted: false });
        st.pending.set('r|' + kind + '|' + id, { t: 'rec', kind, id, env, json });
        st.stats.recordsWritten++;
      }
      function stageDelete(kind, id, srcOverride) {
        const known = st.known[kind];
        const k = known.get(id);
        if (!k || k.deleted) return false;
        const e = srcOverride ? pushSource(srcOverride.s, srcOverride.ref) : null;
        let env;
        try { env = newEnv(kind, id, k); } finally { if (e) popSource(e); }
        env.deletedAt = env.updatedAt;
        // Trimmed edit-log entries keep only a small marker (id + deletedAt),
        // not their (possibly multi-MB) before/after snapshots.
        const json = kind === 'editLog' ? JSON.stringify({ id }) : k.json;
        known.set(id, { env, json, obj: null, deleted: true });
        st.pending.set('r|' + kind + '|' + id, { t: 'rec', kind, id, env, json });
        st.stats.recordsWritten++;
        return true;
      }
      function stageMeta(key, value) {
        st.meta[key] = value;
        st.pending.set('m|' + key, { t: 'meta', key, value });
      }

      // ---------- stored form per kind ----------
      function inspectionStoredCopy(ins) {
        // Same per-record rules v169's stripInspectionPhotos() uses before
        // every save: a temporary on-screen blob: link is never stored, and
        // an inline copy is dropped once the photo has its own photoId.
        if (!ins || typeof ins !== 'object') return ins;
        const copy = Object.assign({}, ins);
        if (copy.results && typeof copy.results === 'object') {
          const r2 = {};
          Object.keys(copy.results).forEach(k => {
            const row = copy.results[k];
            if (!row || typeof row !== 'object') { r2[k] = row; return; }
            if (row.photoId || (row.photoDataUrl && String(row.photoDataUrl).indexOf('blob:') === 0)) {
              const rr = Object.assign({}, row);
              delete rr.photoDataUrl;
              r2[k] = rr;
            } else r2[k] = row;
          });
          copy.results = r2;
        }
        if (Array.isArray(copy.findings)) {
          copy.findings = copy.findings.map(f => {
            if (f && typeof f === 'object' && f.photoId && 'photoDataUrl' in f) {
              const ff = Object.assign({}, f); delete ff.photoDataUrl; return ff;
            }
            return f;
          });
        }
        return copy;
      }
      function storedJson(kind, rec) {
        if (kind === 'inspections') return JSON.stringify(inspectionStoredCopy(rec));
        return JSON.stringify(rec);
      }

      // ---------- generic list save (the choke point) ----------
      function saveKind(kind, list, opts) {
        if (!Array.isArray(list)) list = [];
        st.arrays[kind] = list;
        st.stats.saves++;
        const known = st.known[kind];
        const hint = opts && opts.hintIds ? new Set(opts.hintIds.map(String)) : null;
        const seen = new Set();
        const ids = [];
        for (let i = 0; i < list.length; i++) {
          const rec = list[i];
          if (!rec || typeof rec !== 'object' || rec.id == null || rec.id === '') continue;
          const id = String(rec.id);
          if (seen.has(id)) continue; // a duplicate id inside one list is stored once (first wins)
          seen.add(id);
          ids.push(id);
          const k = known.get(id);
          if (hint && k && !k.deleted && !hint.has(id) && k.obj === rec) continue;
          const json = storedJson(kind, rec);
          if (!k || k.deleted || k.json !== json) stageRecord(kind, id, json, rec);
          else k.obj = rec;
        }
        // Deletions: only records THIS tab has loaded can be marked deleted
        // (a stale second tab never deletes what it never saw).
        let deleted = 0;
        known.forEach((k, id) => {
          if (!k.deleted && !seen.has(id)) {
            const src = (kind === 'editLog' && currentSource().s === 'user') ? { s: 'housekeeping', ref: '' }
              : (kind === 'editLog' && currentSource().s === 'editor') ? { s: 'housekeeping', ref: currentSource().ref } : null;
            if (stageDelete(kind, id, src)) deleted++;
          }
        });
        if (deleted > 1) st.stats.multiDeletes.push({ kind, n: deleted, source: currentSource().s, ref: currentSource().ref, at: new Date().toISOString() });
        const order = ids.join('\u0001');
        if (st.orderCache[kind] !== order) {
          st.orderCache[kind] = order;
          stageMeta('order:' + kind, ids);
        }
        if (hint) scheduleSweep(kind);
        flushSoon();
        return true;
      }
      function scheduleSweep(kind) {
        const src = currentSource();
        clearTimeout(st.sweepTimers[kind]);
        st.sweepTimers[kind] = setTimeout(() => {
          withSourceSync(src.s, src.ref, () => saveKind(kind, st.arrays[kind]));
        }, 1200);
      }
      function sweepAllNow() {
        if (st.plSweepTimer) { clearTimeout(st.plSweepTimer); st.plSweepTimer = null; if (st.plLastBundle) savePunchlist(st.plLastBundle); }
        Object.keys(st.sweepTimers).forEach(kind => {
          if (st.sweepTimers[kind]) {
            clearTimeout(st.sweepTimers[kind]);
            st.sweepTimers[kind] = null;
            saveKind(kind, st.arrays[kind]);
          }
        });
      }

      // ---------- photos ----------
      // Two stores: `photos` holds each photo's details (owner, size, type,
      // sync times, deletedAt) and is small enough to read at start-up;
      // `photoData` holds the picture itself — image bytes (a Blob), or, for
      // punchlist item photos, the exact data-URL text the app has always
      // kept for them (so they come back character-for-character, with no
      // conversion when Punchlist opens).
      function payloadSize(dataUrl) {
        const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
        const pad = b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0);
        return Math.floor(b64.length * 3 / 4) - pad;
      }
      function stagePhotoPut(rec, opts) {
        // rec: { id, blob? | dataUrl?, caption?, createdAt? (ms or ISO), ownerKind?, ownerId?, ownerPart? }
        const prev = st.photos.get(rec.id);
        const src = currentSource();
        const now = new Date().toISOString();
        const isText = typeof rec.dataUrl === 'string';
        const meta = {
          id: rec.id,
          type: isText ? (((rec.dataUrl.match(/^data:([^;,]+)/) || [])[1]) || 'image/jpeg') : ((rec.blob && rec.blob.type) || (prev && prev.type) || 'image/jpeg'),
          size: isText ? payloadSize(rec.dataUrl) : ((rec.blob && rec.blob.size) || 0),
          storedAs: isText ? 'dataUrl' : 'blob',
          caption: rec.caption != null ? rec.caption : (prev ? prev.caption || '' : ''),
          ownerKind: rec.ownerKind || (prev && prev.ownerKind) || '',
          ownerId: rec.ownerId || (prev && prev.ownerId) || '',
          ownerPart: rec.ownerPart != null ? rec.ownerPart : (prev && prev.ownerPart) || '',
          createdAt: prev ? prev.createdAt : iso(rec.createdAt),
          updatedAt: now,
          updatedBy: techName(),
          deviceId: st.deviceId,
          deletedAt: null,
          changeSource: (opts && opts.source) || src.s,
          changeRef: src.ref || ''
        };
        const payload = isText ? { id: rec.id, dataUrl: rec.dataUrl } : { id: rec.id, blob: rec.blob };
        st.photos.set(rec.id, Object.assign({}, meta));
        st.pending.set('p|' + rec.id, { t: 'photo', id: rec.id, meta, payload });
        flushSoon();
        return rec.id;
      }
      function stagePhotoPatch(id, patch) {
        const prev = st.photos.get(id);
        if (!prev) return false;
        const src = currentSource();
        const now = new Date().toISOString();
        const p = Object.assign({ updatedAt: now, updatedBy: techName(), deviceId: st.deviceId, changeSource: src.s, changeRef: src.ref || '' }, patch);
        st.photos.set(id, Object.assign({}, prev, p));
        const key = 'p|' + id;
        const existing = st.pending.get(key);
        if (existing && existing.t === 'photo') {
          Object.assign(existing.meta, p);
        } else if (existing && existing.t === 'photoPatch') {
          Object.assign(existing.patch, p);
        } else {
          st.pending.set(key, { t: 'photoPatch', id, patch: p });
        }
        flushSoon();
        return true;
      }
      function tagPhotoOwner(photoId, ownerKind, ownerId, ownerPart) {
        if (!photoId) return;
        const m = st.photos.get(photoId);
        if (!m || m.ownerKind) return; // owner is set once; never changed by inference
        stagePhotoPatch(photoId, { ownerKind, ownerId: String(ownerId || ''), ownerPart: ownerPart != null ? String(ownerPart) : '' });
      }
      // Explicit, user-initiated photo deletion only (reviewer change 1).
      function deletePhotosExplicit(ids) {
        let n = 0;
        (ids || []).filter(Boolean).forEach(id => {
          const m = st.photos.get(id);
          if (m && !m.deletedAt) {
            stagePhotoPatch(id, { deletedAt: new Date().toISOString() });
            n++;
          }
        });
        return n;
      }
      async function getPayload(id) {
        const p = st.pending.get('p|' + id);
        if (p && p.t === 'photo') return p.payload;
        const db = await openFs();
        return reqP(db.transaction('photoData', 'readonly').objectStore('photoData').get(id));
      }
      function payloadBlob(payload, meta) {
        if (!payload) return null;
        if (payload.blob) return payload.blob;
        if (typeof payload.dataUrl === 'string') { const parts = dataUrlParts(payload.dataUrl); return b64ToBlob(parts.prefix, parts.b64); }
        return null;
      }
      // Same shape v169's photo store returned: { id, blob, caption, createdAt, ... }.
      async function getPhoto(id) {
        if (!id) return null;
        const m = st.photos.get(id);
        if (!m || m.deletedAt) return null;
        try {
          const payload = await getPayload(id);
          const blob = payloadBlob(payload, m);
          if (!blob) return null;
          return Object.assign({}, m, { blob });
        } catch (e) { return null; }
      }
      // A restore puts back a photo this device already has with the same
      // bytes: nothing to write (so its sync times don't change).
      async function photoUnchanged(id, blob) {
        const m = st.photos.get(id);
        if (!m || m.deletedAt || !blob || m.size !== blob.size) return false;
        const cur = await getPhoto(id);
        if (!cur || !cur.blob || cur.blob.size !== blob.size) return false;
        const [x, y] = await Promise.all([cur.blob.arrayBuffer(), blob.arrayBuffer()]);
        const u = new Uint8Array(x), v = new Uint8Array(y);
        for (let i = 0; i < u.length; i++) if (u[i] !== v[i]) return false;
        return true;
      }
      // Every photo that isn't deleted (unowned ones too), with its bytes.
      async function getAllLivePhotos(opts) {
        await flush().catch(() => {});
        const exclude = (opts && opts.exclude) || new Set();
        const out = [];
        for (const [id, m] of st.photos) {
          if (m.deletedAt || exclude.has(id)) continue;
          const payload = await getPayload(id).catch(() => null);
          const blob = payloadBlob(payload, m);
          if (blob) out.push(Object.assign({}, m, { blob }));
        }
        return out;
      }
      // Owner tagging from record photo references (only fills empty owners).
      function tagOwnersFromRecord(kind, rec) {
        if (!rec || typeof rec !== 'object') return;
        if (kind === 'inspections') {
          if (rec.results && typeof rec.results === 'object') {
            Object.keys(rec.results).forEach(k => {
              const row = rec.results[k];
              if (row && row.photoId) tagPhotoOwner(row.photoId, 'inspections', rec.id, 'result:' + k);
            });
          }
          (Array.isArray(rec.findings) ? rec.findings : []).forEach((f, i) => {
            if (f && f.photoId) tagPhotoOwner(f.photoId, 'inspections', rec.id, 'finding:' + i);
          });
        } else if (kind === 'partsRequests') {
          (Array.isArray(rec.parts) ? rec.parts : []).forEach(p => {
            if (p && p.photoId) tagPhotoOwner(p.photoId, 'partsRequests', rec.id, 'line:' + (p.id || ''));
          });
        }
      }

      // ---------- flush (write queue) ----------
      function flushSoon() {
        if (st.mode !== 'v2') return;
        if (st.flushTimer) return;
        st.flushTimer = setTimeout(() => { st.flushTimer = null; flush().catch(() => {}); }, 0);
      }
      const inspectionPhotoMemo = new Map(); // data: URL text -> photoId (so re-saves never mint duplicates)
      function extractInspectionPhotosForWrite(json, id, photoOps) {
        // v169's durable inspection copy kept inline data: photos in the
        // photo store and only a photoId on the record. Same here, at write
        // time; the in-memory record is left exactly as the app has it.
        if (json.indexOf('data:') < 0) return json;
        const data = JSON.parse(json);
        let changed = false;
        const handle = (row, prefix) => {
          if (!row || typeof row !== 'object' || row.photoId || !isBase64DataUrl(row.photoDataUrl)) return;
          let pid = inspectionPhotoMemo.get(row.photoDataUrl);
          if (!pid) {
            pid = prefix + '_' + Date.now() + '_' + rand6();
            const parts = dataUrlParts(row.photoDataUrl);
            const blob = b64ToBlob(parts.prefix, parts.b64);
            photoOps.push({ id: pid, blob, ownerId: id, ownerPart: prefix.indexOf('insf_') === 0 ? 'finding' : 'result' });
            inspectionPhotoMemo.set(row.photoDataUrl, pid);
          }
          row.photoId = pid;
          delete row.photoDataUrl;
          changed = true;
        };
        if (data.results && typeof data.results === 'object') Object.keys(data.results).forEach(k => handle(data.results[k], 'ins_' + id + '_' + k));
        if (Array.isArray(data.findings)) data.findings.forEach((f, i) => handle(f, 'insf_' + id + '_' + i));
        return changed ? JSON.stringify(data) : json;
      }
      async function flush() {
        if (st.mode !== 'v2') return true;
        if (st.flushing) { st.flushAgain = true; return st.flushing; }
        if (!st.pending.size) return true;
        const batch = Array.from(st.pending.entries());
        st.flushing = (async () => {
          const db = await openFs();
          const extraPhotoOps = [];
          const recOps = [];
          for (const [key, op] of batch) {
            if (op.t === 'rec') {
              let json = op.json;
              if (op.kind === 'inspections' && !op.env.deletedAt) json = extractInspectionPhotosForWrite(json, op.id, extraPhotoOps);
              recOps.push([key, op, json]);
            }
          }
          extraPhotoOps.forEach(p => {
            if (!st.photos.has(p.id)) {
              const meta = {
                id: p.id, type: p.blob.type || 'image/jpeg', size: p.blob.size, storedAs: 'blob', caption: '',
                ownerKind: 'inspections', ownerId: String(p.ownerId || ''), ownerPart: p.ownerPart || '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
                updatedBy: techName(), deviceId: st.deviceId, deletedAt: null, changeSource: currentSource().s, changeRef: ''
              };
              st.photos.set(p.id, Object.assign({}, meta));
              batch.push(['p|' + p.id, { t: 'photo', id: p.id, meta, payload: { id: p.id, blob: p.blob } }]);
            }
          });
          const tx = db.transaction(['records', 'photos', 'photoData', 'meta'], 'readwrite');
          const rs = tx.objectStore('records');
          const ps = tx.objectStore('photos');
          const pds = tx.objectStore('photoData');
          const ms = tx.objectStore('meta');
          try {
            for (const [, op, json] of recOps) {
              const row = Object.assign({}, op.env, { json });
              rs.put(row);
            }
            for (const [, op] of batch) {
              if (op.t === 'photo') { ps.put(op.meta); pds.put(op.payload); }
              else if (op.t === 'meta') ms.put(op.value, op.key);
              else if (op.t === 'photoPatch') {
                const g = ps.get(op.id);
                g.onsuccess = () => { if (g.result) ps.put(Object.assign(g.result, op.patch)); };
              }
            }
          } catch (e) {
            try { tx.abort(); } catch (e2) {}
            throw e;
          }
          await txDone(tx);
          // Success: drop exactly the ops we wrote (a newer op staged during
          // the write for the same key stays pending).
          for (const [key, op] of batch) if (st.pending.get(key) === op) st.pending.delete(key);
          // Owner tagging after the record writes landed.
          for (const [, op] of recOps) {
            if (!op.env.deletedAt && (op.kind === 'inspections' || op.kind === 'partsRequests')) {
              const k = st.known[op.kind].get(op.id);
              if (k && k.obj) tagOwnersFromRecord(op.kind, k.obj);
            }
          }
          if (st.pendingFailures) {
            st.pendingFailures = 0;
            window.__lxPersistDurableFailed = null;
          }
          try { if (st.bc) st.bc.postMessage({ from: st.tabId, kinds: Array.from(new Set(recOps.map(r => r[1].kind))) }); } catch (e) {}
          return true;
        })();
        try {
          return await st.flushing;
        } catch (e) {
          st.pendingFailures = st.pending.size;
          st.lastFailureAt = Date.now();
          window.__lxPersistDurableFailed = { at: Date.now(), err: String((e && e.message) || e) };
          console.warn('[storage] write failed; changes kept and will be retried', e);
          try { toast('Could not save — storage full or unavailable', 3500); } catch (e2) {}
          return false;
        } finally {
          st.flushing = null;
          if (st.flushAgain) { st.flushAgain = false; if (st.pending.size && !st.pendingFailures) flushSoon(); }
        }
      }
      function pendingCount() { return st.pendingFailures ? st.pending.size : 0; }

      // ---------- loading (v2 boot) ----------
      async function loadAllIntoMemory() {
        const db = await openFs();
        const tx = db.transaction(['records', 'photos', 'meta'], 'readonly');
        const recs = await reqP(tx.objectStore('records').getAll());
        const metaKeys = await reqP(tx.objectStore('meta').getAllKeys());
        const metaVals = await reqP(tx.objectStore('meta').getAll());
        const photoRecs = await reqP(tx.objectStore('photos').getAll()); // details only — no picture data
        metaKeys.forEach((k, i) => { st.meta[k] = metaVals[i]; });
        KINDS.forEach(k => { st.known[k] = new Map(); st.arrays[k] = []; });
        const byKind = {};
        KINDS.forEach(k => { byKind[k] = []; });
        for (const r of recs) {
          if (!r || !st.known[r.kind]) continue;
          const env = Object.assign({}, r);
          const json = env.json;
          delete env.json;
          if (env.deletedAt) {
            st.known[r.kind].set(r.id, { env, json, obj: null, deleted: true });
            continue;
          }
          const obj = JSON.parse(json);
          st.known[r.kind].set(r.id, { env, json, obj, deleted: false });
          byKind[r.kind].push({ env, obj });
        }
        KINDS.forEach(kind => {
          const order = Array.isArray(st.meta['order:' + kind]) ? st.meta['order:' + kind] : [];
          st.arrays[kind] = orderRecords(kind, byKind[kind], order).map(x => x.obj);
          st.orderCache[kind] = st.arrays[kind].map(o => String(o.id)).join('\u0001');
        });
        st.photos = new Map();
        photoRecs.forEach(p => st.photos.set(p.id, p));
      }
      // Order rule (reviewer change 6): records in this device's stored order
      // come first, in that order. Records with no stored position (e.g.
      // arriving from another phone in 16C) are placed where a NEW record of
      // that kind goes today — at the front (newest first) for jobs,
      // inspections, parts requests and the edit log; at the end (oldest
      // first) for everything else — so they always appear.
      function orderRecords(kind, rows, order) {
        if (kind === 'punchlistItems') {
          return rows.slice().sort((a, b) => {
            const pa = Number(a.env.position), pb = Number(b.env.position);
            if (pa !== pb) return (isNaN(pa) ? Infinity : pa) - (isNaN(pb) ? Infinity : pb);
            return String(a.env.createdAt).localeCompare(String(b.env.createdAt));
          });
        }
        const pos = new Map();
        order.forEach((id, i) => pos.set(String(id), i));
        const inOrder = rows.filter(r => pos.has(String(r.env.id))).sort((a, b) => pos.get(String(a.env.id)) - pos.get(String(b.env.id)));
        const rest = rows.filter(r => !pos.has(String(r.env.id)));
        const byCreated = (a, b) => String(a.env.createdAt).localeCompare(String(b.env.createdAt)) || String(a.env.id).localeCompare(String(b.env.id));
        if (FRONT_KINDS.has(kind)) {
          rest.sort((a, b) => byCreated(b, a));
          return rest.concat(inOrder);
        }
        rest.sort(byCreated);
        return inOrder.concat(rest);
      }

      // ---------- STORE facade used by the v169 code paths in v2 mode ----------
      function load(kind) {
        if (kind === 'timecards') {
          return { entries: st.arrays.timeEntries, active: st.meta['tc:active'] || null };
        }
        if (kind === 'visits') return [];
        if (kind === 'editorSettings') {
          try {
            const raw = localStorage.getItem('lx8_editor_settings');
            const p = raw ? JSON.parse(raw) : null;
            return (p && typeof p === 'object') ? p : { pin: '' };
          } catch (e) { return { pin: '' }; }
        }
        if (!st.known[kind]) throw new Error('STORE.load: unknown kind "' + kind + '"');
        return st.arrays[kind];
      }
      function save(kind, value, opts) {
        if (kind === 'timecards') {
          const v = value || {};
          saveKind('timeEntries', Array.isArray(v.entries) ? v.entries : []);
          const activeJson = JSON.stringify(v.active || null);
          if (JSON.stringify(st.meta['tc:active'] || null) !== activeJson) stageMeta('tc:active', v.active || null);
          flushSoon();
          return true;
        }
        if (kind === 'visits') return true; // the removed Visit feature is no longer written
        if (kind === 'editorSettings') {
          // Device setting: localStorage only, as before (no kv mirror any more).
          try { localStorage.setItem('lx8_editor_settings', JSON.stringify(value || { pin: '' })); return true; } catch (e) { return false; }
        }
        if (kind === 'serials' && currentSource().s !== 'restore') {
          // Unused since Phase 15A; only a backup restore writes it now.
          st.arrays.serials = Array.isArray(value) ? value : [];
          return true;
        }
        if (!st.known[kind]) throw new Error('STORE.save: unknown kind "' + kind + '"');
        return saveKind(kind, value, opts);
      }

      // ---------- punchlist (bundle in memory, records in storage) ----------
      const PHOTO_MARK = '@photo:';
      function isUniqueListKey(key) { return /^(pl|job)_[a-z0-9]{6,}/i.test(String(key)); }
      function isUniqueItemId(id) { return typeof id === 'string' && /^[a-z]{2,6}_[a-z0-9]{8,}$/i.test(id); }
      function listLabel(key) {
        const k = st.known.punchlistLists.get(String(key));
        if (k && k.env && k.env.legacyKey && !isUniqueListKey(k.env.legacyKey)) return k.env.legacyKey;
        const leg = st.plLegacy.lists[String(key)];
        if (leg && leg.legacyKey && !isUniqueListKey(leg.legacyKey)) return leg.legacyKey;
        return String(key);
      }
      function idMap() {
        if (!st.meta.idMap) st.meta.idMap = { lists: {}, items: {} };
        return st.meta.idMap;
      }
      // Re-key a punchlist bundle in the OLD shape (name-keyed lists, numbered
      // items) to unique ids. Uses (and extends) the saved old→new id map, so
      // the same old list/item always gets the same new id on this device.
      // Returns { bundle, changed, mapAdded }.
      function rekeyBundle(src, opts) {
        const map = idMap();
        let mapAdded = false;
        const out = {};
        Object.keys(src || {}).forEach(k => { if (k !== 'jobs') out[k] = src[k]; });
        const jobs = (src && src.jobs && typeof src.jobs === 'object') ? src.jobs : {};
        const keyMap = {};
        const seenItemIds = new Set();
        // ids already used by other lists in memory count as taken
        if (opts && opts.takenIds) opts.takenIds.forEach(id => seenItemIds.add(String(id)));
        out.jobs = {};
        Object.keys(jobs).forEach(oldKey => {
          let newKey = oldKey;
          if (!isUniqueListKey(oldKey)) {
            newKey = map.lists[oldKey];
            if (!newKey) { newKey = newEntityId('pl'); map.lists[oldKey] = newKey; mapAdded = true; }
            st.plLegacy.lists[newKey] = { legacyKey: oldKey, legacyHadListName: !!(src.listNames && Object.prototype.hasOwnProperty.call(src.listNames, oldKey)) };
          }
          keyMap[oldKey] = newKey;
          const items = Array.isArray(jobs[oldKey]) ? jobs[oldKey] : [];
          out.jobs[newKey] = items.map(it => {
            if (!it || typeof it !== 'object') return it;
            const oldId = it.id;
            let newId = oldId;
            const mk = oldKey + '\u0001' + String(oldId);
            if (!isUniqueItemId(oldId) || seenItemIds.has(String(oldId))) {
              newId = map.items[mk];
              if (!newId || seenItemIds.has(newId)) { newId = newEntityId('pli'); map.items[mk] = newId; mapAdded = true; }
              st.plLegacy.items[newId] = { legacyId: oldId, legacyKey: oldKey };
            }
            seenItemIds.add(String(newId));
            if (newId === oldId) return it;
            const copy = {};
            Object.keys(it).forEach(f => { copy[f] = f === 'id' ? newId : it[f]; });
            return copy;
          });
        });
        const remapKeys = (obj) => {
          if (!obj || typeof obj !== 'object') return obj;
          const o = {};
          Object.keys(obj).forEach(k => { o[keyMap[k] || k] = obj[k]; });
          return o;
        };
        if (src && src.listNames) out.listNames = remapKeys(src.listNames);
        // a list that was keyed by its name keeps that name as its display name
        Object.keys(keyMap).forEach(oldKey => {
          const nk = keyMap[oldKey];
          if (nk !== oldKey) {
            if (!out.listNames) out.listNames = {};
            if (!Object.prototype.hasOwnProperty.call(out.listNames, nk)) out.listNames[nk] = oldKey;
          }
        });
        if (src && src.jobIdByKey) out.jobIdByKey = remapKeys(src.jobIdByKey);
        if (src && src.keyByJobId) {
          out.keyByJobId = {};
          Object.keys(src.keyByJobId).forEach(j => { const v = src.keyByJobId[j]; out.keyByJobId[j] = keyMap[v] || v; });
        }
        if (src && 'currentJob' in src) out.currentJob = keyMap[src.currentJob] || src.currentJob;
        return { bundle: out, keyMap, mapAdded };
      }
      function resolveLegacyListKey(key) {
        if (key == null) return key;
        const map = idMap();
        return map.lists[String(key)] || key;
      }
      function plListData(data, key) {
        const listNames = data.listNames || {};
        const jobIdByKey = data.jobIdByKey || {};
        const keyByJobId = data.keyByJobId || {};
        const hasListName = Object.prototype.hasOwnProperty.call(listNames, key);
        const jobLinked = Object.prototype.hasOwnProperty.call(jobIdByKey, key);
        const primaryForJobs = Object.keys(keyByJobId).filter(j => keyByJobId[j] === key);
        return {
          id: key,
          name: hasListName ? listNames[key] : null,
          hasListName,
          jobLinked,
          jobId: jobLinked ? jobIdByKey[key] : null,
          primaryForJobs
        };
      }
      function plExtras(data) {
        // Anything in the bundle that doesn't belong to an existing list
        // (dangling lookup entries, unknown top-level fields). Device-local.
        const jobs = data.jobs || {};
        const ex = { listNames: {}, jobIdByKey: {}, keyByJobId: {}, top: {}, topOrder: Object.keys(data) };
        Object.keys(data.listNames || {}).forEach(k => { if (!(k in jobs)) ex.listNames[k] = data.listNames[k]; });
        Object.keys(data.jobIdByKey || {}).forEach(k => { if (!(k in jobs)) ex.jobIdByKey[k] = data.jobIdByKey[k]; });
        Object.keys(data.keyByJobId || {}).forEach(j => { if (!(data.keyByJobId[j] in jobs)) ex.keyByJobId[j] = data.keyByJobId[j]; });
        Object.keys(data).forEach(k => {
          if (['jobs', 'currentJob', 'listNames', 'jobIdByKey', 'keyByJobId'].indexOf(k) < 0) ex.top[k] = data[k];
        });
        return ex;
      }
      function savePunchlist(data, opts) {
        if (!data || typeof data !== 'object' || !data.jobs || typeof data.jobs !== 'object') return true;
        st.plLastBundle = data;
        clearTimeout(st.plSweepTimer);
        if (opts && opts.listsOnly) {
          // Opening a list only changes the lists / current list: store that
          // now and check every item a moment later (same idea as the
          // inspection keystroke hint).
          const src = currentSource();
          st.plSweepTimer = setTimeout(() => { withSourceSync(src.s, src.ref, () => savePunchlist(st.plLastBundle)); }, 1200);
        }
        const jobs = data.jobs;
        // Safety net: any old-style list key or item number that slips into
        // the in-memory bundle gets a unique id before it is stored.
        let needsRekey = false;
        const seenIds = new Set();
        Object.keys(jobs).forEach(key => {
          if (!isUniqueListKey(key)) needsRekey = true;
          (Array.isArray(jobs[key]) ? jobs[key] : []).forEach(it => {
            if (!it || typeof it !== 'object') return;
            const id = String(it.id);
            if (!isUniqueItemId(it.id) || seenIds.has(id)) needsRekey = true;
            seenIds.add(id);
          });
        });
        if (needsRekey) {
          const r = rekeyBundle(data).bundle;
          Object.keys(data).forEach(k => { delete data[k]; });
          Object.assign(data, r);
          stageMeta('idMap', idMap());
        }
        const listKnown = st.known.punchlistLists;
        const itemKnown = st.known.punchlistItems;
        const listSeen = new Set();
        const itemSeen = new Set();
        const listOrder = [];
        const items = [];
        const listsOnly = !!(opts && opts.listsOnly);
        // The empty "Default" list the punchlist screen makes when there are
        // no lists is only a placeholder (as in v169, where it was never
        // stored): it becomes a stored list once it gets an item, a new name
        // or a job link.
        const phKey = st.plPlaceholder;
        let phSkip = false;
        if (phKey) {
          phSkip = isPunchlistPlaceholder(data, phKey);
          if (!phSkip) st.plPlaceholder = null;
        }
        Object.keys(data.jobs).forEach(key => {
          if (phSkip && key === phKey) return;
          listSeen.add(key);
          listOrder.push(key);
          const ld = plListData(data, key);
          const json = JSON.stringify(ld);
          const k = listKnown.get(key);
          if (!k || k.deleted || k.json !== json) {
            const leg = st.plLegacy.lists[key];
            stageRecord('punchlistLists', key, json, ld, (!k && leg) ? { extras: { legacyKey: leg.legacyKey, legacyHadListName: leg.legacyHadListName } } : null);
          } else k.obj = ld;
          if (listsOnly) return;
          let prevPos = -Infinity;
          (Array.isArray(data.jobs[key]) ? data.jobs[key] : []).forEach(it => {
            if (!it || typeof it !== 'object') return;
            const id = String(it.id);
            if (itemSeen.has(id)) return;
            itemSeen.add(id);
            items.push(it);
            const ik = itemKnown.get(id);
            // photo: compared by reference first (a 4 MB string is never re-read unless it changed)
            let photoId = ik && !ik.deleted ? (ik.env.photoId || '') : '';
            const ph = it.photo;
            let dataForJson = it;
            let photoChanged = false;
            if (isBase64DataUrl(ph)) {
              if (!(ik && ik.photoRef === ph && photoId)) {
                if (!photoId) photoId = newEntityId('plp');
                stagePhotoPut({ id: photoId, dataUrl: ph, ownerKind: 'punchlistItems', ownerId: id, ownerPart: 'photo', createdAt: Date.now() });
                photoChanged = true;
              }
              dataForJson = Object.assign({}, it, { photo: PHOTO_MARK + photoId });
            } else if (typeof ph === 'string' && ph.indexOf(PHOTO_MARK) === 0) {
              // photo not loaded into memory yet: unchanged, keep the link
              photoId = ph.slice(PHOTO_MARK.length);
              dataForJson = it;
            } else if (photoId) {
              photoId = ''; // photo no longer on the item (explicit removal marks the photo deleted separately)
            }
            let pos = ik && !ik.deleted && typeof ik.env.position === 'number' ? ik.env.position : null;
            if (pos == null || pos <= prevPos) pos = (prevPos === -Infinity ? 0 : Math.floor(prevPos) + 1);
            prevPos = pos;
            const json2 = JSON.stringify(dataForJson);
            const envChanged = !ik || ik.deleted || ik.env.listId !== key || ik.env.position !== pos || (ik.env.photoId || '') !== photoId;
            if (envChanged || ik.json !== json2) {
              const leg = st.plLegacy.items[id];
              const extras = { listId: key, position: pos, photoId: photoId || undefined };
              if (!ik && leg) { extras.legacyId = leg.legacyId; extras.legacyKey = leg.legacyKey; }
              if (!photoId) extras.photoId = undefined;
              stageRecord('punchlistItems', id, json2, it, { extras });
              const nk = itemKnown.get(id);
              if (!photoId) delete nk.env.photoId;
            } else {
              ik.obj = it;
            }
            const cur = itemKnown.get(id);
            cur.photoRef = isBase64DataUrl(ph) ? ph : null;
            if (photoChanged) {/* photo record staged above */}
          });
        });
        let delLists = 0, delItems = 0;
        if (!listsOnly) {
        listKnown.forEach((k, id) => { if (!k.deleted && !listSeen.has(id)) { if (stageDelete('punchlistLists', id)) delLists++; } });
        itemKnown.forEach((k, id) => { if (!k.deleted && !itemSeen.has(id)) { if (stageDelete('punchlistItems', id)) delItems++; } });
        if (delLists + delItems > 1) st.stats.multiDeletes.push({ kind: 'punchlist', n: delLists + delItems, lists: delLists, items: delItems, source: currentSource().s, ref: currentSource().ref, at: new Date().toISOString() });
        }
        st.arrays.punchlistLists = listOrder.map(k => listKnown.get(k).obj);
        if (!listsOnly) st.arrays.punchlistItems = items;
        const order = listOrder.join('\u0001');
        if (st.orderCache.punchlistLists !== order) { st.orderCache.punchlistLists = order; stageMeta('order:punchlistLists', listOrder); }
        const cj = (data.currentJob == null || (phSkip && data.currentJob === phKey)) ? '' : data.currentJob;
        if (st.meta['pl:currentJob'] !== cj) stageMeta('pl:currentJob', cj);
        const ex = plExtras(data);
        if (JSON.stringify(st.meta['pl:extras'] || null) !== JSON.stringify(ex)) stageMeta('pl:extras', ex);
        if (!st.meta['pl:initialized']) stageMeta('pl:initialized', true);
        flushSoon();
        return true;
      }
      function markPunchlistPlaceholder(key) { st.plPlaceholder = key || null; }
      // True while `key` is still the untouched placeholder: no items, still
      // named "Default", no job link, never stored.
      function isPunchlistPlaceholder(data, key) {
        if (!key || key !== st.plPlaceholder || !data || !data.jobs) return false;
        const kbj = data.keyByJobId || {};
        return Object.prototype.hasOwnProperty.call(data.jobs, key) &&
          Array.isArray(data.jobs[key]) && data.jobs[key].length === 0 &&
          (data.listNames || {})[key] === 'Default' &&
          !Object.prototype.hasOwnProperty.call(data.jobIdByKey || {}, key) &&
          !Object.keys(kbj).some(j => kbj[j] === key) &&
          !(st.known.punchlistLists.get(key) && !st.known.punchlistLists.get(key).deleted);
      }
      async function loadPunchlistBundle() {
        const ex = st.meta['pl:extras'] || { listNames: {}, jobIdByKey: {}, keyByJobId: {}, top: {}, topOrder: [] };
        const lists = st.arrays.punchlistLists;
        const data = {};
        const order = (ex.topOrder && ex.topOrder.length) ? ex.topOrder : ['currentJob', 'jobs'];
        order.forEach(k => {
          if (k === 'currentJob') data.currentJob = st.meta['pl:currentJob'] || '';
          else if (k === 'jobs') data.jobs = {};
          else if (k === 'listNames') data.listNames = {};
          else if (k === 'jobIdByKey') data.jobIdByKey = {};
          else if (k === 'keyByJobId') data.keyByJobId = {};
          else if (k in (ex.top || {})) data[k] = ex.top[k];
        });
        if (!('currentJob' in data)) data.currentJob = st.meta['pl:currentJob'] || '';
        if (!data.jobs) data.jobs = {};
        const byList = {};
        st.arrays.punchlistItems.forEach(it => {
          const k = st.known.punchlistItems.get(String(it.id));
          const lid = k ? k.env.listId : '';
          (byList[lid] = byList[lid] || []).push(it);
        });
        lists.forEach(ld => {
          const key = ld.id;
          data.jobs[key] = byList[key] || [];
          if (ld.hasListName) { if (!data.listNames) data.listNames = {}; data.listNames[key] = ld.name; }
          if (ld.jobLinked) { if (!data.jobIdByKey) data.jobIdByKey = {}; data.jobIdByKey[key] = ld.jobId; }
          (ld.primaryForJobs || []).forEach(j => { if (!data.keyByJobId) data.keyByJobId = {}; data.keyByJobId[j] = key; });
        });
        ['listNames', 'jobIdByKey', 'keyByJobId'].forEach(m => {
          const extra = ex[m] || {};
          if (Object.keys(extra).length) { if (!data[m]) data[m] = {}; Object.assign(data[m], extra); }
        });
        // Photos: every item photo is put back as the exact text it was.
        const need = [];
        st.arrays.punchlistItems.forEach(it => {
          if (typeof it.photo === 'string' && it.photo.indexOf(PHOTO_MARK) === 0) need.push(it);
        });
        const marks = need.map(it => it.photo);
        if (need.length) {
          const db = await openFs();
          for (let i = 0; i < need.length; i += 8) {
            const chunk = need.slice(i, i + 8);
            const chunkMarks = marks.slice(i, i + 8);
            const store = db.transaction('photoData', 'readonly').objectStore('photoData');
            const rows = await Promise.all(chunk.map((it, j) => {
              const pid = chunkMarks[j].slice(PHOTO_MARK.length);
              const pend = st.pending.get('p|' + pid);
              return (pend && pend.t === 'photo') ? pend.payload : reqP(store.get(pid));
            }));
            for (let j = 0; j < chunk.length; j++) {
              const it = chunk[j], row = rows[j], mark = chunkMarks[j];
              // Only fill in a placeholder that is still the placeholder (another
              // load, or an edit, may already have put the photo back).
              if (it.photo !== mark) continue;
              let full = null;
              if (row && typeof row.dataUrl === 'string') full = row.dataUrl;
              else if (row && row.blob) {
                const m = st.photos.get(mark.slice(PHOTO_MARK.length)) || {};
                full = 'data:' + (m.type || 'image/jpeg') + ';base64,' + await blobToB64(row.blob);
              }
              if (full && it.photo === mark) {
                it.photo = full;
                const k = st.known.punchlistItems.get(String(it.id));
                if (k) k.photoRef = full;
              } else if (!full) {
                // Picture data missing: the item keeps its photo reference
                // (nothing is ever dropped); counted for diagnostics.
                st.missingPhotoPayloads = (st.missingPhotoPayloads || 0) + 1;
                console.warn('[storage] punchlist photo data missing', it.id, mark);
              }
            }
          }
        }
        return data;
      }
      function itemPhotoId(itemId) {
        const k = st.known.punchlistItems.get(String(itemId));
        return (k && !k.deleted && k.env.photoId) || '';
      }
      function inlinePunchlistPhotoIds() {
        const out = new Set();
        st.known.punchlistItems.forEach(k => { if (!k.deleted && k.env.photoId && k.obj && (isBase64DataUrl(k.obj.photo) || (typeof k.obj.photo === 'string' && k.obj.photo.indexOf(PHOTO_MARK) === 0))) out.add(k.env.photoId); });
        return out;
      }

      // ---------- edit log / parts-link re-keying ----------
      function rekeyEditLogEntries(entries, report) {
        // Re-key punchlist references inside pre-upgrade editor entries so
        // Undo keeps working. Anything that can't be mapped is marked
        // "Can't undo — made before the storage upgrade".
        const map = idMap();
        const liveItems = st.known.punchlistItems;
        return (entries || []).map(e => {
          if (!e || typeof e !== 'object') return e;
          let touched = false, blocked = false;
          const mapRow = (row) => {
            if (!row || typeof row !== 'object' || row.listKey == null) return row;
            const oldKey = row.listKey;
            const newKey = isUniqueListKey(oldKey) ? oldKey : map.lists[oldKey];
            const mk = oldKey + '\u0001' + String(row.id);
            const newId = isUniqueItemId(row.id) ? row.id : map.items[mk];
            if (!newKey || !newId) { blocked = true; return row; }
            if (newKey === oldKey && newId === row.id) return row;
            touched = true;
            const r2 = Object.assign({}, row, { listKey: newKey, id: newId });
            if (row.rec && typeof row.rec === 'object') {
              const rec = {};
              Object.keys(row.rec).forEach(f => { rec[f] = f === 'id' ? newId : row.rec[f]; });
              r2.rec = rec;
            }
            return r2;
          };
          const out = Object.assign({}, e);
          ['before', 'after'].forEach(side => {
            if (out[side] && Array.isArray(out[side].punchlistItems)) {
              out[side] = Object.assign({}, out[side], { punchlistItems: out[side].punchlistItems.map(mapRow) });
            }
          });
          if (out.affectedIds && Array.isArray(out.affectedIds.punchlistItems)) {
            out.affectedIds = Object.assign({}, out.affectedIds, { punchlistItems: out.affectedIds.punchlistItems.map(mapRow) });
          }
          if (blocked) {
            // Can't be fully re-keyed: keep the entry exactly as it was and mark
            // it (an entry that was already undone needs nothing).
            if (e.undone) return e;
            if (report) report.blocked++;
            return Object.assign({}, e, { preUpgradeNoUndo: true });
          }
          if (report && touched) report.rekeyed++;
          return touched ? out : e;
        });
      }
      function rekeyPartsSources(requests, oldBundle, report) {
        // Parts lines made from a punchlist item store that item's id. Old ids
        // repeat across lists, so the match goes through the request's job.
        const map = idMap();
        const jobIdByKey = (oldBundle && oldBundle.jobIdByKey) || {};
        const jobs = (oldBundle && oldBundle.jobs) || {};
        return (requests || []).map(req => {
          if (!req || typeof req !== 'object' || !Array.isArray(req.parts)) return req;
          let changed = false;
          const parts = req.parts.map(p => {
            if (!p || !p.source || p.source.type !== 'punchlist') return p;
            const oldId = p.source.id;
            if (isUniqueItemId(oldId)) return p;
            const cands = [];
            Object.keys(jobs).forEach(k => {
              if (jobIdByKey[k] && jobIdByKey[k] === req.jobId && (jobs[k] || []).some(it => it && String(it.id) === String(oldId))) cands.push(k);
            });
            if (cands.length === 1 && map.items[cands[0] + '\u0001' + String(oldId)]) {
              changed = true;
              if (report) report.rekeyed++;
              return Object.assign({}, p, { source: Object.assign({}, p.source, { id: map.items[cands[0] + '\u0001' + String(oldId)] }) });
            }
            if (report) report.unmatched.push({ request: req.id, line: p.id, oldItemId: oldId, candidates: cands.length });
            return p;
          });
          return changed ? Object.assign({}, req, { parts }) : req;
        });
      }

      // ---------- settings / diagnostics ----------
      function counts() {
        const c = {};
        let deleted = 0;
        KINDS.forEach(k => {
          let live = 0;
          st.known[k].forEach(r => { if (r.deleted) deleted++; else live++; });
          c[k] = live;
        });
        let photos = 0, unowned = 0, photosDeleted = 0;
        st.photos.forEach(p => {
          if (p.deletedAt) { photosDeleted++; return; }
          photos++;
          if (!p.ownerKind) unowned++;
        });
        c.photos = photos; c.unownedPhotos = unowned; c.deleted = deleted + photosDeleted;
        return c;
      }
      function settingsText() {
        if (st.mode === 'legacy') {
          return { line: 'Storage v1', warn: st.upgradeFailed ? 'Storage upgrade didn\'t finish — your data is safe; please contact your manager' : '' };
        }
        if (st.mode !== 'v2') return { line: '', warn: '' };
        const c = counts();
        const pl = (n, w, ws) => n + ' ' + (n === 1 ? w : (ws || (w + 's')));
        const bits = ['Storage v2',
          pl(c.jobs, 'job'), pl(c.inspections, 'inspection'),
          pl(c.punchlistLists, 'punchlist') + ' (' + pl(c.punchlistItems, 'item') + ')',
          pl(c.partsRequests, 'parts request'), pl(c.timeEntries, 'time entry', 'time entries'),
          pl(c.photos, 'stored photo') + (c.unownedPhotos ? ' (' + c.unownedPhotos + ' not linked to a record)' : '')];
        bits.push(c.deleted + ' deleted (kept for sync)');
        const n = pendingCount();
        if (n) bits.push(pl(n, 'change') + ' not saved');
        return {
          line: bits.join(' · '),
          warn: st.rollbackWarning ? 'Data was entered in an older version after the storage upgrade — contact your manager' : ''
        };
      }

      return {
        st, KINDS, FRONT_KINDS, LEGACY_LS_DATA_KEYS, LEGACY_KV_DATA_KEYS, PHOTO_MARK,
        ready, isV2, oldStorageClosed, MARKER_KEY, markerRead, markerWrite, iso, rand6, uuid, hash, syncFp, techName, isBase64DataUrl, dataUrlParts, b64ToBlob, blobToB64,
        withSource, withSourceSync, currentSource, pushSource, popSource,
        openFs, metaGet, metaPut, reqP, txDone,
        saveKind, sweepAllNow, flush, flushSoon, pendingCount,
        load, save, loadAllIntoMemory, orderRecords,
        stagePhotoPut, stagePhotoPatch, deletePhotosExplicit, getPhoto, getAllLivePhotos, tagPhotoOwner, photoUnchanged,
        savePunchlist, loadPunchlistBundle, markPunchlistPlaceholder, isPunchlistPlaceholder, rekeyBundle, resolveLegacyListKey, listLabel, itemPhotoId,
        inlinePunchlistPhotoIds, isUniqueListKey, isUniqueItemId, idMap,
        rekeyEditLogEntries, rekeyPartsSources, counts, settingsText, stageMeta, stageRecord, inspectionStoredCopy, storedJson
      };
    })();
    window.__LXS = LXS;

    // v2 STORE dispatch: same per-kind semantics the v169 cases above had
    // (memory first for the lists that keep a storeMem copy), but backed by
    // the new storage.
    const LXS_MEM_KEY = { jobs: 'jobs', customers: 'customers', sites: 'sites', serials: 'serials', machines: 'machines', partsRequests: 'partsRequests', editLog: 'editLog' };
    // Upgraded phone whose new storage can't be opened: nothing is read
    // from the old storage; empty values only (the app is behind the
    // blocking screen and does not start).
    function lxsClosedLoad(kind) {
      if (kind === 'punchlist') return Promise.resolve(null);
      if (kind === 'timecards') return null;
      if (kind === 'editorSettings') return { pin: '' };
      return [];
    }
    function lxsStoreLoad(kind, opts) {
      if (LXS_MEM_KEY[kind]) {
        const mem = Array.isArray(storeMem[LXS_MEM_KEY[kind]]) ? storeMem[LXS_MEM_KEY[kind]] : [];
        return mem.length ? mem : LXS.load(kind);
      }
      if (kind === 'punchlist') return LXS.loadPunchlistBundle();
      return LXS.load(kind);
    }
    function lxsStoreSave(kind, value, opts) {
      if (kind === 'punchlist') { LXS.savePunchlist(value); return Promise.resolve(true); }
      if (kind === 'editLog') {
        storeMem.editLog = Array.isArray(value) ? value : [];
        return LXS.save('editLog', storeMem.editLog);
      }
      return LXS.save(kind, value, opts);
    }

    // ---------- STORAGE v2: one-time upgrade, boot, rollback check ----------
    // Old-storage readers. They only ever READ: v169's own open functions are
    // used so a device that somehow lacks an old database ends up exactly as
    // v169 itself would have left it (same names, versions, stores).
    function lxsOpenFieldPunchlistDb() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('FieldPunchlistDB', 1);
        req.onupgradeneeded = (e) => {
          const database = e.target.result;
          if (!database.objectStoreNames.contains('appdata')) database.createObjectStore('appdata');
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
      });
    }
    function lxsLsRaw(key) {
      try { return localStorage.getItem(key); } catch (e) { return null; }
    }
    function lxsLsParse(key) {
      // { present, ok, value } — distinguishes "key missing" from "unreadable"
      const raw = lxsLsRaw(key);
      if (raw == null) return { present: false, ok: false, value: undefined };
      try { return { present: true, ok: true, value: JSON.parse(raw) }; } catch (e) { return { present: true, ok: false, value: undefined }; }
    }
    function lxsLegacyGetKv(key) {
      return idbOpen().then(db => new Promise((resolve, reject) => {
        const req = db.transaction('kv', 'readonly').objectStore('kv').get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }));
    }
    function lxsLegacyPhotoIds() {
      return idbOpen().then(db => new Promise((resolve, reject) => {
        const req = db.transaction('photos', 'readonly').objectStore('photos').getAllKeys();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      })).catch(() => []);
    }
    function lxsLegacyPhoto(id) {
      return idbOpen().then(db => new Promise((resolve, reject) => {
        const req = db.transaction('photos', 'readonly').objectStore('photos').get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      }));
    }
    // Reads every kind the way v169 shows it (plan section C2).
    async function lxsReadOldSources(report) {
      const out = {};
      const lsOrKv = async (kind, lsKey, kvKey) => {
        const ls = lxsLsParse(lsKey);
        if (ls.present && ls.ok && Array.isArray(ls.value)) { report.sources[kind] = 'localStorage ' + lsKey; return ls.value; }
        if (ls.present && ls.ok && ls.value == null) { report.sources[kind] = 'localStorage ' + lsKey + ' (empty)'; return []; }
        const kv = await lxsLegacyGetKv(kvKey).catch(() => undefined);
        if (Array.isArray(kv)) { report.sources[kind] = 'IndexedDB kv ' + kvKey + (ls.present ? ' (localStorage unreadable)' : ' (localStorage missing)'); return kv; }
        report.sources[kind] = 'none';
        return [];
      };
      out.jobs = await lsOrKv('jobs', 'lx8_jobs', 'jobs');
      out.customers = await lsOrKv('customers', 'lx8_customers', 'customers');
      out.sites = await lsOrKv('sites', 'lx8_sites', 'sites');
      out.serials = await lsOrKv('serials', 'lx8_serials', 'serials');
      out.machines = await lsOrKv('machines', 'lx8_machines', 'machines');
      out.partsRequests = await lsOrKv('partsRequests', 'lx8_parts_requests', 'parts_requests');
      out.editLog = await lsOrKv('editLog', 'lx8_edit_log', 'edit_log');
      // Inspections: kv first when it isn't empty (exactly v169's bootStorage rule).
      const kvIns = await lxsLegacyGetKv('inspections').catch(() => null);
      if (Array.isArray(kvIns) && kvIns.length) { out.inspections = kvIns; report.sources.inspections = 'IndexedDB kv inspections'; }
      else {
        const ls = lxsLsParse('lx8_inspections');
        out.inspections = (ls.ok && Array.isArray(ls.value)) ? ls.value : [];
        report.sources.inspections = ls.present ? 'localStorage lx8_inspections' : 'none';
      }
      const tc = lxsLsParse('lx8_timecards');
      out.timecards = (tc.ok && tc.value && typeof tc.value === 'object') ? tc.value : null;
      report.sources.timeEntries = tc.present ? 'localStorage lx8_timecards' : 'none';
      // Punchlists: exactly plLoadData()'s order of preference.
      let pl = null;
      const kvPl = await lxsLegacyGetKv('punchlist_main').catch(() => null);
      if (kvPl && kvPl.jobs && kvPl.currentJob) { pl = kvPl; report.sources.punchlist = 'IndexedDB kv punchlist_main'; }
      if (!pl) {
        try {
          const fdb = await lxsOpenFieldPunchlistDb();
          const old = await new Promise((resolve, reject) => {
            const req = fdb.transaction('appdata', 'readonly').objectStore('appdata').get('main');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          try { fdb.close(); } catch (e) {}
          if (old && old.jobs && old.currentJob) { pl = old; report.sources.punchlist = 'FieldPunchlistDB main (old database)'; }
        } catch (e) {}
      }
      if (!pl && kvPl && kvPl.jobs && typeof kvPl.jobs === 'object') { pl = kvPl; report.sources.punchlist = 'IndexedDB kv punchlist_main (no current list)'; }
      if (!pl) {
        const legacy = lxsLsParse('field_punchlist_v3');
        if (legacy.ok && legacy.value && legacy.value.jobs) { pl = legacy.value; report.sources.punchlist = 'localStorage field_punchlist_v3'; }
      }
      if (!pl) report.sources.punchlist = 'none';
      out.punchlist = pl;
      out.photoIds = await lxsLegacyPhotoIds();
      report.sources.photos = 'IndexedDB lematic-lx8 photos (' + out.photoIds.length + ')';
      return out;
    }
    function lxsCreatedAtFor(kind, rec) {
      // { iso, from }
      const tryIso = (v) => { if (v == null || v === '') return null; const d = new Date(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v + 'T00:00:00' : v); return isNaN(d.getTime()) ? null : d.toISOString(); };
      if (kind === 'timeEntries') { const v = tryIso(rec && rec.clockIn); if (v) return { iso: v, from: 'clockIn' }; }
      if (kind === 'editLog') { const v = tryIso(rec && rec.at); if (v) return { iso: v, from: 'at' }; }
      const c = rec && rec.createdAt;
      if (typeof c === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c)) { const v = tryIso(c); if (v) return { iso: v, from: 'date-only' }; }
      const v = tryIso(c);
      if (v) return { iso: v, from: 'record' };
      return { iso: null, from: 'upgrade' };
    }
    // Old-storage fingerprint (reviewer change 2). Photo text is summarised by
    // length + both ends so a 42 MB bundle is hashed in milliseconds.
    async function lxsOldFingerprint() {
      const h = LXS.hash;
      const parts = {};
      parts.ls = h(LXS.LEGACY_LS_DATA_KEYS.map(k => k + '=' + (lxsLsRaw(k) || '')).join('\u0001'));
      const summarise = (v) => JSON.stringify(v, (k, x) => (typeof x === 'string' && x.length > 4096) ? ('#' + x.length + ':' + x.slice(0, 96) + x.slice(-96)) : x);
      const kvPl = await lxsLegacyGetKv('punchlist_main').catch(() => null);
      // "which list is open" is a device setting, not data: switching lists
      // in the older version must not count as entering data
      const kvPlData = (kvPl && typeof kvPl === 'object') ? Object.assign({}, kvPl, { currentJob: undefined }) : kvPl;
      parts.kvPunchlist = h(summarise(kvPlData == null ? null : kvPlData));
      const kvIns = await lxsLegacyGetKv('inspections').catch(() => null);
      parts.kvInspections = h(summarise(kvIns == null ? null : kvIns));
      const ids = (await lxsLegacyPhotoIds()).map(String).sort();
      parts.photoIds = h(ids.join('\u0001'));
      return parts;
    }

    async function lxsRunUpgrade() {
      const t0 = performance.now();
      const report = {
        startedAt: new Date().toISOString(), sources: {}, counts: {}, skipped: [], duplicates: [],
        punchlist: { lists: 0, items: 0, photos: 0, rekeyedLists: [], rekeyedItems: 0, nonDataUrlPhotos: 0 },
        partsLinks: { rekeyed: 0, unmatched: [] }, editLog: { rekeyed: 0, blocked: 0 },
        photos: { copied: 0, unowned: 0 }, createdAtFrom: {}, lastPunchlist: null, ms: 0, verified: false
      };
      LXS.st.upgradeReport = report;
      const db = await LXS.openFs();
      const deviceId = LXS.st.deviceId;
      const who = LXS.techName();
      const old = await lxsReadOldSources(report);

      // Space check: the copy needs roughly as much room again as is used now.
      try {
        if (navigator.storage && navigator.storage.estimate) {
          const est = await navigator.storage.estimate();
          if (est && est.quota && est.usage != null && (est.quota - est.usage) < est.usage * 1.05) {
            const e = new Error('not-enough-space'); e.name = 'QuotaExceededError'; throw e;
          }
        }
      } catch (e) { if (e && e.message === 'not-enough-space') throw e; }

      // Old→new id map: saved BEFORE anything is copied so a rerun reuses it.
      const savedMap = await LXS.metaGet('idMap');
      LXS.st.meta.idMap = savedMap && savedMap.lists ? savedMap : { lists: {}, items: {} };
      // The first attempt's start time is reused by any re-run, so records
      // with no date of their own get the same createdAt every time.
      let firstStart = await LXS.metaGet('upgradeFirstStartedAt');
      if (!firstStart) { firstStart = report.startedAt; await LXS.metaPut('upgradeFirstStartedAt', firstStart); }
      let rk = null;
      if (old.punchlist) {
        rk = LXS.rekeyBundle(old.punchlist);
      }
      await LXS.metaPut('idMap', LXS.idMap());

      // Start from a clean new copy each attempt (meta — id map, device id — is kept).
      {
        const tx = db.transaction(['records', 'photos', 'photoData'], 'readwrite');
        tx.objectStore('records').clear();
        tx.objectStore('photos').clear();
        tx.objectStore('photoData').clear();
        await LXS.txDone(tx);
      }

      // References that point at re-keyed punchlist items/lists.
      const partsReport = report.partsLinks;
      const partsRequests = LXS.rekeyPartsSources(old.partsRequests, old.punchlist, partsReport);
      // Edit log needs the item map → computed after rekeyBundle above.
      const editLog = LXS.rekeyEditLogEntries(old.editLog, report.editLog);

      const nowIso = firstStart;
      const envFor = (kind, id, rec, extras) => {
        const c = lxsCreatedAtFor(kind, rec);
        report.createdAtFrom[c.from] = (report.createdAtFrom[c.from] || 0) + 1;
        const createdAt = c.iso || nowIso;
        let updatedAt = createdAt;
        if (rec && typeof rec.updatedAt === 'string') { const d = new Date(rec.updatedAt); if (!isNaN(d.getTime())) updatedAt = d.toISOString(); }
        const env = { kind, id, createdAt, updatedAt, updatedBy: who, deviceId, deletedAt: null, changeSource: 'upgrade', changeRef: '', createdAtFrom: c.from };
        if (kind === 'jobs' && id === 'job_sample_demo') env.sample = true;
        if (kind === 'inspections' && id === 'ins_example_orangeburg') env.sample = true;
        if (kind === 'timeEntries' && String(id).indexOf('tc_sample_') === 0) env.sample = true;
        if (extras) Object.assign(env, extras);
        return env;
      };
      // Prepare simple kinds: null/empty entries skipped; duplicate ids get a new id.
      const plan = {}; // kind -> [{ id, json, rec, sourceIndex, renamedFrom }]
      const simple = {
        jobs: old.jobs, inspections: old.inspections, partsRequests, customers: old.customers, sites: old.sites,
        machines: old.machines, serials: old.serials, editLog,
        timeEntries: (old.timecards && Array.isArray(old.timecards.entries)) ? old.timecards.entries : []
      };
      Object.keys(simple).forEach(kind => {
        const rows = [];
        const seen = new Set();
        (Array.isArray(simple[kind]) ? simple[kind] : []).forEach((rec, i) => {
          if (!rec || typeof rec !== 'object') { report.skipped.push({ kind, index: i, why: 'empty entry' }); return; }
          if (rec.id == null || rec.id === '') { report.skipped.push({ kind, index: i, why: 'no id' }); return; }
          let id = String(rec.id);
          let renamedFrom = null;
          let r = rec;
          if (seen.has(id)) {
            renamedFrom = id;
            const prefix = (id.match(/^([a-z]+)_/i) || [])[1] || kind.slice(0, 3);
            id = newEntityId(prefix);
            r = Object.assign({}, rec, { id });
            report.duplicates.push({ kind, oldId: renamedFrom, newId: id });
          }
          seen.add(id);
          const json = kind === 'inspections' ? LXS.storedJson('inspections', r) : JSON.stringify(r);
          rows.push({ id, json, rec: r, sourceIndex: i, renamedFrom });
        });
        plan[kind] = rows;
      });
      // Write simple kinds in batches.
      for (const kind of Object.keys(plan)) {
        const rows = plan[kind];
        for (let i = 0; i < rows.length; i += 200) {
          const tx = db.transaction('records', 'readwrite');
          const s = tx.objectStore('records');
          rows.slice(i, i + 200).forEach(row => s.put(Object.assign(envFor(kind, row.id, row.rec), { json: row.json })));
          await LXS.txDone(tx);
        }
        const meta = db.transaction('meta', 'readwrite');
        meta.objectStore('meta').put(rows.map(r => r.id), 'order:' + kind);
        await LXS.txDone(meta);
        report.counts[kind] = rows.length;
      }
      await LXS.metaPut('tc:active', (old.timecards && old.timecards.active) || null);

      // Photo owners from references in the data being copied.
      const owners = new Map();
      plan.inspections.forEach(row => {
        const ins = row.rec;
        if (ins.results && typeof ins.results === 'object') Object.keys(ins.results).forEach(k => {
          const r = ins.results[k]; if (r && r.photoId && !owners.has(r.photoId)) owners.set(r.photoId, { ownerKind: 'inspections', ownerId: row.id, ownerPart: 'result:' + k });
        });
        (Array.isArray(ins.findings) ? ins.findings : []).forEach((f, i) => {
          if (f && f.photoId && !owners.has(f.photoId)) owners.set(f.photoId, { ownerKind: 'inspections', ownerId: row.id, ownerPart: 'finding:' + i });
        });
      });
      plan.partsRequests.forEach(row => {
        (Array.isArray(row.rec.parts) ? row.rec.parts : []).forEach(p => {
          if (p && p.photoId && !owners.has(p.photoId)) owners.set(p.photoId, { ownerKind: 'partsRequests', ownerId: row.id, ownerPart: 'line:' + (p.id || '') });
        });
      });
      // Existing photos: one at a time (bytes copied as-is).
      for (const pid of old.photoIds) {
        const rec = await lxsLegacyPhoto(pid);
        if (!rec) continue;
        const o = owners.get(pid) || { ownerKind: '', ownerId: '', ownerPart: '' };
        if (!o.ownerKind) report.photos.unowned++;
        const blob = rec.blob instanceof Blob ? rec.blob : new Blob([rec.blob || ''], { type: 'image/jpeg' });
        const row = {
          id: String(rec.id), type: blob.type || 'image/jpeg', size: blob.size, storedAs: 'blob', caption: rec.caption || '',
          ownerKind: o.ownerKind, ownerId: o.ownerId, ownerPart: o.ownerPart,
          createdAt: LXS.iso(rec.createdAt), updatedAt: LXS.iso(rec.createdAt), updatedBy: who, deviceId,
          deletedAt: null, changeSource: 'upgrade', changeRef: ''
        };
        const tx = db.transaction(['photos', 'photoData'], 'readwrite');
        tx.objectStore('photos').put(row);
        tx.objectStore('photoData').put({ id: row.id, blob });
        await LXS.txDone(tx);
        report.photos.copied++;
      }

      // Punchlists: one list and one photo at a time.
      if (rk) {
        const src = old.punchlist;
        const nb = rk.bundle;
        const oldKeys = Object.keys(src.jobs || {});
        const listOrder = [];
        for (const oldKey of oldKeys) {
          const newKey = rk.keyMap[oldKey];
          listOrder.push(newKey);
          const ld = (function () {
            const listNames = nb.listNames || {}, jobIdByKey = nb.jobIdByKey || {}, keyByJobId = nb.keyByJobId || {};
            const hasListName = Object.prototype.hasOwnProperty.call(listNames, newKey);
            const jobLinked = Object.prototype.hasOwnProperty.call(jobIdByKey, newKey);
            return { id: newKey, name: hasListName ? listNames[newKey] : null, hasListName, jobLinked, jobId: jobLinked ? jobIdByKey[newKey] : null,
              primaryForJobs: Object.keys(keyByJobId).filter(j => keyByJobId[j] === newKey) };
          })();
          const lextras = {};
          if (newKey !== oldKey) {
            lextras.legacyKey = oldKey;
            lextras.legacyHadListName = !!(src.listNames && Object.prototype.hasOwnProperty.call(src.listNames, oldKey));
            report.punchlist.rekeyedLists.push(oldKey);
          }
          {
            const tx = db.transaction('records', 'readwrite');
            tx.objectStore('records').put(Object.assign(envFor('punchlistLists', newKey, {}, lextras), { json: JSON.stringify(ld) }));
            await LXS.txDone(tx);
          }
          report.punchlist.lists++;
          const items = Array.isArray(nb.jobs[newKey]) ? nb.jobs[newKey] : [];
          const oldItems = Array.isArray(src.jobs[oldKey]) ? src.jobs[oldKey] : [];
          let pos = 0;
          for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (!it || typeof it !== 'object') { report.skipped.push({ kind: 'punchlistItems', list: oldKey, index: i, why: 'empty entry' }); continue; }
            const oldIt = oldItems[i];
            const extras = { listId: newKey, position: pos++ };
            if (oldIt && oldIt.id !== it.id) { extras.legacyId = oldIt.id; extras.legacyKey = oldKey; report.punchlist.rekeyedItems++; }
            let dataForJson = it;
            if (LXS.isBase64DataUrl(it.photo)) {
              // The photo moves to the photo store as the exact text it was.
              const pid = (LXS.idMap().photos && LXS.idMap().photos[String(it.id)]) || newEntityId('plp');
              if (!LXS.idMap().photos) LXS.idMap().photos = {};
              LXS.idMap().photos[String(it.id)] = pid;
              const b64len = it.photo.length - it.photo.indexOf(',') - 1;
              const pad = it.photo.endsWith('==') ? 2 : (it.photo.endsWith('=') ? 1 : 0);
              const prow = {
                id: pid, type: ((it.photo.match(/^data:([^;,]+)/) || [])[1]) || 'image/jpeg', size: Math.floor(b64len * 3 / 4) - pad, storedAs: 'dataUrl', caption: '',
                ownerKind: 'punchlistItems', ownerId: String(it.id), ownerPart: 'photo',
                createdAt: (lxsCreatedAtFor('punchlistItems', it).iso || nowIso), updatedAt: nowIso, updatedBy: who, deviceId,
                deletedAt: null, changeSource: 'upgrade', changeRef: ''
              };
              const tx = db.transaction(['photos', 'photoData'], 'readwrite');
              tx.objectStore('photos').put(prow);
              tx.objectStore('photoData').put({ id: pid, dataUrl: it.photo });
              await LXS.txDone(tx);
              extras.photoId = pid;
              dataForJson = Object.assign({}, it, { photo: LXS.PHOTO_MARK + pid });
              report.punchlist.photos++;
            } else if (typeof it.photo === 'string' && it.photo) {
              report.punchlist.nonDataUrlPhotos++;
            }
            const tx = db.transaction('records', 'readwrite');
            tx.objectStore('records').put(Object.assign(envFor('punchlistItems', String(it.id), it, extras), { json: JSON.stringify(dataForJson) }));
            await LXS.txDone(tx);
            report.punchlist.items++;
          }
        }
        const tx = db.transaction('meta', 'readwrite');
        const ms = tx.objectStore('meta');
        ms.put(listOrder, 'order:punchlistLists');
        ms.put(nb.currentJob == null ? '' : nb.currentJob, 'pl:currentJob');
        // dangling lookup entries / unknown top-level fields, so nothing is lost
        const jobsNew = nb.jobs || {};
        const ex = { listNames: {}, jobIdByKey: {}, keyByJobId: {}, top: {}, topOrder: Object.keys(src) };
        Object.keys(nb.listNames || {}).forEach(k => { if (!(k in jobsNew)) ex.listNames[k] = nb.listNames[k]; });
        Object.keys(nb.jobIdByKey || {}).forEach(k => { if (!(k in jobsNew)) ex.jobIdByKey[k] = nb.jobIdByKey[k]; });
        Object.keys(nb.keyByJobId || {}).forEach(j => { if (!(nb.keyByJobId[j] in jobsNew)) ex.keyByJobId[j] = nb.keyByJobId[j]; });
        Object.keys(src).forEach(k => { if (['jobs', 'currentJob', 'listNames', 'jobIdByKey', 'keyByJobId'].indexOf(k) < 0) ex.top[k] = src[k]; });
        ms.put(ex, 'pl:extras');
        ms.put(true, 'pl:initialized');
        ms.put(LXS.idMap(), 'idMap');
        await LXS.txDone(tx);
      }

      // ---------------- verification ----------------
      const vfail = (msg) => { const e = new Error('verify: ' + msg); e.verify = true; throw e; };
      const readKind = async (kind) => {
        const tx = db.transaction('records', 'readonly');
        const rows = await LXS.reqP(tx.objectStore('records').index('kind').getAll(kind));
        const m = new Map();
        rows.forEach(r => m.set(r.id, r));
        return m;
      };
      // inverse transforms for re-keyed references
      const invItem = {};
      Object.keys(LXS.idMap().items).forEach(mk => { const parts = mk.split('\u0001'); invItem[LXS.idMap().items[mk]] = { key: parts[0], id: parts.slice(1).join('\u0001') }; });
      const invList = {};
      Object.keys(LXS.idMap().lists).forEach(k => { invList[LXS.idMap().lists[k]] = k; });
      for (const kind of Object.keys(plan)) {
        const stored = await readKind(kind);
        const srcRows = plan[kind];
        if (stored.size !== srcRows.length) vfail(kind + ' count ' + stored.size + ' vs ' + srcRows.length);
        const original = simple[kind];
        for (const row of srcRows) {
          const r = stored.get(row.id);
          if (!r) vfail(kind + ' missing ' + row.id);
          if (r.json !== row.json) vfail(kind + ' differs ' + row.id);
          // compare with the ORIGINAL source record (before reference re-keying)
          let back = JSON.parse(r.json);
          if (row.renamedFrom) back.id = original[row.sourceIndex].id;
          if (kind === 'partsRequests' && Array.isArray(back.parts)) {
            back.parts = back.parts.map(p => (p && p.source && p.source.type === 'punchlist' && invItem[p.source.id])
              ? Object.assign({}, p, { source: Object.assign({}, p.source, { id: lxsOriginalOldId(invItem[p.source.id].id, (function () { const src = old.partsRequests[row.sourceIndex]; const op = src && Array.isArray(src.parts) ? src.parts.find(q => q && q.id === p.id) : null; return op && op.source ? op.source.id : undefined; })()) }) }) : p);
          }
          if (kind === 'editLog') back = old.editLog[row.sourceIndex] && lxsUnrekeyEditEntry(back, invList, invItem, old.editLog[row.sourceIndex]);
          const srcRec = kind === 'partsRequests' ? old.partsRequests[row.sourceIndex] : kind === 'editLog' ? old.editLog[row.sourceIndex] : original[row.sourceIndex];
          const a = kind === 'inspections' ? LXS.storedJson('inspections', back) : JSON.stringify(back);
          const b = kind === 'inspections' ? LXS.storedJson('inspections', srcRec) : JSON.stringify(srcRec);
          if (a !== b) vfail(kind + ' field mismatch ' + row.id);
        }
      }
      // time-card active clock-in
      if (JSON.stringify(await LXS.metaGet('tc:active')) !== JSON.stringify((old.timecards && old.timecards.active) || null)) vfail('active clock-in');
      // existing photos: byte-identical, one at a time
      const sameBytes = async (a, b) => {
        if (!a || !b || a.size !== b.size) return false;
        const [x, y] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
        const u = new Uint8Array(x), v = new Uint8Array(y);
        for (let i = 0; i < u.length; i++) if (u[i] !== v[i]) return false;
        return true;
      };
      for (const pid of old.photoIds) {
        const o = await lxsLegacyPhoto(pid);
        if (!o) continue;
        const n = await LXS.reqP(db.transaction('photoData', 'readonly').objectStore('photoData').get(String(pid)));
        const nm = await LXS.reqP(db.transaction('photos', 'readonly').objectStore('photos').get(String(pid)));
        if (!n || !nm) vfail('photo missing ' + pid);
        const ob = o.blob instanceof Blob ? o.blob : new Blob([o.blob || ''], { type: 'image/jpeg' });
        if (!(await sameBytes(ob, n.blob))) vfail('photo bytes ' + pid);
      }
      // punchlists: rebuild each old list from the new storage and compare
      // every item character for character (photo text included), one at a time.
      if (old.punchlist) {
        const src = old.punchlist;
        const lists = await readKind('punchlistLists');
        const items = await readKind('punchlistItems');
        const byList = {};
        items.forEach(r => { (byList[r.listId] = byList[r.listId] || []).push(r); });
        Object.keys(byList).forEach(k => byList[k].sort((a, b) => a.position - b.position));
        const order = await LXS.metaGet('order:punchlistLists');
        const oldKeys = Object.keys(src.jobs || {});
        if (!Array.isArray(order) || order.length !== oldKeys.length) vfail('punchlist list count');
        for (let li = 0; li < oldKeys.length; li++) {
          const oldKey = oldKeys[li];
          const newKey = order[li];
          const lrec = lists.get(newKey);
          if (!lrec) vfail('punchlist list missing ' + oldKey);
          if ((lrec.legacyKey || newKey) !== oldKey) vfail('punchlist list order/key ' + oldKey);
          const want = (Array.isArray(src.jobs[oldKey]) ? src.jobs[oldKey] : []).filter(x => x && typeof x === 'object');
          const got = byList[newKey] || [];
          if (want.length !== got.length) vfail('punchlist item count ' + oldKey);
          for (let i = 0; i < want.length; i++) {
            const r = got[i];
            const obj = JSON.parse(r.json);
            const rebuilt = {};
            Object.keys(obj).forEach(f => { rebuilt[f] = f === 'id' ? (r.legacyId !== undefined ? r.legacyId : obj.id) : obj[f]; });
            if (r.photoId) {
              const prow = await LXS.reqP(db.transaction('photoData', 'readonly').objectStore('photoData').get(r.photoId));
              const pmeta = await LXS.reqP(db.transaction('photos', 'readonly').objectStore('photos').get(r.photoId));
              if (!prow || typeof prow.dataUrl !== 'string' || !pmeta) vfail('punchlist photo missing ' + r.id);
              rebuilt.photo = prow.dataUrl;
            }
            if (JSON.stringify(rebuilt) !== JSON.stringify(want[i])) vfail('punchlist item differs ' + oldKey + ' #' + (i + 1));
          }
        }
        // lookup tables (order of entries in these has no meaning)
        const canon = (o) => JSON.stringify(Object.keys(o || {}).sort().map(k => [k, o[k]]));
        const rebuiltNames = {}, rebuiltLinks = {}, rebuiltPrimary = {};
        const ex = await LXS.metaGet('pl:extras') || {};
        lists.forEach(l => {
          const ld = JSON.parse(l.json);
          const oldKey = l.legacyKey || l.id;
          const hadName = l.legacyKey ? l.legacyHadListName : ld.hasListName;
          if (hadName) rebuiltNames[oldKey] = ld.name;
          if (ld.jobLinked) rebuiltLinks[oldKey] = ld.jobId;
          (ld.primaryForJobs || []).forEach(j => { rebuiltPrimary[j] = oldKey; });
        });
        Object.keys(ex.listNames || {}).forEach(k => { rebuiltNames[invList[k] || k] = ex.listNames[k]; });
        Object.keys(ex.jobIdByKey || {}).forEach(k => { rebuiltLinks[invList[k] || k] = ex.jobIdByKey[k]; });
        Object.keys(ex.keyByJobId || {}).forEach(j => { rebuiltPrimary[j] = invList[ex.keyByJobId[j]] || ex.keyByJobId[j]; });
        if (src.listNames && canon(rebuiltNames) !== canon(src.listNames)) vfail('punchlist names');
        if (src.jobIdByKey && canon(rebuiltLinks) !== canon(src.jobIdByKey)) vfail('punchlist job links');
        if (src.keyByJobId && canon(rebuiltPrimary) !== canon(src.keyByJobId)) vfail('punchlist main-list pointers');
        const cj = await LXS.metaGet('pl:currentJob');
        if ((invList[cj] || cj) !== (src.currentJob == null ? '' : src.currentJob)) vfail('punchlist current list');
      }
      report.verified = true;

      // Remember what the old storage looked like at the switch.
      const fp = await lxsOldFingerprint();
      await LXS.metaPut('oldFingerprint', fp);
      report.ms = Math.round(performance.now() - t0);
      report.finishedAt = new Date().toISOString();
      // The switch: one write.
      {
        const tx = db.transaction('meta', 'readwrite');
        const ms = tx.objectStore('meta');
        ms.put(report, 'upgradeReport');
        ms.put(2, 'storageVersion');
        ms.delete('upgradeError');
        await LXS.txDone(tx);
      }
      // From here on this phone counts as upgraded: it never goes back to
      // the old storage, even if the new storage can't be opened later.
      LXS.markerWrite(LXS.st.deviceId);
      LXS.st.upgradedDevice = true;
      // Device setting: last-opened punchlist follows its list's new id.
      try {
        const raw = localStorage.getItem('lx8_last_punchlist');
        if (raw != null) {
          let val; let quoted = true;
          try { val = JSON.parse(raw); } catch (e) { val = raw; quoted = false; }
          const mapped = LXS.idMap().lists[val];
          if (mapped) {
            localStorage.setItem('lx8_last_punchlist', quoted ? JSON.stringify(mapped) : mapped);
            report.lastPunchlist = { from: val, to: mapped };
          }
        }
      } catch (e) {}
      return report;
    }
    function lxsUnrekeyEditEntry(entry, invList, invItem, origEntry) {
      // inverse of LXS.rekeyEditLogEntries (verification only)
      if (!entry || typeof entry !== 'object') return entry;
      const out = Object.assign({}, entry);
      delete out.preUpgradeNoUndo;
      // v171: an old item id comes back exactly as the original entry held it
      // (the number 6 or the text "6"), so the check compares like with like.
      const back = (row, origRow) => {
        if (!row || typeof row !== 'object' || row.listKey == null) return row;
        const inv = invItem[row.id];
        const oldKey = invList[row.listKey] || row.listKey;
        if (!inv) return row;
        const origId = origRow && typeof origRow === 'object' ? origRow.id : undefined;
        const r2 = Object.assign({}, row, { listKey: oldKey, id: lxsOriginalOldId(inv.id, origId) });
        if (row.rec && typeof row.rec === 'object') {
          const origRecId = origRow && origRow.rec && typeof origRow.rec === 'object' ? origRow.rec.id : undefined;
          const rec = {};
          Object.keys(row.rec).forEach(f => { rec[f] = f === 'id' ? lxsOriginalOldId(inv.id, origRecId) : row.rec[f]; });
          r2.rec = rec;
        }
        return r2;
      };
      const origList = (o, side) => (o && o[side] && Array.isArray(o[side].punchlistItems)) ? o[side].punchlistItems : [];
      ['before', 'after'].forEach(side => {
        if (out[side] && Array.isArray(out[side].punchlistItems)) {
          const ol = origList(origEntry, side);
          out[side] = Object.assign({}, out[side], { punchlistItems: out[side].punchlistItems.map((r, i) => back(r, ol[i])) });
        }
      });
      if (out.affectedIds && Array.isArray(out.affectedIds.punchlistItems)) {
        const ol = (origEntry && origEntry.affectedIds && Array.isArray(origEntry.affectedIds.punchlistItems)) ? origEntry.affectedIds.punchlistItems : [];
        out.affectedIds = Object.assign({}, out.affectedIds, { punchlistItems: out.affectedIds.punchlistItems.map((r, i) => back(r, ol[i])) });
      }
      return out;
    }
    // v171: the old id exactly as the original record held it. The id map
    // keys are text, so "6" and 6 look alike there; when the original value
    // is known and matches as text, that original value is used as-is.
    function lxsOriginalOldId(idStr, originalValue) {
      if (originalValue !== undefined && originalValue !== null && String(originalValue) === String(idStr)) return originalValue;
      return lxsCoerceOldId(idStr);
    }
    function lxsCoerceOldId(idStr, row) {
      // the map key holds String(oldId); numbers were numbers before
      return /^-?\d+$/.test(idStr) ? Number(idStr) : idStr;
    }

    let lxsOverlayEl = null;
    function lxsShowUpgradeOverlay() {
      if (lxsOverlayEl) return;
      const el = document.createElement('div');
      el.id = 'lxsUpgradeOverlay';
      el.setAttribute('role', 'status');
      el.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;' +
        'background:var(--bg,#000);color:var(--text,#e8eef2);font:600 17px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;';
      el.textContent = 'Upgrading storage…';
      document.body.appendChild(el);
      lxsOverlayEl = el;
    }
    function lxsHideUpgradeOverlay() {
      if (lxsOverlayEl) { lxsOverlayEl.remove(); lxsOverlayEl = null; }
    }
    async function lxsRollbackCheck() {
      // Reviewer change 2: if the frozen old storage changed after the switch
      // (an older version was used again), keep using the new storage and say so.
      try {
        const saved = await LXS.metaGet('oldFingerprint');
        if (!saved) return;
        const now = await lxsOldFingerprint();
        const changed = Object.keys(saved).filter(k => saved[k] !== now[k]);
        if (changed.length) {
          LXS.st.rollbackWarning = true;
          LXS.st.rollbackChanged = changed;
          if (!(await LXS.metaGet('rollbackDetectedAt'))) await LXS.metaPut('rollbackDetectedAt', new Date().toISOString());
          toast('Data was entered in an older version after the storage upgrade — contact your manager', 8000);
          try { refreshStorageCard(); } catch (e) {}
        }
      } catch (e) { console.warn('[storage] rollback check failed', e); }
    }
    function lxsWithLock(fn) {
      try {
        if (navigator.locks && navigator.locks.request) return navigator.locks.request('lematic-fs-upgrade', { mode: 'exclusive' }, fn);
      } catch (e) {}
      return fn();
    }
    // ---------- blocking screens (upgraded phone, new storage not usable) ----------
    const LXS_BLOCK_TEXT = {
      cantOpen: 'Can’t open your saved work right now. Nothing has been lost. Close the app completely and open it again.',
      missing: 'Your saved work wasn’t found on this phone. Nothing has been changed. Don’t enter any work — contact your manager before using the app.'
    };
    let lxsBlockEl = null;
    function lxsBlock(reason, err) {
      const st = LXS.st;
      st.mode = 'blocked';
      st.blockedReason = reason;
      if (err) st.blockedError = String((err && (err.name + ': ' + err.message)) || err);
      console.warn('[storage] blocked:', reason, st.blockedError || '');
      lxsHideUpgradeOverlay();
      const show = () => {
        if (lxsBlockEl) lxsBlockEl.remove();
        const el = document.createElement('div');
        el.id = 'lxsBlockedOverlay';
        el.setAttribute('role', 'alertdialog');
        el.setAttribute('aria-modal', 'true');
        el.dataset.reason = reason;
        el.style.cssText = 'position:fixed;inset:0;z-index:100001;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px;box-sizing:border-box;text-align:center;' +
          'background:var(--bg,#000);color:var(--text,#e8eef2);font:600 17px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;';
        const msg = document.createElement('div');
        msg.id = 'lxsBlockedText';
        msg.style.cssText = 'max-width:340px;';
        msg.textContent = LXS_BLOCK_TEXT[reason] || LXS_BLOCK_TEXT.cantOpen;
        el.appendChild(msg);
        const btnCss = 'min-width:200px;padding:13px 20px;border-radius:12px;border:0;font:600 16px/1.2 inherit;font-family:inherit;cursor:pointer;';
        if (reason === 'missing') {
          const rb = document.createElement('button');
          rb.id = 'lxsBlockedRestore'; rb.type = 'button';
          rb.textContent = 'Restore a backup';
          rb.style.cssText = btnCss + 'background:var(--accent,#0a84ff);color:#fff;';
          const inp = document.createElement('input');
          inp.type = 'file'; inp.accept = '.zip,application/zip'; inp.id = 'lxsBlockedRestoreInput'; inp.style.display = 'none';
          rb.addEventListener('click', () => inp.click());
          inp.addEventListener('change', () => { const f = inp.files && inp.files[0]; inp.value = ''; if (f) lxsRestoreFromBlocked(f); });
          const note = document.createElement('div');
          note.id = 'lxsBlockedNote';
          note.style.cssText = 'max-width:340px;font-weight:400;font-size:14px;opacity:.8;min-height:1.4em;';
          el.appendChild(rb); el.appendChild(inp); el.appendChild(note);
        }
        const tb = document.createElement('button');
        tb.id = 'lxsBlockedRetry'; tb.type = 'button';
        tb.textContent = 'Try again';
        tb.style.cssText = btnCss + (reason === 'missing' ? 'background:transparent;color:var(--text,#e8eef2);border:1px solid currentColor;' : 'background:var(--accent,#0a84ff);color:#fff;');
        tb.addEventListener('click', () => { try { location.reload(); } catch (e) {} });
        el.appendChild(tb);
        (document.body || document.documentElement).appendChild(el);
        lxsBlockEl = el;
      };
      if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, { once: true });
    }
    // Marker present but the new storage is empty: the technician can put
    // their work back from a backup zip right from the blocking screen.
    // The new storage is used for this (never the old one); the app starts
    // behind the screen on the empty new storage, the backup is restored
    // into it the normal way, and only when that restore succeeds is the
    // new storage marked ready and the app reopened.
    let lxsRestoring = false;
    async function lxsRestoreFromBlocked(file) {
      if (lxsRestoring) return;
      lxsRestoring = true;
      const st = LXS.st;
      const note = document.getElementById('lxsBlockedNote');
      const say = (t) => { if (note) note.textContent = t; };
      say('Restoring backup…');
      try {
        const mk = LXS.markerRead() || {};
        if (st.mode === 'blocked') {
          await LXS.openFs();
          let deviceId = await LXS.metaGet('deviceId');
          if (!deviceId) { deviceId = mk.deviceId || (function () { try { return localStorage.getItem('lx8_device_id'); } catch (e) { return ''; } })() || ('dev_' + LXS.uuid()); await LXS.metaPut('deviceId', deviceId); }
          st.deviceId = deviceId;
          await LXS.loadAllIntoMemory();
          st.mode = 'v2';
          st.blockedRestore = true;
          st.readyResolve(st.mode);
          // let the app finish starting (behind this screen) before restoring
          await new Promise(r => setTimeout(r, 1500));
        }
        await importBackupZip(file);
        const t = ((document.getElementById('toast') || {}).textContent || '').trim();
        const ok = /^(Backup restored|Inspections restored)/.test(t);
        if (!ok) { say(t && t !== 'Restoring backup…' ? t + ' — nothing was changed. Try another backup or contact your manager.' : 'Restore didn’t finish. Contact your manager.'); lxsRestoring = false; return; }
        LXS.sweepAllNow();
        await LXS.flush();
        if (LXS.pendingCount()) throw new Error('not-saved');
        {
          const db = await LXS.openFs();
          const tx = db.transaction('meta', 'readwrite');
          tx.objectStore('meta').put(2, 'storageVersion');
          tx.objectStore('meta').put({ at: new Date().toISOString(), file: String(file && file.name || '') }, 'restoredWhileBlocked');
          await LXS.txDone(tx);
        }
        LXS.markerWrite(st.deviceId);
        say(t);
        setTimeout(() => { try { location.reload(); } catch (e) {} }, 1200);
      } catch (e) {
        console.warn('[storage] restore from blocked screen failed', e);
        say('Restore didn’t finish. Contact your manager.');
        lxsRestoring = false;
      }
    }
    function lxsTimeout(p, ms) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('fs-timeout')), ms);
        p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
      });
    }
    async function lxsReadHead() {
      const db = await LXS.openFs();
      const tx = db.transaction('meta', 'readonly');
      const ms = tx.objectStore('meta');
      const [v, d] = await Promise.all([LXS.reqP(ms.get('storageVersion')), LXS.reqP(ms.get('deviceId'))]);
      return { v, d };
    }
    function lxsEnterV2Extras() {
      const st = LXS.st;
      try {
        st.bc = new BroadcastChannel('lematic-fs');
        st.bc.onmessage = (ev) => {
          const m = ev && ev.data;
          if (m && m.from !== st.tabId && Array.isArray(m.kinds)) m.kinds.forEach(k => st.stale.add(k));
        };
      } catch (e) {}
      // keep the "upgraded" marker in place (written at the switch)
      if (!LXS.markerRead()) LXS.markerWrite(st.deviceId);
      st.upgradedDevice = true;
    }
    async function lxsBoot() {
      const st = LXS.st;
      const t0 = performance.now();
      // An upgraded phone is one with the marker, or whose new storage says
      // version 2. It never runs on the old storage.
      let upgraded = st.upgradedDevice;
      // If a phone that was already upgraded before this launch hasn't
      // finished starting after ~10 s, it shows the blocking screen instead
      // of waiting forever. (A first-time upgrade can take longer and keeps
      // its "Upgrading storage…" screen, as before.)
      const watchdog = setTimeout(() => {
        if (st.mode === 'pending' && upgraded) lxsBlock('cantOpen', new Error('boot-timeout'));
      }, 10000);
      const finish = (mode) => {
        clearTimeout(watchdog);
        if (st.mode === 'blocked') return 'blocked';   // stays blocked even if storage opens late
        st.mode = mode;
        st.bootMs = Math.round(performance.now() - t0);
        st.readyResolve(st.mode);
        return mode;
      };
      try {
        if (!('indexedDB' in window)) throw new Error('no-idb');
        // Open + read the head. An upgraded phone retries over ~8–9 s
        // (each try limited to 2.5 s); a never-upgraded phone tries once,
        // as before.
        let head = null, lastErr = null;
        const waits = [0, 800, 1500, 2000, 2000];
        for (let i = 0; i < waits.length; i++) {
          if (st.mode === 'blocked') return 'blocked';
          if (waits[i]) await new Promise(r => setTimeout(r, waits[i]));
          try {
            head = upgraded ? await lxsTimeout(lxsReadHead(), 2500) : await lxsReadHead();
            break;
          } catch (e) {
            lastErr = e;
            st.db = null;
            if (!upgraded) throw e;
            console.warn('[storage] new storage not opening, try ' + (i + 1), e);
          }
        }
        if (!head) { clearTimeout(watchdog); if (st.mode !== 'blocked') lxsBlock('cantOpen', lastErr); return 'blocked'; }
        if (head.v === 2) { upgraded = true; st.upgradedDevice = true; }
        if (head.v === 2 && head.d) {
          st.deviceId = head.d;
          try {
            await LXS.loadAllIntoMemory();
          } catch (e) {
            // one more go before giving up
            console.warn('[storage] reading new storage failed, retrying', e);
            st.db = null;
            await new Promise(r => setTimeout(r, 1000));
            try { await LXS.loadAllIntoMemory(); }
            catch (e2) { clearTimeout(watchdog); if (st.mode !== 'blocked') lxsBlock('cantOpen', e2); return 'blocked'; }
          }
          if (st.mode === 'blocked') return 'blocked';
          st.upgradeReport = st.meta.upgradeReport || null;
          window.__lxUpgradeReport = st.upgradeReport;
          lxsEnterV2Extras();
          finish('v2');
          setTimeout(() => { try { if (localStorage.getItem('lx8_device_id') !== head.d) localStorage.setItem('lx8_device_id', head.d); } catch (e) {} }, 0);
          const later0 = window.requestIdleCallback || function (fn) { setTimeout(fn, 1500); };
          later0(() => { lxsRollbackCheck(); }, { timeout: 4000 });
          return st.mode;
        }
        if (upgraded && head.v !== 2) {
          // Marker says this phone was upgraded, but the new storage has no
          // data: never upgrade again silently from the old storage.
          clearTimeout(watchdog);
          lxsBlock('missing', new Error('marker-without-storage'));
          return 'blocked';
        }
        let deviceId = head.d;
        if (!deviceId) {
          try { deviceId = localStorage.getItem('lx8_device_id') || ''; } catch (e) { deviceId = ''; }
          if (!deviceId) deviceId = 'dev_' + LXS.uuid();
          await LXS.metaPut('deviceId', deviceId);
        }
        try { if (localStorage.getItem('lx8_device_id') !== deviceId) localStorage.setItem('lx8_device_id', deviceId); } catch (e) {}
        st.deviceId = deviceId;
        let ver = await LXS.metaGet('storageVersion');
        if (ver !== 2) {
          const overlayTimer = setTimeout(lxsShowUpgradeOverlay, 1000);
          try {
            await lxsWithLock(async () => {
              // another tab may have finished it while we waited
              const v = await LXS.metaGet('storageVersion');
              if (v === 2) return;
              await lxsRunUpgrade();
            });
          } catch (e) {
            console.warn('[storage] upgrade did not finish', e);
            st.upgradeFailed = { at: new Date().toISOString(), err: String((e && (e.name + ': ' + e.message)) || e) };
            // remove only the partial NEW copy; old data was never touched
            try {
              const db = await LXS.openFs();
              const tx = db.transaction(['records', 'photos', 'photoData', 'meta'], 'readwrite');
              tx.objectStore('records').clear();
              tx.objectStore('photos').clear();
              tx.objectStore('photoData').clear();
              tx.objectStore('meta').put(st.upgradeFailed, 'upgradeError');
              await LXS.txDone(tx);
            } catch (e2) {}
          } finally {
            clearTimeout(overlayTimer);
            lxsHideUpgradeOverlay();
          }
          ver = await LXS.metaGet('storageVersion').catch(() => null);
        }
        if (ver === 2) {
          st.upgradedDevice = true;
          await LXS.loadAllIntoMemory();
          if (st.mode === 'blocked') return 'blocked';
          st.upgradeReport = st.meta.upgradeReport || st.upgradeReport;
          window.__lxUpgradeReport = st.upgradeReport;
          lxsEnterV2Extras();
          finish('v2');
        } else {
          finish('legacy');
        }
      } catch (e) {
        if (upgraded || st.upgradedDevice) {
          // an upgraded phone never falls back to the old storage
          clearTimeout(watchdog);
          if (st.mode !== 'blocked') lxsBlock('cantOpen', e);
          return 'blocked';
        }
        console.warn('[storage] new storage unavailable, using old storage', e);
        if (!st.upgradeFailed) st.upgradeFailed = { at: new Date().toISOString(), err: String((e && e.message) || e) };
        finish('legacy');
      }
      if (st.mode === 'legacy' && st.upgradeFailed) {
        setTimeout(() => { try { toast('Storage upgrade didn\'t finish — your data is safe; please contact your manager', 8000); } catch (e) {} }, 600);
      }
      if (st.mode === 'v2') {
        const later = window.requestIdleCallback || function (fn) { setTimeout(fn, 1500); };
        later(() => { lxsRollbackCheck(); }, { timeout: 4000 });
      }
      return st.mode;
    }
    // Writes that are still waiting go out the moment the app is hidden or
    // closed; a failed write is retried then too.
    document.addEventListener('visibilitychange', () => {
      if (!LXS.isV2()) return;
      if (document.visibilityState === 'hidden') { LXS.sweepAllNow(); LXS.flush().catch(() => {}); }
      else if (document.visibilityState === 'visible' && LXS.st.stale.size && !LXS.st.pending.size) lxsReloadStale();
    });
    window.addEventListener('pagehide', () => { if (LXS.isV2()) { LXS.sweepAllNow(); LXS.flush().catch(() => {}); } });
    async function lxsReloadStale() {
      // Another tab saved while this one was in the background: reload the
      // in-memory copy from storage so this tab doesn't work on old data.
      const kinds = Array.from(LXS.st.stale);
      LXS.st.stale.clear();
      try {
        await LXS.loadAllIntoMemory();
        storeMem.jobs = null; storeMem.customers = null; storeMem.sites = null; storeMem.machines = null;
        storeMem.partsRequests = null; storeMem.serials = null; storeMem.editLog = null;
        storeMem.inspections = LXS.st.arrays.inspections;
        if (kinds.indexOf('timeEntries') >= 0 && typeof tcLoad === 'function') { try { tcLoad(); } catch (e) {} }
        if ((kinds.indexOf('punchlistLists') >= 0 || kinds.indexOf('punchlistItems') >= 0) && typeof window.plReloadFromStorage === 'function') {
          await window.plReloadFromStorage();
        }
        try { refreshHome(); } catch (e) {}
      } catch (e) { console.warn('[storage] reload after other tab failed', e); }
    }
    // The app starts when storage is ready. A blocked phone never becomes
    // ready, so nothing behind the blocking screen starts.
    lxsBoot().catch(e => console.warn('[storage] boot', e));
    const lxsReady = LXS.ready;
    window.__lxsReady = lxsReady;

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
        const insId = copy.id || newEntityId('ins');
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
      if (lxsIsV2Safe()) return LXS.flush();
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
        // Phase 7C (C4): clears a previously-recorded durable-persist
        // failure once a later attempt actually succeeds — see the
        // catch below for where the flag gets set. Settings surfaces
        // this quietly; nothing toasts from here, this runs on every
        // 180ms debounce and a toast per occurrence would spam the
        // technician for a background operation they didn't initiate.
        if (window.__lxPersistDurableFailed) window.__lxPersistDurableFailed = null;
      } catch (e) {
        console.warn('IndexedDB persist failed', e);
        window.__lxPersistDurableFailed = { at: Date.now(), err: String((e && e.message) || e) };
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
      if (lxsIsV2Safe()) return;
      clearTimeout(lxPersistTimer);
      lxPersistTimer = setTimeout(() => {
        persistAllStores().catch(err => console.warn(err));
      }, 180);
    }

    async function bootStorage() {
      if (lxsIsV2Safe()) {
        storeMem.visits = [];
        storeMem.inspections = LXS.st.arrays.inspections;
        storeMem.ready = true;
        try {
          if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
        } catch (e) {}
        return;
      }
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

    function saveInspections(list, opts) {
      if (lxsIsV2Safe()) {
        storeMem.inspections = Array.isArray(list) ? list : [];
        LXS.save('inspections', storeMem.inspections, opts);
        return true;
      }
      storeMem.inspections = Array.isArray(list) ? list : [];
      // The debounced IndexedDB persist is the durable copy; kick it off
      // regardless of whether the quick localStorage mirror below succeeds.
      schedulePersist();
      const ok = STORE.save('inspections', stripInspectionPhotos(storeMem.inspections));
      if (!ok) {
        // localStorage is likely full or unavailable. The IndexedDB write
        // above is still in flight — don't tell the user it's "saved"
        // before that's actually confirmed.
        console.warn('localStorage write failed for lx8_inspections; relying on IndexedDB backup');
        toast('Storage nearly full — saving to backup storage, free up space soon');
      }
      return true;
    }
    function loadInspections() {
      if (storeMem.inspections) {
        storeMem.inspections = ensureSampleInspection(storeMem.inspections);
        return storeMem.inspections;
      }
      const raw = STORE.load('inspections');
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
      // Phase 15A: resolve/stamp Customer/Site/Machine ids on every real
      // save of this inspection (this function is the single save path
      // used by all three inspection-creation flows and every subsequent
      // in-progress save) — never on a mere load.
      if (typeof resolveInspectionEquipmentSnapshot === 'function') {
        resolveInspectionEquipmentSnapshot(currentInspection, { source: 'inspection-save' });
      }
      let list = loadInspections();
      const idx = list.findIndex(i => i.id === currentInspection.id);
      if (idx >= 0) list[idx] = currentInspection;
      else list.unshift(currentInspection);
      saveInspections(list, { hintIds: [currentInspection.id] });
    }

    // ========== UI HELPERS ==========
    // Navigation history is screen-based so the header back chevron always
    // returns to the page the user actually came from.  Individual pages
    // (such as a selected time-card week) keep their own state separately.
    const navHistory = [];
    let navGoingBack = false;

    // iOS Safari (confirmed on iPhone 16 Pro) can leave the bottom dock's
    // position:fixed layout stale after visiting another screen — most
    // reliably reproduced by tapping a screen's own Back arrow and then
    // the header Home icon in sequence — landing it noticeably lower
    // than its 20px resting gap, closer to the very edge. Not something
    // headless testing can reproduce (no real device navigation quirks
    // to trigger it), and not fixable by changing the CSS value alone,
    // since the browser's own cached layout is what's stale, not the
    // rule. An immediate reflow alone wasn't sufficient — Safari's own
    // internal viewport settling can still land after it — so this also
    // re-asserts the correct position a couple of frames later, once
    // Safari's own layout pass has actually finished, and explicitly
    // via inline style rather than trusting the reflow to have worked.
    function fixHomeDockPosition() {
      const dock = document.querySelector('.home-bottom-nav');
      if (!dock) return;
      const reassert = () => {
        dock.style.display = 'none';
        // eslint-disable-next-line no-unused-expressions
        dock.offsetHeight; // force layout flush before restoring
        dock.style.display = '';
        dock.style.bottom = '20px';
      };
      reassert();
      requestAnimationFrame(() => requestAnimationFrame(reassert));
    }

    function showScreen(id) {
      const current = document.querySelector('.screen.active');
      const currentId = current ? current.id : '';
      if (!navGoingBack && currentId && currentId !== id) {
        navHistory.push(currentId);
      }
      // Drive screen enter direction (forward vs back) for spatial continuity
      document.body.classList.toggle('nav-back', !!navGoingBack);
      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      const screenEl = document.getElementById(id);
      if (screenEl) screenEl.classList.add('active');
      if (currentId && currentId !== id) {
        try { closeBottomSheetsOnScreenChange(); } catch (e) {}
      }
      if (id === 'screenHome') fixHomeDockPosition();
      if (id !== 'screenPunchlist') {
        const overlay = document.getElementById('pl-modal');
        if (overlay && overlay.classList.contains('show')) {
          try { closeModal(); } catch (e) { overlay.classList.remove('show'); }
        }
      }
      document.body.classList.toggle('inspect-active', id === 'screenInspect');
      document.body.classList.toggle('on-findings', id === 'screenFindings');
      if (id === 'screenInspect' && typeof window.bindInspectCamFab === 'function') window.bindInspectCamFab();
      const bottom = document.getElementById('bottomBar');
      const barInspect = document.getElementById('barInspect');
      const bars = {
        screenInspect: 'barInspect'
        // screenFindings intentionally has no bottom bar — replaced with a
        // header Export button (see #btnInspectExport), matching the
        // Time Cards / Punchlist pattern instead of Back+Save.
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
      document.body.classList.toggle('on-time', id === 'screenTime');
      document.body.classList.toggle('on-time-week', id === 'screenTimeWeek');
      document.body.classList.toggle('on-time-edit', id === 'screenTimeEdit');
      document.body.classList.toggle('on-settings', id === 'screenSettings');
      document.body.classList.toggle('on-punchlist', id === 'screenPunchlist');
      document.body.classList.toggle('on-pl-edit', id === 'screenPunchlistEdit');
      document.body.classList.toggle('on-jobs-list', id === 'screenJobsList');
      document.body.classList.toggle('on-editor', id === 'screenEditor');
      if (id === 'screenHome') {
        document.body.classList.remove(
          'has-screen-back',
          'on-time', 'on-time-week', 'on-time-edit',
          'inspect-active', 'on-findings', 'on-inspect-notes', 'on-inspect-preview',
          'on-editor', 'on-pl-edit', 'on-notes'
        );
      }
      // Show the global header back chevron on every navigable page.
      // Home, the Settings landing page, and the main Time Cards landing page
      // keep their existing header behavior; all other screens can now return
      // to the actual previous screen via navHistory.
      const genericBackScreens = new Set([
        'screenJobsList', 'screenJobDetail', 'screenJobForm',
        'screenInspectList', 'screenPunchlistList', 'screenPunchlistEdit',
        'screenPartsList', 'screenPartsForm', 'screenEditor'
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
      if (id === 'screenNotes') {
        initNotesEditor();
        requestAnimationFrame(placeNotesFormatBar);
      } else {
        document.body.classList.remove('notes-focus');
        document.body.classList.remove('notes-typing');
      }
      const inspectFlow = id === 'screenInspect' || id === 'screenFindings';
      document.body.classList.toggle('on-inspect-flow', inspectFlow);
      const inInspections = (
        id === 'screenStart' ||
        id === 'screenInspect' ||
        id === 'screenFindings'
      );
      document.body.classList.toggle('on-inspections', inInspections);
      if (id === 'screenFindings') extraSectionTab = 'findings';
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
    let punchlistSheetMode = 'new';

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

    function configurePunchlistSheet(mode) {
      punchlistSheetMode = mode === 'edit' ? 'edit' : 'new';
      const title = document.getElementById('plStartTitle');
      const done = document.getElementById('plStartDone');
      const del = document.getElementById('plStartDelete');
      if (title) title.textContent = punchlistSheetMode === 'edit' ? 'Edit punchlist' : 'New punchlist';
      if (done) done.textContent = punchlistSheetMode === 'edit' ? 'Save' : 'Create punchlist';
      if (del) del.classList.toggle('hidden', punchlistSheetMode !== 'edit');
    }

    function openPunchlistEdit(key, opts) {
      opts = opts || {};
      punchlistEditIsNew = !!opts.isNew;
      editingPunchlistKey = key || '';
      configurePunchlistSheet('edit');
      const heading = document.getElementById('plEditHeading');
      if (heading) heading.textContent = 'Edit punchlist';
      let currentName = (typeof punchlistDisplayName === 'function') ? punchlistDisplayName(key) : '';
      if (typeof isInternalId === 'function' && isInternalId(currentName)) currentName = '';
      const nameEl = document.getElementById('plStartName') || document.getElementById('plEditName');
      if (nameEl) {
        nameEl.value = punchlistEditIsNew ? '' : currentName;
        nameEl.placeholder = 'Punchlist name';
      }
      const fallbackName = document.getElementById('plEditName');
      if (fallbackName && fallbackName !== nameEl) fallbackName.value = nameEl ? nameEl.value : currentName;
      let jobId = '';
      try {
        if (typeof window.getPunchlistJobId === 'function') jobId = window.getPunchlistJobId(key) || '';
      } catch (e) {}
      if (!jobId && opts.job && opts.job.id) jobId = opts.job.id;
      fillPunchlistStartJobSelect(jobId);
      fillPunchlistEditJobSelect(jobId);
      const sheet = document.getElementById('plStartSheet');
      if (sheet) {
        sheet.classList.remove('hidden');
        sheet.classList.add('show');
        sheet.setAttribute('aria-hidden', 'false');
      } else {
        showScreen('screenPunchlistEdit');
        document.body.classList.add('on-pl-edit');
      }
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
      const nameEl = document.getElementById('plStartName') || document.getElementById('plEditName');
      let name = ((nameEl && nameEl.value) || '').trim() || 'Punchlist';
      if (typeof isInternalId === 'function' && isInternalId(name)) { toast('Choose a different name'); return; }
      const jobSel = document.getElementById('plStartJob') || document.getElementById('plEditJob');
      const jobId = jobSel ? jobSel.value : '';
      if (typeof window.updatePunchlistMeta !== 'function') { toast('Could not save'); return; }
      await window.updatePunchlistMeta(key, name, jobId);
      document.body.classList.remove('on-pl-edit');
      editingPunchlistKey = '';
      punchlistEditIsNew = false;
      punchlistSheetMode = 'new';
      if (typeof closePunchlistStartSheet === 'function') closePunchlistStartSheet();
      const editScreen = document.getElementById('screenPunchlistEdit');
      if (editScreen && editScreen.classList.contains('active')) {
        showScreen('screenPunchlist');
        setHeader('Punchlist');
      }
      if (typeof populateJobSelect === 'function') populateJobSelect();
      if (typeof window.renderList === 'function') window.renderList();
      if (typeof refreshPunchlistHome === 'function') refreshPunchlistHome();
      toast('Saved ' + name);
    }

    function cancelPunchlistEdit() {
      document.body.classList.remove('on-pl-edit');
      punchlistEditIsNew = false;
      editingPunchlistKey = '';
      punchlistSheetMode = 'new';
      if (typeof closePunchlistStartSheet === 'function') closePunchlistStartSheet();
      const editScreen = document.getElementById('screenPunchlistEdit');
      if (editScreen && editScreen.classList.contains('active')) {
        showScreen('screenPunchlist');
        setHeader('Punchlist');
      }
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
      if (title) title.textContent = (name ? punchlistKeyLabel(name) : '') || 'Link job';
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
            const statusLabel = allDone ? 'Complete' : (total === 0 ? 'Empty' : 'Pending');
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

    function formatAppDate(v) {
      if (v == null || v === '') return '';
      const s = String(v).trim();
      const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      let d = null;
      if (m) d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      else {
        const t = Date.parse(s);
        if (!isNaN(t)) d = new Date(t);
      }
      if (!d || isNaN(d.getTime())) return s;
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
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
            <span class="hj-dates">${dateRange ? jobEsc(dateRange) : 'No dates set'}</span>
          </div>
          <div class="hj-name">${jobEsc(job.customer || 'Untitled job')}${isSampleJob(job) ? SAMPLE_TAG_HTML : ''}</div>
          ${siteLine ? `<div class="hj-meta">${jobEsc(siteLine)}</div>` : ''}
          <div class="hj-stats" id="homeCurrentJobStats"><span><b class="n-open">0</b> Pending</span><span><b class="n-done">0</b> Complete</span><span><b class="n-ins">${inspectCount}</b> Inspection${inspectCount===1?'':'s'}</span></div>`;
        const statsEl = item.querySelector('#homeCurrentJobStats');
        const fillStats = (openN, doneN) => {
          if (!statsEl) return;
          statsEl.innerHTML = `<span><b class="n-open">${openN}</b> Pending</span><span><b class="n-done">${doneN}</b> Complete</span><span><b class="n-ins">${inspectCount}</b> Inspection${inspectCount===1?'':'s'}</span>`;
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
        if (typeof openJobDetail === 'function') openJobDetail(job.id);
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
        const findCount = countInspectionFindings(ins);
        const statusClass = ins.status === 'Complete' ? 'badge-complete' : 'badge-draft';
        const statusLabel = ins.status === 'Complete' ? 'Complete' : 'Draft';
        const rowTone = ins.status === 'Complete' ? 'list-complete' : '';
        return `
          <div class="list-item ${rowTone}" data-id="${ins.id}">
            <div class="list-item-main" data-action="open">
              <div class="title">${ins.customer || 'Unknown'} – ${ins.model || 'LX-8'} – ${ins.serial || 'No S/N'}${isSampleInspection(ins) ? SAMPLE_TAG_HTML : ''}</div>
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
      if (typeof bindSwipeToDelete === 'function') {
        bindSwipeToDelete(container, '.list-item', (row) => ({
          id: row.dataset.id,
          kind: 'inspection',
          title: 'Delete inspection?',
          label: 'This inspection report will be permanently deleted.'
        }));
      }
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
    // Phase 7C (C4): purely read-only display of window.__lxPersistDurableFailed
    // (set/cleared by persistAllStores). No toast, no modal, no Home
    // badge — just this one line, shown only while the flag is set.
    function refreshDurablePersistNotice() {
      const el = document.getElementById('durablePersistNotice');
      if (!el) return;
      el.hidden = !window.__lxPersistDurableFailed;
    }
    // v157 (Phase 15B, item 8 + amendment H): build.py fills in the real
    // version number here when it builds app.js/index.html. If app.html is
    // ever opened directly (unbuilt), that fill-in never happened — show
    // "Version dev" instead of a raw placeholder. Deliberately does not
    // spell out the placeholder text itself: build.py's substitution is a
    // plain find-and-replace over the whole built file, so this check
    // looks at the SHAPE of what's left (a plain number, or not) rather
    // than matching the placeholder's exact text, which would just make
    // build.py replace this check's own code too. Static, so this only
    // needs to run once.
    function refreshAppVersionLine() {
      const el = document.getElementById('appVersionLine');
      if (!el) return;
      const m = el.textContent.match(/^Version\s+(.*)$/);
      const value = m ? m[1].trim() : '';
      if (!/^[0-9]+$/.test(value)) el.textContent = 'Version dev';
    }
    refreshAppVersionLine();
    async function refreshStorageCard() {
      const line = document.getElementById('storageLine');
      const sub = document.getElementById('storageSub');
      const fill = document.getElementById('storageBarFill');
      if (!line) return;
      const visits = (typeof loadVisits === 'function' ? loadVisits() : []) || [];
      const inspections = (typeof loadInspections === 'function' ? loadInspections() : []) || [];
      const jobs = (typeof loadJobs === 'function' ? loadJobs() : []) || [];
      // v152 (Phase 12A Fix 2): every photo counted once — visits,
      // inspection answers, punchlist items and parts request lines.
      // A finding only carries a copy of its answer's photo, so findings
      // are no longer counted a second time.
      let photoCount = 0;
      visits.forEach(v => { photoCount += (v.photos || []).length; });
      inspections.forEach(ins => {
        if (ins.results) Object.keys(ins.results).forEach(k => {
          if (ins.results[k] && (ins.results[k].photoId || ins.results[k].photoDataUrl)) photoCount += 1;
        });
      });
      try {
        const reqs = (typeof loadPartsRequests === 'function' ? loadPartsRequests() : []) || [];
        reqs.forEach(r => {
          ((r && r.parts) || []).forEach(p => { if (p && (p.photoId || p.photoThumb)) photoCount += 1; });
        });
      } catch (e) {}
      try {
        if (typeof window.getPunchlistPhotoCount === 'function') photoCount += (await window.getPunchlistPhotoCount()) || 0;
      } catch (e) {}
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
      try {
        // v170: storage version and record counts (Phase 16A)
        const v2 = LXS.settingsText();
        const v2Line = document.getElementById('storageV2Line');
        if (v2Line) { v2Line.textContent = v2.line; v2Line.hidden = !v2.line; }
        const v2Warn = document.getElementById('storageV2Warn');
        if (v2Warn) { v2Warn.textContent = v2.warn; v2Warn.hidden = !v2.warn; }
      } catch (e) {}
      try { refreshSampleDataCard(); } catch (e) {}
      try { refreshPlShrinkCard(); } catch (e) {}
    }
    // v156: show the "Shrink existing punchlist photos" card only when
    // there is something to shrink.
    async function refreshPlShrinkCard() {
      const card = document.getElementById('plShrinkCard');
      if (!card || typeof window.getPunchlistLargePhotoInfo !== 'function') return;
      const info = await window.getPunchlistLargePhotoInfo();
      card.hidden = !(info && info.count);
      const sub = document.getElementById('plShrinkSub');
      if (sub && info && info.count) {
        sub.textContent = info.count + ' punchlist photo' + (info.count === 1 ? ' is' : 's are') +
          ' still full camera size (about ' + info.mb + ' MB), which makes Punchlist slow to open. ' +
          'Shrinking them keeps every photo, at the same size inspection photos use.';
      }
    }
    (function bindShrinkPlPhotos() {
      const btn = document.getElementById('btnShrinkPlPhotos');
      if (!btn) return;
      btn.addEventListener('click', async () => {
        const ok = window.confirm('This permanently reduces the resolution of existing punchlist photos to the size inspection photos use. Export a backup first (Settings → Backup) if you want to keep the originals.\n\nShrink them now?');
        if (!ok) return;
        btn.disabled = true;
        const oldText = btn.textContent;
        btn.textContent = 'Shrinking…';
        try {
          const r = await window.shrinkPunchlistPhotos();
          if (!r.saved) toast('Could not save — nothing was changed on storage');
          else if (!r.count) toast('No photos needed shrinking');
          else toast('Shrank ' + r.count + ' photo' + (r.count === 1 ? '' : 's') + ', saved about ' + r.savedMb + ' MB');
        } catch (e) {
          toast('Could not shrink photos');
        }
        btn.disabled = false;
        btn.textContent = oldText;
        try { refreshStorageCard(); } catch (e) {}
      });
    })();

    // v152 (Phase 12A Fix 6): "Remove sample data". Deletes only records
    // carrying the app's fixed built-in sample IDs (job_sample_demo,
    // ins_example_orangeburg, tc_sample_…) and never re-seeds them, the
    // same way the app already treats a deleted sample. Nothing you
    // entered is touched, even if it's linked to the sample job.
    function sampleDataSummary() {
      const jobN = loadJobs().filter(isSampleJob).length;
      const insN = loadInspections().filter(isSampleInspection).length;
      const tcN = (typeof window.tcCountSampleEntries === 'function') ? window.tcCountSampleEntries() : 0;
      return { jobN, insN, tcN, any: !!(jobN || insN || tcN) };
    }
    function refreshSampleDataCard() {
      const card = document.getElementById('sampleDataCard');
      if (!card) return;
      const s = sampleDataSummary();
      card.hidden = !s.any;
      const sub = document.getElementById('sampleDataSub');
      if (sub && s.any) {
        const parts = [];
        if (s.jobN) parts.push('the sample job');
        if (s.insN) parts.push('the example inspection');
        if (s.tcN) parts.push(s.tcN + ' practice time entr' + (s.tcN === 1 ? 'y' : 'ies'));
        sub.textContent = 'This device still has the app\'s built-in practice records: ' + parts.join(', ') +
          '. They\'re marked "Sample". Removing them doesn\'t touch anything you entered.';
      }
    }
    // Phase 15A / amendment G: after the sample job/inspection are removed
    // above, remove any Customer/Site/Machine record that was referenced
    // ONLY by those sample records — never one still referenced by any
    // real (kept) job, inspection, punchlist item, or parts request line.
    // Reference-counted against everything still on file, including
    // punchlist items (read via the module's own exposed backup getter,
    // since punchlist state lives in a private module scope) — a plain
    // "was it a sample" flag isn't enough, since real data could
    // legitimately share a Customer/Site/Machine with the sample job.
    function cascadeRemoveOrphanedEquipment(removedJobs, removedInspections) {
      const candidateCustomerIds = new Set();
      const candidateSiteIds = new Set();
      const candidateMachineIds = new Set();
      (removedJobs || []).forEach(j => {
        if (j && j.customerId) candidateCustomerIds.add(j.customerId);
        if (j && j.siteId) candidateSiteIds.add(j.siteId);
        (j && j.equipmentIds || []).forEach(id => id && candidateMachineIds.add(id));
      });
      (removedInspections || []).forEach(i => {
        if (i && i.customerId) candidateCustomerIds.add(i.customerId);
        if (i && i.siteId) candidateSiteIds.add(i.siteId);
        if (i && i.equipmentId) candidateMachineIds.add(i.equipmentId);
      });
      if (!candidateCustomerIds.size && !candidateSiteIds.size && !candidateMachineIds.size) return;

      const usedCustomerIds = new Set();
      const usedSiteIds = new Set();
      const usedMachineIds = new Set();
      function note(customerId, siteId, machineId) {
        if (customerId) usedCustomerIds.add(customerId);
        if (siteId) usedSiteIds.add(siteId);
        if (machineId) usedMachineIds.add(machineId);
      }
      (loadJobs() || []).forEach(j => {
        note(j && j.customerId, j && j.siteId);
        (j && j.equipmentIds || []).forEach(id => id && usedMachineIds.add(id));
      });
      (loadInspections() || []).forEach(i => note(i && i.customerId, i && i.siteId, i && i.equipmentId));
      (loadPartsRequests() || []).forEach(r => {
        note(r && r.customerId, r && r.siteId, r && r.equipmentId);
        (r && r.parts || []).forEach(p => note(p && p.customerId, p && p.siteId, p && p.equipmentId));
      });
      try {
        if (typeof window.getPunchlistBackup === 'function') {
          const pl = window.getPunchlistBackup();
          const jobsObj = (pl && pl.jobs) || {};
          Object.keys(jobsObj).forEach(key => {
            (jobsObj[key] || []).forEach(item => note(item && item.customerId, item && item.siteId, item && item.equipmentId));
          });
        }
      } catch (e) {}

      const staleCustomerIds = Array.from(candidateCustomerIds).filter(id => !usedCustomerIds.has(id));
      const staleSiteIds = Array.from(candidateSiteIds).filter(id => !usedSiteIds.has(id));
      const staleMachineIds = Array.from(candidateMachineIds).filter(id => !usedMachineIds.has(id));

      if (staleCustomerIds.length) saveCustomers(loadCustomers().filter(c => !c || !staleCustomerIds.includes(c.id)));
      if (staleSiteIds.length) saveSites(loadSites().filter(s => !s || !staleSiteIds.includes(s.id)));
      if (staleMachineIds.length) saveMachines(loadMachines().filter(m => !m || !staleMachineIds.includes(m.id)));
    }
    function performRemoveSampleData() {
      if (lxsIsV2Safe()) return LXS.withSourceSync('sampleRemoval', '', performRemoveSampleDataInner);
      return performRemoveSampleDataInner();
    }
    function performRemoveSampleDataInner() {
      lsWrite('lx8_sample_job_seeded', true);
      lsWrite('lx8_sample_inspection_seeded', true);
      const jobs = loadJobs();
      const removedJobs = jobs.filter(j => isSampleJob(j));
      const keptJobs = jobs.filter(j => !isSampleJob(j));
      if (keptJobs.length !== jobs.length) saveJobs(keptJobs);
      const inspections = loadInspections();
      const removedInspections = inspections.filter(i => isSampleInspection(i));
      const keptIns = inspections.filter(i => !isSampleInspection(i));
      if (keptIns.length !== inspections.length) saveInspections(keptIns);
      let tcRemoved = 0;
      try { if (typeof window.tcRemoveSampleEntries === 'function') tcRemoved = window.tcRemoveSampleEntries(); } catch (e) {}
      try { cascadeRemoveOrphanedEquipment(removedJobs, removedInspections); } catch (e) { console.warn('sample data equipment cleanup failed', e); }
      if (currentInspection && isSampleInspection(currentInspection)) {
        currentInspection = null;
        results = {};
        findings = [];
      }
      if (editingJobId === SAMPLE_JOB_ID) editingJobId = null;
      if (detailJobId === SAMPLE_JOB_ID) detailJobId = null;
      closeDeleteModal();
      const left = sampleDataSummary();
      toast(left.any ? 'Some sample data could not be removed — storage error' : 'Sample data removed');
      try { refreshHome(); } catch (e) {}
      try { refreshJobsList(); } catch (e) {}
      try { refreshStorageCard(); } catch (e) {}
    }
    (function bindRemoveSampleData() {
      const btn = document.getElementById('btnRemoveSampleData');
      if (!btn) return;
      btn.addEventListener('click', () => {
        pendingDeleteId = 'sample-data';
        pendingDeleteKind = 'sample-data';
        document.getElementById('deleteModalTitle').textContent = 'Remove sample data?';
        document.getElementById('deleteModalLabel').textContent =
          'The built-in sample job, example inspection and practice time entries will be removed. Your own jobs, inspections, punchlists, parts requests and time are not touched.';
        const modal = document.getElementById('deleteModal');
        modal.classList.remove('hidden');
        modal.classList.add('show');
        modal.setAttribute('aria-hidden', 'false');
      });
    })();

    async function blobToUint8(blob) {
      const buf = await blob.arrayBuffer();
      return new Uint8Array(buf);
    }
    function safeZipName(s) {
      return String(s || 'item').replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'item';
    }
    function lxsBuildSyncMeta() {
      const out = { version: 1, deviceId: LXS.st.deviceId, exportedAt: new Date().toISOString(), records: {} };
      LXS.KINDS.forEach(kind => {
        const m = {};
        LXS.st.known[kind].forEach((k, id) => {
          if (k.deleted) return;
          m[id] = { createdAt: k.env.createdAt, updatedAt: k.env.updatedAt, updatedBy: k.env.updatedBy, deviceId: k.env.deviceId, changeSource: k.env.changeSource, fp: lxsSyncFp(kind, k.json) };
        });
        out.records[kind] = m;
      });
      return out;
    }
    function lxsSyncFp(kind, json) { return LXS.syncFp(kind, json); }
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
        const partsRequests = JSON.parse(JSON.stringify(loadPartsRequests() || []));
        // Time cards live in their own lx8_timecards key (an object —
        // {entries, active} — not an array like the datasets above) and
        // were never part of this backup at all until now. Read straight
        // from storage rather than the in-memory tcState, since tcState
        // is only populated once the Time screen has actually been
        // opened this session — reading storage directly means an export
        // is correct even if the technician never visited that screen.
        // Isolated in its own try/catch, per the Phase 1 spec, so a
        // time-card serialization problem can't take down the rest of
        // an otherwise-good backup.
        let timecardsData = null;
        let timecardsError = null;
        try {
          const raw = STORE.load('timecards');
          if (raw && typeof raw === 'object') {
            timecardsData = {
              entries: Array.isArray(raw.entries) ? raw.entries : [],
              active: raw.active || null
            };
          }
        } catch (e) {
          timecardsError = e;
          console.warn('timecards backup failed', e);
        }
        // Phase 10 (F-1): customers/sites/serials — the stable identity
        // layer underneath a job's own customer/site/machine text
        // fields — were live, read/written on every save, and never
        // once included in a backup. Same isolation shape as timecards
        // above: each store gets its own try/catch so one failing
        // (e.g. loadCustomers throwing) doesn't drop the other two, or
        // anything else, from the zip.
        let customersData = null, sitesData = null, serialsData = null, machinesData = null;
        let identityErrors = [];
        try { customersData = JSON.parse(JSON.stringify(loadCustomers() || [])); }
        catch (e) { identityErrors.push('customers'); console.warn('customers backup failed', e); }
        try { sitesData = JSON.parse(JSON.stringify(loadSites() || [])); }
        catch (e) { identityErrors.push('sites'); console.warn('sites backup failed', e); }
        try { serialsData = JSON.parse(JSON.stringify(loadSerials() || [])); }
        catch (e) { identityErrors.push('serials'); console.warn('serials backup failed', e); }
        // Phase 15A (amendment I): the new Machine store, same isolation
        // shape as customers/sites/serials directly above.
        try { machinesData = JSON.parse(JSON.stringify(loadMachines() || [])); }
        catch (e) { identityErrors.push('machines'); console.warn('machines backup failed', e); }
        let photos;
        if (lxsIsV2Safe()) {
          // punchlist.json carries punchlist photos inline (as before); every
          // other photo that isn't deleted goes in photos/ — unowned ones too.
          if (typeof window.plEnsureLoaded === 'function') await window.plEnsureLoaded();
          photos = await LXS.getAllLivePhotos({ exclude: LXS.inlinePunchlistPhotoIds() });
        } else {
          photos = await STORE.getAllPhotos();
        }
        const files = [
          { name: 'manifest.json', data: JSON.stringify({
            app: 'lematic-lx8',
            version: 1,
            exportedAt: new Date().toISOString(),
            visits: visits.length,
            inspections: inspections.length,
            jobs: jobs.length,
            partsRequests: partsRequests.length,
            timeCardEntries: timecardsData ? timecardsData.entries.length : 0,
            customers: customersData ? customersData.length : 0,
            sites: sitesData ? sitesData.length : 0,
            serials: serialsData ? serialsData.length : 0,
            machines: machinesData ? machinesData.length : 0,
            photos: photos.length
          }, null, 2) },
          { name: 'visits.json', data: JSON.stringify(visits) },
          { name: 'inspections.json', data: JSON.stringify(inspections) },
          { name: 'jobs.json', data: JSON.stringify(jobs) },
          { name: 'parts_requests.json', data: JSON.stringify(partsRequests) }
        ];
        if (typeof window.getPunchlistBackup === 'function') {
          files.push({ name: 'punchlist.json', data: JSON.stringify(window.getPunchlistBackup()) });
        }
        if (timecardsData) {
          files.push({ name: 'timecards.json', data: JSON.stringify(timecardsData) });
        }
        if (customersData) files.push({ name: 'customers.json', data: JSON.stringify(customersData) });
        if (sitesData) files.push({ name: 'sites.json', data: JSON.stringify(sitesData) });
        if (serialsData) files.push({ name: 'serials.json', data: JSON.stringify(serialsData) });
        if (machinesData) files.push({ name: 'machines.json', data: JSON.stringify(machinesData) });
        try {
          const editLog = STORE.load('editLog');
          if (Array.isArray(editLog) && editLog.length) {
            files.push({ name: 'edit_log.json', data: JSON.stringify(editLog) });
          }
        } catch (e) { console.warn('edit log backup failed', e); }
        try {
          const rawPin = localStorage.getItem('lx8_editor_settings');
          if (rawPin) files.push({ name: 'editor_settings.json', data: rawPin });
        } catch (e) { console.warn('editor settings backup failed', e); }
        if (lxsIsV2Safe()) {
          // v170: sync times ride along in their own file; older versions
          // ignore it. Deleted records aren't in backups, so neither are their
          // deleted markers.
          try { files.push({ name: 'sync_meta.json', data: JSON.stringify(lxsBuildSyncMeta()) }); }
          catch (e) { console.warn('sync meta backup failed', e); }
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
        // The backup itself still succeeded even if time cards and/or
        // identity records specifically couldn't be read — but the
        // technician needs to know that piece didn't make it in, not
        // just see a generic "downloaded" message that implies
        // everything did. Phase 1's timecards phrasing is left exactly
        // as it was for that single-failure case; identity failure
        // gets its own line, and if both happen at once one toast
        // admits both rather than only reporting whichever came last.
        const omitted = [];
        if (timecardsError) omitted.push('time cards');
        if (identityErrors.length) omitted.push('identity records (' + identityErrors.join('/') + ')');
        toast(omitted.length ? ('Backup downloaded — ' + omitted.join(' and ') + ' could not be included') : 'Backup downloaded');
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
      if (!lxsIsV2Safe()) return importBackupZipInner(file);
      try {
        return await LXS.withSource('restore', '', () => importBackupZipInner(file));
      } finally {
        LXS.st.restoreMeta = null;
      }
    }
    async function importBackupZipInner(file) {
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
        let partsRequests = byName['parts_requests.json'] ? JSON.parse(u8ToText(byName['parts_requests.json'])) : [];
        if (lxsIsV2Safe()) {
          // v170: sync times from a v170 backup are reused for records this
          // device has never seen, when the record's content still matches.
          try {
            if (byName['sync_meta.json']) {
              const sm = JSON.parse(u8ToText(byName['sync_meta.json']));
              if (sm && sm.records && typeof sm.records === 'object') LXS.st.restoreMeta = sm.records;
            }
          } catch (e) { console.warn('sync_meta restore', e); }
          // Old (v169 and earlier) backups: punchlist items are re-keyed the
          // same way the upgrade did it, and parts lines made from those
          // items follow them.
          try {
            if (byName['punchlist.json']) {
              const plPre = JSON.parse(u8ToText(byName['punchlist.json']));
              if (plPre && plPre.jobs) {
                LXS.rekeyBundle(plPre);
                LXS.stageMeta('idMap', LXS.idMap());
                partsRequests = LXS.rekeyPartsSources(partsRequests, plPre, { rekeyed: 0, unmatched: [] });
              }
            }
          } catch (e) { console.warn('punchlist pre-scan', e); }
        }
        const photoFiles = files.filter(f => f.name.indexOf('photos/') === 0);
        for (const pf of photoFiles) {
          const base = pf.name.split('/').pop();
          const id = base.replace(/\.(jpg|jpeg|png)$/i, '');
          const mime = /\.png$/i.test(base) ? 'image/png' : 'image/jpeg';
          const blob = new Blob([pf.data], { type: mime });
          if (lxsIsV2Safe() && await LXS.photoUnchanged(id, blob)) continue;
          await STORE.putPhoto({ id, blob, caption: '', createdAt: Date.now() });
        }
        storeMem.visits = Array.isArray(visits) ? visits : [];
        storeMem.inspections = Array.isArray(inspections) ? inspections : [];
        storeMem.jobs = Array.isArray(jobs) ? jobs : [];
        try { saveJobs(storeMem.jobs); } catch (e) {}
        // Parts Requests were missing from backup/restore entirely until
        // now — same shape of fix as Jobs just above: restore into
        // storeMem and persist via the module's own save function so it
        // goes through the same localStorage+IndexedDB path a normal save
        // would. Older backups simply won't have this file, which
        // correctly restores as zero parts requests, not an error.
        storeMem.partsRequests = Array.isArray(partsRequests) ? partsRequests : [];
        try { savePartsRequests(storeMem.partsRequests); } catch (e) {}
        for (const v of storeMem.visits) {
          if (v.photos && v.photos.length) v.photos = await Promise.all(v.photos.map(hydratePhotoUrl));
        }
        storeMem.inspections = await hydrateInspectionBlobs(storeMem.inspections);
        await persistAllStores();
        // Phase 2 audit finding: the final toast used to be keyed off
        // whether punchlist.json existed in the zip, not whether
        // setPunchlistBackup actually succeeded — so a corrupt or
        // wrong-shaped punchlist.json (setPunchlistBackup throws on
        // anything without a .jobs field) still ended in "Backup
        // restored", even though the technician's punchlist data was
        // never touched. Existing local punchlist data was never at
        // risk here (setPunchlistBackup throwing means data = saved
        // never runs), only the message was wrong. Tracking the real
        // outcome below so the toast can say so.
        let punchlistRestored = false;
        let punchlistFailed = false;
        if (byName['punchlist.json'] && typeof window.setPunchlistBackup === 'function') {
          try {
            const pl = JSON.parse(u8ToText(byName['punchlist.json']));
            await window.setPunchlistBackup(pl);
            punchlistRestored = true;
          } catch (err) {
            punchlistFailed = true;
            console.warn('punchlist restore', err);
          }
        }
        // Time cards: absence of timecards.json is expected for any
        // backup made before this fix, and must not be treated as "zero
        // time cards" — existing local entries are left completely
        // alone in that case, not cleared. A malformed file is the same
        // story: isolated in its own try/catch like punchlist above, so
        // a bad timecards.json can't take down restore of everything
        // else, and specifically does NOT touch lx8_timecards at all
        // rather than overwriting good local data with something
        // unverified.
        let timecardsRestored = false;
        let timecardsFailed = false;
        if (byName['timecards.json']) {
          try {
            const tc = JSON.parse(u8ToText(byName['timecards.json']));
            if (tc && typeof tc === 'object' && Array.isArray(tc.entries)) {
              STORE.save('timecards', { entries: tc.entries, active: tc.active || null });
              if (typeof tcLoad === 'function') tcLoad();
              timecardsRestored = true;
            } else {
              throw new Error('unexpected timecards.json shape');
            }
          } catch (err) {
            timecardsFailed = true;
            console.warn('timecards restore', err);
          }
        }
        // Phase 10 (F-1): customers/sites/serials, same isolation shape
        // as timecards just above — a missing file is the expected,
        // normal case for any pre-Phase-10 backup and must leave local
        // identity data completely untouched (never
        // saveCustomers([])); a present-but-malformed file is caught
        // per-store so one bad file can't block the other two or
        // anything else already restored above. Written in the order
        // the phase spec calls for: customers, then sites, then
        // serials.
        let identityRestoredStores = [];
        let identityFailedStores = [];
        const restoreIdentityStore = (fileKey, saveFn, label) => {
          if (!byName[fileKey]) return; // absent — leave local data alone
          try {
            const parsed = JSON.parse(u8ToText(byName[fileKey]));
            if (!Array.isArray(parsed)) throw new Error('unexpected ' + fileKey + ' shape');
            saveFn(parsed);
            identityRestoredStores.push(label);
          } catch (err) {
            identityFailedStores.push(label);
            console.warn(label + ' restore', err);
          }
        };
        restoreIdentityStore('customers.json', saveCustomers, 'customers');
        restoreIdentityStore('sites.json', saveSites, 'sites');
        restoreIdentityStore('serials.json', saveSerials, 'serials');
        // Phase 15A (amendment I): a missing machines.json is the normal
        // case for any pre-Phase-15 backup and leaves local Machine data
        // untouched, same as the other identity stores above.
        restoreIdentityStore('machines.json', saveMachines, 'machines');
        try {
          if (byName['edit_log.json']) {
            let parsedLog = JSON.parse(u8ToText(byName['edit_log.json']));
            if (Array.isArray(parsedLog) && lxsIsV2Safe()) parsedLog = LXS.rekeyEditLogEntries(parsedLog);
            if (Array.isArray(parsedLog)) STORE.save('editLog', parsedLog);
          }
        } catch (e) { console.warn('edit log restore', e); }
        try {
          if (byName['editor_settings.json']) {
            const parsedSet = JSON.parse(u8ToText(byName['editor_settings.json']));
            if (parsedSet && typeof parsedSet === 'object') {
              localStorage.setItem('lx8_editor_settings', JSON.stringify(parsedSet));
              try { STORE.save('editorSettings', parsedSet); } catch (e2) {}
            }
          }
        } catch (e) { console.warn('editor settings restore', e); }

        // v157 fix (Phase 15B review round 2, item B.1): restored data
        // needs machine links too, even on a device where the one-time
        // backfill already ran (its "done" flag is per-device, not
        // per-dataset, so it would otherwise never run again for this
        // freshly-restored data). Calling runEquipmentBackfill() directly
        // — not the gated runEquipmentBackfillIfNeeded() — always re-runs
        // it here; it's idempotent (only fills IDs that are missing), so
        // this is safe even when the restored data already had links.
        try { await runEquipmentBackfill(); } catch (e) { console.warn('post-restore backfill failed', e); }

        refreshHome();
        let summary = punchlistRestored ? 'Backup restored'
          : punchlistFailed ? 'Backup restored — punchlists in this backup were unreadable and were not restored'
          : 'Inspections restored — this zip has no punchlists';
        if (timecardsFailed) summary += ' — time cards in this backup were unreadable and were not restored';
        else if (timecardsRestored) summary += ', time cards included';
        if (identityFailedStores.length) summary += ' — some identity records (' + identityFailedStores.join('/') + ') were unreadable and were not restored';
        else if (identityRestoredStores.length) summary += ', identity records included';
        toast(summary);
      } catch (e) {
        console.warn(e);
        toast(String(e && e.message) === 'compressed-zip' ? 'Need an uncompressed LeMatic backup' : 'Restore failed');
      }
    }

    // The standalone "Visit" flow (saveVisits/openVisit/persistVisit/
    // performDeleteVisit/isTripFlowScreen) predates the Jobs + Inspections
    // model this app now uses, and was fully stubbed out with no callers
    // left — removed. loadVisits() is kept below because the backup/restore
    // format and storage layer still read/write an (always-empty) "visits"
    // key for compatibility with older exported backups.
    function loadVisits() { return []; }

    // ========== JOBS ==========
    let editingJobId = null;

    const SAMPLE_JOB_ID = 'job_sample_demo';
    // v152 (Phase 12A decision 2): the built-in sample job, inspection and
    // time week are only seeded when the app is running from a test
    // location — never on the live site (GitHub Pages). Test locations:
    // a file opened directly, localhost / 127.0.0.1, or an in-chat
    // preview (a sandboxed frame or a claudeusercontent.com page). Any
    // other address counts as live. No switch to remember before
    // deploying. Existing installs that already have samples keep them
    // until "Remove sample data" (Settings) is used. The manual
    // "Load example inspection" button still works everywhere.
    function isSampleDataLocation() {
      try {
        const loc = window.location || {};
        const proto = String(loc.protocol || '').toLowerCase();
        if (proto === 'file:' || proto === 'blob:' || proto === 'data:' || proto === 'about:') return true;
        const host = String(loc.hostname || '').toLowerCase();
        if (!host) return true;
        if (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]' || host === '::1') return true;
        if (host === 'claudeusercontent.com' || host.endsWith('.claudeusercontent.com')) return true;
        if (window.origin === 'null') return true;
        return false;
      } catch (e) {
        return false;
      }
    }
    // v152 (Phase 12A Fix 6): the built-in sample records are recognized
    // only by their fixed built-in IDs — never by name — so a real job
    // that happens to share a name is never tagged or removed.
    const SAMPLE_TC_ID_PREFIX = 'tc_sample_';
    const SAMPLE_TAG_HTML = '<span class="sample-tag">Sample</span>';
    function isSampleJob(job) { return !!(job && job.id === SAMPLE_JOB_ID); }
    function isSampleInspection(ins) { return !!(ins && ins.id === 'ins_example_orangeburg'); }
    function isSampleTimeEntry(en) { return !!(en && String(en.id || '').indexOf(SAMPLE_TC_ID_PREFIX) === 0); }
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
        findings: findingsFromResults(exampleResults, templateForModel('LX-8')),
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
        // Seed the demo inspection exactly once, ever. If it's missing and
        // we've already seeded it before, that means someone deleted it on
        // purpose — respect that instead of resurrecting it on next load.
        // v152: and only at a test location (see isSampleDataLocation).
        if (isSampleDataLocation() && !lsRead('lx8_sample_inspection_seeded', false)) {
          const full = (typeof window !== 'undefined' && window.__SAMPLE_INSPECTION_FULL) || getSampleInspectionRecord();
          arr.unshift(full);
          lsWrite('lx8_sample_inspection_seeded', true);
        }
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
      if (idx < 0) {
        // Same one-time-seed rule as ensureSampleInspection above.
        if (isSampleDataLocation() && !lsRead('lx8_sample_job_seeded', false)) {
          arr.unshift(sample);
          lsWrite('lx8_sample_job_seeded', true);
        }
      } else {
        arr[idx] = Object.assign({}, arr[idx], {
          site: sample.site,
          contact: sample.contact
        });
      }
      return arr;
    }
    function loadJobs() {
      window.loadJobs = loadJobs;
      const src = STORE.load('jobs');
      storeMem.jobs = ensureJobsIdentities(ensureSampleJob(src));
      if (applyJobStatuses(storeMem.jobs)) saveJobs(storeMem.jobs);
      return storeMem.jobs;
    }

    function saveJobs(list) {
      storeMem.jobs = ensureJobsIdentities(Array.isArray(list) ? list : []);
      return STORE.save('jobs', storeMem.jobs);
    }

    // ===== CUSTOMER / SITE / SERIAL (physical equipment) =====
    // Same load/save shape as loadJobs/saveJobs above — localStorage mirror
    // + IndexedDB via the shared kv store. This is the stable identity
    // layer underneath Job's existing customer/site/machine/serials text
    // fields; those text fields are never read from or written to by any
    // function below. See the Phase 1 Item 4 report for the reasoning
    // behind three layers (Customer → Site → Serial) rather than four —
    // approved as final: no Machine or MachineType entity.

    function normalizeMatchText(v) {
      return String(v || '').trim().toLowerCase();
    }

    function loadCustomers() {
      const src = STORE.load('customers');
      storeMem.customers = Array.isArray(src) ? src : [];
      return storeMem.customers;
    }
    function saveCustomers(list) {
      storeMem.customers = Array.isArray(list) ? list : [];
      return STORE.save('customers', storeMem.customers);
    }
    function loadSites() {
      const src = STORE.load('sites');
      storeMem.sites = Array.isArray(src) ? src : [];
      return storeMem.sites;
    }
    function saveSites(list) {
      storeMem.sites = Array.isArray(list) ? list : [];
      return STORE.save('sites', storeMem.sites);
    }
    function loadSerials() {
      const src = STORE.load('serials');
      storeMem.serials = Array.isArray(src) ? src : [];
      return storeMem.serials;
    }
    function saveSerials(list) {
      storeMem.serials = Array.isArray(list) ? list : [];
      return STORE.save('serials', storeMem.serials);
    }

    // Find-or-create a Customer by exact normalized name (trim + lowercase
    // only — no fuzzy matching, per the approved matching rules). Returns
    // the Customer record; mutates and persists the passed-in list only
    // when a new one is created.
    function findOrCreateCustomer(name) {
      const norm = normalizeMatchText(name);
      if (!norm) return null;
      const all = loadCustomers();
      let found = all.find(c => c && c.nameNormalized === norm);
      if (found) return found;
      const now = new Date().toISOString();
      found = { id: newEntityId('cust'), name: String(name).trim(), nameNormalized: norm, createdAt: now, updatedAt: now };
      all.push(found);
      saveCustomers(all);
      return found;
    }
    // Site identity is scoped to its Customer — the same site name under
    // two different customers must remain two separate Sites.
    function findOrCreateSite(customerId, name) {
      const norm = normalizeMatchText(name);
      if (!customerId || !norm) return null;
      const all = loadSites();
      let found = all.find(s => s && s.customerId === customerId && s.nameNormalized === norm);
      if (found) return found;
      const now = new Date().toISOString();
      found = { id: newEntityId('site'), customerId, name: String(name).trim(), nameNormalized: norm, address: '', createdAt: now, updatedAt: now };
      all.push(found);
      saveSites(all);
      return found;
    }
    // Serial identity is scoped to its Site for this phase — the same
    // serial number appearing at two different sites is preserved as two
    // separate equipment records rather than guessed-merged.
    function findOrCreateSerial(siteId, serialNumber, machineType) {
      const norm = normalizeMatchText(serialNumber);
      if (!siteId || !norm) return null;
      const all = loadSerials();
      let found = all.find(s => s && s.siteId === siteId && s.serialNumberNormalized === norm);
      if (found) return found;
      const now = new Date().toISOString();
      found = { id: newEntityId('ser'), siteId, machineType: machineType || '', serialNumber: String(serialNumber).trim(), serialNumberNormalized: norm, createdAt: now, updatedAt: now };
      all.push(found);
      saveSerials(all);
      return found;
    }

    // Resolves (creating only what's missing) the stable Customer/Site/
    // Serial ids for ONE job, and writes only customerId/siteId/serialIds
    // onto that job — job.customer/site/machine/serials/contact are never
    // read for anything but lookup, and never written to. Deliberately
    // lazy (runs the first time a job without customerId is loaded) rather
    // than a bulk one-time migration pass: a bulk pass over every job at
    // boot is exactly the kind of "opening the app unexpectedly rewrites a
    // lot of unrelated data at once" the brief was concerned about, and
    // offers no real safety advantage here, since this resolver only ever
    // touches the one job it's given — never other jobs, never unrelated
    // storage. Idempotent by construction: re-running it on an
    // already-resolved job is a no-op (short-circuits on customerId), and
    // re-running find-or-create against the same normalized text always
    // returns the same existing record rather than creating a duplicate.
    // Superseded by resolveJobEquipmentSnapshot() below (Phase 15A) — no
    // longer called from anywhere. Left in place, untouched, per the
    // "never delete existing data/code" rule; loadSerials/saveSerials/
    // findOrCreateSerial (which this still calls) are likewise left
    // completely untouched and are now unused dead code as well.
    function resolveJobEquipmentIds(job) {
      if (!job || job.customerId) return job;
      const customer = findOrCreateCustomer(job.customer);
      if (!customer) return job;
      job.customerId = customer.id;
      const site = findOrCreateSite(customer.id, job.site);
      if (site) job.siteId = site.id;
      const serials = Array.isArray(job.serials) ? job.serials : [];
      if (site && serials.length) {
        job.serialIds = serials
          .map(s => findOrCreateSerial(site.id, s, job.machine))
          .filter(Boolean)
          .map(rec => rec.id);
      }
      return job;
    }

    // ===== MACHINE (Phase 15A — roadmap Sections 3.4-3.6) =====
    // The target "equipment identity" record: keyed by NORMALIZED SERIAL
    // ONLY (not scoped to a site, unlike the old Serial layer above), so
    // the same physical machine is one record no matter which site/job it
    // shows up on next. Same load/save shape as customers/sites (through
    // STORE), plus a deterministic id so two devices that see the same
    // serial number independently compute the same machine id (needed for
    // Phase 16 sync joinability — approved amendment A).
    //
    // Shape:
    //   {
    //     id,                     // 'mach_' + encodeURIComponent(normalized serial)
    //     serialNumber,           // as first typed, trimmed
    //     serialNumberNormalized, // trim + lowercase — the matching key
    //     machineType,            // '' until known
    //     machineTypeSource,      // '' | 'inspection' | 'job' | 'manual'
    //     salesOrder,             // '' until known
    //     currentSiteId,          // most recent site this machine is at
    //     currentCustomerId,      // that site's customer, for convenience
    //     lineLabel,              // '' until set — the MACHINE line (e.g. "Line 1")
    //     productionLine,         // '' until set — the PRODUCTION line (e.g. "Line 9"),
    //                             // shared by several machines at a site (Phase 15B,
    //                             // roadmap 3.7). Filled in only when empty — from the
    //                             // job form's optional Production line field — never
    //                             // overwritten by a later job.
    //     moveLog: [ { at, fromSiteId, toSiteId, source, jobId, previousLineLabel, previousProductionLine } ],
    //     createdAt, updatedAt
    //   }
    // Placeholder machines (type only, no serial yet — roadmap 3.6, Phase
    // 15B) are NOT stored here. They live only on job.placeholderMachines
    // (see saveJobFromForm) and never get a lx8_machines record, so they
    // never appear in loadMachines(), backups' machines.json, or any
    // autocomplete sourced from this store (approved amendment B).
    // ===== v159 (Phase 15B follow-up): ONE machine-type list =====
    // Defined once, used everywhere a type is chosen — the job form's
    // serial/placeholder chips and the inspection machine picker (see
    // openTypePicker() below) — so there is never a second hard-coded copy
    // to fall out of sync. Order matters: COMMON first (large one-tap
    // buttons), then OTHER KNOWN (smaller buttons/list), then "Other".
    const MACHINE_TYPE_COMMON = ['LX-8', 'LX-7', 'LS-132', 'LS-133'];
    const MACHINE_TYPE_OTHER_KNOWN = ['Muffin Bagger', 'LS-131', 'SL90', 'Band Slicer', 'Hinge Slicer', 'Bagel Slicer', 'Muffin Forker', 'Tray Washer', 'Dough Imprinter', 'P-7 Pattern Former', 'Horizontal Switch'];
    const ALL_MACHINE_TYPES = MACHINE_TYPE_COMMON.concat(MACHINE_TYPE_OTHER_KNOWN);
    // Types that have an inspection checklist — driven by the checklist
    // templates themselves (window.MACHINE_TEMPLATES), never a second
    // hard-coded list. Today that's exactly the COMMON four, but this
    // stays correct if a template is ever added/removed.
    function checklistMachineTypes() {
      let keys = [];
      try { keys = Object.keys(window.MACHINE_TEMPLATES || {}); } catch (e) { keys = []; }
      if (!keys.length) return MACHINE_TYPE_COMMON.slice();
      const known = ALL_MACHINE_TYPES.filter(t => keys.indexOf(t) !== -1);
      const extra = keys.filter(k => ALL_MACHINE_TYPES.indexOf(k) === -1);
      return known.concat(extra);
    }
    // v159 review fix #4: whether a given type has an inspection checklist
    // at all (case/space/hyphen-insensitive) — used to keep the inspection
    // picker from silently defaulting to a checklist type for a machine
    // that has none (e.g. "Tray Washer"), and to require one be actually
    // picked before an inspection can start.
    function typeHasChecklist(type) {
      const key = normalizeTypeKey(type);
      if (!key) return false;
      return checklistMachineTypes().some(t => normalizeTypeKey(t) === key);
    }
    // Case/space/hyphen-insensitive key for matching typed "Other" text
    // against the known list — "ls133", "Ls-131", "band slicer" all match
    // their known spelling this way (normalizeMatchText alone only
    // lowercases/trims, which isn't enough for "LS-133" vs "ls133").
    function normalizeTypeKey(v) {
      return String(v || '').trim().toLowerCase().replace(/[\s-]+/g, '');
    }
    // Trim; if the trimmed text matches a known type ignoring case/spaces/
    // hyphens, return the known type's exact spelling; otherwise keep the
    // trimmed text as typed.
    function normalizeMachineTypeInput(text) {
      const trimmed = String(text || '').trim();
      if (!trimmed) return '';
      const key = normalizeTypeKey(trimmed);
      const known = ALL_MACHINE_TYPES.find(t => normalizeTypeKey(t) === key);
      return known || trimmed;
    }
    // Custom (not-in-the-known-list) types already used on this device —
    // suggestions for the "Other" text box. Scans machine records and any
    // in-progress job placeholders/drafts so a type typed once is
    // suggested again right away, even before it's saved anywhere else.
    function customMachineTypeSuggestions() {
      const seen = new Set();
      const out = [];
      const consider = (t) => {
        const v = String(t || '').trim();
        if (!v) return;
        if (ALL_MACHINE_TYPES.some(k => normalizeTypeKey(k) === normalizeTypeKey(v))) return;
        const key = normalizeTypeKey(v);
        if (seen.has(key)) return;
        seen.add(key);
        out.push(v);
      };
      try { (loadMachines() || []).forEach(m => consider(m && m.machineType)); } catch (e) {}
      try { (typeof jobPlaceholdersDraft !== 'undefined' ? jobPlaceholdersDraft : []).forEach(p => consider(p && p.type)); } catch (e) {}
      try {
        const jobs = (typeof loadJobs === 'function') ? (loadJobs() || []) : [];
        jobs.forEach(j => (Array.isArray(j && j.placeholderMachines) ? j.placeholderMachines : []).forEach(p => consider(p && p.type)));
      } catch (e) {}
      return out;
    }
    function loadMachines() {
      const src = STORE.load('machines');
      storeMem.machines = Array.isArray(src) ? src : [];
      return storeMem.machines;
    }
    function saveMachines(list) {
      storeMem.machines = Array.isArray(list) ? list : [];
      return STORE.save('machines', storeMem.machines);
    }
    // Deterministic id — same normalized serial always yields the same id,
    // on any device, without needing to look anything up first.
    function machineIdForSerial(serialNumber) {
      const norm = normalizeMatchText(serialNumber);
      if (!norm) return '';
      return 'mach_' + encodeURIComponent(norm);
    }
    function findOrCreateMachine(serialNumber) {
      const norm = normalizeMatchText(serialNumber);
      if (!norm) return null;
      const id = machineIdForSerial(serialNumber);
      const all = loadMachines();
      let found = all.find(m => m && m.id === id);
      if (found) return found;
      const now = new Date().toISOString();
      found = {
        id,
        serialNumber: String(serialNumber).trim(),
        serialNumberNormalized: norm,
        machineType: '',
        machineTypeSource: '',
        salesOrder: '',
        currentSiteId: '',
        // Not part of the originally-described shape — added so
        // "currentSiteId" genuinely means "the site it's most recently
        // been logged at" (Section 3.4) regardless of the ORDER records
        // happen to be processed in, and so the one-time backfill (which
        // walks history oldest-first) is idempotent: re-running it must
        // not let an older job "move" a machine backwards past a site a
        // later job already established. See applyMachineUpdate.
        currentSiteAsOf: '',
        currentCustomerId: '',
        lineLabel: '',
        productionLine: '',
        moveLog: [],
        createdAt: now,
        updatedAt: now
      };
      all.push(found);
      saveMachines(all);
      return found;
    }
    // Applies proposed updates to ONE machine record in a single load+save
    // round trip, enforcing the approved priority rules:
    //   - machineType: an 'inspection'-sourced type can never be
    //     overwritten by a 'job'-sourced one; an 'inspection'-sourced type
    //     may replace a 'job'- or 'manual'-sourced one; any other
    //     same-source-tier conflict is left as-is and reported back to the
    //     caller (amendment B).
    //   - salesOrder: first non-empty value wins; a later different value
    //     is reported, never overwritten (amendment C).
    //   - currentSiteId: changing it appends a moveLog entry and clears
    //     lineLabel (amendment F).
    // Returns { machine, typeConflict, soConflict, moved } — the caller
    // (job/inspection save paths, and the backfill routine) uses the
    // conflict/moved fields purely for reporting; nothing here blocks the
    // save that triggered it.
    function applyMachineUpdate(machineId, updates, opts) {
      opts = opts || {};
      updates = updates || {};
      if (!machineId) return null;
      const all = loadMachines();
      const idx = all.findIndex(m => m && m.id === machineId);
      if (idx < 0) return null;
      const m = all[idx];
      let changed = false;
      const report = { machine: m, typeConflict: null, soConflict: null, moved: null };

      if (updates.machineType) {
        const incomingType = String(updates.machineType).trim();
        const incomingSource = updates.machineTypeSource || 'manual';
        const currentType = m.machineType || '';
        const currentSource = m.machineTypeSource || '';
        const sameNormalized = normalizeMatchText(incomingType) === normalizeMatchText(currentType);
        if (!currentType) {
          m.machineType = incomingType;
          m.machineTypeSource = incomingSource;
          changed = true;
        } else if (!sameNormalized) {
          if (incomingSource === 'manager') {
            // Manager correction always writes. Inspection does not
            // overwrite a different manager type (Needs Attention).
            m.machineType = incomingType;
            m.machineTypeSource = incomingSource;
            changed = true;
          } else if (incomingSource === 'inspection') {
            if (currentSource === 'manager') {
              report.typeConflict = { existingType: currentType, existingSource: currentSource, incomingType, incomingSource };
            } else {
              // v159: a later inspection updates the machine, including
              // over a previous inspection-sourced type.
              m.machineType = incomingType;
              m.machineTypeSource = incomingSource;
              changed = true;
            }
          } else if (currentSource === 'inspection' || currentSource === 'manager') {
            report.typeConflict = { existingType: currentType, existingSource: currentSource, incomingType, incomingSource };
          } else if (incomingSource === 'job' && opts.allowJobRetype) {
            // v159 (Phase 15B follow-up): a deliberate per-serial type
            // correction made through the job form's shared picker — the
            // technician tapped a serial's type and chose a different one
            // on purpose, so (unlike an ordinary job-save reconciling
            // whatever job.machine used to say) this MAY replace an
            // existing job/manual-sourced type. Still never touches an
            // inspection-sourced one — that's the branch above.
            m.machineType = incomingType;
            m.machineTypeSource = incomingSource;
            changed = true;
          } else {
            // Two non-inspection values disagree — keep the first on file,
            // report the conflict (same "first wins" rule as before, now
            // scoped to same-tier conflicts only).
            report.typeConflict = { existingType: currentType, existingSource: currentSource, incomingType, incomingSource };
          }
        } else if (incomingSource === 'inspection' && currentSource !== 'inspection' && currentSource !== 'manager') {
          // Same text, but now confirmed by an inspection — upgrade the
          // recorded source so a later job-sourced change can't override it.
          m.machineTypeSource = 'inspection';
          changed = true;
        } else if (incomingSource === 'manager' && currentSource !== 'manager') {
          m.machineTypeSource = 'manager';
          changed = true;
        }
      }

      if (updates.salesOrder) {
        const incomingSO = String(updates.salesOrder).trim();
        if (!m.salesOrder) {
          m.salesOrder = incomingSO;
          changed = true;
        } else if (m.salesOrder !== incomingSO) {
          report.soConflict = { existing: m.salesOrder, incoming: incomingSO };
        }
      }

      if (updates.siteId) {
        // asOf: the real-world date this fact is true as of (a job's own
        // date, an inspection's own date) — defaults to "now" for an
        // ordinary live save. Comparing against the machine's own
        // currentSiteAsOf (rather than just reacting to "does this differ
        // from what's on file right now") is what makes this correct
        // regardless of processing order: an event dated BEFORE the
        // machine's already-recorded most-recent site is never treated as
        // a move, even if the two site ids differ — it's stale information
        // that's already been superseded, not a new relocation. Without
        // this, replaying history oldest-first (the backfill) would
        // "move" the machine forward through every job every time it's
        // run, appending duplicate moveLog entries on every re-run.
        const asOf = opts.asOf || new Date().toISOString();
        const knownAsOf = m.currentSiteAsOf || '';
        // Compared as real timestamps, not raw strings — job.date is a
        // plain "YYYY-MM-DD" while createdAt/"now" are full ISO
        // timestamps, and those two formats don't compare correctly as
        // plain strings (e.g. "2026-01-05" sorts before
        // "2026-01-05T00:00:00.000Z" even though they're the same day).
        const asOfMs = Date.parse(asOf);
        const knownAsOfMs = Date.parse(knownAsOf);
        const isNewer = !knownAsOf || isNaN(knownAsOfMs) || isNaN(asOfMs) || asOfMs >= knownAsOfMs;
        if (updates.siteId !== m.currentSiteId) {
          if (isNewer) {
            // v157 fix (Phase 15B review round 2, item A): a machine's very
            // FIRST site assignment (it had no currentSiteId at all yet) is
            // not a move — there's nothing to move it away from, so nothing
            // should be cleared. Only a real move (it already had a
            // different site on file) clears the line label/production
            // line, exactly as before. moveLog itself still gets an entry
            // either way (tidying first-placement log entries is 15C).
            const isFirstPlacement = !m.currentSiteId;
            const moveEntry = {
              at: new Date().toISOString(),
              fromSiteId: m.currentSiteId || '',
              toSiteId: updates.siteId,
              source: opts.source || '',
              jobId: opts.jobId || '',
              previousLineLabel: m.lineLabel || '',
              previousProductionLine: m.productionLine || ''
            };
            m.moveLog = Array.isArray(m.moveLog) ? m.moveLog.slice() : [];
            m.moveLog.push(moveEntry);
            report.moved = { fromSiteId: moveEntry.fromSiteId, toSiteId: moveEntry.toSiteId };
            m.currentSiteId = updates.siteId;
            m.currentSiteAsOf = asOf;
            if (!isFirstPlacement) {
              m.lineLabel = '';
              m.productionLine = '';
            }
            changed = true;
          }
          // else: an older/stale record disagreeing with the current
          // (more recent) site — not a move, not reported; the current
          // site is already correct and stays as-is.
        } else if (isNewer && asOf !== knownAsOf) {
          // Same site, but confirmed by a more recent record — keep
          // currentSiteAsOf meaningful without logging a no-op "move".
          m.currentSiteAsOf = asOf;
          changed = true;
        }
      }
      if (updates.customerId && updates.customerId !== m.currentCustomerId) {
        m.currentCustomerId = updates.customerId;
        changed = true;
      }

      // Production line (Phase 15B, roadmap 3.7): fill-only-if-empty, from
      // the job form's optional field. Unlike salesOrder this is never
      // reported as a conflict — a differing later value is simply left
      // alone, same as the machine-type-source rule for a job-sourced type.
      // Deliberately handled AFTER the siteId block above: a brand-new
      // machine's very first site assignment is itself logged as a "move"
      // (fromSiteId ''), which clears productionLine/lineLabel as part of
      // that — running this first would have the fill get wiped out by
      // its own triggering call.
      if (updates.productionLine && !(m.productionLine || '')) {
        m.productionLine = String(updates.productionLine).trim();
        changed = true;
      }

      if (changed) {
        m.updatedAt = new Date().toISOString();
        all[idx] = m;
        saveMachines(all);
      }
      return report;
    }
    // Resolves (creating only what's missing) Customer/Site/Machine ids for
    // ONE job and stamps job.customerId/siteId/equipmentIds — called only
    // from real save paths (saveJobFromForm, rememberJobSerial) and the
    // one-time backfill, NEVER from loadJobs()/ensureJobIdentity, per
    // approved amendment D ("no writes on load"). Idempotent: re-running
    // it on an unchanged job creates nothing new and changes nothing on
    // the underlying machine records (find-or-create by exact normalized
    // text / deterministic id; applyMachineUpdate only writes when a value
    // actually changes).
    function resolveJobEquipmentSnapshot(job, opts) {
      opts = opts || {};
      if (!job) return job;
      const customer = findOrCreateCustomer(job.customer);
      if (!customer) return job;
      job.customerId = customer.id;
      const site = findOrCreateSite(customer.id, job.site);
      if (site) job.siteId = site.id;
      const serials = normalizeJobSerials(Array.isArray(job.serials) ? job.serials : []);
      const singleSerial = serials.length === 1;
      const machineIds = [];
      if (!singleSerial && serials.length && job.so && opts.multiSerialSoSkipped) {
        opts.multiSerialSoSkipped.push({ serials: serials.slice(), so: job.so, jobId: job.id });
      }
      // v159 (Phase 15B follow-up, item 6): each serial's OWN chosen type
      // is applied here — never job.machine stamped onto every serial (job.
      // machine is now only a derived summary, computed after this runs;
      // see computeJobMachineSummary()). opts.serialTypeOverrides is a
      // { normalizeMatchText(serial): type } map the job form builds from
      // its per-chip picker choices (jobSerialTypeDraft) — see
      // saveJobFromForm(). A serial with no entry there already has its
      // own committed type (or none was ever chosen for it), so nothing
      // is sent and nothing changes.
      const serialTypeOverrides = opts.serialTypeOverrides || {};
      serials.forEach(serial => {
        const machine = findOrCreateMachine(serial);
        if (!machine) return;
        machineIds.push(machine.id);
        const updates = {};
        const chosenType = serialTypeOverrides[normalizeMatchText(serial)];
        if (chosenType) { updates.machineType = chosenType; updates.machineTypeSource = 'job'; }
        if (singleSerial && job.so) updates.salesOrder = job.so;
        if (job.productionLine) updates.productionLine = job.productionLine;
        if (site) { updates.siteId = site.id; updates.customerId = customer.id; }
        const result = applyMachineUpdate(machine.id, updates, {
          source: opts.source || 'job-save',
          jobId: job.id,
          asOf: job.date || job.createdAt || '',
          // Only the real interactive job-save path may retype an
          // already-typed serial (a deliberate tap on its chip) — the
          // lazy view-fallback and the one-time backfill never do.
          allowJobRetype: opts.source === 'job-save'
        });
        if (result) {
          if (result.typeConflict && opts.typeConflicts) opts.typeConflicts.push(Object.assign({ serial }, result.typeConflict));
          if (result.soConflict && opts.soConflicts) opts.soConflicts.push(Object.assign({ serial }, result.soConflict));
          if (result.moved && opts.moves) opts.moves.push(Object.assign({ serial }, result.moved));
        }
      });
      job.equipmentIds = machineIds;
      // Placeholder machines (type only, no serial yet) live on the job
      // itself, never in the Machine store — same fill-only-if-empty rule
      // for productionLine applies to them.
      if (Array.isArray(job.placeholderMachines)) {
        job.placeholderMachines.forEach(p => {
          if (p && job.productionLine && !p.productionLine) p.productionLine = job.productionLine;
        });
      }
      return job;
    }
    // v159 (Phase 15B follow-up, item 7): job.machine is kept, but only as
    // a DERIVED summary — the most common type across the job's serials
    // (their machine records, read back after resolveJobEquipmentSnapshot
    // has just written to them) and placeholders, first type seen wins a
    // tie. Never written back to any machine record; existing readers
    // (parts-request headers, the inspection info card, old exports, old
    // data) keep reading job.machine exactly as before.
    function computeJobMachineSummary(job) {
      if (!job) return '';
      const counts = new Map();
      const order = [];
      const tally = (type) => {
        const t = String(type || '').trim();
        if (!t) return;
        if (!counts.has(t)) { counts.set(t, 0); order.push(t); }
        counts.set(t, counts.get(t) + 1);
      };
      (Array.isArray(job.serials) ? job.serials : []).forEach(s => {
        const machine = findMachineBySerial(jobSerialText(s));
        tally(machine && machine.machineType);
      });
      (Array.isArray(job.placeholderMachines) ? job.placeholderMachines : []).forEach(p => tally(p && p.type));
      let best = '', bestCount = 0;
      order.forEach(t => {
        const c = counts.get(t);
        if (c > bestCount) { best = t; bestCount = c; }
      });
      return best;
    }
    // Same idea as resolveJobEquipmentSnapshot, for one inspection. Called
    // whenever an inspection is actually saved (saveCurrentDraft, and the
    // edit-meta save handler) — never from a mere read. customerId/siteId
    // are taken from the linked job's own already-resolved ids when there
    // is one (a standalone inspection has no job/site to snapshot, so
    // siteId stays ''); equipmentId comes from the inspection's own serial
    // text. The literal placeholder "TBD" (the unlinked-inspection default
    // — see startInspectionFromMachinePopup) is treated as "no real serial
    // yet" and never resolves to a machine.
    function resolveInspectionEquipmentSnapshot(inspection, opts) {
      opts = opts || {};
      if (!inspection) return inspection;
      let customerId = '', siteId = '';
      if (inspection.jobId) {
        const job = (loadJobs() || []).find(j => j && j.id === inspection.jobId);
        if (job) { customerId = job.customerId || ''; siteId = job.siteId || ''; }
      }
      if (!customerId) {
        const customer = findOrCreateCustomer(inspection.customer);
        if (customer) customerId = customer.id;
      }
      if (customerId) inspection.customerId = customerId;
      if (siteId) inspection.siteId = siteId;
      const serial = String(inspection.serial || '').trim();
      if (serial && serial.toUpperCase() !== 'TBD') {
        const machine = findOrCreateMachine(serial);
        if (machine) {
          inspection.equipmentId = machine.id;
          const updates = {};
          if (inspection.model) { updates.machineType = inspection.model; updates.machineTypeSource = 'inspection'; }
          if (siteId) { updates.siteId = siteId; if (customerId) updates.customerId = customerId; }
          if (Object.keys(updates).length) {
            const result = applyMachineUpdate(machine.id, updates, {
              source: opts.source || 'inspection-save',
              jobId: inspection.jobId || '',
              asOf: inspection.date || inspection.createdAt || ''
            });
            if (result) {
              if (result.typeConflict && opts.typeConflicts) opts.typeConflicts.push(Object.assign({ serial }, result.typeConflict));
              if (result.moved && opts.moves) opts.moves.push(Object.assign({ serial }, result.moved));
            }
          }
        }
      }
      return inspection;
    }
    // True once an inspection's machine type must never change again:
    // any recorded answer, or a Complete status. A still-blank Draft
    // remains fully editable. (Approved answer to Decision 2/5.)
    function isInspectionTypeLocked(inspection) {
      if (!inspection) return false;
      if (inspection.status === 'Complete') return true;
      const results = inspection.results;
      if (results && typeof results === 'object' && Object.keys(results).length) return true;
      return false;
    }

    // ===== SERIAL LOCK (Phase 15B, approved amendment G) =====
    // A serial can be added to a job any time, but once a real record
    // (inspection, punchlist item, or parts line) points at its machine
    // id, it can't be removed from the job — removing the chip would
    // silently orphan that reference. Counts every reference across the
    // three record types; the job itself doesn't count (removing FROM the
    // job is what's being asked about). Read-only — never writes.
    function findMachineBySerial(serial) {
      const norm = normalizeMatchText(serial);
      if (!norm) return null;
      return (loadMachines() || []).find(m => m && m.serialNumberNormalized === norm) || null;
    }
    // v157 (Phase 15B, approved amendment A): the display/export source of
    // truth for one record's equipment info — a punchlist item, a parts
    // line, a parts request header. Prefers the snapshot taken at save
    // time (so a later re-label or move never rewrites an old export);
    // falls back to the live machine record only for a record saved
    // before the snapshot fields existed.
    function equipmentDisplayFor(record) {
      const out = { productionLine: '', lineLabel: '', serial: (record && record.serial) || '', machineType: '', salesOrder: '' };
      if (!record) return out;
      const hasSnapshot = Object.prototype.hasOwnProperty.call(record, 'lineLabelAtSave') ||
        Object.prototype.hasOwnProperty.call(record, 'productionLineAtSave') ||
        Object.prototype.hasOwnProperty.call(record, 'machineTypeAtSave') ||
        Object.prototype.hasOwnProperty.call(record, 'salesOrderAtSave');
      if (hasSnapshot) {
        out.lineLabel = record.lineLabelAtSave || '';
        out.productionLine = record.productionLineAtSave || '';
        out.machineType = record.machineTypeAtSave || '';
        out.salesOrder = record.salesOrderAtSave || '';
      } else if (record.equipmentId) {
        const m = (loadMachines() || []).find(x => x && x.id === record.equipmentId);
        if (m) {
          out.lineLabel = m.lineLabel || '';
          out.productionLine = m.productionLine || '';
          out.machineType = m.machineType || '';
          out.salesOrder = m.salesOrder || '';
        }
      }
      return out;
    }
    // "<production line> · <machine line> · <serial>" (roadmap 3.7's export
    // format), dropping any segment that's empty — never a bare " · ·  ".
    function equipmentExportLine(record) {
      const eq = equipmentDisplayFor(record);
      return [eq.productionLine, eq.lineLabel, eq.serial].filter(Boolean).join(' · ');
    }
    function countRecordsUsingEquipmentId(equipmentId) {
      if (!equipmentId) return 0;
      let n = 0;
      try { n += (loadInspections() || []).filter(i => i && i.equipmentId === equipmentId).length; } catch (e) {}
      try {
        if (typeof window.getPunchlistBackup === 'function') {
          const pl = window.getPunchlistBackup();
          const jobsObj = (pl && pl.jobs) || {};
          Object.keys(jobsObj).forEach(key => {
            (jobsObj[key] || []).forEach(item => {
              if (item && item.equipmentId === equipmentId) n += 1;
            });
          });
        }
      } catch (e) {}
      try {
        (loadPartsRequests() || []).forEach(req => {
          if (!req) return;
          if (req.equipmentId === equipmentId) n += 1;
          (req.parts || []).forEach(line => {
            if (line && line.equipmentId === equipmentId) n += 1;
          });
        });
      } catch (e) {}
      return n;
    }
    // Returns '' if the serial may be freely removed, or an explanatory
    // message (approved wording) if it's locked.
    function jobSerialRemovalBlockedMessage(serial) {
      const machine = findMachineBySerial(serial);
      if (!machine) return '';
      const n = countRecordsUsingEquipmentId(machine.id);
      if (!n) return '';
      return "Can't remove — " + n + ' record' + (n === 1 ? '' : 's') + ' use' + (n === 1 ? 's' : '') +
        ' this serial. A manager can correct it in the Local Data Editor.';
    }

    // ===== ONE-TIME EQUIPMENT BACKFILL (Phase 15A) =====
    // Sweeps every existing job, inspection, punchlist item and parts
    // request once, resolving/creating Customer, Site and Machine records
    // by exact normalized match and stamping the new id fields — the
    // "backfill existing records" half of the task. Guarded by a
    // localStorage flag (same pattern as the existing sample-data-seeded
    // flags) so it only actually runs once per device; runEquipmentBackfill
    // itself is exposed unguarded on window for testing (amendment H
    // requires it to be safe to run twice: idempotent by construction,
    // since every step below is find-or-create-by-exact-match or an
    // update that only writes when a value truly changed).
    function sortByDateThenCreated(list, dateField) {
      return (list || []).slice().sort((a, b) => {
        const ad = (a && (a[dateField] || a.createdAt)) || '';
        const bd = (b && (b[dateField] || b.createdAt)) || '';
        if (ad < bd) return -1;
        if (ad > bd) return 1;
        return 0;
      });
    }
    async function runEquipmentBackfill() {
      if (lxsIsV2Safe()) return LXS.withSource('backfill', '', runEquipmentBackfillInner);
      return runEquipmentBackfillInner();
    }
    async function runEquipmentBackfillInner() {
      const report = {
        machinesBefore: (loadMachines() || []).length,
        machinesAfter: 0,
        machinesCreated: 0,
        moves: [],
        typeConflicts: [],
        soConflicts: [],
        multiSerialSoSkipped: []
      };

      // 1) Jobs, oldest first — establishes each machine's first-seen type
      // (job-sourced) and site, and every job-vs-job type/SO conflict.
      const jobs = loadJobs();
      sortByDateThenCreated(jobs, 'date').forEach(job => {
        resolveJobEquipmentSnapshot(job, {
          source: 'backfill',
          typeConflicts: report.typeConflicts,
          soConflicts: report.soConflicts,
          moves: report.moves,
          multiSerialSoSkipped: report.multiSerialSoSkipped
        });
      });
      saveJobs(jobs);

      // 2) Inspections, oldest first — inspection-sourced type always wins
      // over a job-sourced one (applyMachineUpdate enforces this), and the
      // most recent inspection's type wins over an earlier inspection's,
      // simply because it's applied last.
      const inspections = loadInspections();
      sortByDateThenCreated(inspections, 'date').forEach(ins => {
        resolveInspectionEquipmentSnapshot(ins, {
          source: 'backfill',
          typeConflicts: report.typeConflicts,
          moves: report.moves
        });
      });
      saveInspections(inspections);

      // 3) Punchlist items — ids only (never a machine type), from each
      // item's own serial and its bucket's linked job (already resolved
      // above). Reached through the module's own exposed backup getter,
      // since punchlist state lives in a private module scope.
      try {
        if (typeof plLoadData === 'function') await plLoadData();
        if (typeof window.getPunchlistBackup === 'function' && typeof window.setPunchlistBackup === 'function') {
          const pl = window.getPunchlistBackup();
          const jobsObj = (pl && pl.jobs) || {};
          const jobIdByKey = (pl && pl.jobIdByKey) || {};
          const freshJobs = loadJobs();
          let plChanged = false;
          Object.keys(jobsObj).forEach(key => {
            const jobId = jobIdByKey[key];
            const linkedJob = jobId ? freshJobs.find(j => j && j.id === jobId) : null;
            (jobsObj[key] || []).forEach(item => {
              if (!item) return;
              const nextCustomerId = linkedJob ? (linkedJob.customerId || '') : (item.customerId || '');
              const nextSiteId = linkedJob ? (linkedJob.siteId || '') : (item.siteId || '');
              let nextEquipmentId = item.equipmentId || '';
              const serial = String(item.serial || '').trim();
              if (serial) {
                const machine = findOrCreateMachine(serial);
                if (machine) nextEquipmentId = machine.id;
              }
              if (item.customerId !== nextCustomerId || item.siteId !== nextSiteId || item.equipmentId !== nextEquipmentId) {
                item.customerId = nextCustomerId;
                item.siteId = nextSiteId;
                item.equipmentId = nextEquipmentId;
                plChanged = true;
              }
            });
          });
          if (plChanged) await window.setPunchlistBackup(pl);
        }
      } catch (e) { console.warn('backfill: punchlist sweep failed', e); }

      // 4) Parts requests — header + line ids, via the same stamping
      // function used at every real save.
      const requests = loadPartsRequests();
      let requestsChanged = false;
      requests.forEach(req => {
        const before = JSON.stringify(req);
        stampPartsRequestEquipment(req);
        if (JSON.stringify(req) !== before) requestsChanged = true;
      });
      if (requestsChanged) savePartsRequests(requests);

      report.machinesAfter = (loadMachines() || []).length;
      report.machinesCreated = Math.max(0, report.machinesAfter - report.machinesBefore);
      return report;
    }
    async function runEquipmentBackfillIfNeeded() {
      if (lsRead('lx8_equipment_backfill_v1_done', false)) return null;
      let report = null;
      try {
        report = await runEquipmentBackfill();
      } catch (e) {
        console.warn('equipment backfill failed', e);
        return null;
      }
      lsWrite('lx8_equipment_backfill_v1_done', true);
      return report;
    }
    window.runEquipmentBackfill = runEquipmentBackfill;
    window.runEquipmentBackfillIfNeeded = runEquipmentBackfillIfNeeded;

    // ===== PARTS REQUESTS =====
    // Same load/save shape as loadJobs/saveJobs above. Photo blobs live in
    // IndexedDB (idbPutPhoto) referenced by photoId, exactly like inspection
    // photos; each part also keeps a small inline photoThumb data URL for
    // instant rendering and — critically — for a synchronous Web Share (see
    // sharePartsRequest below).
    function loadPartsRequests() {
      const src = STORE.load('partsRequests');
      storeMem.partsRequests = Array.isArray(src) ? src : [];
      return storeMem.partsRequests;
    }
    function savePartsRequests(list) {
      storeMem.partsRequests = Array.isArray(list) ? list : [];
      return STORE.save('partsRequests', storeMem.partsRequests);
    }
    // A short, human-readable "#104"-style number, distinct from the
    // opaque internal id (pr_xxxxx) — assigned lazily the first time a
    // request is actually saved (see savePartsFormDraft) rather than the
    // moment the screen opens, so an abandoned draft doesn't burn a number.
    function nextPartsRequestSeq() {
      const n = (lsRead('lx8_parts_request_seq', 0) || 0) + 1;
      lsWrite('lx8_parts_request_seq', n);
      return n;
    }
    function findActiveJobForContext() {
      const jobs = getCurrentJobs();
      return jobs.find(j => j && j.status === 'In Progress') || jobs[0] || null;
    }
    function newPartsRequestDraft(jobId) {
      const jobs = loadJobs();
      const job = (jobId && jobs.find(j => j.id === jobId)) || findActiveJobForContext();
      const now = new Date().toISOString();
      return {
        id: newEntityId('pr'),
        seq: null,
        jobId: job ? job.id : '',
        customer: job ? (job.customer || '') : '',
        site: job ? (job.site || '') : '',
        machine: job ? (job.machine || '') : '',
        serial: (job && Array.isArray(job.serials) && job.serials.length) ? job.serials[0] : '',
        salesOrder: job ? (job.so || '') : '',
        technician: (job && job.technician) ? job.technician : profileName(),
        urgent: false,
        status: 'unsent',
        createdAt: now,
        updatedAt: now,
        parts: []
      };
    }
    function newPartsRequestLine() {
      // serial/machineType/salesOrder (Phase 15B, item 7): each line
      // carries its own equipment snapshot rather than only the request
      // header's, since one job's parts can be for different machines.
      return { id: newEntityId('prp'), description: '', qty: 1, partNumber: '', notes: '', photoId: null, photoThumb: '', urgent: false, serial: '', machineType: '', salesOrder: '' };
    }
    // Phase 15A: stamps/refreshes a parts request's own customerId/siteId/
    // equipmentId (from its linked job and its own header `serial` field)
    // and fills in any line that doesn't already have its own equipmentId
    // (a manually-added line, or one from before this phase) with the
    // header's — amendment E's "header ids only for lines with no source
    // serial". A line already stamped with its own source serial's
    // equipmentId (see syncPartsRequestFromSource) is left untouched.
    // Called only from real save points (savePartsFormDraft and
    // syncPartsRequestFromSource) — never merely on open.
    function stampPartsRequestEquipment(req) {
      if (!req) return;
      const job = req.jobId ? (loadJobs() || []).find(j => j && j.id === req.jobId) : null;
      req.customerId = job ? (job.customerId || '') : (req.customerId || '');
      req.siteId = job ? (job.siteId || '') : (req.siteId || '');
      const headerSerial = String(req.serial || '').trim();
      let headerMachine = null;
      if (headerSerial && typeof findOrCreateMachine === 'function') {
        headerMachine = findOrCreateMachine(headerSerial);
        if (headerMachine) req.equipmentId = headerMachine.id;
      }
      (req.parts || []).forEach(line => {
        if (!line) return;
        if (!line.equipmentId) line.equipmentId = req.equipmentId || '';
        line.customerId = req.customerId || '';
        line.siteId = req.siteId || '';
        // A manually-added line (or one from before this field existed)
        // with no serial of its own inherits the header's, same rule as
        // equipmentId above; a line with its own source serial (see
        // syncPartsRequestFromSource) keeps it.
        if (!line.serial && headerSerial) {
          line.serial = headerSerial;
          if (headerMachine) {
            line.machineType = headerMachine.machineType || '';
            line.salesOrder = headerMachine.salesOrder || '';
            line.lineLabelAtSave = headerMachine.lineLabel || '';
            line.productionLineAtSave = headerMachine.productionLine || '';
            line.machineTypeAtSave = headerMachine.machineType || '';
            line.salesOrderAtSave = headerMachine.salesOrder || '';
          }
        }
      });
    }
    // Auto-generates or updates a parts-request line from a punchlist
    // item or inspection finding. One draft per job, not one per
    // finding — reuses whatever unsent draft already exists for the
    // job rather than starting a new one, the same rule the Parts
    // screen's own "+" already follows. Each generated line is tagged
    // with source {type, id} so re-saving the same item updates its
    // one line instead of duplicating it, and clearing the part name
    // removes that line again. A line's own serial isn't a field this
    // schema has (requests carry one serial, not per-line) — where a
    // job has multiple machines and this item's resolved serial
    // differs from the request's own, that's folded into the line's
    // notes instead of silently lost.
    function syncPartsRequestFromSource(opts) {
      const { sourceType, sourceId, jobId, description, urgent, serial, findingLabel } = opts || {};
      if (!jobId || !sourceType || !sourceId) return;
      const desc = (description || '').trim();
      let requests = loadPartsRequests();
      let req = requests.find(r => r.status === 'unsent' && r.jobId === jobId);

      if (!req) {
        if (!desc) return;
        req = newPartsRequestDraft(jobId);
        requests.push(req);
      }
      req.parts = req.parts || [];
      const idx = req.parts.findIndex(p => p && p.source && p.source.type === sourceType && p.source.id === sourceId);

      if (!desc) {
        if (idx > -1) req.parts.splice(idx, 1);
      } else {
        // Bugfix: this used to only show the serial when it differed
        // from the request's own req.serial — meant to avoid repeating
        // it when they matched, since req.serial is already shown
        // elsewhere on the request. In practice this made the note
        // appear or disappear based on a comparison the technician has
        // no visibility into, so a part generated from a punchlist item
        // that always has a serial attached would sometimes show it and
        // sometimes not, with no visible reason why. Now shows whenever
        // the source item has a serial, full stop.
        const serialNote = serial ? ('Serial ' + serial) : '';
        // Phase 15A / amendment E: a line generated from a punchlist item
        // or inspection finding is stamped with THAT item's own serial's
        // equipmentId, not the request header's — a job with more than one
        // machine can have findings against different ones.
        const sourceMachine = (serial && typeof findOrCreateMachine === 'function') ? findOrCreateMachine(serial) : null;
        if (idx > -1) {
          const line = req.parts[idx];
          line.description = desc;
          line.urgent = !!urgent;
          line.source = { type: sourceType, id: sourceId, label: findingLabel || '' };
          if (serialNote) line.notes = serialNote;
          if (sourceMachine) {
            line.equipmentId = sourceMachine.id;
            line.serial = serial || '';
            line.machineType = sourceMachine.machineType || '';
            line.salesOrder = sourceMachine.salesOrder || '';
            line.lineLabelAtSave = sourceMachine.lineLabel || '';
            line.productionLineAtSave = sourceMachine.productionLine || '';
            line.machineTypeAtSave = sourceMachine.machineType || '';
            line.salesOrderAtSave = sourceMachine.salesOrder || '';
          }
        } else {
          const line = newPartsRequestLine();
          line.description = desc;
          line.urgent = !!urgent;
          line.source = { type: sourceType, id: sourceId, label: findingLabel || '' };
          if (serialNote) line.notes = serialNote;
          if (sourceMachine) {
            line.equipmentId = sourceMachine.id;
            line.serial = serial || '';
            line.machineType = sourceMachine.machineType || '';
            line.salesOrder = sourceMachine.salesOrder || '';
            line.lineLabelAtSave = sourceMachine.lineLabel || '';
            line.productionLineAtSave = sourceMachine.productionLine || '';
            line.machineTypeAtSave = sourceMachine.machineType || '';
            line.salesOrderAtSave = sourceMachine.salesOrder || '';
          }
          req.parts.push(line);
        }
      }
      if (typeof stampPartsRequestEquipment === 'function') stampPartsRequestEquipment(req);
      req.updatedAt = new Date().toISOString();
      savePartsRequests(requests);
      // Keep the open Parts screen in sync if this request happens to
      // be on-screen right now (e.g. a manager reviewing while a tech
      // logs a finding elsewhere isn't realistic today, but re-opening
      // the same job's draft right after logging a finding is).
      if (typeof partsFormDraft !== 'undefined' && partsFormDraft && partsFormDraft.id === req.id && typeof renderPartsForm === 'function') {
        partsFormDraft = JSON.parse(JSON.stringify(req));
        renderPartsForm();
      }
      if (typeof refreshPartsList === 'function') refreshPartsList();
    }
    // Removes any auto-generated line tied to a since-deleted finding —
    // if the underlying problem is gone, a lingering part request for
    // it shouldn't stick around silently.
    function removePartsRequestSource(sourceType, sourceId) {
      if (!sourceType || !sourceId) return;
      const requests = loadPartsRequests();
      let changed = false;
      requests.forEach(req => {
        if (req.status !== 'unsent' || !Array.isArray(req.parts)) return;
        const idx = req.parts.findIndex(p => p && p.source && p.source.type === sourceType && p.source.id === sourceId);
        if (idx > -1) { req.parts.splice(idx, 1); req.updatedAt = new Date().toISOString(); changed = true; }
      });
      if (changed) {
        savePartsRequests(requests);
        if (typeof refreshPartsList === 'function') refreshPartsList();
      }
    }
    function partsRequestHasUrgent(req) {
      return !!(req.urgent || (req.parts || []).some(p => p && p.urgent));
    }
    function partsRequestSummary(req) {
      const parts = req.parts || [];
      return {
        sub: [req.customer, [req.machine, req.serial ? ('Serial ' + req.serial) : ''].filter(Boolean).join(' — ')].filter(Boolean).join(' · '),
        partsCount: parts.length
      };
    }
    function formatPartsRequestText(req) {
      const lines = [];
      lines.push('PARTS REQUEST');
      lines.push('From: ' + (req.technician || ''));
      lines.push('Site: ' + (req.site || ''));
      lines.push('Machine: ' + (req.machine || ''));
      lines.push('Sales Order: ' + (req.salesOrder || ''));
      lines.push('Serial Number: ' + (req.serial || ''));
      if (partsRequestHasUrgent(req)) lines.push('URGENT!!!');
      lines.push('');
      lines.push('');
      const parts = (req.parts || []).filter(p => p.description || p.qty);
      parts.forEach((p, i) => {
        const sku = p.partNumber ? '  [' + p.partNumber + ']' : '';
        lines.push((i + 1) + '. ' + (p.qty || 1) + '× ' + (p.description || 'Unspecified part') + sku);
        // v157 (Phase 15B, item 7 + amendment E): each line shows its OWN
        // serial/type/SO/lines — a job with more than one machine can have
        // parts for different ones, so the request header alone isn't
        // enough once there's more than one line.
        const eq = (typeof equipmentDisplayFor === 'function') ? equipmentDisplayFor(p) : null;
        if (eq && (eq.productionLine || eq.lineLabel || eq.serial)) {
          const bits = [eq.productionLine, eq.lineLabel, eq.serial, eq.machineType, eq.salesOrder ? 'SO ' + eq.salesOrder : ''].filter(Boolean);
          lines.push('   Machine: ' + bits.join(' · '));
        }
        if (p.notes) lines.push('   Notes: ' + p.notes);
        if (i < parts.length - 1) lines.push('');
      });
      lines.push('');
      lines.push('');
      lines.push('Sent from field parts request');
      return lines.join('\n');
    }
    // Synchronous data-URL -> Blob (no IndexedDB round-trip). navigator.share()
    // must fire with no meaningful delay after the tap that triggered it, or
    // the browser silently drops the share sheet — this keeps everything
    // before the actual share call synchronous.
    function dataUrlToBlob(dataUrl) {
      const [meta, b64] = String(dataUrl || '').split(',');
      if (!b64) return null;
      const mime = (meta.match(/data:([^;]+);base64/) || [, 'image/jpeg'])[1];
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }
    function collectPartsRequestPhotoFiles(req) {
      const files = [];
      (req.parts || []).forEach(p => {
        if (!p.photoThumb) return;
        const blob = dataUrlToBlob(p.photoThumb);
        if (!blob) return;
        files.push(new File([blob], (p.description || 'part').replace(/[^a-z0-9]+/gi, '-').slice(0, 40) + '.jpg', { type: blob.type || 'image/jpeg' }));
      });
      return files;
    }
    async function sharePartsRequest(req) {
      const text = formatPartsRequestText(req);
      const files = collectPartsRequestPhotoFiles(req);
      const shareData = { title: 'Parts Request' + (req.urgent ? ' — URGENT' : ''), text };
      try {
        if (navigator.share) {
          if (files.length && (!navigator.canShare || navigator.canShare({ files }))) shareData.files = files;
          await navigator.share(shareData);
          return true;
        }
      } catch (e) {
        if (e && e.name === 'AbortError') return false;
      }
      openPartsShareFallback(text);
      return false;
    }
    function openPartsShareFallback(text) {
      const ta = document.getElementById('partsShareText');
      if (ta) ta.value = text;
      const sheet = document.getElementById('partsShareSheet');
      if (sheet) {
        sheet.hidden = false;
        sheet.removeAttribute('hidden');
        // Match the same open sequence every other .save-sheet uses (e.g.
        // closePunchlistLinkSheet's counterpart): hidden must come off
        // before .show is added, or the slide-up transition never plays.
        requestAnimationFrame(() => sheet.classList.add('show'));
      }
    }
    function closePartsShareSheet() {
      const sheet = document.getElementById('partsShareSheet');
      if (sheet) {
        sheet.classList.remove('show');
        sheet.hidden = true;
        sheet.setAttribute('hidden', '');
      }
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
            <div class="title">${jobEsc(job.customer || 'Untitled job')}${isSampleJob(job) ? SAMPLE_TAG_HTML : ''}</div>
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

    // ===== PARTS REQUESTS UI =====
    let partsFormDraft = null;
    let partsListStatus = 'unsent';
    let partsLineEditingId = null; // id of the line currently open in the modal, or null = adding new

    function partsRequestStatusLabel(status) {
      if (status === 'pending') return 'Pending';
      if (status === 'complete') return 'Complete';
      return 'Unsent';
    }
    function partsRequestStatusBadgeClass(status) {
      if (status === 'pending') return 'badge-inprogress';
      if (status === 'complete') return 'badge-complete';
      return 'badge-draft';
    }
    function formatPartsRequestDate(iso) {
      try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
      catch (e) { return ''; }
    }

    function refreshPartsList() {
      const container = document.getElementById('partsRequestsList');
      if (!container) return;
      const all = loadPartsRequests().slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      const list = all.filter(r => (r.status || 'unsent') === partsListStatus);
      if (!list.length) {
        container.innerHTML = `<div class="empty-state">
          <div class="icon"><svg viewBox="0 0 24 24" width="40" height="40" fill="none" aria-hidden="true"><rect x="4.5" y="5" width="15" height="10.4" rx="3.2" stroke="currentColor" stroke-width="0.9"/><path d="M8.6 15.4v3.6l4-3.6" stroke="currentColor" stroke-width="0.9" stroke-linejoin="round" stroke-linecap="round"/><path d="M7.8 8.6h9M7.8 11.4h5.8" stroke="currentColor" stroke-width="0.9" stroke-linecap="round"/></svg></div>
          <p>No ${jobEsc(partsRequestStatusLabel(partsListStatus).toLowerCase())} parts requests.</p>
        </div>`;
        return;
      }
      container.innerHTML = list.map(req => {
        const sum = partsRequestSummary(req);
        return `<div class="pl-item${partsRequestHasUrgent(req) ? ' priority-high' : ''}" data-id="${req.id}">
          <div class="list-item-main">
            <div class="title">Parts Request${req.seq ? ' #' + req.seq : ''}${partsRequestHasUrgent(req) ? ' <span class="badge badge-urgent">Urgent</span>' : ''}</div>
            <div class="sub">${jobEsc(sum.sub || 'No job linked')}</div>
            <div class="action-line">${sum.partsCount} part${sum.partsCount !== 1 ? 's' : ''} · ${jobEsc(formatPartsRequestDate(req.updatedAt))}</div>
          </div>
          <div class="list-item-actions">
            <span class="badge ${partsRequestStatusBadgeClass(req.status)}">${partsRequestStatusLabel(req.status)}</span>
          </div>
        </div>`;
      }).join('');
      container.querySelectorAll('[data-id]').forEach(el => {
        el.addEventListener('click', (ev) => {
          if (typeof window.swipeIgnoreClicksUntil === 'number' && Date.now() < window.swipeIgnoreClicksUntil) return;
          if (ev.currentTarget.closest && ev.currentTarget.closest('.swipe-host.swipe-open')) return;
          openPartsForm(el.getAttribute('data-id'));
        });
      });
      if (typeof bindSwipeToDelete === 'function') {
        bindSwipeToDelete(container, '.pl-item', (row) => ({
          id: row.getAttribute('data-id'),
          kind: 'parts-request',
          title: 'Delete parts request?',
          label: 'This parts request will be permanently deleted.'
        }));
      }
    }

    function setPartsListTab(status) {
      partsListStatus = status;
      document.querySelectorAll('#partsSeg .seg-btn').forEach(btn => {
        const on = btn.getAttribute('data-status') === status;
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      const seg = document.getElementById('partsSeg');
      if (seg) seg.setAttribute('data-mode', status);
      refreshPartsList();
    }
    // One-time bounce-landing entrance for the thumb, matching exactly how
    // tcOpenExportSheet() lands #tcExportSeg's thumb when that sheet opens.
    function landPartsSeg() {
      const seg = document.getElementById('partsSeg');
      if (!seg) return;
      seg.classList.remove('seg-land');
      void seg.offsetWidth;
      requestAnimationFrame(() => seg.classList.add('seg-land'));
    }

    function openPartsForm(requestIdOrNull, jobId) {
      if (requestIdOrNull) {
        const existing = loadPartsRequests().find(r => r.id === requestIdOrNull);
        partsFormDraft = existing ? JSON.parse(JSON.stringify(existing)) : newPartsRequestDraft(jobId);
      } else {
        partsFormDraft = newPartsRequestDraft(jobId);
      }
      renderPartsForm();
      showScreen('screenPartsForm');
      setHeader('Parts Request');
    }

    function renderPartsFormHeader() {
      const req = partsFormDraft;
      const el = document.getElementById('pfHeaderTitle');
      if (!el) return;
      el.textContent = (req && req.seq) ? ('Parts Request #' + req.seq) : 'New Parts Request';
    }
    // Delivery-truck icon for the thumb button on each part row.
    const PARTS_TRUCK_ICON = '<svg viewBox="0 0 24 24" fill="none"><path d="M1.5 10h2M1.5 13.5h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M6.5 9h9.5v8h-9.5z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M16 12h3l2 2.4V17h-5z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="10" cy="18.3" r="1.7" fill="currentColor"/><circle cx="18.2" cy="18.3" r="1.7" fill="currentColor"/></svg>';
    function renderPartsForm() {
      const req = partsFormDraft;
      if (!req) return;
      renderPartsFormHeader();
      const dash = (v) => (v && String(v).trim()) ? String(v).trim() : '—';
      document.getElementById('pfJob').textContent = dash(req.customer);
      document.getElementById('pfSite').textContent = dash(req.site);
      document.getElementById('pfMachine').textContent = dash(req.machine);
      // Serial / Sales Order / Technician are still fully auto-filled on
      // the request object (see newPartsRequestDraft) and still go out
      // in the share text — just no longer shown in this on-screen
      // summary. A tech only needs Job/Site/Machine to confirm they're
      // on the right request; the rest is populated for the recipient,
      // not something they need to double-check here.
      const urgentBtn = document.getElementById('btnPartsUrgent');
      if (urgentBtn) urgentBtn.classList.toggle('on', !!req.urgent);
      const readOnly = req.status !== 'unsent';
      document.querySelectorAll('#screenPartsForm [data-parts-editable]').forEach(el => el.classList.toggle('hidden', readOnly));
      const sendBtn = document.getElementById('btnPartsSend');
      if (sendBtn) sendBtn.textContent = req.status === 'unsent' ? 'Send' : 'Share again';
      // v152 (Phase 12A Fix 5): dimmed instead of disabled, so tapping it
      // with no parts says "Add at least one part" instead of doing nothing.
      sendBtn.disabled = false;
      sendBtn.classList.toggle('is-incomplete', !(req.parts || []).length);

      const listEl = document.getElementById('partsFormList');
      const parts = req.parts || [];
      if (!parts.length) {
        listEl.innerHTML = `<div class="empty-state compact"><p>No parts added yet.</p></div>`;
      } else {
        const sourceIcon = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14.7 6.3a4 4 0 00-5.4 4.7L4 16.3V20h3.7l5.3-5.3a4 4 0 004.7-5.4l-2.8 2.8-2-2 2.8-2.8z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
        // Delivery-truck icon at rest in the thumb "button" — a real
        // photo takes its place there instead when one's attached, same
        // spot either way rather than two different places on the row.
        // Urgent and the thumb now share a right-side column — Urgent
        // on top, thumb directly below it — rather than Urgent sitting
        // inline with the title and the thumb on the left. Same row,
        // same existing padding on both pieces; only their position
        // changed.
        // Truck icon button is fixed on the left, always — it's a
        // generic "this is a part" indicator, not a photo slot, so it
        // never swaps out. A real attached photo is its own separate
        // thing, shown on the right under Urgent instead.
        listEl.innerHTML = parts.map(p => `<div class="pl-item${p.urgent ? ' priority-high' : ''}" data-line-id="${p.id}">
          <div class="pf-thumb-btn">${PARTS_TRUCK_ICON}</div>
          <div class="list-item-main">
            <div class="title">${jobEsc(p.description || 'Unnamed part')}</div>
            <div class="sub">Qty ${p.qty || 1}${p.partNumber ? ' · ' + jobEsc(p.partNumber) : ''}</div>
            ${p.notes ? `<div class="action-line">→ ${jobEsc(p.notes)}</div>` : ''}
            ${p.source && p.source.label ? `<div class="source-line">${sourceIcon}From: ${jobEsc(p.source.label)}</div>` : ''}
          </div>
          <div class="pf-right-rail">
            ${p.urgent ? '<span class="badge badge-urgent pf-rail-urgent">Urgent</span>' : ''}
            ${p.photoThumb ? `<img class="pf-rail-photo" src="${p.photoThumb}" alt="Part photo" data-line-photo="${p.id}">` : ''}
          </div>
        </div>`).join('');
        listEl.querySelectorAll('[data-line-id]').forEach(el => {
          el.addEventListener('click', (ev) => {
            if (typeof window.swipeIgnoreClicksUntil === 'number' && Date.now() < window.swipeIgnoreClicksUntil) return;
            if (ev.currentTarget.closest && ev.currentTarget.closest('.swipe-host.swipe-open')) return;
            if (ev.target && ev.target.closest && ev.target.closest('.pf-rail-photo')) return;
            openPartsLineModal(el.getAttribute('data-line-id'));
          });
        });
        listEl.querySelectorAll('.pf-rail-photo').forEach(img => {
          img.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            openPartsRequestPhoto(ev, img.getAttribute('data-line-photo'), img.src);
          });
        });
        if (typeof bindSwipeToDelete === 'function') {
          bindSwipeToDelete(listEl, '.pl-item', (row) => ({
            id: row.getAttribute('data-line-id'),
            kind: 'parts-line',
            title: 'Delete part?',
            label: 'This part will be removed from the request.'
          }));
        }
      }
    }

    function openPartsLineModal(lineIdOrNull) {
      partsLineEditingId = lineIdOrNull;
      const line = lineIdOrNull ? (partsFormDraft.parts || []).find(p => p.id === lineIdOrNull) : newPartsRequestLine();
      document.getElementById('plineTitle').textContent = lineIdOrNull ? 'Edit part' : 'Add part';
      document.getElementById('plineDesc').value = line.description || '';
      const qtySelect = document.getElementById('plineQty');
      // Native <select> picker, same as the rest of the app (job/machine/
      // status pickers etc.) — iOS/Android render this as their own
      // built-in wheel/list picker.
      if (qtySelect && !qtySelect.options.length) {
        for (let n = 1; n <= 20; n++) {
          const opt = document.createElement('option');
          opt.value = String(n);
          opt.textContent = String(n);
          qtySelect.appendChild(opt);
        }
      }
      qtySelect.value = line.qty || 1;
      document.getElementById('plinePartNumber').value = line.partNumber || '';
      document.getElementById('plineNotes').value = line.notes || '';
      const urgentBtn = document.getElementById('btnLineUrgent');
      if (urgentBtn) urgentBtn.classList.toggle('on', !!line.urgent);
      const thumb = document.getElementById('plinePhotoPreview');
      if (line.photoThumb) { thumb.src = line.photoThumb; thumb.classList.remove('hidden'); }
      else { thumb.src = ''; thumb.classList.add('hidden'); }
      window.__partsLineDraftPhoto = { photoId: line.photoId, photoThumb: line.photoThumb };
      bindPartsLinePhotoPreview();
      clearMissingFlag(document.getElementById('plineDesc')); // v152 (Phase 12A Fix 5)
      refreshPartsLineRequired();
      document.getElementById('partsLineModal').classList.add('show');
    }
    // v152 (Phase 12A Fix 5): Save dimmed until the part has a description.
    function refreshPartsLineRequired() {
      const d = document.getElementById('plineDesc');
      const btn = document.getElementById('plineSave');
      if (!d || !btn) return;
      const ready = !!d.value.trim();
      btn.classList.toggle('is-incomplete', !ready);
      if (ready) clearMissingFlag(d);
    }
    function closePartsLineModal() {
      document.getElementById('partsLineModal').classList.remove('show');
      partsLineEditingId = null;
    }
    function bindPartsLinePhotoPreview() {
      const thumb = document.getElementById('plinePhotoPreview');
      if (!thumb || thumb.dataset.viewerBound === '1') return;
      thumb.dataset.viewerBound = '1';
      thumb.addEventListener('click', (ev) => {
        if (!thumb.src || thumb.classList.contains('hidden')) return;
        openPartsRequestPhoto(ev, partsLineEditingId || 'draft', thumb.src);
      });
    }
    async function openPartsRequestPhoto(ev, lineId, fallbackSrc) {
      if (ev) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      let src = fallbackSrc || '';
      const line = (lineId && lineId !== 'draft' && partsFormDraft)
        ? (partsFormDraft.parts || []).find(p => String(p.id) === String(lineId))
        : null;
      const photoId = (line && line.photoId) || (window.__partsLineDraftPhoto && window.__partsLineDraftPhoto.photoId);
      if (photoId && typeof STORE !== 'undefined' && typeof STORE.getPhoto === 'function') {
        try {
          const rec = await STORE.getPhoto(photoId);
          if (rec && rec.blob && typeof blobToObjectUrl === 'function') src = blobToObjectUrl(rec.blob);
        } catch (e) {}
      }
      if (!src && line && line.photoThumb) src = line.photoThumb;
      if (!src) return;
      window.__partsPhotoLineId = lineId || 'draft';
      if (typeof openPhotoViewer === 'function') openPhotoViewer(src, 'parts', lineId || 'draft');
    }
    function requestDeletePartsPhoto(ev) {
      if (ev) ev.stopPropagation();
      const id = window.__partsPhotoLineId || partsLineEditingId || 'parts-photo';
      if (typeof showDeleteConfirm === 'function') {
        showDeleteConfirm(id, 'parts-photo', 'Delete photo?', 'This photo will be removed from the part.');
      }
    }
    function performDeletePartsPhoto() {
      const lineId = window.__partsPhotoLineId;
      let photoId = null;
      if (partsFormDraft && lineId && lineId !== 'draft' && lineId !== 'parts-photo') {
        const line = (partsFormDraft.parts || []).find(p => String(p.id) === String(lineId));
        if (line) {
          photoId = line.photoId || null;
          line.photoId = null;
          line.photoThumb = '';
        }
      }
      const editingThis = !lineId || lineId === 'draft' || lineId === 'parts-photo' || String(partsLineEditingId) === String(lineId);
      if (editingThis && window.__partsLineDraftPhoto) {
        if (!photoId) photoId = window.__partsLineDraftPhoto.photoId || null;
        window.__partsLineDraftPhoto = { photoId: null, photoThumb: '' };
        const thumb = document.getElementById('plinePhotoPreview');
        if (thumb) {
          thumb.src = '';
          thumb.classList.add('hidden');
        }
      }
      if (photoId && typeof STORE !== 'undefined' && typeof STORE.deletePhotos === 'function') {
        STORE.deletePhotos([photoId]).catch(() => {});
      }
      if (partsFormDraft && typeof savePartsFormDraft === 'function') savePartsFormDraft(false);
      if (typeof renderPartsForm === 'function') renderPartsForm();
      if (typeof closePunchlistPhoto === 'function') closePunchlistPhoto();
      if (typeof closeDeleteModal === 'function') closeDeleteModal();
      toast('Photo deleted');
    }
    window.openPartsRequestPhoto = openPartsRequestPhoto;
    window.requestDeletePartsPhoto = requestDeletePartsPhoto;
    window.performDeletePartsPhoto = performDeletePartsPhoto;
    function savePartsLineModal() {
      const description = document.getElementById('plineDesc').value.trim();
      const qty = parseInt(document.getElementById('plineQty').value, 10) || 1;
      const partNumber = document.getElementById('plinePartNumber').value.trim();
      const notes = document.getElementById('plineNotes').value.trim();
      if (!description) { flagMissingField(document.getElementById('plineDesc')); toast('Enter a part description'); return; }
      const urgent = document.getElementById('btnLineUrgent').classList.contains('on');
      const photo = window.__partsLineDraftPhoto || {};
      if (partsLineEditingId) {
        const line = partsFormDraft.parts.find(p => p.id === partsLineEditingId);
        Object.assign(line, { description, qty, partNumber, notes, urgent, photoId: photo.photoId || null, photoThumb: photo.photoThumb || '' });
      } else {
        partsFormDraft.parts.push({ id: newEntityId('prp'), description, qty, partNumber, notes, urgent, photoId: photo.photoId || null, photoThumb: photo.photoThumb || '' });
      }
      closePartsLineModal();
      renderPartsForm();
      // Local-first: persist the moment a part is actually added/edited,
      // not only when the technician later taps the explicit Save button.
      // Without this, navigating away before tapping Save silently lost
      // whatever parts had just been added.
      savePartsFormDraft(false);
    }
    // readFileDataUrl exists elsewhere in this app but is private to a
    // different module's closure, not globally accessible — this is its
    // own small, self-contained copy rather than reaching into that
    // module's internals for something this trivial.
    function partsReadFileDataUrl(file) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(file);
      });
    }
    async function attachPartsRequestPhoto(file) {
      if (!file) return;
      try {
        const blob = await compressImageFile(file, 1600, 0.72);
        const id = 'pr_line_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        await STORE.putPhoto({ id, blob: blob || file, caption: '', createdAt: Date.now() });
        const thumbBlob = await compressImageFile(file, 320, 0.6).catch(() => null);
        const dataUrl = await partsReadFileDataUrl(thumbBlob || blob || file).catch(() => '');
        window.__partsLineDraftPhoto = { photoId: id, photoThumb: dataUrl };
        const thumb = document.getElementById('plinePhotoPreview');
        thumb.src = dataUrl; thumb.classList.remove('hidden');
        toast('Photo attached');
      } catch (e) { toast('Could not attach photo'); }
    }

    // Phase 7C (C1): now returns the real persist outcome instead of
    // leaving savePartsRequests' return value on the floor. The
    // "saved" toast — and the two callers below that already show
    // their own completion toast right after a persist
    // (performDeletePartsRequest, performDeletePartsLine) — are
    // conditioned on it, same shape as the job/punchlist-item fix in
    // Phase 7B. showConfirmation=false callers (e.g. autosave-on-part-
    // line-delete below) still persist silently either way — this
    // only changes whether a toast that was ALREADY going to show
    // fires on the right condition, not whether persistence happens.
    function savePartsFormDraft(showConfirmation) {
      if (!partsFormDraft) return true;
      // v152 (Phase 12A Fix 5): a request that has never been saved and
      // has no parts yet is not saved (e.g. tapping Urgent on a blank
      // request used to save it and use up a #number). It stays on screen
      // and is saved the moment the first part is added. A request that's
      // already saved keeps saving normally, so deleting its last part
      // still sticks.
      if (!(partsFormDraft.parts || []).length &&
          !loadPartsRequests().some(r => r && r.id === partsFormDraft.id)) {
        return true;
      }
      if (!partsFormDraft.seq) {
        partsFormDraft.seq = nextPartsRequestSeq();
        // The screen header shows this once assigned — update it in place
        // if the form is the thing currently on screen.
        renderPartsFormHeader();
      }
      // Phase 15A: this is the real, single commit point for the manual
      // Parts Request form (header edits, adding/editing/deleting a line,
      // sending) — stamp/refresh equipment ids here, never merely while
      // the form is open (openPartsForm/newPartsRequestDraft do not call
      // find-or-create).
      if (typeof stampPartsRequestEquipment === 'function') stampPartsRequestEquipment(partsFormDraft);
      partsFormDraft.updatedAt = new Date().toISOString();
      const all = loadPartsRequests();
      const idx = all.findIndex(r => r.id === partsFormDraft.id);
      if (idx >= 0) all[idx] = partsFormDraft; else all.unshift(partsFormDraft);
      const ok = savePartsRequests(all);
      if (showConfirmation) {
        toast(ok ? 'Parts request saved' : 'Could not save parts request — storage full or unavailable');
      }
      if (partsFormDraft.jobId === detailJobId) refreshJobDetailPartsSection();
      return ok;
    }

    function performDeletePartsRequest(id) {
      if (!id) { toast('No request to delete'); return; }
      const all = loadPartsRequests();
      const target = all.find(r => r.id === id);
      const next = all.filter(r => r.id !== id);
      if (next.length === all.length) { toast('Parts request not found'); closeDeleteModal(); return; }
      const ok = savePartsRequests(next);
      if (lxsIsV2Safe() && target) LXS.deletePhotosExplicit((target.parts || []).map(p => p && p.photoId).filter(Boolean));
      if (partsFormDraft && partsFormDraft.id === id) partsFormDraft = null;
      closeDeleteModal();
      toast(ok ? 'Parts request deleted' : 'Could not save parts request — storage full or unavailable');
      refreshPartsList();
      if (target && target.jobId === detailJobId) refreshJobDetailPartsSection();
    }
    function performDeletePartsLine(id) {
      if (!id || !partsFormDraft) { toast('No part to delete'); return; }
      const lxsLine = (partsFormDraft.parts || []).find(p => p && p.id === id);
      const lxsLinePhoto = (lxsLine && lxsLine.photoId) || '';
      partsFormDraft.parts = (partsFormDraft.parts || []).filter(p => p.id !== id);
      if (lxsLinePhoto && lxsIsV2Safe()) LXS.deletePhotosExplicit([lxsLinePhoto]);
      closeDeleteModal();
      renderPartsForm();
      const ok = savePartsFormDraft(false);
      toast(ok ? 'Part deleted' : 'Could not save parts request — storage full or unavailable');
    }

    async function sendPartsFormDraft() {
      if (!partsFormDraft) return;
      if (!(partsFormDraft.parts || []).length) {
        // v152 (Phase 12A Fix 5): used to do nothing at all.
        toast('Add at least one part');
        const fab = document.getElementById('btnAddPartsLine');
        if (fab) {
          fab.classList.add('field-missing');
          setTimeout(() => fab.classList.remove('field-missing'), 1600);
        }
        return;
      }
      savePartsFormDraft(false);
      const shared = await sharePartsRequest(partsFormDraft);
      if (shared && partsFormDraft.status === 'unsent') {
        partsFormDraft.status = 'pending';
        savePartsFormDraft(false);
        renderPartsForm();
        toast('Sent — moved to Pending');
      }
    }

    function refreshJobDetailPartsSection() {
      const job = loadJobs().find(j => j.id === detailJobId);
      const listEl = document.getElementById('jobDetailPartsList');
      const countEl = document.getElementById('jdPartsCount');
      if (!job || !listEl || !countEl) return;
      const reqs = loadPartsRequests().filter(r => r.jobId === job.id);
      if (!reqs.length) {
        countEl.textContent = 'None yet';
        listEl.innerHTML = `<div class="empty-state compact"><p>No parts requests for this job yet.</p></div>`;
        return;
      }
      const openN = reqs.filter(r => r.status !== 'complete').length;
      countEl.textContent = reqs.length + ' total' + (openN ? ' · ' + openN + ' open' : '');
      listEl.innerHTML = reqs.slice(0, 20).map(req => {
        const sum = partsRequestSummary(req);
        return `<div class="list-item" data-id="${req.id}">
          <div class="list-item-main" data-action="open">
            <div class="title">Parts Request${req.seq ? ' #' + req.seq : ''}${partsRequestHasUrgent(req) ? ' <span class="badge badge-urgent">Urgent</span>' : ''}</div>
            <div class="sub">${sum.partsCount} part${sum.partsCount !== 1 ? 's' : ''} · ${jobEsc(formatPartsRequestDate(req.updatedAt))}</div>
          </div>
          <div class="list-item-actions">
            <span class="badge ${partsRequestStatusBadgeClass(req.status)}">${partsRequestStatusLabel(req.status)}</span>
          </div>
        </div>`;
      }).join('');
      listEl.querySelectorAll('.list-item').forEach(el => {
        const id = el.dataset.id;
        el.querySelector('[data-action="open"]').addEventListener('click', () => openPartsForm(id));
      });
    }

    function fillJobCustomerList() {
      const names = new Set();
      try { (loadCustomers() || []).forEach(c => c && c.name && names.add(c.name)); } catch (e) {}
      try { loadJobs().forEach(j => j && j.customer && names.add(j.customer)); } catch (e) {}
      const dl = document.getElementById('jobCustomerList');
      if (dl) dl.innerHTML = [...names].map(c => `<option value="${jobEsc(c)}">`).join('');
    }
    // v157 (Phase 15B, item 1 + approved amendment D): Site suggestions are
    // scoped to the entered customer (every known site if the customer is
    // new/blank, so nothing is ever hidden — just not yet narrowed).
    function fillJobSiteList(customerName) {
      const dl = document.getElementById('jobSiteList');
      if (!dl) return;
      const names = new Set();
      try {
        const custNorm = normalizeMatchText(customerName);
        const customers = loadCustomers() || [];
        const cust = custNorm ? customers.find(c => c && c.nameNormalized === custNorm) : null;
        const sites = loadSites() || [];
        (cust ? sites.filter(s => s && s.customerId === cust.id) : sites).forEach(s => s && s.name && names.add(s.name));
      } catch (e) {}
      dl.innerHTML = [...names].map(s => `<option value="${jobEsc(s)}">`).join('');
    }
    // Serial suggestions: machines at the entered site first, then that
    // customer's other machines, then everything else (approved amendment
    // D) — so the closest match is always what a technician sees typing.
    function machineSerialsScopedTo(customerName, siteName) {
      const machines = loadMachines() || [];
      let siteId = '', customerId = '';
      try {
        const custNorm = normalizeMatchText(customerName);
        const customers = loadCustomers() || [];
        const cust = custNorm ? customers.find(c => c && c.nameNormalized === custNorm) : null;
        if (cust) {
          customerId = cust.id;
          const siteNorm = normalizeMatchText(siteName);
          const sites = loadSites() || [];
          const site = siteNorm ? sites.find(s => s && s.customerId === cust.id && s.nameNormalized === siteNorm) : null;
          if (site) siteId = site.id;
        }
      } catch (e) {}
      const atSite = [], atCustomer = [], rest = [];
      machines.forEach(m => {
        if (!m || !m.serialNumber) return;
        if (siteId && m.currentSiteId === siteId) atSite.push(m.serialNumber);
        else if (customerId && m.currentCustomerId === customerId) atCustomer.push(m.serialNumber);
        else rest.push(m.serialNumber);
      });
      return atSite.concat(atCustomer, rest);
    }
    function fillJobSerialList(customerName, siteName) {
      const dl = document.getElementById('jobSerialAutocompleteList');
      if (!dl) return;
      dl.innerHTML = machineSerialsScopedTo(customerName, siteName).map(s => `<option value="${jobEsc(s)}">`).join('');
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
      const prodLineEl = document.getElementById('jobProductionLine');
      if (prodLineEl) prodLineEl.value = job?.productionLine || '';
      // v158 simplification: show the Production line field automatically
      // only when this job already has one; otherwise start collapsed
      // behind "+ Production line" (#btnShowJobProductionLine).
      const prodLineGroup = document.getElementById('jobProductionLineGroup');
      const prodLineToggle = document.getElementById('btnShowJobProductionLine');
      if (prodLineGroup && prodLineToggle) {
        const hasProdLine = !!(job && job.productionLine);
        prodLineGroup.classList.toggle('hidden', !hasProdLine);
        prodLineToggle.classList.toggle('hidden', hasProdLine);
      }
      document.getElementById('jobStatus').value = job?.status || 'Planned';
      document.getElementById('jobScope').value = job?.scope || '';
      document.getElementById('jobNotes').value = job?.notes || '';
      fillJobCustomerList();
      fillJobSiteList(job?.customer || '');
      fillJobSerialList(job?.customer || '', job?.site || '');
      // v159 (Phase 15B follow-up): no more job-level Machine picker — each
      // serial/placeholder carries its own type. jobSerialTypeDraft holds a
      // pending job-chosen type for any serial that doesn't yet have a
      // committed one of its own; jobLastAddedType tracks the running
      // default ("type of the last serial added on this job") so a
      // single-type job takes no more taps than before (item 5/9).
      jobSerialsDraft = normalizeJobSerials(Array.isArray(job?.serials) ? job.serials : []);
      jobPlaceholdersDraft = Array.isArray(job?.placeholderMachines) ? job.placeholderMachines.map(p => Object.assign({}, p)) : [];
      jobSerialTypeDraft = {};
      jobLastAddedType = '';
      // Walk the job's serials in their ORIGINAL (add) order, not the
      // display-sorted jobSerialsDraft, so "last added" means what it says.
      (Array.isArray(job?.serials) ? job.serials : []).forEach(s => {
        const text = jobSerialText(s);
        if (!text) return;
        const machine = findMachineBySerial(text);
        let type = machine && machine.machineType;
        if (!type) {
          // v159 (item 7): an old job's single job.machine field becomes
          // this still-untyped serial's DISPLAYED type — a backward-compat
          // read only. It's written to the machine record (and job.machine
          // recomputed as a derived summary) only if this job is actually
          // saved — see saveJobFromForm()/resolveJobEquipmentSnapshot().
          type = job.machine || jobLastAddedType || 'LX-8';
          jobSerialTypeDraft[normalizeMatchText(text)] = type;
        }
        jobLastAddedType = type;
      });
      jobPlaceholdersDraft.forEach(p => { if (p && p.type) jobLastAddedType = p.type; });
      // v157 fix (Phase 15B review, item 3): any "Fill in serial" taps from
      // a previous, cancelled edit of this (or another) job must not carry
      // over — the conversion itself is deferred until Save Job (see
      // jobPendingPlaceholderConversions below), so a fresh form always
      // starts with an empty queue.
      jobPendingPlaceholderConversions = [];
      populateJobSerialSelect(jobSerialsDraft, jobSerialsDraft[0] || '');
      if (typeof renderJobSerialChips === 'function') renderJobSerialChips();
      // v152 (Phase 12A Fix 5)
      clearMissingFlag(document.getElementById('jobCustomer'));
      clearMissingFlag(document.getElementById('jobTechnician'));
      if (typeof refreshJobFormRequired === 'function') refreshJobFormRequired();
    }

    let jobSerialsDraft = [];
    // v159: pending job-chosen types for the currently-open job form — see
    // initJobForm()'s comment above and renderJobSerialChips() below.
    let jobSerialTypeDraft = {};
    let jobLastAddedType = '';
    let machineModalMode = 'job';
    let pendingInspectJobId = null;

    // #jobMachineSummaryText was never actually in the markup (a leftover
    // from before the per-serial chip redesign), so this has always been a
    // no-op; kept as a harmless no-op purely because a couple of unrelated
    // handlers below still call it.
    function updateJobMachineSummary() {
      const el = document.getElementById('jobMachineSummaryText');
      if (!el) return;
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

    // v157 (Phase 15B): one small reusable text-entry sheet for the
    // several "typed once" one-tap actions (Set line, Add placeholder
    // machine, Fill in serial). onSave is called with the trimmed value
    // only when it's non-empty; an empty save or Cancel does nothing.
    let genericTextPromptOnSave = null;
    function openGenericTextPrompt(opts) {
      opts = opts || {};
      const modal = document.getElementById('genericTextModal');
      if (!modal) return;
      const title = document.getElementById('genericTextTitle');
      const label = document.getElementById('genericTextLabel');
      const input = document.getElementById('genericTextInput');
      if (title) title.textContent = opts.title || 'Enter a value';
      if (label) label.textContent = opts.label || 'Value';
      if (input) {
        input.placeholder = opts.placeholder || '';
        input.value = opts.value || '';
      }
      genericTextPromptOnSave = typeof opts.onSave === 'function' ? opts.onSave : null;
      modal.classList.remove('hidden');
      modal.classList.add('show');
      modal.setAttribute('aria-hidden', 'false');
      if (input) setTimeout(() => { try { input.focus(); } catch (e) {} }, 0);
      // v158 fix: hide the job form's/start screen's fixed Save/Cancel
      // bar (z-index 400, restored via an inline !important style by the
      // keyboard-pin logic below) right away, instead of waiting for a
      // focus event to reach it — see __syncKeyboardPinBars above.
      if (typeof window.__syncKeyboardPinBars === 'function') { try { window.__syncKeyboardPinBars(); } catch (e) {} }
    }
    function closeGenericTextModal() {
      const modal = document.getElementById('genericTextModal');
      if (!modal) return;
      modal.classList.add('hidden');
      modal.classList.remove('show');
      modal.setAttribute('aria-hidden', 'true');
      genericTextPromptOnSave = null;
      if (typeof window.__syncKeyboardPinBars === 'function') { try { window.__syncKeyboardPinBars(); } catch (e) {} }
    }

    // ===== v159 (Phase 15B follow-up): ONE shared machine-type picker =====
    // Opens the #typePickerModal sheet. opts:
    //   title             sheet heading (default 'Machine type')
    //   current           the type to treat as already-selected — v159
    //                     review fix #5: highlighted among the common/other-
    //                     known buttons when it matches one of them
    //   restrictToChecklist  true for the inspection picker: only types with
    //                     an inspection checklist are offered (plus Other).
    //                     v159 review fix #4: when `current` is a real type
    //                     that ISN'T one of these (e.g. "Tray Washer" — no
    //                     checklist exists for it), nothing is highlighted
    //                     and a note explains why, rather than silently
    //                     landing on some checklist type.
    //   onSelect(type)    called once with the final type string, after the
    //                     sheet closes
    let typePickerOnSelect = null;
    function openTypePicker(opts) {
      opts = opts || {};
      const modal = document.getElementById('typePickerModal');
      if (!modal) return;
      const title = document.getElementById('typePickerTitle');
      if (title) title.textContent = opts.title || 'Machine type';
      typePickerOnSelect = typeof opts.onSelect === 'function' ? opts.onSelect : null;
      const restrict = !!opts.restrictToChecklist;
      const current = String(opts.current || '').trim();
      const currentKey = normalizeTypeKey(current);
      const commonTypes = restrict ? checklistMachineTypes() : MACHINE_TYPE_COMMON;
      const otherKnown = restrict ? [] : MACHINE_TYPE_OTHER_KNOWN;
      const commonWrap = document.getElementById('typePickerCommon');
      const otherWrap = document.getElementById('typePickerOtherKnown');
      const otherWrapOuter = document.getElementById('typePickerOtherKnownWrap');
      const noteEl = document.getElementById('typePickerNote');
      const selectType = (t) => {
        const cb = typePickerOnSelect;
        closeTypePicker();
        if (cb) cb(t);
      };
      const matchedCommon = commonTypes.some(t => normalizeTypeKey(t) === currentKey);
      const matchedOther = otherKnown.some(t => normalizeTypeKey(t) === currentKey);
      if (commonWrap) {
        commonWrap.innerHTML = commonTypes.map((t, i) => {
          const sel = currentKey && normalizeTypeKey(t) === currentKey ? ' selected' : '';
          return `<button type="button" class="btn btn-outline type-picker-common-btn${sel}" data-i="${i}">${jobEsc(t)}</button>`;
        }).join('');
        commonWrap.querySelectorAll('.type-picker-common-btn').forEach((btn, i) => {
          btn.addEventListener('click', () => selectType(commonTypes[i]));
        });
      }
      if (otherWrapOuter) otherWrapOuter.classList.toggle('hidden', !otherKnown.length);
      if (otherWrap) {
        otherWrap.innerHTML = otherKnown.map((t, i) => {
          const sel = currentKey && normalizeTypeKey(t) === currentKey ? ' selected' : '';
          return `<button type="button" class="btn-link type-picker-known-btn${sel}" data-i="${i}">${jobEsc(t)}</button>`;
        }).join('');
        otherWrap.querySelectorAll('.type-picker-known-btn').forEach((btn, i) => {
          btn.addEventListener('click', () => selectType(otherKnown[i]));
        });
      }
      // v159 review fix #4: the current type is real but has no checklist
      // (only possible when restrictToChecklist — otherwise every real type
      // is offered somewhere above) — nothing above is highlighted, so say
      // why and leave the "Other" box unfilled rather than pick for them.
      if (noteEl) {
        const showNote = restrict && current && !matchedCommon && !matchedOther;
        noteEl.classList.toggle('hidden', !showNote);
        noteEl.textContent = showNote ? `No inspection checklist for ${current} — pick a type` : '';
      }
      // "Other" text box + suggestions, collapsed until tapped.
      const otherGroup = document.getElementById('typePickerOtherGroup');
      const otherInput = document.getElementById('typePickerOtherInput');
      const otherSave = document.getElementById('typePickerSave');
      const otherBtn = document.getElementById('typePickerOtherBtn');
      const otherList = document.getElementById('typePickerOtherList');
      if (otherGroup) otherGroup.classList.add('hidden');
      if (otherSave) otherSave.classList.add('hidden');
      if (otherInput) otherInput.value = '';
      if (otherList) otherList.innerHTML = customMachineTypeSuggestions().map(t => `<option value="${jobEsc(t)}">`).join('');
      if (otherBtn) {
        otherBtn.onclick = () => {
          if (otherGroup) otherGroup.classList.remove('hidden');
          if (otherSave) otherSave.classList.remove('hidden');
          if (otherInput) setTimeout(() => { try { otherInput.focus(); } catch (e) {} }, 0);
          if (typeof window.__syncKeyboardPinBars === 'function') { try { window.__syncKeyboardPinBars(); } catch (e) {} }
        };
      }
      if (otherSave) {
        otherSave.onclick = () => {
          const v = normalizeMachineTypeInput(otherInput ? otherInput.value : '');
          if (!v) return;
          selectType(v);
        };
      }
      modal.classList.remove('hidden');
      modal.classList.add('show');
      modal.setAttribute('aria-hidden', 'false');
      if (typeof window.__syncKeyboardPinBars === 'function') { try { window.__syncKeyboardPinBars(); } catch (e) {} }
    }
    function closeTypePicker() {
      const modal = document.getElementById('typePickerModal');
      if (!modal) return;
      modal.classList.add('hidden');
      modal.classList.remove('show');
      modal.setAttribute('aria-hidden', 'true');
      typePickerOnSelect = null;
      if (typeof window.__syncKeyboardPinBars === 'function') { try { window.__syncKeyboardPinBars(); } catch (e) {} }
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
    // v157 (Phase 15B, roadmap 3.6/3.7): what the technician actually SEES
    // on a chip — "<machine line> · <serial> · <type>" — is now built from
    // the machine record, never from sort position. This is display only:
    // taggedJobSerials()'s "line" (the array index, used to key punchlist
    // items via item.line/serialForLine) is left completely untouched, so
    // existing punchlist data keeps working exactly as before.
    // Restored to its pre-v159 shape (v159 had dropped the type segment,
    // which broke punchlistMachineOptions()'s item-form chip labels — see
    // the fix note there). Used for the PUNCHLIST item form's chips; the
    // job form builds its own row markup directly (renderJobSerialChips)
    // since each segment there is now its own tappable control.
    function jobSerialChipSegments(serial, machine) {
      const segs = [];
      segs.push((machine && machine.lineLabel) ? machine.lineLabel : '');
      segs.push(serial);
      if (machine && machine.machineType) segs.push(machine.machineType);
      return segs.filter(Boolean);
    }
    // v159 (Phase 15B follow-up, item 5): a real serial's type for DISPLAY
    // on the job form's chip. A pending jobSerialTypeDraft choice — a new
    // serial, an old untyped one showing job.machine (see initJobForm), or
    // a deliberate tap-to-correct on an already-typed serial — always wins
    // for display; nothing is written to the machine record until Save Job
    // (see saveJobFromForm/resolveJobEquipmentSnapshot). "locked" mirrors
    // the existing inspection-type-lock rule: once an inspection has
    // confirmed a type, the job form can't change it (no draft is ever set
    // for one), so it always shows the machine's own type.
    function jobSerialEffectiveType(serial, machine) {
      const locked = !!(machine && (machine.machineTypeSource === 'inspection' || machine.machineTypeSource === 'manager') && machine.machineType);
      if (locked) return { type: machine.machineType, locked: true };
      const draft = jobSerialTypeDraft[normalizeMatchText(serial)];
      const type = draft || (machine && machine.machineType) || '';
      return { type, locked: false };
    }
    // Placeholder machines (type only, no serial yet — roadmap 3.6). Kept
    // on the job itself (job.placeholderMachines), never in lx8_machines,
    // so they never show up in autocomplete or backups' machines.json
    // (approved amendment B). Each entry: { id, type, lineLabel, productionLine }.
    let jobPlaceholdersDraft = [];
    // v157 fix (Phase 15B review, item 3): "Fill in serial" used to convert
    // the placeholder (write the real machine, reassign every existing
    // inspection/punchlist item/parts line onto it) the instant the
    // technician typed the serial — even if they then cancelled the job
    // edit entirely. That's a real write that should only happen once the
    // job is actually saved. Each queued entry is { placeholder, serial };
    // saveJobFromForm() drains this queue via convertPlaceholderToSerial()
    // right before it resolves the job's own equipment snapshot, and
    // initJobForm() clears it for a fresh form (see above) so a cancelled
    // edit's queued conversions are simply discarded, never applied.
    let jobPendingPlaceholderConversions = [];
    function newPlaceholderId() {
      return 'ph_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
    function renderJobSerialChips() {
      const wrap = document.getElementById('jobSerialChips');
      if (!wrap) return;
      jobSerialsDraft = normalizeJobSerials(jobSerialsDraft);
      if (!Array.isArray(jobPlaceholdersDraft)) jobPlaceholdersDraft = [];
      if (!jobSerialsDraft.length && !jobPlaceholdersDraft.length) {
        wrap.innerHTML = '<div class="job-serial-empty">No serials yet</div>';
        return;
      }
      const realRows = jobSerialsDraft.map((serial, i) => {
        const machine = findMachineBySerial(serial);
        const { type, locked } = jobSerialEffectiveType(serial, machine);
        // v159 (item 5): the type is its own tappable segment — locked
        // (inspection-confirmed) types render as plain text, everything
        // else opens the shared picker.
        const typeHtml = locked
          ? `<span class="job-serial-locked-type">${jobEsc(type || '')}</span>`
          : `<button type="button" class="btn-link job-serial-type-btn" data-kind="serial" data-idx="${i}">${jobEsc(type || 'Set type')}</button>`;
        // Fix (review round 1, item 2): the line label is now ALWAYS a
        // tappable pill — its own text once set, "Set line" before that —
        // instead of disappearing into plain text once set. Same handler
        // as before (.job-set-line), which already reads the current
        // label as its pre-fill value, so tapping an existing label
        // reopens the Set line sheet pre-filled with it.
        const lineLabel = (machine && machine.lineLabel) || '';
        const lineHtml = `<button type="button" class="btn-link job-set-line" data-kind="serial" data-idx="${i}">${jobEsc(lineLabel || 'Set line')}</button>`;
        return `<div class="job-serial-row" data-kind="serial" data-idx="${i}">
          <span class="job-serial-text">${jobEsc(serial)}</span>
          ${typeHtml}
          ${lineHtml}
          <button type="button" class="btn-link job-serial-remove" data-idx="${i}" aria-label="Remove">Remove</button>
        </div>`;
      });
      const placeholderRows = jobPlaceholdersDraft.map((ph, i) => {
        const lineHtml = `<button type="button" class="btn-link job-set-line" data-kind="placeholder" data-idx="${i}">${jobEsc((ph.lineLabel || '') || 'Set line')}</button>`;
        return `<div class="job-serial-row" data-kind="placeholder" data-idx="${i}">
          <span class="job-serial-text">Placeholder</span>
          <button type="button" class="btn-link job-serial-type-btn" data-kind="placeholder" data-idx="${i}">${jobEsc(ph.type || 'Set type')}</button>
          ${lineHtml}
          <button type="button" class="btn-link job-fill-serial" data-idx="${i}">Fill in serial</button>
          <button type="button" class="btn-link job-placeholder-remove" data-idx="${i}" aria-label="Remove">Remove</button>
        </div>`;
      });
      wrap.innerHTML = realRows.join('') + placeholderRows.join('');
      // v159 (item 5): tap a chip's type segment to change it via the
      // shared picker. Locked (inspection-confirmed) real serials never get
      // this button (see jobSerialEffectiveType above), matching the
      // existing "inspection-confirmed type can't be changed from the job
      // form" rule.
      wrap.querySelectorAll('.job-serial-type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-idx'));
          const kind = btn.getAttribute('data-kind');
          if (kind === 'placeholder') {
            const ph = jobPlaceholdersDraft[idx];
            if (!ph) return;
            openTypePicker({
              title: 'Machine type',
              current: ph.type || '',
              restrictToChecklist: false,
              onSelect: (t) => {
                ph.type = t;
                jobLastAddedType = t;
                renderJobSerialChips();
              }
            });
          } else {
            const serial = jobSerialsDraft[idx];
            const machine = findMachineBySerial(serial);
            const { type: current } = jobSerialEffectiveType(serial, machine);
            openTypePicker({
              title: 'Machine type',
              current,
              restrictToChecklist: false,
              onSelect: (t) => {
                jobSerialTypeDraft[normalizeMatchText(serial)] = t;
                renderJobSerialChips();
              }
            });
          }
        });
      });
      wrap.querySelectorAll('.job-serial-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-idx'));
          const serial = jobSerialsDraft[idx];
          const blocked = jobSerialRemovalBlockedMessage(serial);
          if (blocked) { toast(blocked); return; }
          jobSerialsDraft.splice(idx, 1);
          jobSerialsDraft = normalizeJobSerials(jobSerialsDraft);
          // Removing a just-converted serial before Save Job cancels its
          // queued conversion too — nothing should be written for it.
          jobPendingPlaceholderConversions = jobPendingPlaceholderConversions.filter(p => p.serial.toLowerCase() !== serial.toLowerCase());
          renderJobSerialChips();
        });
      });
      wrap.querySelectorAll('.job-placeholder-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-idx'));
          const ph = jobPlaceholdersDraft[idx];
          const n = ph ? countRecordsUsingEquipmentId(ph.id) : 0;
          if (n) { toast("Can't remove — " + n + ' record' + (n === 1 ? '' : 's') + ' use' + (n === 1 ? 's' : '') + " this placeholder. A manager can correct it in the Local Data Editor."); return; }
          jobPlaceholdersDraft.splice(idx, 1);
          renderJobSerialChips();
        });
      });
      wrap.querySelectorAll('.job-set-line').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-idx'));
          const kind = btn.getAttribute('data-kind');
          const current = kind === 'placeholder' ? (jobPlaceholdersDraft[idx] && jobPlaceholdersDraft[idx].lineLabel) : ((findMachineBySerial(jobSerialsDraft[idx]) || {}).lineLabel);
          openGenericTextPrompt({
            title: 'Set line',
            label: 'Machine line label',
            placeholder: 'e.g. Line 1',
            value: current || '',
            onSave: (v) => {
              if (kind === 'placeholder') {
                if (jobPlaceholdersDraft[idx]) jobPlaceholdersDraft[idx].lineLabel = v;
              } else {
                const serial = jobSerialsDraft[idx];
                const m = findOrCreateMachine(serial);
                if (m) setMachineLineLabel(m.id, v);
              }
              renderJobSerialChips();
            }
          });
        });
      });
      wrap.querySelectorAll('.job-fill-serial').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-idx'));
          const ph = jobPlaceholdersDraft[idx];
          if (!ph) return;
          openGenericTextPrompt({
            title: 'Fill in serial',
            label: 'Serial number',
            placeholder: 'Serial number',
            value: '',
            onSave: (serial) => {
              // Draft-only: queue the real conversion for Save Job (see
              // jobPendingPlaceholderConversions) instead of writing to the
              // machine store / reassigning references right now.
              jobPendingPlaceholderConversions.push({ placeholder: Object.assign({}, ph), serial });
              jobPlaceholdersDraft.splice(idx, 1);
              if (!jobSerialsDraft.some(s => jobSerialText(s).toLowerCase() === serial.toLowerCase())) jobSerialsDraft.push(serial);
              jobSerialsDraft = normalizeJobSerials(jobSerialsDraft);
              // v159: the placeholder's type carries over to the new
              // serial's draft type (unless it's turned out to already be a
              // differently-typed known machine — same fill-only-if-empty
              // rule convertPlaceholderToSerial() uses for the real write
              // at Save Job time).
              const existingMachine = findMachineBySerial(serial);
              if (!(existingMachine && existingMachine.machineType) && ph.type) {
                jobSerialTypeDraft[normalizeMatchText(serial)] = ph.type;
              }
              jobLastAddedType = (existingMachine && existingMachine.machineType) || ph.type || jobLastAddedType;
              renderJobSerialChips();
            }
          });
        });
      });
    }
    // Sets a machine's line label directly (an explicit one-tap user
    // action, so — unlike productionLine's fill-only-once rule — this may
    // correct an existing label, same as roadmap 3.3's "one-tap
    // correct-once action").
    function setMachineLineLabel(machineId, label) {
      const all = loadMachines();
      const idx = all.findIndex(m => m && m.id === machineId);
      if (idx < 0) return null;
      all[idx].lineLabel = String(label || '').trim();
      all[idx].updatedAt = new Date().toISOString();
      saveMachines(all);
      return all[idx];
    }
    // Converts a type-only placeholder into a real machine record once its
    // serial is known on-site (roadmap 3.6): creates/looks up the real
    // machine by serial, carries over the placeholder's line label/
    // production line (fill-only, never overwriting anything already on
    // the real record), then reassigns every inspection/punchlist item/
    // parts line that referenced the placeholder's id over to the real id.
    function convertPlaceholderToSerial(placeholder, serial) {
      const machine = findOrCreateMachine(serial);
      if (!machine) return null;
      const updates = {};
      if (placeholder.type && !machine.machineType) { updates.machineType = placeholder.type; updates.machineTypeSource = 'job'; }
      if (placeholder.productionLine) updates.productionLine = placeholder.productionLine;
      if (Object.keys(updates).length) applyMachineUpdate(machine.id, updates, { source: 'placeholder-convert' });
      if (placeholder.lineLabel && !machine.lineLabel) setMachineLineLabel(machine.id, placeholder.lineLabel);
      // v157 fix (Phase 15B review round 2, item D): applyMachineUpdate()/
      // setMachineLineLabel() each load and save their OWN copy of the
      // Machine store, so the `machine` object above is stale by now —
      // re-read it so the reassignment below carries the real, final
      // type/line label/production line, not what it was before conversion.
      const finalMachine = findMachineBySerial(serial) || machine;
      reassignEquipmentReferences(placeholder.id, finalMachine, serial);
      return finalMachine;
    }
    // Moves every stored reference from a placeholder's id to the real
    // machine's — used only for placeholder → real machine conversion.
    // v157 fix (Phase 15B review round 2, item D): a punchlist item or
    // parts line that pointed at the placeholder had no serial of its own
    // (placeholders don't have one) and its snapshot (lineLabelAtSave etc.)
    // was stamped from the PLACEHOLDER's fields at save time — once it's
    // repointed at the real machine, both of those now need to reflect the
    // real machine too, or the item form/exports would keep showing
    // whatever the placeholder used to look like.
    function reassignEquipmentReferences(fromId, toMachine, serial) {
      const toId = toMachine && toMachine.id;
      if (!fromId || !toId || fromId === toId) return;
      const snap = {
        lineLabelAtSave: (toMachine && toMachine.lineLabel) || '',
        productionLineAtSave: (toMachine && toMachine.productionLine) || '',
        machineTypeAtSave: (toMachine && toMachine.machineType) || '',
        salesOrderAtSave: (toMachine && toMachine.salesOrder) || ''
      };
      try {
        const inspections = loadInspections() || [];
        let changed = false;
        inspections.forEach(i => { if (i && i.equipmentId === fromId) { i.equipmentId = toId; changed = true; } });
        if (changed) saveInspections(inspections);
      } catch (e) {}
      try {
        if (typeof window.getPunchlistBackup === 'function' && typeof window.setPunchlistBackup === 'function') {
          const pl = window.getPunchlistBackup();
          const jobsObj = (pl && pl.jobs) || {};
          let changed = false;
          Object.keys(jobsObj).forEach(key => {
            (jobsObj[key] || []).forEach(item => {
              if (item && item.equipmentId === fromId) {
                item.equipmentId = toId;
                if (!item.serial && serial) item.serial = serial;
                item.lineLabelAtSave = snap.lineLabelAtSave;
                item.productionLineAtSave = snap.productionLineAtSave;
                item.machineTypeAtSave = snap.machineTypeAtSave;
                item.salesOrderAtSave = snap.salesOrderAtSave;
                changed = true;
              }
            });
          });
          if (changed) window.setPunchlistBackup(pl);
        }
      } catch (e) {}
      try {
        const reqs = loadPartsRequests() || [];
        let changed = false;
        reqs.forEach(req => {
          if (!req) return;
          if (req.equipmentId === fromId) { req.equipmentId = toId; changed = true; }
          (req.parts || []).forEach(line => {
            if (line && line.equipmentId === fromId) {
              line.equipmentId = toId;
              if (!line.serial && serial) line.serial = serial;
              line.machineType = snap.machineTypeAtSave;
              line.salesOrder = snap.salesOrderAtSave;
              line.lineLabelAtSave = snap.lineLabelAtSave;
              line.productionLineAtSave = snap.productionLineAtSave;
              line.machineTypeAtSave = snap.machineTypeAtSave;
              line.salesOrderAtSave = snap.salesOrderAtSave;
              changed = true;
            }
          });
        });
        if (changed) savePartsRequests(reqs);
      } catch (e) {}
    }

    function addJobSerialFromInput() {
      const input = document.getElementById('jobSerialInput');
      if (!input) return;
      const v = input.value.trim();
      if (!v) return;
      if (!jobSerialsDraft.some(s => jobSerialText(s).toLowerCase() === v.toLowerCase())) jobSerialsDraft.push(v);
      jobSerialsDraft = normalizeJobSerials(jobSerialsDraft);
      input.value = '';
      // v157 (Phase 15B, item 1 + approved amendment F): a known serial
      // suggests its sales order and machine type. Sales order is only
      // ever auto-filled into the job's own (currently empty) SO box when
      // this is the job's only serial — matches the existing single-serial
      // restriction on the reverse direction (job SO -> machine record).
      const machine = findMachineBySerial(v);
      // v159 (item 5/9): a never-seen serial defaults to the type of the
      // last serial added on this job (LX-8 if none) — so a single-type
      // job with several new serials takes no more taps than before. A
      // known serial keeps its own committed type untouched.
      if (machine && machine.machineType) {
        jobLastAddedType = machine.machineType;
      } else {
        const defaultType = jobLastAddedType || 'LX-8';
        jobSerialTypeDraft[normalizeMatchText(v)] = defaultType;
        jobLastAddedType = defaultType;
      }
      renderJobSerialChips();
      if (machine) {
        if (jobSerialsDraft.length === 1 && machine.salesOrder) {
          const soEl = document.getElementById('jobSO');
          if (soEl && !soEl.value.trim()) soEl.value = machine.salesOrder;
        }
        if (machine.machineType) {
          toast('Known serial — ' + machine.machineType + (machine.salesOrder ? ' · SO ' + machine.salesOrder : ''));
        }
      }
    }
    function addJobPlaceholderMachine() {
      // v159 (item 2/4): "Add placeholder" opens the shared type picker
      // instead of a free-text prompt.
      openTypePicker({
        title: 'Add placeholder machine',
        current: jobLastAddedType || 'LX-8',
        restrictToChecklist: false,
        onSelect: (type) => {
          if (!Array.isArray(jobPlaceholdersDraft)) jobPlaceholdersDraft = [];
          jobPlaceholdersDraft.push({ id: newPlaceholderId(), type, lineLabel: '', productionLine: '' });
          jobLastAddedType = type;
          renderJobSerialChips();
        }
      });
    }

    // v159 (Phase 15B follow-up, item 3): the inspection machine picker.
    // #inspectMachine/#inspectMachineCustom are kept exactly as before
    // (hidden — see the machineModal markup) purely so every other
    // read/write of them elsewhere in the file keeps working unchanged;
    // this function also syncs the new visible button's label. "known" is
    // the checklist-driven list (checklistMachineTypes()), never a second
    // hard-coded copy of the COMMON four.
    function setInspectMachineFields(value) {
      const sel = document.getElementById('inspectMachine');
      const custom = document.getElementById('inspectMachineCustom');
      if (!sel || !custom) return;
      const known = checklistMachineTypes();
      const v = String(value || '').trim();
      // v159 review fix #4: never silently default to a checklist type
      // (e.g. 'LX-8') just because a real type wasn't recognized or wasn't
      // supplied — that's exactly the bug being fixed. A checklist type is
      // shown as itself; any other real type (a machine with no checklist,
      // such as "Tray Washer") is kept as-is via the hidden custom field so
      // the button and Cancel/re-open still reflect the true type; only a
      // genuinely blank value shows nothing.
      if (known.includes(v)) {
        sel.value = v;
        custom.value = '';
        custom.classList.add('hidden');
      } else {
        sel.value = '__other';
        custom.value = v;
        custom.classList.add('hidden');
      }
      const btn = document.getElementById('inspectMachineTypeBtn');
      if (btn) btn.textContent = readInspectMachine() || 'Select type';
    }

    function readInspectMachine() {
      const sel = document.getElementById('inspectMachine');
      const custom = document.getElementById('inspectMachineCustom');
      if (!sel) return '';
      if (sel.value === '__other') return (custom && custom.value.trim()) || '';
      return sel.value;
    }

    // v159: the standalone "New/Edit Inspection" screen's machine picker
    // (#screenStart, #inpModel) — same shared-picker treatment as
    // #inspectMachine above. #inpModel is a plain hidden input (not a
    // <select>) so it can hold any "Other" value — see its markup.
    function setInpModelField(value) {
      const el = document.getElementById('inpModel');
      if (!el) return;
      el.value = String(value || '').trim() || 'LX-8';
      const btn = document.getElementById('inpModelTypeBtn');
      if (btn) btn.textContent = el.value;
    }
    function readInpModel() {
      const el = document.getElementById('inpModel');
      return el ? el.value : '';
    }

    function inspectJobsSource() {
      let jobs = [];
      try { jobs = loadJobs() || []; } catch (e) { jobs = []; }
      if (!jobs.length) {
        try { jobs = STORE.load('jobs') || []; } catch (e) { jobs = []; }
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

    // v157 fix (Phase 15B review, item 2): whenever the machine picker's
    // serial resolves to a known machine with a confirmed/known type, the
    // type field follows it (still a one-tap change away) — same rule as
    // the roadmap 3.6 "type belongs to the serial" behavior elsewhere.
    // Only fills in when the machine actually HAS a type; a never-seen
    // serial leaves whatever type is already showing (the job's default)
    // untouched, per the plan's "pre-filled for one-tap confirm" rule.
    function syncInspectMachineFromSerial(serial) {
      const s = String(serial || '').trim();
      if (!s) return;
      const machine = (typeof findMachineBySerial === 'function') ? findMachineBySerial(s) : null;
      if (machine && machine.machineType) setInspectMachineFields(machine.machineType);
    }
    function readJobSerial() {
      const sel = document.getElementById('inspectSerialSelect');
      const custom = document.getElementById('inspectSerialInput');
      if (sel && sel.value === '__other') return (custom && custom.value.trim()) || '';
      if (sel && sel.value) return sel.value.trim();
      return (custom && custom.value.trim()) || '';
    }

    let detailJobId = null;

    const JD_ACC_KEY = 'lx8_jd_acc';
    const JD_ACC_DEFAULTS = { inspect: true, punch: true, time: true, parts: true };
    function loadJdAccState() {
      const saved = lsRead(JD_ACC_KEY, null);
      return Object.assign({}, JD_ACC_DEFAULTS, (saved && typeof saved === 'object') ? saved : {});
    }
    function saveJdAccState(state) {
      lsWrite(JD_ACC_KEY, state);
    }
    function applyJdAccState() {
      const state = loadJdAccState();
      document.querySelectorAll('#screenJobDetail .jd-acc[data-jd-acc]').forEach((acc) => {
        const key = acc.getAttribute('data-jd-acc');
        const open = state[key] !== false;
        acc.classList.toggle('open', open);
        const btn = acc.querySelector('.jd-acc-toggle');
        if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }
    function bindJdAccordions() {
      document.querySelectorAll('#screenJobDetail .jd-acc-toggle').forEach((btn) => {
        if (btn.dataset.bound === '1') return;
        btn.dataset.bound = '1';
        btn.addEventListener('click', () => {
          const acc = btn.closest('.jd-acc');
          if (!acc) return;
          const key = acc.getAttribute('data-jd-acc');
          const open = !acc.classList.contains('open');
          acc.classList.toggle('open', open);
          btn.setAttribute('aria-expanded', open ? 'true' : 'false');
          if (!key) return;
          const state = loadJdAccState();
          state[key] = open;
          saveJdAccState(state);
        });
      });
    }

    function openJobDetail(id) {
      const job = loadJobs().find(j => j.id === id);
      if (!job) { toast('Job not found'); return; }
      // Resolve this one job's Customer/Site/Serial ids the first time
      // it's actually opened — not for every job whenever the list is
      // loaded. Deliberately scoped to exactly the job the technician is
      // opening, so viewing Job Detail never touches any other job's data.
      if (!job.customerId) {
        // Phase 15A: resolveJobEquipmentIds (old Serial layer) is
        // superseded by resolveJobEquipmentSnapshot (Machine layer) — see
        // that function's comment. Kept as a lazy safety net for any job
        // that somehow reached here without ever going through a save
        // path or the one-time backfill.
        resolveJobEquipmentSnapshot(job, { source: 'job-view-fallback' });
        try { saveJobs(loadJobs()); } catch (e) {}
      }
      detailJobId = id;
      showScreen('screenJobDetail');
      setHeader('Job');
      bindJdAccordions();
      applyJdAccState();
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
          const raw = STORE.load('timecards');
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
      if (en.clockIn && en.clockOut) return tcHoursFromMs(tcSpanMs(en.clockIn, en.clockOut));
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
        const typeLabel = (en.type || 'bakery').charAt(0).toUpperCase() + (en.type || 'bakery').slice(1);
        const fmt = window.tcFormatLongDate || (typeof tcFormatLongDate === 'function' ? tcFormatLongDate : null);
        const dateStr = fmt ? fmt(en.date || en.clockIn) : (en.date || '');
        return '<div class="tc-entry" data-id="' + String(en.id || '').replace(/"/g, '&quot;') + '">' +
          '<div class="tc-entry-main"><div class="tc-entry-title">' + String(dateStr).replace(/</g,'&lt;') + '</div>' +
          '<div class="tc-entry-sub">' + jobEsc(typeLabel) + '</div></div>' +
          '<div class="tc-entry-hours">' + hrs.toFixed(2) + '</div></div>';
      }).join('');
      listEl.querySelectorAll('.tc-entry').forEach(el => {
        el.addEventListener('click', () => {
          const id = el.getAttribute('data-id');
          const open = window.tcOpenEdit || (typeof tcOpenEdit === 'function' ? tcOpenEdit : null);
          if (id && open) open(id);
        });
      });
      if (typeof bindSwipeToDelete === 'function') {
        bindSwipeToDelete(listEl, '.tc-entry', (row) => ({
          id: row.getAttribute('data-id'),
          kind: 'timecard',
          title: 'Delete time entry?',
          label: 'This time entry will be permanently deleted.'
        }));
      }
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
      if (isSampleJob(job)) document.getElementById('jobDetailTitle').insertAdjacentHTML('beforeend', SAMPLE_TAG_HTML);
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
          const findCount = countInspectionFindings(ins);
          const statusClass = ins.status === 'Complete' ? 'badge-complete' : 'badge-draft';
          const statusLabel = ins.status === 'Complete' ? 'Complete' : 'Draft';
          const rowTone = ins.status === 'Complete' ? 'list-complete' : '';
          return `<div class="list-item ${rowTone}" data-id="${ins.id}">
            <div class="list-item-main" data-action="open">
              <div class="title">${jobEsc(ins.customer || 'Unknown')} – ${jobEsc(ins.model || 'LX-8')} – ${jobEsc(ins.serial || 'No S/N')}${isSampleInspection(ins) ? SAMPLE_TAG_HTML : ''}</div>
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
            <span class="badge ${allDone ? 'badge-complete' : 'badge-draft'}">${allDone ? 'Complete' : 'Pending'}</span>
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
      refreshJobDetailPartsSection();
    }

    function openJob(id) {
      // Edit form
      const job = loadJobs().find(j => j.id === id);
      if (!job) { toast('Job not found'); return; }
      editingJobId = id;
      detailJobId = id;
      initJobForm(job);
      document.getElementById('btnSaveJob').textContent = 'Save';
      const jobFormTitle = document.getElementById('jobFormTitle');
      if (jobFormTitle) jobFormTitle.textContent = 'Edit Job';
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
      setInpModelField(checklistMachineTypes().includes(model) ? model : 'LX-8');
      fillInspectionSerialOptions(job);
      jobSerialsDraft = Array.isArray(job.serials) ? job.serials.slice() : [];
      machineModalMode = 'startInspect';
      const title = document.getElementById('machineModalTitle');
      const done = document.getElementById('machineModalDone');
      if (title) title.textContent = 'Link job';
      if (done) done.textContent = 'Start inspection';
      if (typeof populateInspectJobSelect === 'function') populateInspectJobSelect(job && job.id);
      // v159 review fix #4: no more blind 'LX-8' fallback here — job.machine
      // (or, better, the pre-selected serial's own type just below) is the
      // real type if there is one; if there truly isn't one yet, leave it
      // blank rather than lying with a default, so the picker/gate below can
      // show "no type selected" honestly.
      setInspectMachineFields(job.machine || '');
      populateJobSerialSelect(jobSerialsDraft, jobSerialsDraft[0] || '');
      // v157 fix (Phase 15B review, item 2): populateJobSerialSelect() may
      // have pre-selected a single serial above — if that serial already
      // has a known type, show it right away rather than the job default.
      syncInspectMachineFromSerial(readJobSerial());
      openMachineModal();
      toast('Add machine type and serial number to start inspection');
    }

    // v157 (Phase 15B, item 1 + amendment D): the linked job's own serials
    // (if any) come first — they're the most likely match — followed by
    // every other known machine scoped to the typed customer (no site
    // field on this screen, so there's no site tier here).
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
      const jobSerials = (job && Array.isArray(job.serials)) ? job.serials.slice() : [];
      const customerName = job ? job.customer : (document.getElementById('inpCustomer') || {}).value;
      const scoped = machineSerialsScopedTo(customerName, '');
      const seen = new Set();
      const ordered = [];
      jobSerials.concat(scoped).forEach(s => {
        const key = normalizeMatchText(s);
        if (!s || seen.has(key)) return;
        seen.add(key);
        ordered.push(s);
      });
      dl.innerHTML = ordered.map(s => `<option value="${jobEsc(s)}">`).join('');
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
          id: newEntityId('ins'),
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
        id: newEntityId('ins'),
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
        // Phase 15A: this is a real save (job.serials changes and persists
        // below), so resolve/stamp equipment ids here too.
        resolveJobEquipmentSnapshot(job, { source: 'job-save' });
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
      document.getElementById('btnSaveJob').textContent = 'Save';
      const jobFormTitle = document.getElementById('jobFormTitle');
      if (jobFormTitle) jobFormTitle.textContent = 'New Job';
      document.getElementById('btnDeleteJob').classList.add('hidden');
      showScreen('screenJobForm');
      setHeader('New Job');
    }

    // v152 (Phase 12A Fix 5): required fields are marked (*), Save is
    // dimmed until they're filled, and tapping Save anyway outlines the
    // first empty field and scrolls it into view instead of only
    // flashing a toast. Save stays tappable on purpose, so the tap can
    // point at what's missing. The outline clears as soon as you type.
    function flagMissingField(el) {
      if (!el) return;
      el.classList.add('field-missing');
      try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { try { el.scrollIntoView(); } catch (e2) {} }
      if (typeof el.focus === 'function' && /^(INPUT|TEXTAREA)$/.test(el.tagName || '')) {
        try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
      }
    }
    function clearMissingFlag(el) {
      if (el) el.classList.remove('field-missing');
    }
    function refreshJobFormRequired() {
      const c = document.getElementById('jobCustomer');
      const t = document.getElementById('jobTechnician');
      const btn = document.getElementById('btnSaveJob');
      if (!c || !t || !btn) return;
      const ready = !!(c.value.trim() && t.value.trim());
      btn.classList.toggle('is-incomplete', !ready);
      if (c.value.trim()) clearMissingFlag(c);
      if (t.value.trim()) clearMissingFlag(t);
    }
    ['jobCustomer', 'jobTechnician'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', refreshJobFormRequired);
        el.addEventListener('change', refreshJobFormRequired);
      }
    });

    function saveJobFromForm() {
      const customer = document.getElementById('jobCustomer').value.trim();
      const tech = document.getElementById('jobTechnician').value.trim();
      const scope = document.getElementById('jobScope').value.trim();
      const so = document.getElementById('jobSO').value.trim();
      if (!customer || !tech) {
        refreshJobFormRequired();
        flagMissingField(document.getElementById(!customer ? 'jobCustomer' : 'jobTechnician'));
        toast(!customer && !tech ? 'Please fill Customer and Technician' : (!customer ? 'Please fill Customer' : 'Please fill Technician'));
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
        productionLine: (document.getElementById('jobProductionLine') || {}).value ? document.getElementById('jobProductionLine').value.trim() : '',
        status: document.getElementById('jobStatus').value || 'Planned',
        scope,
        // v159 (item 7): job.machine is now a derived summary, computed
        // below AFTER resolveJobEquipmentSnapshot has written each
        // serial's own type — not read from a job-level picker (removed).
        serials: jobSerialsDraft.slice(),
        placeholderMachines: (jobPlaceholdersDraft || []).map(p => Object.assign({}, p)),
        notes: document.getElementById('jobNotes').value.trim(),
        updatedAt: new Date().toISOString()
      };
      payload.status = jobStatusFromDates(payload);
      try { lsWrite('lx8_last_tech', tech); } catch (e) {}
      const list = loadJobs();
      let successCopy;
      let savedJob;
      if (editingJobId) {
        const idx = list.findIndex(j => j.id === editingJobId);
        if (idx < 0) { toast('Job not found'); return; }
        list[idx] = { ...list[idx], ...payload };
        savedJob = list[idx];
        successCopy = 'Job updated';
      } else {
        const newId = newEntityId('job');
        savedJob = ensureJobIdentity({
          id: newId,
          createdAt: new Date().toISOString(),
          ...payload
        });
        list.unshift(savedJob);
        editingJobId = newId;
        successCopy = 'Job saved';
      }
      // v157 fix (Phase 15B review, item 3): only now — the job is actually
      // being saved — do queued "Fill in serial" placeholder conversions
      // really happen (real machine record, reassigned references). A
      // cancelled edit never reaches this line, so its queue (reset by
      // initJobForm on the next edit) is simply discarded.
      if (jobPendingPlaceholderConversions.length) {
        jobPendingPlaceholderConversions.forEach(entry => {
          convertPlaceholderToSerial(entry.placeholder, entry.serial);
        });
        jobPendingPlaceholderConversions = [];
      }
      // Phase 15A: resolve/stamp Customer, Site and Machine ids on every
      // real job save (not on load) — see resolveJobEquipmentSnapshot.
      // v159 (item 6): each serial's own job-chosen type (jobSerialTypeDraft,
      // built by the chips' shared-picker taps and by initJobForm's
      // backward-compat defaults) is what gets applied — never a single
      // job.machine value stamped onto every serial.
      const serialTypeOverrides = {};
      Object.keys(jobSerialTypeDraft || {}).forEach(k => { serialTypeOverrides[k] = jobSerialTypeDraft[k]; });
      resolveJobEquipmentSnapshot(savedJob, { source: 'job-save', serialTypeOverrides });
      // v159 (item 7): job.machine — kept only as a derived summary (most
      // common type across this job's serials/placeholders) for old
      // readers (parts-request headers, the inspection info card, old
      // exports, old data) to keep working. Computed AFTER the line above
      // so it reflects each serial's real, just-resolved type.
      savedJob.machine = computeJobMachineSummary(savedJob);
      // Phase 7B: the success toast used to fire right here,
      // unconditionally, before saveJobs was even called. Now it only
      // fires once saveJobs' own return value confirms the write
      // actually happened — on failure the technician sees a failure
      // toast instead of "Job saved"/"Job updated" for an edit that
      // didn't persist. list (in-memory) already holds the edit either
      // way, same as before this phase — a reload before a later
      // successful save would still lose an edit that failed to
      // persist here.
      const ok = saveJobs(list);
      if (!ok) {
        toast('Could not save job — storage full or unavailable');
        return;
      }
      toast(successCopy);
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



    /* ---- Swipe to delete (Mail-style) ---- */
    const SWIPE_ACTION_W = 78;
    const SWIPE_OPEN_AT = SWIPE_ACTION_W * 0.375;
    window.swipeOpenHost = null;
    window.swipeIgnoreClicksUntil = 0;

    function swipeHaptic() {
      try {
        if (navigator.vibrate) navigator.vibrate(8);
      } catch (e) {}
    }

    function swipeApply(host, x, withSpring) {
      if (!host) return;
      const front = host._swipeFront || host.querySelector('.list-item, .pl-item, .tc-entry');
      const disc = host._swipeDisc || host.querySelector('.swipe-delete-disc');
      const label = host._swipeLabel || host.querySelector('.swipe-delete-label');
      const easeOpen = 'transform 0.72s cubic-bezier(0.08, 0.78, 0.08, 1)';
      const easeClose = 'transform 0.46s cubic-bezier(0.22, 0.82, 0.2, 1)';
      const opening = withSpring && x < -2;
      const ease = opening ? easeOpen : easeClose;
      if (front) {
        front.style.transition = withSpring ? ease : 'none';
        front.style.transform = 'translate3d(' + x + 'px,0,0)';
      }
      const p = Math.max(0, Math.min(1.15, (-x) / SWIPE_ACTION_W));
      const scale = Math.max(0.08, Math.min(1, 0.08 + 0.92 * Math.min(1, p)));
      const lab = Math.max(0, Math.min(1, (p - 0.28) / 0.55));
      if (disc) {
        disc.style.transition = withSpring ? (ease + ', opacity 0.4s ease') : 'none';
        disc.style.transform = 'scale(' + scale + ')';
      }
      if (label) {
        label.style.transition = withSpring ? 'opacity 0.28s ease' : 'none';
        label.style.opacity = String(lab);
      }
    }

    function swipeResist(x) {
      if (x > 0) return x * 0.16;
      const abs = -x;
      if (abs <= SWIPE_ACTION_W) return x;
      const extra = abs - SWIPE_ACTION_W;
      return -(SWIPE_ACTION_W + extra * 0.2);
    }

    function swipeDisarm(host) {
      if (!host) return;
      host.classList.remove('swipe-ready');
      if (host._swipeReadyT) { clearTimeout(host._swipeReadyT); host._swipeReadyT = null; }
      if (host._swipeReadyRaf) { cancelAnimationFrame(host._swipeReadyRaf); host._swipeReadyRaf = 0; }
    }
    function swipeArm(host) {
      if (!host || !host.classList.contains('swipe-open')) return;
      host.classList.add('swipe-ready');
    }
    function swipeReadX(front) {
      if (!front) return 0;
      const t = getComputedStyle(front).transform;
      if (!t || t === 'none') return 0;
      if (t.indexOf('matrix3d') === 0) {
        const p = t.slice(9, -1).split(',');
        return parseFloat(p[12]) || 0;
      }
      if (t.indexOf('matrix') === 0) {
        const p = t.slice(7, -1).split(',');
        return parseFloat(p[4]) || 0;
      }
      return 0;
    }
    function swipeWatchArm(host) {
      if (!host) return;
      const front = host._swipeFront || host.querySelector('.list-item, .pl-item, .tc-entry');
      const tick = () => {
        if (!host.classList.contains('swipe-open')) return;
        const x = swipeReadX(front);
        if (-x >= SWIPE_ACTION_W * 0.8) {
          swipeArm(host);
          host._swipeReadyRaf = 0;
          return;
        }
        host._swipeReadyRaf = requestAnimationFrame(tick);
      };
      host._swipeReadyRaf = requestAnimationFrame(tick);
    }
    function swipeCloseHost(host, spring) {
      if (!host) return;
      swipeDisarm(host);
      const front = host._swipeFront || host.querySelector('.list-item, .pl-item, .tc-entry');
      swipeApply(host, 0, spring !== false);
      host.classList.remove('swipe-open');
      host._swipeX = 0;
      if (window.swipeOpenHost === host) window.swipeOpenHost = null;
    }

    function swipeCloseAll(except) {
      document.querySelectorAll('.swipe-host.swipe-open').forEach(h => {
        if (h !== except) swipeCloseHost(h, true);
      });
    }

    function swipeOpenHostTo(host) {
      swipeDisarm(host);
      swipeApply(host, -SWIPE_ACTION_W, true);
      host.classList.add('swipe-open');
      host._swipeX = -SWIPE_ACTION_W;
      window.swipeOpenHost = host;
      swipeWatchArm(host);
    }

    function bindSwipeToDelete(container, rowSelector, specFn) {
      if (!container) return;
      const rows = container.querySelectorAll(rowSelector);
      rows.forEach(row => {
        if (row.closest && row.closest('.swipe-host')) return;
        if (row.dataset.swipeSkip === '1') return;
        const host = document.createElement('div');
        host.className = 'swipe-host' + (row.classList.contains('tc-entry') ? ' swipe-host-tc' : '');
        const actions = document.createElement('div');
        actions.className = 'swipe-actions';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'swipe-delete-btn';
        btn.setAttribute('aria-label', 'Delete');
        btn.innerHTML = '<span class="swipe-delete-disc"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7.4 7.15h9.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M10.55 7.15V5.7A1.15 1.15 0 0 1 11.7 4.55h.6A1.15 1.15 0 0 1 13.45 5.7v1.45" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.55 7.4l.62 11.15A1.85 1.85 0 0 0 10 20.35h4a1.85 1.85 0 0 0 1.83-1.8L16.45 7.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.35 10.55v6.05M13.65 10.55v6.05" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span><span class="swipe-delete-label">Delete</span>';
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!host.classList.contains('swipe-ready')) return;
          const spec = specFn(row, host);
          if (!spec) return;
          if (typeof showDeleteConfirm === 'function') {
            showDeleteConfirm(spec.id, spec.kind, spec.title, spec.label);
          }
        });
        actions.appendChild(btn);
        row.parentNode.insertBefore(host, row);
        host.appendChild(actions);
        host.appendChild(row);
        host._swipeFront = row;
        host._swipeDisc = host.querySelector('.swipe-delete-disc');
        host._swipeLabel = host.querySelector('.swipe-delete-label');
        host._swipeX = 0;
        swipeApply(host, 0, false);

        let pid = null, startX = 0, startY = 0, lastX = 0, baseX = 0;
        let axis = null, tracking = false, crossed = false;

        const front = row;

        const onDown = (e) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          if (e.target && e.target.closest && e.target.closest('.swipe-delete-btn, button, a, input, select, textarea, img')) {
            if (e.target.closest && e.target.closest('.swipe-delete-btn')) return;
            if (host.classList.contains('swipe-open')) {
              swipeCloseHost(host, true);
              window.swipeIgnoreClicksUntil = Date.now() + 280;
              e.preventDefault();
            }
            return;
          }
          if (window.swipeOpenHost && window.swipeOpenHost !== host) swipeCloseAll(host);
          // Pointer capture is deliberately NOT taken here anymore — see
          // onMove, where it's only taken once a horizontal swipe is
          // actually confirmed. Capturing unconditionally on every
          // pointerdown (including a plain click with no movement at
          // all) retargets the browser's synthesized "click" event to
          // this host element instead of the original nested target —
          // per spec, but it meant [data-action="open"]'s own click
          // listener, and every other nested click handler on every
          // swipeable row app-wide, never fired at all with mouse
          // input (touch was unaffected, which is why this only showed
          // up on desktop/Windows, never in phone testing). A plain
          // click/tap now never captures the pointer, so the native
          // click reaches its real target normally.
          pid = e.pointerId;
          startX = lastX = e.clientX;
          startY = e.clientY;
          axis = null;
          tracking = true;
          crossed = false;
          baseX = host._swipeX || 0;
          swipeApply(host, baseX, false);
        };

        const onMove = (e) => {
          if (!tracking || e.pointerId !== pid) return;
          const dx = e.clientX - startX;
          const dy = e.clientY - startY;
          if (!axis) {
            if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
            axis = (Math.abs(dx) > Math.abs(dy) * 1.2) ? 'h' : 'v';
            if (axis === 'v') {
              tracking = false;
              pid = null;
              return;
            }
            // Horizontal swipe confirmed — capture now, not before, so
            // the drag keeps tracking correctly even if the pointer
            // moves outside the row's own bounds.
            try { host.setPointerCapture(pid); } catch (_) {}
          }
          if (axis !== 'h') return;
          e.preventDefault();
          swipeDisarm(host);
          lastX = e.clientX;
          const raw = baseX + dx;
          const x = swipeResist(raw);
          host._swipeX = x;
          swipeApply(host, x, false);
          if (-x >= SWIPE_ACTION_W * 0.8) {
            host.classList.add('swipe-open');
            swipeArm(host);
          } else {
            swipeDisarm(host);
          }
          if (!crossed && x <= -SWIPE_OPEN_AT) {
            crossed = true;
            swipeHaptic();
          }
        };

        const onUp = (e) => {
          if (pid == null || (e && e.pointerId !== pid)) return;
          try { host.releasePointerCapture(pid); } catch (_) {}
          const wasH = axis === 'h';
          const x = host._swipeX || 0;
          tracking = false;
          axis = null;
          pid = null;
          if (!wasH) return;
          window.swipeIgnoreClicksUntil = Date.now() + 280;
          if (x <= -SWIPE_OPEN_AT) window.swipeOpenHostTo(host);
          else swipeCloseHost(host, true);
        };

        host.addEventListener('pointerdown', onDown);
        host.addEventListener('pointermove', onMove, { passive: false });
        host.addEventListener('pointerup', onUp);
        host.addEventListener('pointercancel', onUp);

        row.addEventListener('click', (e) => {
          if (Date.now() < window.swipeIgnoreClicksUntil) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          if (host.classList.contains('swipe-open')) {
            e.preventDefault();
            e.stopPropagation();
            swipeCloseHost(host, true);
          }
        }, true);
      });
    }
    window.swipeOpenHostTo = swipeOpenHostTo;
    window.bindSwipeToDelete = bindSwipeToDelete;
    window.swipeCloseAll = swipeCloseAll;

    document.addEventListener('scroll', () => swipeCloseAll(), { capture: true, passive: true });
    document.addEventListener('touchstart', (e) => {
      if (!window.swipeOpenHost) return;
      if (e.target && window.swipeOpenHost.contains(e.target)) return;
      swipeCloseAll();
    }, { passive: true });

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
      // v170: the inspection's own photos are marked deleted with it.
      const lxsInsPhotoIds = [];
      if (lxsIsV2Safe()) {
        const victim = list.find(i => i && i.id === id);
        if (victim && victim.results) Object.keys(victim.results).forEach(k => { const r = victim.results[k]; if (r && r.photoId) lxsInsPhotoIds.push(r.photoId); });
        if (victim && Array.isArray(victim.findings)) victim.findings.forEach(f => { if (f && f.photoId) lxsInsPhotoIds.push(f.photoId); });
      }
      saveInspections(next);
      if (lxsInsPhotoIds.length) LXS.deletePhotosExplicit(lxsInsPhotoIds);

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
      if (kind === 'job') run(window.performDeleteJob || performDeleteJob, id);
      else if (kind === 'punchlist-item') run(window.performDeletePunchlistItem || performDeletePunchlistItem, id);
      else if (kind === 'punchlist-item-unsaved') {
        if (typeof closeModal === 'function') closeModal();
        closeDeleteModal();
        toast('Item discarded');
      }
      else if (kind === 'punchlist-photo') {
        const fn = window.removePhoto || removePhoto;
        if (typeof fn === 'function') fn();
        if (typeof closePunchlistPhoto === 'function') closePunchlistPhoto();
        closeDeleteModal();
        toast('Photo deleted');
      }
      else if (kind === 'punchlist') run(window.performDeletePunchlist || performDeletePunchlist, id);
      else if (kind === 'parts-request') run(window.performDeletePartsRequest || performDeletePartsRequest, id);
      else if (kind === 'parts-line') run(window.performDeletePartsLine || performDeletePartsLine, id);
      else if (kind === 'parts-photo') run(window.performDeletePartsPhoto || performDeletePartsPhoto, id);
      else if (kind === 'timecard') run(window.performDeleteTimecard, id);
      else if (kind === 'inspect-photo') run(window.performDeleteInspectPhoto || performDeleteInspectPhoto, id);
      else if (kind === 'sample-data') run(performRemoveSampleData, id); // v152 (Phase 12A Fix 6)
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
      // Always the actual first section, not wherever a previous session
      // left off — a saved currentSectionIndex from earlier progress
      // used to make this "resume in place", which looked like landing
      // on the wrong section. The dots still let a tech jump straight to
      // any section (including Findings, last) if they want to pick up
      // partway through instead.
      currentSectionIndex = 0;
      currentItemIndex = 0;
      editingInspectionId = null;
      extraSectionTab = null;
      showScreen('screenInspect');
      setHeader('Inspecting');
      renderSection(true);
    }

    // v157 (Phase 15B, item 1): customer suggestions merge past-inspection
    // names with the Phase 15A Customer store, so a customer created only
    // via a job (never yet inspected) still suggests.
    function inspectionCustomerNames() {
      const names = new Set();
      try { loadInspections().forEach(i => i && i.customer && names.add(i.customer)); } catch (e) {}
      try { (loadCustomers() || []).forEach(c => c && c.name && names.add(c.name)); } catch (e) {}
      return [...names];
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
      setInpModelField(ins.model || 'LX-8');
      document.getElementById('inpSerial').value = ins.serial || '';
      document.getElementById('inpTechnician').value = ins.technician || profileName() || '';
      document.getElementById('inpDate').value = ins.date || new Date().toISOString().slice(0, 10);
      document.getElementById('inpPO').value = ins.po || '';
      // Autocomplete customers
      document.getElementById('customerList').innerHTML = inspectionCustomerNames().map(c => `<option value="${jobEsc(c)}">`).join('');
      fillInspectionSerialOptions(ins.jobId ? loadJobs().find(j => j.id === ins.jobId) : null);
      // Linked job chip
      linkedJobIdForStart = ins.jobId || null;
      fillInspectJobSelect(ins.jobId || '');
      const group = document.getElementById('jobLinkGroup');
      if (group) group.classList.remove('hidden');
      if (true) {
        document.getElementById('inpCustomer').value = ins.customer || '';
        setInpModelField(ins.model || 'LX-8');
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
      setInpModelField('LX-8');
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
      document.getElementById('customerList').innerHTML = inspectionCustomerNames().map(c => `<option value="${jobEsc(c)}">`).join('');
      fillInspectionSerialOptions(null);
    }
    // v157 (Phase 15B, amendment D): keep serial suggestions on the start
    // screen scoped to whatever's currently typed in Customer, same as the
    // job form.
    (function bindInspectCustomerScoping() {
      const el = document.getElementById('inpCustomer');
      if (el) el.addEventListener('input', () => {
        const job = linkedJobIdForStart ? loadJobs().find(j => j.id === linkedJobIdForStart) : null;
        fillInspectionSerialOptions(job);
      });
    })();


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
      setActiveMachine(currentInspection.model || 'LX-8');
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

    document.getElementById('navHomeInspect').addEventListener('click', () => {
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
              // openPunchlistByName() has already rendered the list; v156
              // no longer renders it a second time here.
              await window.openPunchlistByName(last);
              showScreen('screenPunchlist');
              setHeader('Punchlist');
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
    document.getElementById('navHomePunchlist').addEventListener('click', () => {
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
    const btnViewAllJobs = document.getElementById('btnViewAllJobs');
    if (btnViewAllJobs) btnViewAllJobs.addEventListener('click', () => {
      closeSearch();
      showScreen('screenJobsList');
      setHeader('Jobs');
      refreshJobsList();
    });

    // ===== PARTS REQUESTS bindings =====
    const homeTileParts = document.getElementById('navHomeParts');
    if (homeTileParts) homeTileParts.addEventListener('click', () => {
      closeSearch();
      setPartsListTab('unsent');
      showScreen('screenPartsList');
      setHeader('Parts Requests');
      landPartsSeg();
    });
    const btnNewParts = document.getElementById('btnNewParts');
    if (btnNewParts) btnNewParts.addEventListener('click', () => openPartsForm(null));
    document.querySelectorAll('#partsSeg .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => setPartsListTab(btn.getAttribute('data-status')));
    });
    const btnJobOpenParts = document.getElementById('btnJobOpenParts');
    if (btnJobOpenParts) btnJobOpenParts.addEventListener('click', () => openPartsForm(null, detailJobId));
    const btnPartsUrgent = document.getElementById('btnPartsUrgent');
    if (btnPartsUrgent) btnPartsUrgent.addEventListener('click', () => {
      if (!partsFormDraft) return;
      partsFormDraft.urgent = !partsFormDraft.urgent;
      renderPartsForm();
      savePartsFormDraft(false);
    });
    const btnLineUrgent = document.getElementById('btnLineUrgent');
    if (btnLineUrgent) btnLineUrgent.addEventListener('click', () => {
      btnLineUrgent.classList.toggle('on');
    });
    const btnPartsSend = document.getElementById('btnPartsSend');
    if (btnPartsSend) btnPartsSend.addEventListener('click', () => { sendPartsFormDraft(); });
    const btnAddPartsLine = document.getElementById('btnAddPartsLine');
    if (btnAddPartsLine) btnAddPartsLine.addEventListener('click', () => openPartsLineModal(null));
    const partsLineModal = document.getElementById('partsLineModal');
    if (partsLineModal) partsLineModal.addEventListener('click', (e) => { if (e.target.id === 'partsLineModal') closePartsLineModal(); });
    const plineCancel = document.getElementById('plineCancel');
    if (plineCancel) plineCancel.addEventListener('click', closePartsLineModal);
    const plineSave = document.getElementById('plineSave');
    if (plineSave) plineSave.addEventListener('click', savePartsLineModal);
    const plineDescEl = document.getElementById('plineDesc');
    if (plineDescEl) plineDescEl.addEventListener('input', refreshPartsLineRequired); // v152 (Phase 12A Fix 5)
    const plinePhotoInput = document.getElementById('plinePhotoInput');
    if (plinePhotoInput) plinePhotoInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) attachPartsRequestPhoto(file);
    });
    const btnPartsCopyText = document.getElementById('btnPartsCopyText');
    if (btnPartsCopyText) btnPartsCopyText.addEventListener('click', async () => {
      const ta = document.getElementById('partsShareText');
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(ta.value);
        else { ta.select(); document.execCommand('copy'); }
        toast('Copied to clipboard');
      } catch (e) { ta.select(); toast('Select and copy the text below'); }
      if (partsFormDraft && partsFormDraft.status === 'unsent') {
        partsFormDraft.status = 'pending';
        savePartsFormDraft(false);
        renderPartsForm();
      }
    });
    const btnPartsShareClose = document.getElementById('btnPartsShareClose');
    if (btnPartsShareClose) btnPartsShareClose.addEventListener('click', () => {
      closePartsShareSheet();
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

    const btnJobMachinePopup = document.getElementById('btnJobMachinePopup');
    if (btnJobMachinePopup) btnJobMachinePopup.addEventListener('click', () => {
      machineModalMode = 'job';
      openMachineModal();
    });
    const machineCancel = document.getElementById('machineModalCancel');
    if (machineCancel) machineCancel.addEventListener('click', () => {
      machineModalMode = 'job';
      closeMachineModal();
    });
    const machineDone = document.getElementById('machineModalDone');
    if (machineDone) machineDone.addEventListener('click', () => {
      if (machineModalMode === 'startInspect') {
        // v159 review fix #4: inspections are checklist-driven, so a type
        // with no checklist (or no type picked at all yet) can't start
        // one — require a real checklist type first rather than silently
        // starting against the wrong template.
        const currentType = (typeof readInspectMachine === 'function') ? readInspectMachine() : '';
        if (!currentType || !typeHasChecklist(currentType)) {
          toast(currentType ? `No inspection checklist for ${currentType} — pick a type` : 'Pick a machine type to start the inspection');
          return;
        }
        startInspectionFromMachinePopup();
        return;
      }
      closeMachineModal();
    });
    const machineModal = document.getElementById('machineModal');
    if (machineModal) machineModal.addEventListener('click', (e) => {
      if (e.target.id === 'machineModal') closeMachineModal();
    });
    const genericTextCancel = document.getElementById('genericTextCancel');
    if (genericTextCancel) genericTextCancel.addEventListener('click', closeGenericTextModal);
    const genericTextSave = document.getElementById('genericTextSave');
    if (genericTextSave) genericTextSave.addEventListener('click', () => {
      const input = document.getElementById('genericTextInput');
      const v = (input && input.value || '').trim();
      const cb = genericTextPromptOnSave;
      if (!v) return;
      closeGenericTextModal();
      if (cb) cb(v);
    });
    const genericTextModalEl = document.getElementById('genericTextModal');
    if (genericTextModalEl) genericTextModalEl.addEventListener('click', (e) => {
      if (e.target.id === 'genericTextModal') closeGenericTextModal();
    });
    const typePickerCancel = document.getElementById('typePickerCancel');
    if (typePickerCancel) typePickerCancel.addEventListener('click', closeTypePicker);
    const typePickerModalEl = document.getElementById('typePickerModal');
    if (typePickerModalEl) typePickerModalEl.addEventListener('click', (e) => {
      if (e.target.id === 'typePickerModal') closeTypePicker();
    });
    const addSerialBtn = document.getElementById('btnAddJobSerial');
    if (addSerialBtn) addSerialBtn.addEventListener('click', addJobSerialFromInput);
    const serialInp = document.getElementById('jobSerialInput');
    if (serialInp) serialInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addJobSerialFromInput(); }
    });
    // v157 (Phase 15B, amendment D): keep Site/Serial suggestions scoped to
    // whatever's currently typed in Customer (and Site, for serials).
    const jobCustomerInp = document.getElementById('jobCustomer');
    if (jobCustomerInp) jobCustomerInp.addEventListener('input', () => {
      const site = document.getElementById('jobSite');
      fillJobSiteList(jobCustomerInp.value);
      fillJobSerialList(jobCustomerInp.value, site ? site.value : '');
    });
    const jobSiteInp = document.getElementById('jobSite');
    if (jobSiteInp) jobSiteInp.addEventListener('input', () => {
      fillJobSerialList(jobCustomerInp ? jobCustomerInp.value : '', jobSiteInp.value);
    });
    const btnAddJobPlaceholder = document.getElementById('btnAddJobPlaceholder');
    if (btnAddJobPlaceholder) btnAddJobPlaceholder.addEventListener('click', addJobPlaceholderMachine);
    // v158 simplification: "+ Production line" reveals the (rare)
    // Production line field and hides itself; the field itself, and how
    // it's saved, are unchanged.
    const btnShowJobProductionLine = document.getElementById('btnShowJobProductionLine');
    if (btnShowJobProductionLine) btnShowJobProductionLine.addEventListener('click', () => {
      const grp = document.getElementById('jobProductionLineGroup');
      if (grp) {
        grp.classList.remove('hidden');
        const inp = document.getElementById('jobProductionLine');
        if (inp) inp.focus();
      }
      btnShowJobProductionLine.classList.add('hidden');
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
          syncInspectMachineFromSerial(jobSerialSel.value);
        }
        updateJobMachineSummary();
      });
    }
    const inspectSerialCustomInp = document.getElementById('inspectSerialInput');
    if (inspectSerialCustomInp) {
      // v157 fix (Phase 15B review, item 2): a typed ("Other") serial that
      // turns out to already be a known machine should sync its type too —
      // checked as the technician finishes typing, not on every keystroke.
      inspectSerialCustomInp.addEventListener('blur', () => {
        syncInspectMachineFromSerial(inspectSerialCustomInp.value);
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
    // v159 (item 3): the two "inspection machine picker" buttons — both
    // open the shared picker restricted to checklist types.
    const inspectMachineTypeBtn = document.getElementById('inspectMachineTypeBtn');
    if (inspectMachineTypeBtn) inspectMachineTypeBtn.addEventListener('click', () => {
      openTypePicker({
        title: 'Machine type',
        current: readInspectMachine(),
        restrictToChecklist: true,
        onSelect: (t) => setInspectMachineFields(t)
      });
    });
    const inpModelTypeBtn = document.getElementById('inpModelTypeBtn');
    if (inpModelTypeBtn) inpModelTypeBtn.addEventListener('click', () => {
      openTypePicker({
        title: 'Machine type',
        current: readInpModel(),
        restrictToChecklist: true,
        onSelect: (t) => setInpModelField(t)
      });
    });
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
      // v170: same format (prefix + time + 6 random characters); the random
      // part now comes from the browser's secure generator.
      let r;
      try { r = LXS.rand6(); } catch (e) { r = Math.random().toString(36).slice(2, 8); }
      return String(prefix || 'id') + '_' + Date.now().toString(36) + r;
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
      const base = isInternalId(label) ? 'Job' : label;
      const line = String((job && job.productionLine) || '').trim();
      return line ? (base + ' · ' + line) : base;
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

    // v170: the text a list key used to show where the raw key was shown
    // (Needs Attention, search). Lists that used to be keyed by their name
    // keep showing that name after getting a unique id.
    function punchlistKeyLabel(key) {
      try { return LXS.isV2() ? LXS.listLabel(key) : String(key == null ? '' : key); } catch (e) { return String(key == null ? '' : key); }
    }
    window.punchlistKeyLabel = punchlistKeyLabel;
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
        if (job.machine) setInpModelField(job.machine);
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
            id: newEntityId('ins'),
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

    // Phase 6 — runs only when explicitly tapped, never on startup and
    // never when the Punchlist screen opens, per the phase's
    // performance requirement. Read-only: renders whatever
    // analyzePunchlistIntegrity() returns, does not call any save/
    // mutation function.
    function renderPunchlistDiagReport(report) {
      const body = document.getElementById('punchlistDiagBody');
      if (!body) return;
      const esc = (typeof jobEsc === 'function') ? jobEsc : (s => String(s == null ? '' : s));
      const parts = [];
      parts.push('<p style="color:var(--muted);font-size:0.85rem;margin:0 0 14px;">These records may need review. No changes have been made.</p>');
      parts.push('<p style="font-size:0.85rem;margin:0 0 14px;">' + report.totalBuckets + ' Punchlist bucket(s) total · ' + report.validBuckets + ' structurally valid</p>');
      if (report.currentJobFinding) {
        parts.push('<div class="card" style="padding:12px;margin-bottom:10px;border-color:var(--danger,#f87171);"><strong>' + esc(report.currentJobFinding.classification) + '</strong><div style="font-size:0.8rem;color:var(--muted);margin-top:4px;">' + esc(report.currentJobFinding.reason) + '</div></div>');
      }
      if (!report.findings.length) {
        parts.push('<p style="font-size:0.85rem;color:var(--muted);">No structural issues found.</p>');
      }
      report.findings.forEach(f => {
        const bucketLines = (f.buckets || []).map(b =>
          '&nbsp;&nbsp;' + esc(b.name) + ' (' + esc(b.bucketKey) + ') — ' + b.itemCount + ' item' + (b.itemCount === 1 ? '' : 's') + (b.isCurrent ? ' · current' : '')
        ).join('<br>');
        parts.push(
          '<div class="card" style="padding:12px;margin-bottom:10px;">' +
            '<strong>' + esc(f.classification) + '</strong>' +
            '<div style="font-size:0.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;margin-top:2px;">' + esc(f.determinism) + '</div>' +
            (f.jobId ? '<div style="font-size:0.8rem;margin-top:6px;">Job: ' + esc(f.jobId) + '</div>' : '') +
            (bucketLines ? '<div style="font-size:0.8rem;margin-top:6px;">' + bucketLines + '</div>' : '') +
            '<div style="font-size:0.8rem;color:var(--muted);margin-top:6px;">' + esc(f.reason) + '</div>' +
          '</div>'
        );
      });
      if (report.emptyBuckets && report.emptyBuckets.length) {
        const lines = report.emptyBuckets.map(b => '&nbsp;&nbsp;' + esc(b.name) + ' (' + esc(b.bucketKey) + ')').join('<br>');
        parts.push('<div class="card" style="padding:12px;margin-bottom:10px;"><strong>Empty Punchlists — review</strong><div style="font-size:0.8rem;color:var(--muted);margin-top:6px;">An empty Punchlist may be intentional (not yet used) or a leftover. Listed for awareness only.</div><div style="font-size:0.8rem;margin-top:6px;">' + lines + '</div></div>');
      }
      body.innerHTML = parts.join('');
    }
    const btnPunchlistDiag = document.getElementById('btnPunchlistDiag');
    const punchlistDiagModal = document.getElementById('punchlistDiagModal');
    const punchlistDiagClose = document.getElementById('punchlistDiagClose');
    if (btnPunchlistDiag) btnPunchlistDiag.addEventListener('click', async () => {
      if (typeof window.analyzePunchlistIntegrity !== 'function') { toast('Diagnostic unavailable'); return; }
      const report = await window.analyzePunchlistIntegrity();
      renderPunchlistDiagReport(report);
      if (punchlistDiagModal) { punchlistDiagModal.hidden = false; punchlistDiagModal.classList.add('show'); punchlistDiagModal.setAttribute('aria-hidden', 'false'); }
    });
    if (punchlistDiagClose) punchlistDiagClose.addEventListener('click', () => {
      if (punchlistDiagModal) { punchlistDiagModal.classList.remove('show'); punchlistDiagModal.hidden = true; punchlistDiagModal.setAttribute('aria-hidden', 'true'); }
    });
    if (punchlistDiagModal) punchlistDiagModal.addEventListener('click', (e) => {
      if (e.target === punchlistDiagModal) { punchlistDiagModal.classList.remove('show'); punchlistDiagModal.hidden = true; punchlistDiagModal.setAttribute('aria-hidden', 'true'); }
    });

    function getActiveCurrentJob() {
      const list = (typeof getCurrentJobs === 'function') ? getCurrentJobs() : [];
      return (list && list[0]) || null;
    }
    // v157 (Phase 15B, item 2 + amendment C): starts a Draft inspection
    // straight away for a serial whose type is already confirmed — same
    // record shape as startInspectionFromMachinePopup's job-linked branch,
    // just without needing the machine modal first. The type used is
    // always shown (see the inspectMachineBanner wiring in renderSection).
    function beginInspectionForKnownMachine(job, serial, model) {
      pendingInspectJobId = null;
      machineModalMode = 'job';
      currentInspection = null;
      editingInspectionId = null;
      results = {};
      findings = [];
      currentSectionIndex = 0;
      if (typeof setActiveMachine === 'function') setActiveMachine(model);
      currentInspection = {
        id: newEntityId('ins'),
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
      toast('Known serial — opened ' + model + ' checklist');
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
      // v157 (Phase 15B, item 2): a job with exactly one serial whose type
      // has already been CONFIRMED by a past inspection skips the machine
      // modal entirely — no type to ask about, no serial to pick between.
      // A never-seen serial, or one whose type only ever came from a job
      // field, still shows the modal below (pre-filled, one tap to
      // confirm) — same as today.
      const jobSerials = job ? normalizeJobSerials(Array.isArray(job.serials) ? job.serials : []) : [];
      if (job && jobSerials.length === 1) {
        const knownMachine = findMachineBySerial(jobSerials[0]);
        if (knownMachine && knownMachine.machineTypeSource === 'inspection' && knownMachine.machineType) {
          beginInspectionForKnownMachine(job, jobSerials[0], knownMachine.machineType);
          return;
        }
      }
      if (job) applyJobToInspectionForm(job);
      else applyJobToInspectionForm(null);
      const model = (job && job.machine) || 'LX-8';
      setInpModelField(model);
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
      // v157 fix (Phase 15B review, item 2): same pre-fill-from-serial rule
      // as startInspectionForDetailJob above.
      syncInspectMachineFromSerial(readJobSerial());
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
    // v157 (Phase 15B, item 4): "<Customer> – <Production line>" when the
    // job (or one of its machines) has one — still just a suggestion, the
    // name box stays fully editable and blank otherwise, exactly as today.
    function suggestedPunchlistName(job) {
      if (!job || !job.customer) return '';
      let prodLine = job.productionLine || '';
      if (!prodLine && Array.isArray(job.equipmentIds) && job.equipmentIds.length) {
        try {
          const machines = loadMachines() || [];
          const withLine = job.equipmentIds.map(id => machines.find(m => m && m.id === id)).find(m => m && m.productionLine);
          if (withLine) prodLine = withLine.productionLine;
        } catch (e) {}
      }
      return prodLine ? (job.customer + ' – ' + prodLine) : '';
    }
    function openPunchlistStartSheet(job) {
      const sheet = document.getElementById('plStartSheet');
      if (!sheet) { toast('Punchlist sheet missing'); return; }
      editingPunchlistKey = '';
      punchlistEditIsNew = true;
      configurePunchlistSheet('new');
      const nameEl = document.getElementById('plStartName');
      if (nameEl) nameEl.value = suggestedPunchlistName(job);
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
      if (punchlistSheetMode === 'edit') {
        editingPunchlistKey = '';
        punchlistEditIsNew = false;
      }
      configurePunchlistSheet('new');
    }
    async function confirmPunchlistStart() {
      if (punchlistSheetMode === 'edit' && editingPunchlistKey) {
        await savePunchlistEdit();
        return;
      }
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
      const delStart = document.getElementById('plStartDelete');
      if (delStart && delStart.dataset.bound !== '1') {
        delStart.dataset.bound = '1';
        delStart.addEventListener('click', (e) => {
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
        // Phase 15A / Decision 2: once an inspection has any recorded
        // answer or is Complete, its machine type must never change again.
        // Every other field in this form still saves normally; only the
        // type change itself is dropped, silently as far as the record
        // goes, but the technician is told via toast (not a silent revert).
        const typeLocked = isInspectionTypeLocked(list[idx]) &&
          normalizeMatchText(model) !== normalizeMatchText(list[idx].model);
        if (!typeLocked) list[idx].model = model;
        list[idx].serial = serial;
        list[idx].technician = tech;
        list[idx].date = date;
        list[idx].po = po;
        const jobSel = document.getElementById('inspectJobSelect');
        const pickedJob = (jobSel && jobSel.value) ? jobSel.value : (linkedJobIdForStart || null);
        list[idx].jobId = pickedJob || null;
        linkedJobIdForStart = pickedJob || null;
        list[idx].updatedAt = new Date().toISOString();
        resolveInspectionEquipmentSnapshot(list[idx], { source: 'inspection-save' });
        saveInspections(list);
        currentInspection = list[idx];
        editingInspectionId = null;
        document.getElementById('btnBeginInspection').textContent = 'Begin Inspection';
        document.getElementById('btnDeleteInspection').classList.add('hidden');
        toast(typeLocked ? "Machine type can't be changed once answers are recorded." : 'Inspection details updated');
        showScreen('screenInspectList');
        setHeader('Inspections');
        refreshHome();
        return;
      }

      // Create new inspection
      currentInspection = {
        id: newEntityId('ins'),
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
      html = html + `<div class="section-dot${extraSectionTab === 'findings' ? ' current' : ''}" data-extra="findings">Findings</div>`;
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
            return;
          }
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
      const items = currentSectionItems();
      const idx = items.findIndex(it => it.item_id === afterId);
      for (let i = idx + 1; i < items.length; i++) {
        if (!results[items[i].item_id] || !results[items[i].item_id].condition) {
          const el = document.getElementById('item-' + items[i].item_id);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
      }
    }
    function currentSectionItems() {
      if (!APP_DATA || !APP_DATA.sections || !APP_DATA.sections[currentSectionIndex]) return [];
      return getItemsForSection(APP_DATA.sections[currentSectionIndex].section_id);
    }
    function goToNextInspectItem() {
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
    }

    function goToPrevInspectItem() {
      if (currentSectionIndex > 0) {
        currentSectionIndex -= 1;
        const prevItems = currentSectionItems();
        currentItemIndex = Math.max(0, prevItems.length - 1);
        saveCurrentDraft();
        renderSection(true);
        window.scrollTo(0, 0);
      }
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
      // v157 (Phase 15B, amendment C): always visible, so an auto-picked
      // machine type (Begin skipped the dropdown) is never a surprise.
      const banner = document.getElementById('inspectMachineBanner');
      if (banner && currentInspection) {
        banner.textContent = [currentInspection.model, currentInspection.serial ? 'S/N ' + currentInspection.serial : ''].filter(Boolean).join(' · ');
      }

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
      const visible = items;
      container.classList.add('inspect-list-mode');
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
        const compact = isAnswered && isCleanResult(item, res.condition);
        if (compact) cardClass += ' compact';

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
              <div class="form-group">
                <label>Part needed <span class="pline-optional-hint">(optional)</span></label>
                <input type="text" class="part-needed-input" data-item="${item.item_id}" value="${jobEsc(res.partNeeded || '')}" placeholder="e.g. Seal bar heater">
              </div>
            </div>`;
        }

        const photoHtml = res.photoDataUrl
          ? `<div class="pl-photo-block"><div class="pl-photo-preview-wrap"><img class="photo-preview" src="${res.photoDataUrl}" alt="" /></div></div>`
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
            delete results[itemId].severity;
            // Condition reversed away from a finding (e.g. Poor -> Good)
            // — clean up any generated parts-request line the same way
            // deleting a punchlist item does, since the problem it was
            // for no longer applies.
            if (results[itemId].partNeeded) {
              delete results[itemId].partNeeded;
              if (typeof removePartsRequestSource === 'function' && currentInspection) {
                removePartsRequestSource('inspection', 'ins_' + ((currentInspection && currentInspection.id) || 'draft') + '_' + itemId);
              }
            }
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
          // Re-sync urgency on an already-generated line if severity
          // changes after the part was typed — otherwise bumping to
          // Critical later wouldn't flip a line that's already there.
          if (results[itemId].partNeeded && typeof syncPartsRequestFromSource === 'function' && currentInspection) {
            const item = APP_DATA.items.find(i => i.item_id === itemId);
            const label = (item ? item.inspection_item : 'Finding') + (results[itemId].severity === 3 ? ' (Critical)' : '');
            syncPartsRequestFromSource({
              sourceType: 'inspection',
              sourceId: 'ins_' + ((currentInspection && currentInspection.id) || 'draft') + '_' + itemId,
              jobId: currentInspection.jobId || '',
              description: results[itemId].partNeeded,
              urgent: results[itemId].severity === 3,
              serial: currentInspection.serial || '',
              findingLabel: label
            });
          }
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

      // Bind part needed — same auto-generate-a-parts-line mechanism
      // punchlist items use. Each inspection already has exactly one
      // serial (unlike punchlist's multi-line jobs), so there's no
      // line-to-serial resolution needed here, just the one already on
      // currentInspection. Severity 3 (Critical) carries over as
      // urgent, the same way punchlist's own High priority does.
      container.querySelectorAll('.part-needed-input').forEach(inp => {
        inp.addEventListener('input', () => {
          const itemId = parseInt(inp.dataset.item, 10);
          if (!results[itemId]) results[itemId] = {};
          results[itemId].partNeeded = inp.value;
          saveCurrentDraft();
          if (typeof syncPartsRequestFromSource === 'function' && currentInspection) {
            const item = APP_DATA.items.find(i => i.item_id === itemId);
            const label = (item ? item.inspection_item : 'Finding') + (results[itemId].severity === 3 ? ' (Critical)' : '');
            syncPartsRequestFromSource({
              sourceType: 'inspection',
              sourceId: 'ins_' + ((currentInspection && currentInspection.id) || 'draft') + '_' + itemId,
              jobId: currentInspection.jobId || '',
              description: inp.value,
              urgent: results[itemId].severity === 3,
              serial: currentInspection.serial || '',
              findingLabel: label
            });
          }
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
              await STORE.putPhoto({ id, blob: blob || file, caption: '', createdAt: Date.now() });
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

      // Update next button text
      const lastItem = currentItemIndex >= items.length - 1;
      const lastSection = currentSectionIndex === APP_DATA.sections.length - 1;
      const nextBtn = document.getElementById('btnNextSection');
      if (nextBtn) nextBtn.textContent = (lastItem && lastSection) ? 'Finish inspection' : 'Next →';
      const prevBtn = document.getElementById('btnPrevSection');
      if (prevBtn) prevBtn.style.visibility = (currentSectionIndex === 0 && currentItemIndex === 0) ? 'hidden' : 'visible';
    }

    // v152 (Phase 12A Fix 1): the findings rule now lives in one place,
    // findingsFromResults(), so the editor (updateFindings) and the list
    // counts (countInspectionFindings) can never disagree. The list
    // counts used to read the saved ins.findings array, which is only
    // rebuilt while an inspection is open — so a seeded, restored or
    // older inspection showed "0 findings" until it was opened.
    // templateForModel() uses exactly the same fallback as
    // setActiveMachine(), so a count is always taken against the
    // inspection's own machine checklist, never whichever one is active.
    function templateForModel(model) {
      const key = model || 'LX-8';
      return (window.MACHINE_TEMPLATES && (window.MACHINE_TEMPLATES[key] || window.MACHINE_TEMPLATES['LX-8'])) || window.EMBEDDED_DATA || null;
    }
    function findingsFromResults(resultsObj, pack) {
      const out = [];
      if (!pack || !pack.items || !resultsObj) return out;
      Object.keys(resultsObj).forEach(idStr => {
        const itemId = parseInt(idStr, 10);
        const item = pack.items.find(i => i.item_id === itemId);
        if (!item) return;
        const r = resultsObj[itemId];
        if (!r) return;
        if (showsFindingPanel(item, r.condition)) {
          out.push({
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
      return out;
    }
    function countInspectionFindings(ins) {
      if (!ins) return 0;
      const pack = templateForModel(ins.model);
      if (!pack || !pack.items || !pack.items.length) return (ins.findings || []).length;
      return findingsFromResults(ins.results || {}, pack).length;
    }

    function updateFindings() {
      findings = [];
      if (!APP_DATA || !APP_DATA.items) return;
      findings = findingsFromResults(results, APP_DATA);
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
    function bindInspectHomeTiles() {
      document.querySelectorAll('.inspect-count-tile').forEach(btn => {
        if (btn.dataset.bound === '1') return;
        btn.dataset.bound = '1';
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          window.filterInspectHome(btn.getAttribute('data-filter') || '');
        });
      });
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
          if (sidx >= 0) currentSectionIndex = sidx;
          const secItems = currentSectionItems();
          const iidx = secItems.findIndex(it => it.item_id === id);
          currentItemIndex = iidx >= 0 ? iidx : 0;
          showScreen('screenInspect');
          renderSection(true);
          requestAnimationFrame(() => {
            const target = document.getElementById('item-' + id);
            if (target) {
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
              target.classList.add('item-card-highlight');
              setTimeout(() => target.classList.remove('item-card-highlight'), 1600);
            }
          });
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
      const f = document.getElementById('sumFair');
      const p = document.getElementById('sumPoor');
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

    document.querySelectorAll('.inspect-count-tile').forEach(btn => {
      btn.addEventListener('click', () => {
        const next = btn.getAttribute('data-filter') || '';
        inspectHomeFilter = inspectHomeFilter === next ? '' : next;
        document.querySelectorAll('.inspect-count-tile').forEach(b => b.classList.toggle('on', b.getAttribute('data-filter') === inspectHomeFilter));
        renderInspectHomeFilter();
      });
    });

    const btnInspectExport = document.getElementById('btnInspectExport');
    if (btnInspectExport) btnInspectExport.addEventListener('click', () => {
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
      // Phase 10 Task D: was !document.body.classList.contains('on-notes')
      // — see the matching CSS fix above #notesFormatBar for why.
      if (!bar || !document.body.classList.contains('notes-focus')) return;
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
        if (has('jobPickerModal')) { closeJobPicker(); closed = true; }
        if (has('plExportSheet')) { window.closePlExportSheet(); closed = true; }
        if (has('saveSheet')) { closeSaveSheet(); closed = true; }
        if (has('tcWeekPickSheet')) { window.tcCloseWeekPick(); closed = true; }
        if (has('tcExportSheet')) { window.tcCloseExportSheet(); closed = true; }
        if (has('plLinkJobSheet')) { closePunchlistLinkSheet(); closed = true; }
        if (has('partsLineModal')) { closePartsLineModal(); closed = true; }
        if (has('partsShareSheet')) { closePartsShareSheet(); closed = true; }
        if (has('plStartSheet')) { closePunchlistStartSheet(); closed = true; }
        // In practice this specific check can't fire from a real tap:
        // the photo viewer is a full-screen overlay at z-index 24000,
        // covering the header (and its Back button) entirely by design
        // while open — closing it relies on its own dedicated × button,
        // not this header. Left in as a harmless safety net in case
        // that layering ever changes.
        const photoViewer = document.getElementById('pl-photo-viewer');
        if (photoViewer && !photoViewer.hidden) { closePunchlistPhoto(); closed = true; }
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
        ['edPinSheet','edPreviewSheet','edFormSheet','edBackupAskSheet'].forEach((sid) => {
          const el = document.getElementById(sid);
          if (el && el.classList.contains('show')) {
            try { if (typeof window.editorCloseAllSheets === 'function') window.editorCloseAllSheets(); } catch (e2) {}
            closed = true;
          }
        });
      } catch (e) {}
      return closed;
    }
    // v152 (Phase 12A Fix 4): called by showScreen() whenever the screen
    // actually changes, so a bottom sheet can't be left sitting on top of
    // the next screen when you leave by Home, the bottom nav or a search
    // result instead of the header Back button. Uses the same close
    // functions Back uses; each one is purely visual (no data touched).
    // Each is isolated so one failing can't stop the others.
    function closeBottomSheetsOnScreenChange() {
      const isOpen = (id) => {
        const el = document.getElementById(id);
        return !!(el && el.classList.contains('show'));
      };
      const tryClose = (id, fn) => {
        if (!isOpen(id)) return;
        try { if (typeof fn === 'function') fn(); } catch (e) {}
      };
      tryClose('plExportSheet', window.closePlExportSheet);
      tryClose('saveSheet', typeof closeSaveSheet === 'function' ? closeSaveSheet : null);
      tryClose('tcExportSheet', window.tcCloseExportSheet);
      tryClose('tcWeekPickSheet', window.tcCloseWeekPick);
      tryClose('plLinkJobSheet', typeof closePunchlistLinkSheet === 'function' ? closePunchlistLinkSheet : null);
      tryClose('partsShareSheet', typeof closePartsShareSheet === 'function' ? closePartsShareSheet : null);
      tryClose('plStartSheet', typeof closePunchlistStartSheet === 'function' ? closePunchlistStartSheet : null);
      try { if (typeof window.editorCloseAllSheets === 'function') window.editorCloseAllSheets(); } catch (e) {}
    }

    document.getElementById('btnHeaderBack').addEventListener('click', () => {
      // Back first dismisses any open sheet, dialog, modal, or search UI.
      // A second tap then navigates to the previous page.
      if (document.body.classList.contains('on-editor') && typeof window.editorOnHeaderBack === 'function') {
        window.editorOnHeaderBack();
        return;
      }
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
      } else if (previousId === 'screenPartsList') {
        setHeader('Parts Requests');
        if (typeof refreshPartsList === 'function') refreshPartsList();
      } else if (previousId === 'screenTime') {
        setHeader('Time Cards');
        if (typeof tcRefresh === 'function') tcRefresh();
      } else if (previousId === 'screenTimeWeek') {
        if (typeof tcRenderWeekDetail === 'function') tcRenderWeekDetail();
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
      // A separate "visit letter" record was part of an earlier design
      // (before Jobs existed). It was never finished — the code called an
      // undefined collectVisit() and silently caught the ReferenceError —
      // so this always produced a plain inspection report anyway. Made
      // explicit below rather than throwing on every export.
      const combined = false;

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
      if (typeof refreshDurablePersistNotice === 'function') refreshDurablePersistNotice();
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
      if (!bar) return;
      if (bar.classList.contains('show')) {
        closeSearch();
        return;
      }
      document.body.classList.add('search-open');
      // Double-rAF so closed styles commit before open transition
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          bar.classList.add('show');
          const inp = document.getElementById('inpSearch');
          if (inp) {
            window.setTimeout(() => {
              try { inp.focus({ preventScroll: true }); } catch (e) { try { inp.focus(); } catch (_) {} }
            }, 120);
          }
          if (typeof renderSearchResults === 'function') renderSearchResults();
        });
      });
    });

    function syncSearchClear() {
      const bar = document.getElementById('searchBar');
      const inp = document.getElementById('inpSearch');
      bar.classList.toggle('has-query', !!(inp.value || '').trim());
    }

    function hideSearchResults() {
      const panel = document.getElementById('searchResults');
      const scrim = document.getElementById('searchScrim');
      if (panel) {
        panel.classList.remove('show');
        // Clear content after fade so dismiss can animate
        window.setTimeout(() => {
          if (!panel.classList.contains('show')) {
            panel.innerHTML = '';
            panel.hidden = true;
          }
        }, 240);
      }
      if (scrim) {
        scrim.classList.remove('show');
        scrim.hidden = false; // visibility handled by CSS
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
      loadPartsRequests().forEach(req => {
        const partBits = [];
        (req.parts || []).forEach(p => {
          partBits.push(p.description, p.notes, p.partNumber);
        });
        const hay = searchHay([
          req.customer, req.site, req.machine, req.serial, req.salesOrder, req.technician, req.status,
          req.seq ? ('#' + req.seq) : '',
          searchDateHay(req.createdAt), searchDateHay(req.updatedAt)
        ].concat(partBits));
        const sum = partsRequestSummary(req);
        if (hay.includes(q)) {
          rows.push({
            kind: 'parts-request',
            id: req.id,
            kicker: 'Parts Request',
            title: 'Parts Request' + (req.seq ? ' #' + req.seq : ''),
            sub: [sum.sub, sum.partsCount + ' part' + (sum.partsCount !== 1 ? 's' : ''), partsRequestStatusLabel(req.status)].filter(Boolean).join(' · ')
          });
        }
        (req.parts || []).forEach(p => {
          const ph = searchHay([p.description, p.notes, p.partNumber]);
          if (ph.includes(q)) {
            rows.push({
              kind: 'parts-request',
              id: req.id,
              kicker: 'Part',
              title: p.description || 'Unnamed part',
              sub: [req.customer, 'Qty ' + (p.qty || 1), p.partNumber].filter(Boolean).join(' · ')
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
      // Punchlist results are appended asynchronously below via
      // getPunchlistSummaries()/searchPunchlistItems(), since that data
      // isn't available synchronously the way Jobs/Inspections/Parts are.

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
              } else if (kind === 'parts-request') {
                if (typeof openPartsForm === 'function') openPartsForm(id);
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
        const h = header.offsetHeight || 81;
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
    // v170 (Phase 16A): the first screen waits for storage to be ready (the
    // in-memory copy is read from the database first), so nothing is ever
    // drawn from — or saved against — an empty copy.
    lxsReady.then(() => {
    initApp();
    bootStorage().then(async () => {
      // Phase 15A: one-time equipment backfill, guarded so it only ever
      // actually runs once per device (see runEquipmentBackfillIfNeeded).
      try { await runEquipmentBackfillIfNeeded(); } catch (e) { console.warn('equipment backfill', e); }
      try { refreshHome(); } catch (e) {}
      const later = window.requestIdleCallback || function(fn){ setTimeout(fn, 1800); };
      later(() => { warmExcelLibs(); });
    }).catch(() => {});
    });

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
    // v169: all online/offline warnings removed (bottom bar, pop-ups,
    // Punchlist OFFLINE pill). The app is offline-first and nothing syncs
    // yet, so there is nothing to act on. A sync-status indicator is
    // planned for Phase 16.
    window.addEventListener('pagehide', () => { persistAllStores().catch(() => {}); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') persistAllStores().catch(() => {});
    });

  
    // ========== PUNCHLIST ==========
    /* Excel/PDF library loader — moved here from inside
       punchlistModule's closure below, where it was defined but
       never actually reachable from outside that IIFE. That silently
       broke every OTHER feature's Excel export (confirmed: Inspection
       Excel export threw "ensureExcelLibs is not defined"), even
       though Punchlist's own export worked fine since it's called
       from inside the same closure. Now genuinely global so Time
       Cards, Punchlist, and Inspections can all reach it. */
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

    // ===== IndexedDB consolidation =====
    // FieldPunchlistDB used to be Punchlist's own, separate IndexedDB
    // database — completely independent of the main app's `lematic-lx8`
    // database that Jobs/Inspections/Parts Requests all share. That's real
    // architectural fragmentation a future sync layer would have to know
    // about twice. This moves the single "main" blob into the existing
    // shared `kv` store (via the same idbGetKv/idbSetKv every other module
    // already uses) under its own key, leaving the blob's internal shape
    // (including its embedded-base64 photos) completely untouched — only
    // *where* it lives changes. FieldPunchlistDB itself is never deleted
    // here, only stopped-from-being-written-to once migrated, exactly per
    // the "don't remove until migration is proven safe" requirement.
    const PL_CONSOLIDATED_KEY = 'punchlist_main';
    async function plMigrateFromOldDatabase() {
      // Already-migrated devices short-circuit here on every future load —
      // this is what makes running the migration repeatedly a no-op.
      // { skipLegacyFallback: true } keeps this a pure kv-only check (same
      // as the old direct idbGetKv(PL_CONSOLIDATED_KEY) call) so it never
      // triggers STORE's own field_punchlist_v3 fallback ahead of the
      // FieldPunchlistDB migration below — that fallback only belongs to
      // plLoadData(), once this migration has already been tried.
      const already = await STORE.load('punchlist', { skipLegacyFallback: true });
      if (already && already.jobs && already.currentJob) return already;
      // Nothing in the new location yet — check the old, separate database.
      try {
        await openDB();
        const old = await idbGet('main');
        if (old && old.jobs && old.currentJob) {
          // { rawKvOnly: true }: must throw on failure exactly like the raw
          // idbSetKv() call it replaces, so the catch below (not STORE's own
          // localStorage fallback) decides whether this migration succeeded.
          await STORE.save('punchlist', old, { rawKvOnly: true });
          return old;
        }
      } catch (e) {
        // No old database either (a fresh install), or the kv write above
        // failed — either way, nothing to report as migrated.
      }
      return null;
    }

    // v153: the built-in example punchlists (Aryzta Australia, Epi) follow
    // the same rule as the sample job/inspection/time week — test
    // locations only, never the live site. See isSampleDataLocation().
    function plUseSamplePunchlists() {
      return (typeof isSampleDataLocation === 'function') ? isSampleDataLocation() : true;
    }
    async function plLoadData() {
      if (lxsIsV2Safe()) return plLoadDataV2();
      try {
        let saved = await plMigrateFromOldDatabase();
        if (!saved) {
          // Falls through to STORE's own kv-read + field_punchlist_v3
          // fallback (upgrade-write + "Data upgraded to larger storage"
          // toast) — identical to the direct lsRead(LEGACY_KEY)/idbSetKv/
          // toast sequence this used to run inline. The kv read inside
          // STORE.load('punchlist') is redundant here (plMigrateFromOldDatabase
          // just established kv is empty) but harmless.
          try {
            saved = await STORE.load('punchlist');
          } catch (e) {}
        }
        if (saved && saved.jobs && saved.currentJob) data = saved;
        else if (!plUseSamplePunchlists()) {
          // v153: live site. Never create the example punchlists, and never
          // swap saved punchlists for them. Keeps whatever was saved (even
          // with no current list picked, e.g. after deleting every list —
          // which used to bring Aryzta/Epi back); otherwise starts empty,
          // the same empty state the app already uses once every list is
          // deleted.
          // plMigrateFromOldDatabase() also reports "nothing saved" when no
          // current list is picked, so re-read the stored copy directly and
          // only write an empty start when nothing is stored at all.
          let stored = saved;
          if (!stored) stored = await STORE.load('punchlist', { skipLegacyFallback: true });
          if (stored && stored.jobs && typeof stored.jobs === 'object') data = stored;
          else { data = { jobs: {}, currentJob: '' }; await plSaveData(); }
        }
        else { data = JSON.parse(JSON.stringify(defaultData)); await plSaveData(); }
        try { migratePunchlistJobKeys(); } catch (e) {}
        plLoaded = true;
      } catch (e) {
        data = plUseSamplePunchlists() ? JSON.parse(JSON.stringify(defaultData)) : { jobs: {}, currentJob: '' };
        plLoaded = false;
      }
    }

    // v170 (Phase 16A): punchlists live as one record per list and per item
    // in the new storage; this rebuilds the same in-memory bundle shape the
    // rest of this module has always used. Same seeding rules as above.
    let plV2Loading = null;
    function plLoadDataV2() {
      // One load at a time: everything that asks for the punchlists while a
      // load is running waits for that same load.
      if (plLoaded && data && data.jobs) return Promise.resolve();
      if (!plV2Loading) plV2Loading = plLoadDataV2Run().finally(() => { plV2Loading = null; });
      return plV2Loading;
    }
    async function plLoadDataV2Run() {
      try {
        const saved = await LXS.loadPunchlistBundle();
        if (saved && saved.jobs && saved.currentJob) data = saved;
        else if (!plUseSamplePunchlists()) {
          data = (saved && saved.jobs && typeof saved.jobs === 'object') ? saved : { jobs: {}, currentJob: '' };
          if (!LXS.st.meta['pl:initialized']) await plSaveData();
        }
        else {
          data = LXS.rekeyBundle(JSON.parse(JSON.stringify(defaultData))).bundle;
          LXS.stageMeta('idMap', LXS.idMap());
          await plSaveData();
        }
        try { migratePunchlistJobKeys(); } catch (e) {}
        plLoaded = true;
      } catch (e) {
        console.warn('punchlist load', e);
        data = plUseSamplePunchlists() ? LXS.rekeyBundle(JSON.parse(JSON.stringify(defaultData))).bundle : { jobs: {}, currentJob: '' };
        plLoaded = false;
      }
    }
    window.plReloadFromStorage = async function () {
      plLoaded = false;
      data = null;
      await plLoadData();
      try { populateJobSelect(); renderList(); } catch (e) {}
    };

    // v156 (punchlist speed): every punchlist change in this page already
    // goes through the in-memory `data` object and is saved from it, so
    // once the bundle has been read from storage the in-memory copy is
    // always the current one. Read-only helpers (opening a list, list
    // summaries, counts, search) use this instead of plLoadData(), so a
    // tap on Punchlist no longer re-reads the whole bundle — every photo
    // in every list — from IndexedDB. A load already in progress (e.g.
    // initPunchlist at startup) is shared rather than started twice.
    let plLoaded = false;
    let plLoadingPromise = null;
    function plEnsureLoaded() {
      if (plLoaded && data && data.jobs) return Promise.resolve();
      if (!plLoadingPromise) {
        plLoadingPromise = plLoadData().finally(() => { plLoadingPromise = null; });
      }
      return plLoadingPromise;
    }
    window.plEnsureLoaded = plEnsureLoaded;

    async function plSaveData() {
      // The kv 'punchlist_main' write + field_punchlist_v3 fallback-with-
      // toasts now lives in STORE.save('punchlist', value) — see the STORE
      // section. This is an exact behavioral delegate: same write, same
      // fallback, same two toasts.
      return STORE.save('punchlist', data);
    }

    function getItems() { return data.jobs[data.currentJob] || []; }
    // Phase 7B: now async and returns the real outcome of the persist
    // instead of firing plSaveData() and forgetting about it. Callers
    // that don't care about the result (removePhoto, delete) can still
    // call this without awaiting — that's unchanged, still fire-and-
    // forget for them, same as before. saveItem is the one caller that
    // now awaits this and acts on the result.
    async function setItems(items) { data.jobs[data.currentJob] = items; return await plSaveData(); }

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
        if (lxsIsV2Safe()) {
          // v170: same "Default" list, with a unique id
          const nk = newEntityId('pl');
          if (!data.listNames) data.listNames = {};
          data.listNames[nk] = "Default";
          data.jobs[nk] = [];
          data.currentJob = nk;
          jobs.push(nk);
          // not stored until it gets an item or a new name (as in v169)
          LXS.markPunchlistPlaceholder(nk);
        } else {
        data.jobs["Default"] = [];
        data.currentJob = "Default";
        jobs.push("Default");
        }
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
      document.getElementById("pl-modal").style.pointerEvents = "";
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

      document.getElementById("stat-open").innerHTML = `<strong>${items.filter(i => i.status === "Not Started").length}</strong> Pending`;
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
        <div class="${classes.join(" ")}" data-id="${item.id}" onclick="toggleItem('${item.id}', event)">
          <span class="pl-created-tag">${escapeHtml((typeof formatAppDate === 'function' ? formatAppDate(item.createdAt) : stampDate(item.createdAt)))}</span>
          <div class="list-item-main">
            <div class="title">${escapeHtml(item.description)}</div>
            <div class="sub">${escapeHtml((typeof equipmentExportLine === 'function' && equipmentExportLine(item)) || item.line || '')} · ${escapeHtml(item.location)}${item.dueDate ? " · " + (typeof formatAppDate === 'function' ? formatAppDate(item.dueDate) : item.dueDate) : ""}${item.responsible ? " · " + escapeHtml(item.responsible) : ""}</div>
            <div class="action-line">→ ${escapeHtml(item.action)}</div>
            <span class="dept ${deptClass(item.department)}">${escapeHtml(item.department)}</span>
          </div>
          <div class="list-item-actions">
            <span class="badge ${statusBadgeClass(item.status)}">${item.status}</span>
            ${item.photo ? `<img class="list-item-photo" data-pl-photo="1" alt="Item photo" loading="lazy" decoding="async" onclick="openPunchlistPhoto(event, this.src)">` : ""}
          </div>
          <div class="list-item-detail">
            ${item.comments ? `<div class="detail-row"><strong>Comments</strong>${escapeHtml(item.comments)}</div>` : ""}
            ${item.responsible ? `<div class="detail-row"><strong>Responsible</strong>${escapeHtml(item.responsible)}</div>` : ""}
            ${item.dueDate ? `<div class="detail-row"><strong>Due</strong>${escapeHtml((typeof formatAppDate === 'function' ? formatAppDate(item.dueDate) : item.dueDate))}</div>` : ""}
            ${/* v156: a second full-size copy of the photo used to be placed here too. This expanded-detail panel is never opened by any code (nothing adds the "expanded" class to punchlist rows), so that copy was pure cost: every photo was loaded twice per render. The thumbnail above is the one people see and tap. */ ""}

          </div>
        </div>
      `}).join("");
      // v156 (punchlist speed): photos used to be pasted into the HTML
      // text above as full data URLs — twice per item — so every render
      // parsed megabytes of text per photo. Now the <img> tags carry no
      // src and each one is pointed at the item's existing photo string
      // here instead (no copying, no HTML parsing). Same picture, same
      // tap-to-open behavior (it reads this.src).
      try {
        const plPhotoById = {};
        filtered.forEach(it => { if (it && it.photo) plPhotoById[String(it.id)] = it.photo; });
        list.querySelectorAll('.pl-item').forEach(row => {
          const ph = plPhotoById[row.getAttribute('data-id')];
          if (!ph) return;
          row.querySelectorAll('img[data-pl-photo]').forEach(img => { img.src = ph; });
        });
      } catch (e) {}
      if (typeof bindSwipeToDelete === 'function') {
        bindSwipeToDelete(list, '.pl-item', (row) => ({
          id: row.getAttribute('data-id'),
          kind: 'punchlist-item',
          title: 'Delete item?',
          label: 'This punchlist item will be permanently deleted.'
        }));
      }
    }

    function toggleItem(id, ev) {
      if (ev && ev.target.closest("button, a, input, select, textarea, img.list-item-photo, .pl-photo-viewer, .swipe-delete-btn")) return;
      if (typeof window.swipeIgnoreClicksUntil === 'number' && Date.now() < window.swipeIgnoreClicksUntil) return;
      if (ev && ev.currentTarget && ev.currentTarget.closest && ev.currentTarget.closest('.swipe-host.swipe-open')) return;
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
      if (photoViewerMode === 'parts') {
        requestDeletePartsPhoto(ev);
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
      let lxsDeletedPhotoId = '';
      if (itemId != null && results) {
        const key = Object.keys(results).find(k => String(k) === String(itemId)) || itemId;
        if (results[key]) {
          lxsDeletedPhotoId = results[key].photoId || '';
          delete results[key].photoDataUrl;
          delete results[key].photoId;
        }
      }
      try { if (typeof saveCurrentDraft === 'function') saveCurrentDraft(); } catch (e) {}
      if (lxsDeletedPhotoId && lxsIsV2Safe()) LXS.deletePhotosExplicit([lxsDeletedPhotoId]);
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
      // String()-coerced comparison: existing items have numeric ids,
      // new items (see newId below) have string ids from newEntityId() —
      // this works correctly against either without needing every id in
      // storage to be rewritten to match.
      const item = getItems().find(i => String(i.id) === String(id));
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
            <label>Machine</label>
            <div class="line-chip-row" id="f-line-chips"></div>
            <!-- v157 fix (Phase 15B review, item 1): f-line is kept ONLY so
                 an old item's stored slot digit round-trips untouched when
                 the item is edited for something unrelated (never read to
                 identify a machine anywhere, form or export). Which chip is
                 selected, and what actually gets saved, is driven entirely
                 by f-serial / f-equipment-id below, set from the item's own
                 saved serial/equipmentId — never from this digit. -->
            <input type="hidden" id="f-line" value="${escapeHtml(item.line || '')}">
            <input type="hidden" id="f-serial" value="${escapeHtml(item.serial || '')}">
            <input type="hidden" id="f-equipment-id" value="${escapeHtml(item.equipmentId || '')}">
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
          <label>Description *</label>
          <textarea id="f-description" placeholder="What is the problem?">${escapeHtml(item.description || '')}</textarea>
        </div>
        <div class="form-group">
          <label>Part needed <span class="pline-optional-hint">(optional)</span></label>
          <input type="text" id="f-part-needed" value="${escapeHtml(item.partNeeded || '')}" placeholder="e.g. Seal bar heater">
        </div>
        <div class="form-group">
          <label>Action</label>
          <textarea id="f-action" placeholder="What needs to be done?">${escapeHtml(item.action || '')}</textarea>
        </div>
        <div class="form-row">
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
          <div class="form-group">
            <label>Responsible</label>
            <input type="text" id="f-responsible" value="${escapeHtml(item.responsible || '')}" placeholder="Name">
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
          <label>Location</label>
          <input type="text" id="f-location" value="${escapeHtml(item.location || '')}" placeholder="e.g. Seal Unit">
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
      document.getElementById("pl-modal").style.pointerEvents = "";
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
      const input = e.target;
      const file = input.files[0];
      if (!file) return;
      const onRead = (ev) => {
        tempPhoto = ev.target.result;
        const preview = document.getElementById("photo-preview");
        const wrap = document.getElementById("photo-preview-wrap");
        if (preview) {
          preview.src = tempPhoto;
          preview.classList.remove("hidden");
        }
        if (wrap) wrap.classList.remove("hidden");
        try { input.value = ''; } catch (err) {}
        try { input.blur(); } catch (err) {}
        if (typeof showPlActionBars === 'function') showPlActionBars();
      };
      // Phase 7C (C3): this had no failure path at all — a bad read
      // left the technician with no preview and no error, previously
      // indistinguishable from success. Same failure copy already used
      // elsewhere in the app for this exact situation.
      const onFail = () => { toast('Could not attach photo'); try { input.value = ''; } catch (err) {} };
      const readAsDataUrl = (blob) => {
        const reader = new FileReader();
        reader.onload = onRead;
        reader.onerror = onFail;
        reader.onabort = onFail;
        reader.readAsDataURL(blob);
      };
      // v156 (punchlist speed): shrink the photo the same way inspection
      // and parts photos already are (longest side 1600 px, JPEG 72%)
      // before storing it. A full camera photo is 3–6 MB; this is
      // typically 200–400 KB. Stored exactly as before (a data URL in
      // item.photo). If shrinking fails, or would make it bigger, the
      // original file is used, as before.
      const shrink = (typeof compressImageFile === 'function')
        ? compressImageFile(file, 1600, 0.72).catch(() => file)
        : Promise.resolve(file);
      shrink.then((blob) => {
        const use = (blob && blob.size && blob.size < file.size) ? blob : file;
        readAsDataUrl(use);
      }, () => readAsDataUrl(file));
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
          const lxsPhoto = lxsIsV2Safe() ? LXS.itemPhotoId(editingId) : '';
          items[idx] = { ...items[idx], photo: null };
          setItems(items);
          if (lxsPhoto) LXS.deletePhotosExplicit([lxsPhoto]);
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
    // v157 fix (Phase 15B review, item 1): builds the item form's machine
    // options — exactly one per machine on the linked job (its real
    // serials, plus any placeholders), a trailing "off list" entry for an
    // existing item whose own serial isn't (or is no longer) among the
    // job's current serials, and a "No machine" option. Never a fixed
    // Line 1/2/3/4 set, so a job with any number of machines shows all of
    // them and one with fewer never pads out fake slots.
    function punchlistMachineOptions(job, currentSerial) {
      const out = [];
      const serials = (typeof taggedJobSerials === 'function') ? taggedJobSerials(job && job.serials) : [];
      serials.forEach(t => {
        const machine = findMachineBySerial(t.serial);
        out.push({ kind: 'machine', serial: t.serial, machine, label: jobSerialChipSegments(t.serial, machine).join(' · ') });
      });
      (Array.isArray(job && job.placeholderMachines) ? job.placeholderMachines : []).forEach(ph => {
        const label = [ph.lineLabel || '', 'Placeholder', ph.type || ''].filter(Boolean).join(' · ');
        out.push({ kind: 'placeholder', id: ph.id, label });
      });
      const cur = String(currentSerial || '').trim();
      if (cur && !out.some(o => o.kind === 'machine' && o.serial.toLowerCase() === cur.toLowerCase())) {
        const machine = findMachineBySerial(cur);
        out.push({ kind: 'machine', serial: cur, machine, label: jobSerialChipSegments(cur, machine).join(' · ') });
      }
      out.push({ kind: 'none', label: 'No machine' });
      return out;
    }
    function bindPunchlistLineChips() {
      const row = document.getElementById('f-line-chips');
      const hiddenSerial = document.getElementById('f-serial');
      const hiddenEquip = document.getElementById('f-equipment-id');
      if (!row || !hiddenSerial) return;
      const job = punchlistLinkedJob();
      const options = punchlistMachineOptions(job, hiddenSerial.value);
      // Which option is selected comes ONLY from the item's own saved
      // serial/equipmentId — never from item.line or sort position. A
      // placeholder is matched by its id (its serials array is always
      // empty, so it can only ever match this way); a real machine is
      // matched by its serial text. No serial and no placeholder id means
      // "No machine" — old items with a bare slot digit and no serial land
      // here too, rather than guessing which machine they meant.
      const equipVal = String(hiddenEquip.value || '').trim();
      const serialVal = String(hiddenSerial.value || '').trim();
      let selectedIdx = options.findIndex(o => o.kind === 'placeholder' && equipVal && o.id === equipVal);
      if (selectedIdx < 0 && serialVal) {
        selectedIdx = options.findIndex(o => o.kind === 'machine' && o.serial.toLowerCase() === serialVal.toLowerCase());
      }
      // v157 fix (Phase 15B review round 2, item D): fall back to matching
      // a real-machine chip by equipmentId — a converted-placeholder item
      // is repointed at the real machine's id and (going forward) also
      // gets its serial filled in, but this covers an item whose serial
      // text is still empty for any other reason, so it isn't stranded on
      // "No machine" when it actually has a real machine link.
      if (selectedIdx < 0 && equipVal) {
        selectedIdx = options.findIndex(o => o.kind === 'machine' && o.machine && o.machine.id === equipVal);
      }
      if (selectedIdx < 0) selectedIdx = options.findIndex(o => o.kind === 'none');
      function selectOption(idx) {
        selectedIdx = idx;
        const opt = options[idx];
        if (opt && opt.kind === 'machine') {
          hiddenSerial.value = opt.serial;
          hiddenEquip.value = '';
        } else if (opt && opt.kind === 'placeholder') {
          hiddenSerial.value = '';
          hiddenEquip.value = opt.id;
        } else {
          hiddenSerial.value = '';
          hiddenEquip.value = '';
        }
        paint();
      }
      function paint() {
        row.innerHTML = options.map((opt, idx) => {
          return '<button type="button" class="chip line-chip' + (idx === selectedIdx ? ' on' : '') + '" data-idx="' + idx + '">' + jobEsc(opt.label) + '</button>';
        }).join('');
        row.querySelectorAll('.line-chip').forEach(btn => {
          btn.addEventListener('click', () => {
            const idx = Number(btn.getAttribute('data-idx'));
            selectOption(idx === selectedIdx ? options.findIndex(o => o.kind === 'none') : idx);
          });
        });
        // v158 simplification: the punchlist item form's one-tap "Set line
        // for <serial>" link (#f-line-setlabel) was removed per the user's
        // request — line labels are rare and technicians shouldn't see
        // this in the everyday item-entry flow. Setting a line label is
        // still available from the job form (next to the serial/placeholder
        // chip). Chips here still display a machine's line label when one
        // is already set (see the label-building code above).
      }
      paint();
    }

    async function saveItem() {
      // v157 fix (Phase 15B review, item 1): serial/equipmentId now come
      // straight from the machine chip the technician actually tapped
      // (bindPunchlistLineChips) — never re-derived from a slot number, so
      // saving an item with no chip change can never move it onto a
      // different machine just because the job's serial list changed.
      // "line" itself is intentionally left OUT of formData: an existing
      // item's stored slot digit is never touched by a save (the spread
      // below keeps it exactly as it was); a new item simply has none.
      const chipSerial = (document.getElementById("f-serial") && document.getElementById("f-serial").value.trim()) || "";
      const chipEquipmentId = (document.getElementById("f-equipment-id") && document.getElementById("f-equipment-id").value.trim()) || "";
      const formData = {
        serial: chipSerial,
        location: document.getElementById("f-location").value.trim(),
        description: document.getElementById("f-description").value.trim(),
        action: document.getElementById("f-action").value.trim(),
        partNeeded: (document.getElementById("f-part-needed") && document.getElementById("f-part-needed").value.trim()) || '',
        department: document.getElementById("f-department").value,
        responsible: document.getElementById("f-responsible").value.trim(),
        dueDate: editingId ? ((getItems().find(i => String(i.id) === String(editingId)) || {}).dueDate || "") : "",
        priority: document.getElementById("f-priority").value,
        comments: document.getElementById("f-comments").value.trim(),
        // No longer an editable field on the sheet — preserved as-is
        // from the existing item when editing (never overwritten by a
        // form value that doesn't exist anymore), and set once at
        // creation for a new item. Still shown quietly on the list
        // card itself for reference.
        createdAt: editingId ? ((getItems().find(i => String(i.id) === String(editingId)) || {}).createdAt || nowStamp()) : nowStamp(),
        status: document.getElementById("f-status").value,
        photo: tempPhoto !== null ? tempPhoto : (editingId ? (getItems().find(i => String(i.id) === String(editingId))?.photo || null) : null)
      };
      if (!formData.description) { alert("Description is required"); return; }

      // Phase 15A: stamp customerId/siteId (from the linked job, if any)
      // and equipmentId (from this item's own serial) at the real save
      // point — never merely while the sheet is open.
      (function stampPunchlistItemEquipment() {
        const job = (typeof punchlistLinkedJob === 'function') ? punchlistLinkedJob() : null;
        formData.customerId = job ? (job.customerId || '') : '';
        formData.siteId = job ? (job.siteId || '') : '';
        formData.equipmentId = '';
        if (formData.serial && typeof findOrCreateMachine === 'function') {
          const machine = findOrCreateMachine(formData.serial);
          if (machine) {
            formData.equipmentId = machine.id;
            // v157 (Phase 15B, approved amendment A): snapshot the
            // machine's line/production line/type/SO as of RIGHT NOW, so a
            // later re-label or move never rewrites what this item's
            // export already showed. Display/export code prefers this
            // snapshot and only falls back to the live machine record for
            // an item saved before this existed.
            formData.lineLabelAtSave = machine.lineLabel || '';
            formData.productionLineAtSave = machine.productionLine || '';
            formData.machineTypeAtSave = machine.machineType || '';
            formData.salesOrderAtSave = machine.salesOrder || '';
          }
        } else if (chipEquipmentId) {
          // v157 fix (Phase 15B review, item 1): the technician picked a
          // placeholder machine chip — it has no serial, so equipmentId is
          // set directly from the chip rather than through findOrCreateMachine.
          formData.equipmentId = chipEquipmentId;
          const job2 = job;
          const ph = (job2 && Array.isArray(job2.placeholderMachines)) ? job2.placeholderMachines.find(p => p && p.id === chipEquipmentId) : null;
          if (ph) {
            formData.lineLabelAtSave = ph.lineLabel || '';
            formData.productionLineAtSave = ph.productionLine || '';
            formData.machineTypeAtSave = ph.type || '';
            formData.salesOrderAtSave = '';
          }
        } else {
          // v157 fix (Phase 15B review round 2, item C): "No machine" was
          // picked (no serial, no placeholder). Without this, editing an
          // item that used to be on a machine back down to "No machine"
          // left its old snapshot fields in place (the spread below only
          // OVERWRITES keys formData actually has) — so the list/PDF/Excel
          // kept showing the previous machine's line forever. Clearing
          // them here means equipmentId, being '', has nothing to fall
          // back to either.
          formData.lineLabelAtSave = '';
          formData.productionLineAtSave = '';
          formData.machineTypeAtSave = '';
          formData.salesOrderAtSave = '';
        }
      })();

      let items = getItems();
      let savedId;
      let successCopy;
      if (editingId) {
        const idx = items.findIndex(i => String(i.id) === String(editingId));
        items[idx] = { ...items[idx], ...formData };
        savedId = editingId;
        successCopy = "Item updated";
      } else {
        // Standardized on newEntityId() (same generator Jobs/Parts
        // Requests/Time Cards use) instead of Math.max(existing ids)+1 —
        // a client-computed sequential id collides the moment two
        // devices add an item offline from the same starting list.
        // Existing numeric ids are left exactly as they are; every
        // comparison against item.id elsewhere in this module was
        // updated to String()-coerce so old (numeric) and new (string)
        // ids compare correctly against each other.
        const newId = newEntityId('pli');
        items.push({ id: newId, ...formData });
        savedId = newId;
        successCopy = "Item added";
      }
      // Phase 7B: the success toast used to fire unconditionally right
      // here, before the persist was even attempted. Now it only fires
      // once setItems (which now awaits plSaveData and returns its real
      // result) confirms the write actually happened — on failure the
      // technician sees a failure toast instead, not "Item added" for
      // something that didn't save. The in-memory items array above is
      // still updated either way (unchanged from before this phase) —
      // a reload before a later successful save would still lose an
      // item that failed to persist here, same as it always would have.
      const ok = await setItems(items);
      if (!ok) {
        toast('Could not save item — storage full or unavailable');
        closeModal();
        renderList();
        return;
      }
      toast(successCopy);
      // Auto-generates/updates a parts-request line when this item
      // names a part needed — one line per item, in whichever unsent
      // draft already exists for this job (or a new one). Clearing the
      // field removes the line again; typing something back in re-adds
      // it. Priority High on the item carries straight over as urgent
      // on the generated line, not something re-flagged separately.
      // Phase 7B: only runs now when the item itself actually
      // persisted — no parts line should get created or updated from
      // an item edit that didn't save.
      if (typeof syncPartsRequestFromSource === 'function' && formData.partNeeded) {
        let job = punchlistLinkedJob();
        // punchlistLinkedJob() can come back empty for a punchlist
        // whose key was never formally linked to a job record (a name
        // typed directly rather than picked from Jobs), or where the
        // key's formatting doesn't exactly match jobDisplayName's own
        // "Customer – Site" join (a plain "Aryzta Australia" key
        // against a job whose display name renders as "Aryzta –
        // Australia"). Try a looser match before giving up: same
        // words, ignoring case, whitespace, and punctuation.
        if (!job) {
          const rawKey = (typeof data !== 'undefined' && data && data.currentJob) ? String(punchlistKeyLabel(data.currentJob)) : '';
          const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          const keyNorm = normalize(rawKey);
          if (keyNorm) {
            const jobs = loadJobs();
            job = jobs.find(j => j && normalize(j.customer) === keyNorm) ||
                  jobs.find(j => j && normalize((j.customer || '') + ' ' + (j.site || '')) === keyNorm) ||
                  null;
          }
        }
        if (job) {
          syncPartsRequestFromSource({
            sourceType: 'punchlist',
            sourceId: savedId,
            jobId: job.id,
            description: formData.partNeeded,
            urgent: formData.priority === 'High',
            serial: formData.serial,
            findingLabel: formData.description + (formData.priority === 'High' ? ' (High)' : '')
          });
        } else {
          // Don't fail silently — a part typed here with nothing
          // showing up in Parts afterward looks like data loss, not a
          // missing job link. Item itself still saves either way.
          toast('Part noted, but this punchlist isn\'t linked to a job yet — link it to auto-add to a parts request');
        }
      }
      closeModal();
      renderList();
    }

    function deleteItem(id) {
      const targetId = (id !== undefined && id !== null && id !== "") ? id : editingId;
      if (targetId === undefined || targetId === null || targetId === "") {
        // Unsaved draft — still confirm before discarding so Delete
        // never silently drops work, same pattern as saved items.
        if (typeof showDeleteConfirm === 'function') {
          showDeleteConfirm('__pl_unsaved__', 'punchlist-item-unsaved', 'Discard item?', 'This item has not been saved and will be discarded.');
        } else {
          closeModal();
          toast("Item discarded");
        }
        return;
      }
      if (typeof showDeleteConfirm === 'function') {
        showDeleteConfirm(targetId, 'punchlist-item', 'Delete item?', 'This punchlist item will be permanently deleted.');
        return;
      }
      pendingDeleteId = targetId;
      pendingDeleteKind = "punchlist-item";
      const titleEl = document.getElementById("deleteModalTitle");
      const labelEl = document.getElementById("deleteModalLabel");
      const modal = document.getElementById("deleteModal");
      if (titleEl) titleEl.textContent = "Delete item?";
      if (labelEl) labelEl.textContent = "This punchlist item will be permanently deleted.";
      if (!modal) { toast('Delete dialog missing'); return; }
      modal.classList.remove("hidden");
      modal.classList.add("show");
      modal.style.display = 'flex';
      modal.style.zIndex = '30000';
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
      const lxsPhoto = lxsIsV2Safe() ? LXS.itemPhotoId(targetId) : '';
      setItems(next);
      if (lxsPhoto) LXS.deletePhotosExplicit([lxsPhoto]);
      // If this item had generated a parts-request line, remove that
      // too — the problem it was for no longer exists.
      if (typeof removePartsRequestSource === 'function') removePartsRequestSource('punchlist', targetId);
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
      overlay.style.pointerEvents = "none";
      // The real bug: showPlActionBars() (keyboard-avoidance — keeps the
      // Save/Cancel bar usable while typing, above the keyboard) sets
      // pointer-events/visibility/opacity/display directly as *inline*
      // !important styles on .pl-item-bar. An inline !important beats
      // any ancestor's CSS, .show included — so once that ran, this bar
      // stayed fully interactive and visible even after the modal
      // "closed", sitting on top of whatever was underneath (e.g. the
      // "+" FAB), silently re-saving the last item on the next tap
      // there instead of opening a blank one. Clearing these specific
      // inline overrides on close removes the stale interactive layer;
      // showPlActionBars() re-applies them correctly next time a form
      // actually opens.
      document.querySelectorAll('#pl-modal .btn-row, #pl-modal .pl-item-bar').forEach((bar) => {
        bar.style.removeProperty('display');
        bar.style.removeProperty('visibility');
        bar.style.removeProperty('opacity');
        bar.style.removeProperty('pointer-events');
      });
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
      document.getElementById("pl-modal").style.pointerEvents = "";
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
      if (lxsIsV2Safe()) {
        // v170: a new list always gets a unique id; its name is its display name.
        const nk = newEntityId('pl');
        if (!data.listNames) data.listNames = {};
        data.listNames[nk] = name;
        data.jobs[nk] = [];
        data.currentJob = nk;
        plSaveData();
        populateJobSelect();
        closeModal();
        renderList();
        toast("Punchlist created: " + name);
        return;
      }
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
      // Phase 5 fix: this deleted the bucket itself but never checked
      // whether the job's reverse pointer (keyByJobId) pointed at it,
      // leaving keyByJobId[jobId] = <this now-deleted key> behind —
      // a stale mapping claiming a deleted bucket is still that job's
      // active punchlist. A job can legitimately have more than one
      // punchlist (e.g. "Electrical Punchlist" and "Mechanical
      // Punchlist" both on the same job), so this only clears the
      // reverse pointer when it actually points at the bucket being
      // deleted — if it points at a different, still-existing bucket
      // for the same job, that mapping is left completely alone.
      const jobId = data.jobIdByKey && data.jobIdByKey[key];
      if (jobId && data.keyByJobId && data.keyByJobId[jobId] === key) {
        delete data.keyByJobId[jobId];
      }
      const lxsListPhotos = lxsIsV2Safe() ? (data.jobs[key] || []).map(it => it && LXS.itemPhotoId(it.id)).filter(Boolean) : [];
      delete data.jobs[key];
      if (data.listNames) delete data.listNames[key];
      if (data.jobIdByKey) delete data.jobIdByKey[key];
      if (data.currentJob === key) {
        const left = Object.keys(data.jobs);
        data.currentJob = left[0] || '';
      }
      await plSaveData();
      if (lxsListPhotos.length) LXS.deletePhotosExplicit(lxsListPhotos);
      if (typeof closeDeleteModal === 'function') closeDeleteModal();
      if (typeof closePunchlistStartSheet === 'function') closePunchlistStartSheet();
      document.body.classList.remove('on-pl-edit');
      editingPunchlistKey = '';
      punchlistEditIsNew = false;
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
    // Phase 3 fix: this used to unconditionally delegate straight to
    // createPunchlistForJob(), which always mints a brand-new random
    // bucket key with an empty item list — so opening the same job's
    // punchlist a second time (completely normal navigation: leave the
    // screen, come back) silently created a second, empty, orphaned
    // bucket and reassigned that job's keyByJobId to it, making the
    // first bucket's real items disappear from view even though they
    // were still safely stored.
    //
    // The existing ensurePunchlistBucketForJob() nearby does check for
    // a bucket before creating one, but it keys buckets by job.id
    // directly — a different, incompatible scheme from the pl_<random>
    // keys (mapped through jobIdByKey/keyByJobId) that
    // createPunchlistForJob() has always actually used in every real
    // bucket created through this path. Using that function here
    // wouldn't find any of those existing buckets — it would just
    // create a third, differently-keyed orphan. So this checks
    // keyByJobId directly instead — the same map createPunchlistForJob
    // itself already populates — and only creates a new bucket when
    // that job genuinely doesn't have one yet.
    window.openPunchlistForJob = async function(job) {
      if (job && job.id) {
        try { if (typeof ensureJobIdentity === 'function') ensureJobIdentity(job); } catch (e) {}
        await plLoadData();
        const existingKey = data && data.keyByJobId && data.keyByJobId[job.id];
        if (existingKey && data.jobs && Object.prototype.hasOwnProperty.call(data.jobs, existingKey)) {
          data.currentJob = existingKey;
          await plSaveData();
          populateJobSelect();
          renderList();
          try {
            if (typeof window.setLastPunchlistName === 'function') window.setLastPunchlistName(existingKey);
          } catch (e) {}
          return existingKey;
        }
      }
      return window.createPunchlistForJob(job);
    };
    window.getPunchlistStatsForJob = async function(jobOrName) {
      await plEnsureLoaded(); // v156: in-memory copy, no re-read
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
    // v152 (Phase 12A Fix 2): read-only count of punchlist item photos
    // (item.photo), for the Settings "On this device" line. Never writes.
    window.getPunchlistPhotoCount = async function() {
      await plEnsureLoaded(); // v156: in-memory copy, no re-read
      if (!data || !data.jobs) return 0;
      let n = 0;
      Object.keys(data.jobs).forEach(k => {
        (data.jobs[k] || []).forEach(item => { if (item && item.photo) n += 1; });
      });
      return n;
    };
    // v156 (punchlist speed): punchlist photos taken before v156 were
    // stored at full camera size. These two helpers find them and, only
    // when the user asks (Settings, after a confirm), re-save them at the
    // same size inspection photos use. Nothing else is touched: same
    // items, same field, same data-URL format — only smaller pictures.
    const PL_LARGE_PHOTO_CHARS = 700000; // ~0.5 MB
    window.getPunchlistLargePhotoInfo = async function() {
      await plEnsureLoaded();
      let count = 0, chars = 0;
      Object.keys((data && data.jobs) || {}).forEach(k => {
        (data.jobs[k] || []).forEach(item => {
          if (item && typeof item.photo === 'string' && item.photo.indexOf('data:image') === 0 && item.photo.length > PL_LARGE_PHOTO_CHARS) {
            count += 1; chars += item.photo.length;
          }
        });
      });
      return { count, mb: Math.round(chars * 0.75 / 1048576) };
    };
    window.shrinkPunchlistPhotos = async function() {
      await plEnsureLoaded();
      const toDataUrl = (blob) => new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => resolve(null);
        fr.readAsDataURL(blob);
      });
      let count = 0, before = 0, after = 0, failed = 0;
      for (const k of Object.keys((data && data.jobs) || {})) {
        for (const item of (data.jobs[k] || [])) {
          if (!item || typeof item.photo !== 'string' || item.photo.indexOf('data:image') !== 0) continue;
          if (item.photo.length <= PL_LARGE_PHOTO_CHARS) continue;
          try {
            const blob = (typeof dataUrlToBlob === 'function') ? dataUrlToBlob(item.photo) : null;
            if (!blob) { failed += 1; continue; }
            const small = await compressImageFile(blob, 1600, 0.72);
            if (!small || small === blob || !small.size || small.size >= blob.size) { failed += 1; continue; }
            const url = await toDataUrl(small);
            if (!url || url.indexOf('data:image') !== 0 || url.length >= item.photo.length) { failed += 1; continue; }
            before += item.photo.length; after += url.length;
            item.photo = url;
            count += 1;
          } catch (e) { failed += 1; }
        }
      }
      let saved = true;
      if (count) saved = await plSaveData();
      try { if (typeof renderList === 'function') renderList(); } catch (e) {}
      return { count, failed, saved, savedMb: Math.round((before - after) * 0.75 / 1048576) };
    };
    window.searchPunchlistItems = async function(q) {
      await plEnsureLoaded(); // v156: in-memory copy, no re-read
      const needle = String(q || "").trim().toLowerCase();
      if (!needle || !data || !data.jobs) return [];
      const out = [];
      Object.keys(data.jobs).forEach(name => {
        (data.jobs[name] || []).forEach(item => {
          if (!item) return;
          const hay = [item.description, item.action, item.location, item.line, item.comments, item.department, item.status, punchlistKeyLabel(name),
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
      await plEnsureLoaded(); // v156: in-memory copy, no re-read
      if (!data || !data.jobs) return [];
      const links = data.jobIdByKey || {};
      const fieldJobs = (typeof loadJobs === 'function' ? loadJobs() : []) || [];
      return Object.keys(data.jobs).filter(name => !(lxsIsV2Safe() && LXS.isPunchlistPlaceholder(data, name))).map(name => {
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
      if (lxsIsV2Safe() && !data.jobs[name]) {
        // v170: an old list name resolves to its new id; an unknown name
        // becomes a new list with a unique id (the name is its display name).
        const mapped = LXS.resolveLegacyListKey(name);
        if (data.jobs[mapped]) name = mapped;
        else if (!LXS.isUniqueListKey(name)) {
          const nk = newEntityId('pl');
          if (!data.listNames) data.listNames = {};
          data.listNames[nk] = name;
          name = nk;
        }
      }
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
      await plEnsureLoaded(); // v156: in-memory copy, no re-read
      if (!data) data = { jobs: {}, currentJob: '' };
      if (!data.jobs) data.jobs = {};
      let key = name;
      if (lxsIsV2Safe() && !data.jobs[key]) {
        const mapped = LXS.resolveLegacyListKey(name);
        if (data.jobs[mapped]) key = mapped;
      }
      if (!data.jobs[key]) {
        if (data.keyByJobId && data.keyByJobId[name]) key = data.keyByJobId[name];
        else if (data.jobIdByKey && data.jobIdByKey[name] && data.jobs[data.jobIdByKey[name]]) key = data.jobIdByKey[name];
        else if (data.listNames) {
          const found = Object.keys(data.listNames).find(k => data.listNames[k] === name && data.jobs[k]);
          if (found) key = found;
        }
      }
      // v156: only write the bundle if opening this list actually changed
      // something (a new empty list, or a different current list). It used
      // to rewrite the whole bundle — every photo — on every open.
      let plOpenChanged = false;
      if (!data.jobs[key] && lxsIsV2Safe() && !LXS.isUniqueListKey(key)) {
        const nk = newEntityId('pl');
        if (!data.listNames) data.listNames = {};
        data.listNames[nk] = key;
        key = nk;
      }
      if (!data.jobs[key]) { data.jobs[key] = []; plOpenChanged = true; }
      if (data.currentJob !== key) plOpenChanged = true;
      data.currentJob = key;
      name = key;
      if (plOpenChanged) {
        if (lxsIsV2Safe()) LXS.savePunchlist(data, { listsOnly: true });
        else await plSaveData();
      }
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
      if (lxsIsV2Safe()) {
        // v170: old list names / item numbers get their unique ids (the
        // same ones the upgrade gave them, via the saved id map).
        saved = LXS.rekeyBundle(saved).bundle;
        LXS.stageMeta('idMap', LXS.idMap());
      }
      data = saved;
      plLoaded = true;
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

    // Phase 6 — read-only diagnostic only. Never writes anything: no
    // plSaveData, no mutation of `data` (it's deep-cloned before being
    // inspected, purely as a defensive extra layer, since none of the
    // logic below assigns into it regardless). Reports on the current
    // state so a technician/admin can see which Punchlist records might
    // deserve a look — it never decides anything on its own, and never
    // claims a record was "definitely" caused by an old bug, since
    // Phase 4 established the data model doesn't carry enough history
    // to prove that either way.
    window.analyzePunchlistIntegrity = async function() {
      await plLoadData();
      const snapshot = JSON.parse(JSON.stringify(data || { jobs: {} }));
      const jobs = snapshot.jobs || {};
      const listNames = snapshot.listNames || {};
      const jobIdByKey = snapshot.jobIdByKey || {};
      const keyByJobId = snapshot.keyByJobId || {};
      const bucketKeys = Object.keys(jobs);

      // Group every bucket that HAS a forward job mapping, by that job,
      // so buckets sharing a job are judged together rather than each
      // being compared to the reverse pointer in isolation — which is
      // what would incorrectly flag one of two *legitimate* Punchlists
      // for the same job as "inconsistent" (only one bucket can ever
      // match keyByJobId at a time, by definition).
      const byJob = {};
      bucketKeys.forEach(key => {
        if (Object.prototype.hasOwnProperty.call(jobIdByKey, key)) {
          const jobId = jobIdByKey[key];
          if (!byJob[jobId]) byJob[jobId] = [];
          byJob[jobId].push(key);
        }
      });

      const findings = [];
      const describe = (key) => ({
        bucketKey: key,
        name: listNames[key] || 'Punchlist',
        itemCount: (jobs[key] || []).length,
        isCurrent: snapshot.currentJob === key
      });

      Object.keys(byJob).forEach(jobId => {
        const keys = byJob[jobId];
        const reverseTarget = keyByJobId[jobId];
        if (keys.length > 1) {
          // Rule E — multiple legitimate buckets for one job. Not a
          // problem by itself; only worth a closer look if every one
          // of them still carries the untouched default name, which is
          // consistent with (but doesn't prove) old duplicate-bucket
          // creation rather than deliberate multi-list use.
          const allDefaultName = keys.every(k => (listNames[k] || 'Punchlist') === 'Punchlist');
          findings.push({
            classification: 'Multiple Punchlists for same job',
            determinism: 'informational',
            jobId,
            buckets: keys.map(describe),
            reason: allDefaultName
              ? keys.length + ' Punchlists share job ' + jobId + ', and all still use the default "Punchlist" name — worth a look, but this alone does not prove they came from the old bug rather than deliberate use.'
              : keys.length + ' Punchlists share job ' + jobId + ' with distinct names — looks like intentional multiple lists, not flagged as a problem.'
          });
        } else {
          const key = keys[0];
          if (reverseTarget === key) {
            // Rule A — nothing to report; structurally valid.
          } else if (reverseTarget && !Object.prototype.hasOwnProperty.call(jobs, reverseTarget)) {
            // Rule C — the job's reverse pointer names a bucket that
            // doesn't exist at all. High-value finding: this is exactly
            // what Phase 5 was built to stop from happening on delete.
            findings.push({
              classification: 'Reverse mapping points to missing bucket',
              determinism: 'definitive',
              jobId,
              buckets: [describe(key)],
              reason: 'keyByJobId["' + jobId + '"] points to bucket "' + reverseTarget + '", which does not exist in jobs. This bucket ("' + key + '") has a valid forward mapping to this job but is not the one currently linked.'
            });
          } else {
            // Rule B — forward mapping exists, reverse points somewhere
            // else that isn't the same job (or is empty for this job).
            findings.push({
              classification: 'Inconsistent forward/reverse mapping',
              determinism: 'definitive (structural)',
              jobId,
              buckets: [describe(key)],
              reason: 'jobIdByKey["' + key + '"] = "' + jobId + '", but keyByJobId["' + jobId + '"] = ' + JSON.stringify(reverseTarget || null) + '. The two mappings disagree.'
            });
          }
        }
      });

      // Rule C, second pass — the byJob loop above only catches a stale
      // reverse pointer for jobs that still have exactly one forward
      // mapping in jobIdByKey. A reverse pointer can also go stale for
      // a job with NO forward mapping at all (e.g. every bucket that
      // once pointed to it was individually removed) — that job would
      // never enter byJob above and would be silently missed without
      // this separate pass over keyByJobId directly.
      const reportedJobIds = new Set(Object.keys(byJob));
      Object.keys(keyByJobId).forEach(jobId => {
        if (reportedJobIds.has(jobId)) return; // already handled above
        const target = keyByJobId[jobId];
        if (target && !Object.prototype.hasOwnProperty.call(jobs, target)) {
          findings.push({
            classification: 'Reverse mapping points to missing bucket',
            determinism: 'definitive',
            jobId,
            buckets: [],
            reason: 'keyByJobId["' + jobId + '"] points to bucket "' + target + '", which does not exist in jobs, and no bucket currently has a forward mapping to this job either.'
          });
        }
      });

      // Rule D / G — buckets with no forward job mapping at all.
      bucketKeys.forEach(key => {
        if (Object.prototype.hasOwnProperty.call(jobIdByKey, key)) return; // already handled above
        const looksModern = /^pl_/.test(key);
        findings.push({
          classification: looksModern ? 'Missing job mapping — review' : 'Legacy/name-keyed Punchlist',
          determinism: 'possible / requires review',
          jobId: null,
          buckets: [describe(key)],
          reason: looksModern
            ? 'Bucket "' + key + '" exists but has no entry in jobIdByKey, so no job currently claims it. Could be an older record, a manually-created list, or a leftover — not determinable from this data alone.'
            : 'Bucket key "' + key + '" is a plain name rather than a generated pl_ key, consistent with the application\'s own built-in sample data (e.g. "Aryzta Australia", "Epi") or an older, pre-ID punchlist. Not treated as corruption.'
        });
      });

      // Rule F — empty buckets, called out as a secondary note only
      // (already covered above by whatever classification applies;
      // this is just surfaced as an additional short list so it's easy
      // to scan, not a separate top-level inconsistency).
      const emptyBuckets = bucketKeys.filter(k => (jobs[k] || []).length === 0).map(describe);

      // Rule H — currentJob pointing at nothing.
      let currentJobFinding = null;
      if (snapshot.currentJob && !Object.prototype.hasOwnProperty.call(jobs, snapshot.currentJob)) {
        currentJobFinding = {
          classification: 'Current Punchlist points to missing bucket',
          determinism: 'definitive (structural)',
          reason: 'data.currentJob = "' + snapshot.currentJob + '", but jobs["' + snapshot.currentJob + '"] does not exist.'
        };
      }

      return {
        totalBuckets: bucketKeys.length,
        validBuckets: bucketKeys.length - findings.reduce((n, f) => n + f.buckets.length, 0),
        findings,
        emptyBuckets,
        currentJobFinding,
        scannedAt: new Date().toISOString()
      };
    };

    

    // v172: a stored template copy is used only if it really is an xlsx file
    // (an ArrayBuffer starting with "PK"). Anything else, such as a copy a
    // browser handed back in another shape, is ignored and the built-in
    // template file is used instead.
    function usableTemplateBuffer(v) {
      try {
        let buf = null;
        if (v instanceof ArrayBuffer) buf = v;
        else if (v && ArrayBuffer.isView(v)) buf = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
        else if (v && typeof v.byteLength === 'number' && typeof v.slice === 'function') buf = v;
        if (!buf || buf.byteLength < 100) return null;
        const head = new Uint8Array(buf.slice(0, 2));
        return (head[0] === 0x50 && head[1] === 0x4B) ? buf : null;
      } catch (e) { return null; }
    }
    async function loadWorkbookTemplate(fileName, cacheKey) {
      const key = cacheKey || fileName;
      try {
        const cached = usableTemplateBuffer(await idbGetKv(key));
        if (cached) return cached;
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
          try { await idbSetKv(key, buf.slice(0)); } catch (e) {}
          return buf;
        } catch (e) { lastErr = e; }
      }
      try {
        const cached = usableTemplateBuffer(await idbGetKv(key));
        if (cached) return cached;
      } catch (e) {}
      throw lastErr || new Error('Could not load ' + fileName);
    }
    async function getStoredTemplateBuffer() {
      // Filename and cache key both changed together deliberately: the
      // cache key must change too, or a technician who already has the
      // old template's buffer cached in IndexedDB would keep using it
      // forever — loadWorkbookTemplate checks its IndexedDB cache before
      // ever re-fetching, so an unchanged key would silently mask this
      // update for anyone who's already exported a punchlist before.
      // Cache key bumped again (V2 -> V3): the file's content changed here
      // too (logo added back, this time authored by ExcelJS's own writer
      // so it round-trips correctly) — same reasoning as the V1->V2 bump
      // above, anyone who already cached V2's buffer needs to re-fetch,
      // not silently keep serving the no-logo version forever.
      return loadWorkbookTemplate('Punchlist_Template_ExcelJS.xlsx', 'punchlistTemplateXlsxV3');
    }
    async function getTimecardTemplateBuffer() {
      return loadWorkbookTemplate('timecard-template.xlsx', 'timecardTemplateXlsx');
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

      // v157 (Phase 15B, approved amendment E): the Line column now shows
      // "<production line> · <machine line> · <serial>" when the item has
      // that equipment info (from its own save-time snapshot, or the live
      // machine record for older items) — no template/column changes,
      // just richer text in the cell that was already there. An item with
      // none of that (pre-15A data, or no serial ever entered) falls back
      // to its bare stored line number exactly as before.
      const head = [['#', 'Line', 'Location', 'Description', 'Action', 'Department', 'Comments', 'Status']];
      const body = (items.length ? items : [{}]).map(function (item, idx) {
        return [
          idx + 1,
          (typeof equipmentExportLine === 'function' && equipmentExportLine(item)) || item.line || '',
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

    // Findings-style export — same visual language as the Inspection PDF's
    // "Primary findings" cards (bold title, color chip, meta line, wrapped
    // notes, inline photo), just fed from Punchlist items instead of
    // inspection findings. Intentionally NOT sharing code with
    // generatePDFReport's card renderer: that renderer is a function
    // nested inside generatePDFReport itself, not reachable from here
    // (punchlistModule is a separate closure) — this is a fresh,
    // self-contained implementation that matches its output, not a
    // refactor of shared code.
    async function exportPunchlistFindingsPdf() {
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
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'letter' });
      const W = doc.internal.pageSize.getWidth();
      const H = doc.internal.pageSize.getHeight();
      const L = 14;
      const R = W - 14;
      const usable = R - L;
      let y = 14;

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
        const right = (customer + (dateRange ? '  ·  ' + dateRange : '')).substring(0, 48);
        doc.text(right, W - 8, 6.6, { align: 'right' });
      }
      function runningFooter() {
        const page = doc.internal.getCurrentPageInfo().pageNumber;
        doc.setFillColor(244, 245, 247);
        doc.rect(0, H - 12, W, 12, 'F');
        doc.setTextColor(92, 101, 112);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7);
        doc.text('Punchlist findings  ·  Customer copy', 8, H - 5);
        doc.text('Page ' + page, W - 8, H - 5, { align: 'right' });
      }
      function paintChrome() { runningHeader(); runningFooter(); }
      function newPage() { doc.addPage(); paintChrome(); y = 16; }
      function need(h) { if (y + h > H - 16) newPage(); }
      function wrap(text, width, fontSize) {
        doc.setFontSize(fontSize || 9);
        return doc.splitTextToSize(String(text || ''), width);
      }

      paintChrome();

      // Hero — same block style as the inspection report's opener, so this
      // reads as the same family of document.
      doc.setFillColor(20, 20, 24);
      doc.rect(L, y, usable, 30, 'F');
      doc.setTextColor(243, 179, 188);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.text('FIELD SERVICE — PUNCHLIST FINDINGS', L + 6, y + 8);
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(15);
      doc.text(String(customer).substring(0, 46), L + 6, y + 17);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(208, 213, 219);
      const sub = [site, dateRange, tech].filter(Boolean).join('  ·  ');
      if (sub) doc.text(sub.substring(0, 90), L + 6, y + 24);
      try {
        if (typeof LEMATIC_LOGO_JPG === 'string' && LEMATIC_LOGO_JPG) {
          doc.setFillColor(255, 255, 255);
          doc.roundedRect(R - 34, y + 6, 30, 10, 1, 1, 'F');
          doc.addImage('data:image/jpeg;base64,' + LEMATIC_LOGO_JPG, 'JPEG', R - 32.6, y + 6.8, 27.2, 8.4);
        }
      } catch (e) {}
      y += 38;

      function priorityChip(label, x, yy) {
        const v = String(label || '').toLowerCase();
        const bg = v === 'high' ? [253, 236, 234] : v === 'low' ? [235, 245, 238] : [255, 246, 217];
        const fg = v === 'high' ? [198, 40, 40] : v === 'low' ? [46, 125, 50] : [184, 134, 11];
        doc.setFillColor(bg[0], bg[1], bg[2]);
        doc.roundedRect(x, yy - 4, 18, 6, 1, 1, 'F');
        doc.setTextColor(fg[0], fg[1], fg[2]);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(6.5);
        doc.text(String(label || 'Normal').toUpperCase().substring(0, 9), x + 9, yy, { align: 'center' });
      }

      function findingCard(item) {
        const noteParts = [];
        if (item.action) noteParts.push('Action: ' + item.action);
        if (item.comments) noteParts.push(item.comments);
        const bodyLines = wrap(noteParts.join('\n') || 'No notes recorded.', usable - 10, 9);
        const src = item.photo || null;
        const photoH = src ? 48 : 0;
        const h = 16 + bodyLines.length * 4.2 + photoH + (src ? 8 : 4);
        need(Math.min(h, 70));
        doc.setDrawColor(228, 230, 234);
        doc.setFillColor(255, 255, 255);
        doc.rect(L, y, usable, h, 'FD');
        doc.setFillColor(198, 40, 40);
        doc.rect(L, y, 1.8, h, 'F');
        doc.setTextColor(20, 20, 24);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.text(String(item.description || 'Untitled item').substring(0, 62), L + 5, y + 7);
        priorityChip(item.priority, R - 24, y + 7);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.setTextColor(92, 101, 112);
        // v157 (Phase 15B, amendment E): production line/machine line/
        // serial (and type/SO, since this meta line has room) alongside
        // the fields already shown here — no layout change, just more
        // text in the line that already existed.
        const eq = (typeof equipmentDisplayFor === 'function') ? equipmentDisplayFor(item) : null;
        const eqBits = eq ? [eq.productionLine, eq.lineLabel, eq.serial, eq.machineType, eq.salesOrder ? 'SO ' + eq.salesOrder : ''].filter(Boolean) : [];
        const meta = eqBits.concat([item.location, item.department, item.status].filter(Boolean)).join('  ·  ');
        doc.text(meta.substring(0, 110), L + 5, y + 13);
        doc.setTextColor(20, 20, 24);
        doc.setFontSize(9);
        let yy = y + 19;
        bodyLines.forEach(line => { doc.text(line, L + 5, yy); yy += 4.2; });
        if (src) {
          try { doc.addImage(src, 'JPEG', L + 5, yy, 70, 42); }
          catch (e) { try { doc.addImage(src, 'PNG', L + 5, yy, 70, 42); } catch (e2) {} }
        }
        y += h + 4;
      }

      function lineHeader(label) {
        need(12);
        doc.setFillColor(241, 242, 245);
        doc.rect(L, y, usable, 8, 'F');
        doc.setFillColor(198, 40, 40);
        doc.rect(L, y, 1.8, 8, 'F');
        doc.setTextColor(20, 20, 24);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.text(String(label).toUpperCase().substring(0, 70), L + 5, y + 5.5);
        y += 8 + 3;
      }

      // High priority first within each line — same "most important
      // problem first" logic as the inspection report's Poor/Fail
      // ranking, adapted to Punchlist's own priority field. Every item
      // appears, not just photographed ones, since a typed note without
      // a photo is still a real finding worth putting in the trip
      // report.
      const rank = (p) => { const v = String(p || '').toLowerCase(); return v === 'high' ? 2 : v === 'low' ? 0 : 1; };

      // Grouped by MACHINE (equipmentId, falling back to the item's own
      // serial for one saved before equipmentId existed) — a tech scanning
      // the report for "what's left on Line 9" shouldn't have to read
      // every card on the page. v157 fix (Phase 15B review, item 1): this
      // used to group by the stored item.line slot digit, which silently
      // reshuffled every time the job's serial list was edited (adding a
      // lower serial could move an old item's card under a different
      // machine's heading). Grouping by machine identity means the job's
      // serial list can be edited at any time without it ever affecting
      // where an already-saved item's card lands. Items with no machine
      // fall into their own group at the end rather than being scattered
      // in among the labeled ones.
      const NO_LINE = 'No line specified';
      // v157 fix (Phase 15B review round 2, item B.2): the grouping key is
      // now always resolved to ONE identity per machine, not whichever of
      // equipmentId/serial the item happens to carry. An item with a
      // serial groups by that serial's machine id (findMachineBySerial) —
      // so two items on the same machine land together whether or not
      // BOTH happen to be stamped with equipmentId yet (e.g. right after a
      // restore, before every item has been re-saved). Only an item with
      // no serial at all falls back to its own equipmentId, and only an
      // item with neither falls into "No line specified".
      function machineGroupKey(item) {
        const serial = String((item && item.serial) || '').trim();
        if (serial) {
          const m = (typeof findMachineBySerial === 'function') ? findMachineBySerial(serial) : null;
          if (m && m.id) return m.id;
          return (typeof normalizeMatchText === 'function') ? normalizeMatchText(serial) : serial.toLowerCase();
        }
        return (item && item.equipmentId) ? String(item.equipmentId) : '';
      }
      const groups = new Map();
      rawItems.forEach(item => {
        const key = machineGroupKey(item) || NO_LINE;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      });
      // v157 (Phase 15B, amendment E): the group header shows the real
      // machine's production line/line label/serial (taken from the
      // group's own items, snapshot-first) — never a bare slot number.
      function groupHeaderLabel(key) {
        if (key === NO_LINE) return NO_LINE;
        const groupItems = groups.get(key) || [];
        const withEquipment = groupItems.find(it => (typeof equipmentExportLine === 'function') && equipmentExportLine(it));
        if (withEquipment) return equipmentExportLine(withEquipment);
        // No snapshot and no matching machine record (e.g. a serial that
        // was typed but never resolved) — fall back to the item's own
        // serial text rather than the internal grouping key.
        const withSerial = groupItems.find(it => it && it.serial);
        return (withSerial && withSerial.serial) || NO_LINE;
      }
      const lineKeys = Array.from(groups.keys())
        .filter(k => k !== NO_LINE)
        .sort((a, b) => groupHeaderLabel(a).localeCompare(groupHeaderLabel(b), undefined, { numeric: true, sensitivity: 'base' }));
      if (groups.has(NO_LINE)) lineKeys.push(NO_LINE);

      if (!rawItems.length) {
        doc.setTextColor(92, 101, 112);
        doc.setFontSize(9);
        doc.text('No punchlist items to report.', L, y);
      } else {
        lineKeys.forEach(key => {
          lineHeader(groupHeaderLabel(key));
          groups.get(key)
            .slice()
            .sort((a, b) => rank(b.priority) - rank(a.priority))
            .forEach(findingCard);
        });
      }

      const safeName = String(jobName).replace(/[\\/:*?"<>|]/g, '-').trim() || 'Punchlist';
      doc.save(safeName + ' Findings.pdf');
      toast('Findings PDF downloaded');
    }


    
    


    // v172: Excel-safe workbook fixes (the Excel library writes two things
    // desktop Excel rejects with "We found a problem with some content"):
    //  1. Dropdown rules: the library merges per-cell rules into ranges in
    //     text order ("F10" before "F6"), producing overlapping ranges
    //     (F10:F50 and F6:F50). Rebuild them as one range per unbroken run.
    //  2. Pictures: a picture with only a size is written as a one-cell
    //     anchor carrying an attribute only two-cell anchors may have. Give
    //     every picture both corners instead (same place, same size).
    function xlFixDataValidations(ws) {
      try {
        const dvs = ws && ws.dataValidations;
        const model = dvs && dvs.model;
        if (!model) return;
        const keys = Object.keys(model);
        const groups = {};
        const keep = {};
        keys.forEach(k => {
          const m = /^([A-Z]+)(\d+)$/.exec(k);
          if (!m) { keep[k] = model[k]; return; }
          const sig = m[1] + '|' + JSON.stringify(model[k]);
          (groups[sig] = groups[sig] || { col: m[1], dv: model[k], rows: [] }).rows.push(Number(m[2]));
        });
        const out = Object.assign({}, keep);
        Object.keys(groups).forEach(sig => {
          const g = groups[sig];
          const rows = g.rows.sort((a, b) => a - b);
          let start = rows[0], prev = rows[0];
          const flush = () => { out[start === prev ? (g.col + start) : (g.col + start + ':' + g.col + prev)] = g.dv; };
          for (let i = 1; i < rows.length; i++) {
            if (rows[i] === prev + 1) { prev = rows[i]; continue; }
            flush(); start = prev = rows[i];
          }
          flush();
        });
        dvs.model = out;
      } catch (e) { console.warn('[excel] dropdown fix skipped', e); }
    }
    const XL_EMU_PER_PX = 9525;
    function xlColPx(ws, idx0) {
      try { const w = ws.getColumn(idx0 + 1).width; return Math.round((w || 8.43) * 7 + (w ? 0 : 5)); } catch (e) { return 64; }
    }
    function xlRowPx(ws, idx0) {
      try { const h = ws.getRow(idx0 + 1).height; return Math.round((h || 15) * 96 / 72); } catch (e) { return 20; }
    }
    // Bottom-right corner of a picture placed at (col0,row0)+offsets with the
    // given pixel size, as exact cell + offset positions.
    function xlBottomRight(ws, col0, colOffEmu, row0, rowOffEmu, wPx, hPx) {
      let col = col0, x = (colOffEmu || 0) / XL_EMU_PER_PX + wPx;
      for (let guard = 0; guard < 200 && x >= xlColPx(ws, col); guard++) { x -= xlColPx(ws, col); col++; }
      let row = row0, y = (rowOffEmu || 0) / XL_EMU_PER_PX + hPx;
      for (let guard = 0; guard < 2000 && y >= xlRowPx(ws, row); guard++) { y -= xlRowPx(ws, row); row++; }
      return { nativeCol: col, nativeColOff: Math.round(x * XL_EMU_PER_PX), nativeRow: row, nativeRowOff: Math.round(y * XL_EMU_PER_PX) };
    }
    function xlFixPictureAnchors(ws) {
      try {
        (ws.getImages() || []).forEach(img => {
          const r = img && img.range;
          if (!r || r.br || !r.tl || !r.ext) return;
          const tl = { nativeCol: r.tl.nativeCol || 0, nativeColOff: r.tl.nativeColOff || 0, nativeRow: r.tl.nativeRow || 0, nativeRowOff: r.tl.nativeRowOff || 0 };
          const br = xlBottomRight(ws, tl.nativeCol, tl.nativeColOff, tl.nativeRow, tl.nativeRowOff, r.ext.width || 0, r.ext.height || 0);
          img.model = { type: 'image', imageId: img.imageId, range: { tl: tl, br: br, editAs: 'oneCell' }, hyperlinks: img.hyperlinks };
        });
      } catch (e) { console.warn('[excel] picture fix skipped', e); }
    }

    // v172: the Excel library writes a sheet's page-setup and outline
    // settings in the wrong order when both exist, and Excel then rejects
    // the whole sheet ("Replaced Part: sheet1.xml"). The outline settings
    // are Excel's own defaults (summary rows below / right), so they are
    // dropped; the page setup (fit to page) is kept.
    function xlFixSheetProperties(wb) {
      try {
        (wb.worksheets || []).forEach(sh => {
          if (sh && sh.properties && sh.properties.outlineProperties) delete sh.properties.outlineProperties;
        });
      } catch (e) { console.warn('[excel] sheet properties fix skipped', e); }
    }
    // v172: workbook names Excel cross-checks against the sheet.
    //  - The template carries the filter's internal name as a workbook-wide
    //    name; Excel expects it to belong to the sheet, and the library
    //    shrinks it when rows are trimmed so it no longer matches the filter.
    //    It is removed; Excel rebuilds it from the sheet's own filter.
    //  - The print area is written by the library as $A1:$H50 (row not
    //    fixed); it is given in a form that comes out as $A$1:$H$50.
    function xlFixWorkbookNames(wb) {
      try {
        if (wb.definedNames && Array.isArray(wb.definedNames.model)) {
          wb.definedNames.model = wb.definedNames.model.filter(d => d && d.name !== '_xlnm._FilterDatabase');
        }
      } catch (e) { console.warn('[excel] names fix skipped', e); }
      try {
        (wb.worksheets || []).forEach(sh => {
          const ps = sh && sh.pageSetup;
          if (!ps || !ps.printArea) return;
          ps.printArea = String(ps.printArea).split('&&').map(r => r.split(':').map(c => {
            const m = /^\$?([A-Z]+)\$?(\d+)$/.exec(c.trim());
            return m ? (m[1] + '$' + m[2]) : c;
          }).join(':')).join('&&');
        });
      } catch (e) { console.warn('[excel] print area fix skipped', e); }
    }
    // v172: colour rules ("cell contains Bakery", etc.) are saved by the
    // library without the text Excel normally stores with them. Save them as
    // plain formula rules instead: same formula, same colours.
    function xlFixColourRules(ws) {
      try {
        (ws.conditionalFormattings || []).forEach(cf => {
          (cf && cf.rules || []).forEach(rule => {
            if (rule && rule.type === 'containsText' && rule.formulae && rule.formulae[0]) {
              rule.type = 'expression';
              delete rule.operator;
              delete rule.text;
            }
          });
        });
      } catch (e) { console.warn('[excel] colour rule fix skipped', e); }
    }

    async function exportPunchlistExcel() {
      const items = getItems();
      // v172: the file is named after the list's real name (as the PDF is),
      // never its internal id ("pl_mu5n…").
      let jobName = '';
      try { jobName = punchlistDisplayName(data.currentJob) || ''; } catch (e) {}
      if (!jobName || isInternalId(jobName)) { try { jobName = punchlistKeyLabel(data.currentJob) || ''; } catch (e) {} }
      if (!jobName || isInternalId(jobName)) jobName = "Punchlist";
      const safeName = String(jobName).replace(/[\\/:*?"<>|]/g, "-").trim() || "Punchlist";
      const filename = (/punchlist$/i.test(safeName) ? safeName : safeName + " Punchlist") + ".xlsx";

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
        // v157 (Phase 15B, amendment E): richer text in the existing Line
        // cell — "<production line> · <machine line> · <serial>" when
        // known, same bare stored number as before otherwise. No template
        // or column changes.
        row.getCell(2).value = (typeof equipmentExportLine === 'function' && equipmentExportLine(item)) || item.line || "";
        row.getCell(3).value = item.location || "";
        row.getCell(4).value = item.description || "";
        row.getCell(5).value = item.action || "";
        row.getCell(6).value = dept;
        row.getCell(7).value = item.comments || "";
        row.getCell(8).value = status;
        for (let c = 2; c <= 7; c++) {
          const cell = row.getCell(c);
          // Vertical center, matching the template's own default — this
          // used to force top-alignment specifically for filled rows,
          // which is what made wrapped multi-line text look pinned to the
          // top of a tall row instead of sitting centered in it.
          cell.alignment = Object.assign({}, cell.alignment || {}, { wrapText: true, vertical: "middle" });
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
            // v172: both corners given (Excel-safe two-cell anchor), same
            // place and size as before: 220 x 150 px at the top-left of C.
            pws.addImage(imgId, {
              tl: { nativeCol: 2, nativeColOff: 0, nativeRow: rowIdx - 1, nativeRowOff: 0 },
              br: xlBottomRight(pws, 2, 0, rowIdx - 1, 0, 220, 150),
              editAs: 'oneCell'
            });
          } catch (e) {}
        });
      }

      xlFixDataValidations(ws);
      xlFixPictureAnchors(ws);
      xlFixSheetProperties(wb);
      xlFixColourRules(ws);
      xlFixWorkbookNames(wb);

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
    // v152 (Phase 12A Fix 4): this function lives inside its own module,
    // so the header Back button's closeOpenOverlaysForBack() could not
    // reach it — the call failed silently and the sheet stayed open.
    window.closePlExportSheet = closePlExportSheet;
    document.getElementById("btn-export").addEventListener("click", () => {
      openPlExportSheet();
    });
    const plExportPdf = document.getElementById('plExportPdf');
    if (plExportPdf) plExportPdf.addEventListener('click', () => {
      closePlExportSheet();
      exportPunchlistPdf();
    });
    const plExportFindings = document.getElementById('plExportFindings');
    if (plExportFindings) plExportFindings.addEventListener('click', () => {
      closePlExportSheet();
      exportPunchlistFindingsPdf().catch(err => {
        console.warn(err);
        toast('Could not build Findings PDF');
      });
    });
    const plExportXlsx = document.getElementById('plExportXlsx');
    if (plExportXlsx) plExportXlsx.addEventListener('click', () => {
      closePlExportSheet();
      exportPunchlistExcel().catch(err => {
        console.warn(err);
        // v172: include the reason, so a failure on a phone can be traced.
        let why = '';
        try { why = String((err && (err.message || err.name)) || err || '').replace(/\s+/g, ' ').slice(0, 80); } catch (e) {}
        toast("Could not build Excel file" + (why ? " (" + why + ")" : ""));
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
    window.tcFormatLongDate = tcFormatLongDate;
    window.tcOpenEdit = tcOpenEdit;
    function tcUid() {
      // Was its own separate implementation of the same idea as
      // newEntityId() — now just delegates to it, removing the duplicate
      // while keeping every call site (3 of them) unchanged.
      return newEntityId('tc');
    }
    function tcLoad() {
      try {
        const raw = STORE.load('timecards');
        if (raw && typeof raw === 'object') {
          tcState.entries = Array.isArray(raw.entries) ? raw.entries : [];
          tcState.active = raw.active || null;
        }
      } catch (e) { tcState.entries = []; tcState.active = null; }
      try { tcNormalizeEntryJobs(); } catch (e) {}
      tcEnsureSampleWeek();
    }
    // Phase 7C (C2): used to swallow its own write failure completely
    // (empty catch, no return value) — every one of its ~8 callers had
    // no way to know whether the write actually happened. Now returns
    // a real boolean. Only tcSaveEdit (the one user-facing "Saved"
    // toast) is wired to check it, per the approved scope — the other
    // callers (clock in/out, delete, etc.) keep their existing
    // behavior unchanged, same as before this phase.
    function tcSave() {
      try {
        return !!STORE.save('timecards', { entries: tcState.entries, active: tcState.active });
      } catch (e) {
        return false;
      }
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
      // v152 (Phase 12A decision 2): never seeded on the live site.
      if (typeof isSampleDataLocation === 'function' && !isSampleDataLocation()) return;
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
      const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      return days[d.getDay()] + ', ' + months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
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
      const minutes = Math.round(ms / 60000);
      return Math.round((minutes / 60) * 100) / 100;
    }
    function tcHoursLabel(hours) {
      const n = Math.max(0, Math.min(24, Number(hours) || 0));
      const minutes = Math.round(n * 60);
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      return h + ' hr ' + String(m).padStart(2, '0') + ' min';
    }
    function tcSpanMs(clockIn, clockOut) {
      const a = Number(clockIn);
      let b = Number(clockOut);
      if (!isFinite(a) || !isFinite(b)) return 0;
      if (b === a) return TC_MAX_MS;
      if (b < a) b += TC_MAX_MS;
      if (b - a > TC_MAX_MS) return TC_MAX_MS;
      return b - a;
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
        if (typeRow) typeRow.querySelectorAll('.tc-type-chip').forEach(b => { b.disabled = false; });
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
        const liveType = (tcState.active && tcState.active.type) || tcState.selectedType;
        typeRow.querySelectorAll('.tc-type-chip').forEach(b => {
          b.classList.toggle('on', b.getAttribute('data-type') === liveType);
        });
      }
    }
    // v152 (Phase 12A Fix 6): the week card totals every job; this line
    // shows only the job picked in the dropdown, this calendar week, so
    // the two can't be mistaken for each other. Read-only.
    function tcRenderJobWeekLine() {
      const el = document.getElementById('tcJobWeekLine');
      const sel = document.getElementById('tcJobSelect');
      if (!el) return;
      const jobId = sel ? sel.value : '';
      const jobs = (typeof loadJobs === 'function' ? loadJobs() : []) || [];
      const job = jobId ? jobs.find(j => j && String(j.id) === String(jobId)) : null;
      if (!job) { el.hidden = true; el.textContent = ''; return; }
      const hrs = tcEntriesForWeek(0).filter(en => tcEntryMatchesJob(en, job, jobs))
        .reduce((sum, en) => sum + tcEntryHours(en), 0);
      el.innerHTML = 'This job: <strong>' + (Math.round(hrs * 100) / 100).toFixed(2) + ' hrs</strong> this week';
      el.hidden = false;
    }
    function tcRenderWeek() {
      try { tcRenderJobWeekLine(); } catch (e) {}
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
    function tcWeekCardHTML(offset) {
      const fmt = n => (Math.round(n * 100) / 100).toFixed(2);
      const t = tcWeekTotals(offset);
      const label = tcWeekLabelText(offset);
      const kicker = (offset === 0 ? 'This week' : (offset === -1 ? 'Last week' : (offset === 1 ? 'Next week' : 'Week'))) + ' · All jobs'; // v152 (Phase 12A Fix 6)
      return (
        '<div class="tc-week-card" data-offset="' + offset + '">' +
          '<div class="tc-week-kicker">' + kicker + '</div>' +
          '<div class="tc-week-label">' + label + '</div>' +
          '<div class="tc-week-totals">' +
            '<span>Bakery<strong>' + fmt(t.bakery) + '</strong></span>' +
            '<span>Travel<strong>' + fmt(t.travel) + '</strong></span>' +
            '<span>Shop<strong>' + fmt(t.shop) + '</strong></span>' +
            '<span>Total<strong>' + fmt(t.total) + '</strong></span>' +
          '</div>' +
          '<div class="tc-week-hint">' + (t.count ? (t.count + ' entr' + (t.count === 1 ? 'y' : 'ies')) : 'No entries') + '</div>' +
        '</div>'
      );
    }

    function tcRenderWeekStrip() {
      const strip = document.getElementById('tcWeekStrip');
      if (!strip) return;
      const off = tcState.weekOffset || 0;

      strip.innerHTML =
        '<div class="tc-week-viewport" id="tcWeekViewport">' +
          '<div class="tc-week-track" id="tcWeekTrack">' +
            tcWeekCardHTML(off - 1) +
            tcWeekCardHTML(off) +
            tcWeekCardHTML(off + 1) +
          '</div>' +
        '</div>';

      const viewport = document.getElementById('tcWeekViewport');
      const track = document.getElementById('tcWeekTrack');
      if (!viewport || !track) return;

      // Tear down prior observer so re-renders do not stack listeners
      if (strip._tcWeekRO) {
        try { strip._tcWeekRO.disconnect(); } catch (_) {}
        strip._tcWeekRO = null;
      }

      const cards = Array.from(track.querySelectorAll('.tc-week-card'));
      const GAP = 12; // padding visible between cards while swiping
      const measure = () => Math.max(1, Math.round(viewport.getBoundingClientRect().width));
      const layout = () => {
        const w = measure();
        cards.forEach(c => {
          c.style.flex = '0 0 ' + w + 'px';
          c.style.width = w + 'px';
          c.style.minWidth = w + 'px';
          c.style.maxWidth = w + 'px';
        });
        track.style.gap = GAP + 'px';
        track.style.width = (w * cards.length + GAP * Math.max(0, cards.length - 1)) + 'px';
        return w;
      };
      let pageW = layout();
      // Track holds [prev, current, next]; center on current (account for gap)
      const stepOf = (w) => w + GAP;
      let baseX = -stepOf(pageW);
      let dragX = 0;
      let settling = false;
      let moved = false;
      let axis = null; // null | 'h' | 'v'
      let startX = 0, startY = 0, lastX = 0, lastT = 0, velX = 0;
      let pointerId = null;

      const setX = (x, withTransition) => {
        if (withTransition) {
          track.style.transition = 'transform 0.32s cubic-bezier(0.32, 0.72, 0, 1)';
        } else {
          track.style.transition = 'none';
        }
        // Force compositor layer; avoid subpixel jitter
        track.style.transform = 'translate3d(' + Math.round(x * 100) / 100 + 'px,0,0)';
      };

      setX(baseX, false);

      const openCurrent = () => {
        const displayed = parseInt(track.querySelectorAll('.tc-week-card')[1]?.getAttribute('data-offset') || String(off), 10);
        tcOpenWeek(Number.isFinite(displayed) ? displayed : (tcState.weekOffset || 0));
      };

      const finishSettle = (dir) => {
        // dir: -1 next week (swiped left), +1 prev week (swiped right), 0 snap back
        if (dir !== 0) {
          tcState.weekOffset = (tcState.weekOffset || 0) - dir;
        }
        // Re-render centered on the new week (no residual transform)
        tcRenderWeekStrip();
      };

      const settle = (dir) => {
        settling = true;
        pageW = layout();
        baseX = -stepOf(pageW);
        const target = baseX + dir * stepOf(pageW);
        setX(target, true);
        const onEnd = (e) => {
          if (e && e.propertyName && e.propertyName !== 'transform') return;
          track.removeEventListener('transitionend', onEnd);
          settling = false;
          finishSettle(dir);
        };
        track.addEventListener('transitionend', onEnd);
        // Fallback if transitionend is skipped
        window.setTimeout(() => {
          if (!settling) return;
          track.removeEventListener('transitionend', onEnd);
          settling = false;
          finishSettle(dir);
        }, 400);
      };

      const onPointerDown = (e) => {
        if (settling) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        pointerId = e.pointerId;
        try { viewport.setPointerCapture(pointerId); } catch (_) {}
        pageW = measure();
        baseX = -stepOf(pageW);
        dragX = 0;
        moved = false;
        axis = null;
        startX = e.clientX;
        startY = e.clientY;
        lastX = e.clientX;
        lastT = performance.now();
        velX = 0;
        track.style.transition = 'none';
      };

      const onPointerMove = (e) => {
        if (pointerId == null || e.pointerId !== pointerId || settling) return;
        const x = e.clientX;
        const y = e.clientY;
        const dx = x - startX;
        const dy = y - startY;
        if (!axis) {
          if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
          axis = Math.abs(dx) > Math.abs(dy) * 1.15 ? 'h' : 'v';
          if (axis === 'v') {
            // Let the page scroll; abandon horizontal gesture
            try { viewport.releasePointerCapture(pointerId); } catch (_) {}
            pointerId = null;
            return;
          }
        }
        if (axis !== 'h') return;
        e.preventDefault();
        moved = true;
        const now = performance.now();
        const dt = Math.max(1, now - lastT);
        velX = (x - lastX) / dt; // px/ms
        lastX = x;
        lastT = now;
        dragX = dx;
        // Slight edge resistance when over-dragging past a full page
        let resisted = dragX;
        const limit = stepOf(pageW) * 1.05;
        if (resisted > limit) resisted = limit + (resisted - limit) * 0.25;
        if (resisted < -limit) resisted = -limit + (resisted + limit) * 0.25;
        setX(baseX + resisted, false);
      };

      const onPointerUp = (e) => {
        if (pointerId == null || (e && e.pointerId !== pointerId)) return;
        try { viewport.releasePointerCapture(pointerId); } catch (_) {}
        pointerId = null;
        if (settling) return;
        if (axis !== 'h' || !moved) {
          // Tap → open week
          if (!moved && axis !== 'v') openCurrent();
          axis = null;
          dragX = 0;
          setX(baseX, false);
          return;
        }
        const dx = dragX;
        const threshold = stepOf(pageW) * 0.22;
        const flick = Math.abs(velX) > 0.45; // ~450 px/s
        let dir = 0;
        if (dx <= -threshold || (flick && velX < -0.25)) dir = -1; // next
        else if (dx >= threshold || (flick && velX > 0.25)) dir = 1;  // prev
        axis = null;
        dragX = 0;
        settle(dir);
      };

      viewport.addEventListener('pointerdown', onPointerDown);
      viewport.addEventListener('pointermove', onPointerMove, { passive: false });
      viewport.addEventListener('pointerup', onPointerUp);
      viewport.addEventListener('pointercancel', onPointerUp);

      strip._tcWeekRO = new ResizeObserver(() => {
        if (settling || pointerId != null) return;
        pageW = layout();
        baseX = -stepOf(pageW);
        setX(baseX, false);
      });
      strip._tcWeekRO.observe(viewport);
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
          '<div class="tc-entry-sub">' + typeLabel + (isSampleTimeEntry(en) ? SAMPLE_TAG_HTML : '') + '</div></div>' +
          '<div class="tc-entry-hours">' + h.toFixed(2) + '</div></div>';
      }).join('');
      listEl.querySelectorAll('.tc-entry').forEach(el => {
        el.addEventListener('click', () => tcOpenEdit(el.getAttribute('data-id')));
      });
      if (typeof bindSwipeToDelete === 'function') {
        bindSwipeToDelete(listEl, '.tc-entry', (row) => ({
          id: row.getAttribute('data-id'),
          kind: 'timecard',
          title: 'Delete time entry?',
          label: 'This time entry will be permanently deleted.'
        }));
      }
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
    window.tcCloseWeekPick = tcCloseWeekPick; // v152 (Phase 12A Fix 4)
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
      const scrollThisWeekIntoMiddle = () => {
        const target = list.querySelector('.tc-week-pick-item[data-offset="0"]');
        if (!target || !list.clientHeight) return;
        const top = target.offsetTop - (list.clientHeight / 2) + (target.offsetHeight / 2);
        list.scrollTop = Math.max(0, top);
      };
      requestAnimationFrame(() => {
        scrollThisWeekIntoMiddle();
        requestAnimationFrame(scrollThisWeekIntoMiddle);
      });
      setTimeout(scrollThisWeekIntoMiddle, 60);
      setTimeout(scrollThisWeekIntoMiddle, 320);
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
    }
    function tcStartTick() {
      if (tcState.tickTimer) clearInterval(tcState.tickTimer);
      tcState.tickTimer = setInterval(() => {
        const sc = document.getElementById('screenTime');
        if (sc && sc.classList.contains('active')) {
          tcRenderStatus();
          if (tcState.active) tcRenderWeek();
        }
      }, tcState.active ? 1000 : 15000);
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
      tcStartTick();
      toast('Clocked in');
    }
    function tcSwitchType(nextType) {
      nextType = String(nextType || 'bakery').toLowerCase();
      if (nextType !== 'travel' && nextType !== 'shop' && nextType !== 'bakery') nextType = 'bakery';
      const current = (tcState.active && tcState.active.type) || tcState.selectedType || 'bakery';
      if (!tcState.active) {
        tcState.selectedType = nextType;
        tcRenderStatus();
        return;
      }
      if (current === nextType) {
        tcState.selectedType = nextType;
        tcRenderStatus();
        return;
      }
      tcEnsureActiveClosedIfNeeded();
      if (!tcState.active) {
        tcState.selectedType = nextType;
        tcClockIn();
        return;
      }
      const now = Date.now();
      const prev = tcState.entries.find(e => e.id === tcState.active.id);
      if (prev) {
        prev.clockOut = Math.min(now, prev.clockIn + TC_MAX_MS);
        if (prev.clockOut >= prev.clockIn + TC_MAX_MS - 1000) prev.autoCapped = true;
        if (prev.clockOut <= prev.clockIn) prev.clockOut = prev.clockIn + 1000;
      }
      const jobId = (prev && prev.jobId) || tcState.active.jobId || '';
      const bakeryName = (prev && prev.bakeryName) || tcState.active.bakeryName || tcBakeryNameForJob(jobId);
      const id = tcUid();
      const entry = {
        id, clockIn: now, clockOut: null,
        type: nextType,
        jobId: jobId || '',
        bakeryName: bakeryName || '',
        date: tcDateKey(now),
        notes: '',
        manualHours: null,
        autoCapped: false
      };
      tcState.entries.push(entry);
      tcState.selectedType = nextType;
      tcState.active = { id, clockIn: now, type: nextType, jobId: entry.jobId, bakeryName: entry.bakeryName };
      tcSave();
      tcRefresh();
      tcStartTick();
      const label = nextType.charAt(0).toUpperCase() + nextType.slice(1);
      toast('Switched to ' + label);
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
      tcStartTick();
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
      const sameTime = String(cin.value || '').slice(0,5) === String(cout.value || '').slice(0,5) && cin.value;
      const a = parseTime(cin.value);
      let b = parseTime(cout.value);
      if (isNaN(a) || isNaN(b)) {
        if (hint) hint.textContent = 'Enter clock in and out to calculate hours, or type hours directly';
        return;
      }
      const ms = sameTime ? TC_MAX_MS : tcSpanMs(a, b);
      const h = sameTime ? 24 : tcHoursFromMs(ms);
      hoursEl.value = h;
      if (hint) {
        hint.textContent = h >= 24
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
      let manualHours = (!isNaN(hoursVal)) ? Math.max(0, Math.min(24, hoursVal)) : null;
      if (cinStr && coutStr && String(cinStr).slice(0,5) === String(coutStr).slice(0,5) && !tcHoursManualOverride) {
        manualHours = 24;
      }
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
      if (clockIn && clockOut && clockOut <= clockIn) clockOut += 24 * 3600000;
      if (cinStr && coutStr && String(cinStr).slice(0,5) === String(coutStr).slice(0,5)) {
        clockOut = clockIn + TC_MAX_MS;
        if (manualHours == null || !tcHoursManualOverride) {
          // 8:00 to 8:00 (same displayed time) is a 24-hour shift
        }
      }
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
      // Phase 7C (C2): toast now reflects the real write outcome
      // instead of always claiming "Saved". Navigation to the week
      // view is left exactly as it was before this phase — only the
      // toast text is conditioned.
      const tcOk = tcSave();
      showScreen('screenTimeWeek');
      document.body.classList.add('on-time-week');
      document.body.classList.remove('on-time-edit');
      tcRenderWeekDetail();
      toast(tcOk ? 'Saved' : 'Could not save time card — storage full or unavailable');
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
    // v152 (Phase 12A Fix 6): removes only the built-in sample time
    // entries (IDs starting tc_sample_). Returns how many were removed.
    function tcRemoveSampleEntries() {
      try { lsWrite('lx8_tc_sample_seeded', true); } catch (e) {}
      tcLoad();
      const before = (tcState.entries || []).length;
      tcState.entries = (tcState.entries || []).filter(en => !isSampleTimeEntry(en));
      const removed = before - tcState.entries.length;
      if (tcState.active && isSampleTimeEntry(tcState.active)) tcState.active = null;
      if (removed) tcSave();
      return removed;
    }
    window.tcRemoveSampleEntries = tcRemoveSampleEntries;
    window.tcCountSampleEntries = function() {
      try {
        const raw = STORE.load('timecards');
        const list = (raw && Array.isArray(raw.entries)) ? raw.entries : [];
        return list.filter(isSampleTimeEntry).length;
      } catch (e) { return 0; }
    };
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

    function tcCloseExportSheet() {
      const sheet = document.getElementById('tcExportSheet'), scrim = document.getElementById('tcExportScrim');
      if (sheet) { sheet.classList.remove('show'); sheet.hidden = true; sheet.setAttribute('hidden',''); }
      if (scrim) { scrim.classList.remove('show'); scrim.hidden = true; scrim.setAttribute('hidden',''); }
    }
    // v152 (Phase 12A Fix 4): same reachability fix as closePlExportSheet.
    window.tcCloseExportSheet = tcCloseExportSheet;

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

    function tcOpenExportSheet() {
      tcLoad();
      const current = tcState.weekOffset || 0;
      tcExportSelection = { mode: 'weeks', weeks: new Set([current]), days: new Set() };
      const sheet = document.getElementById('tcExportSheet'), scrim = document.getElementById('tcExportScrim');
      if (!sheet || !scrim) return;
      sheet.hidden = false; sheet.removeAttribute('hidden');
      scrim.hidden = false; scrim.removeAttribute('hidden');
      const seg = document.getElementById('tcExportSeg');
      if (seg) {
        seg.setAttribute('data-mode', tcExportSelection.mode || 'weeks');
        seg.classList.remove('seg-land');
      }
      requestAnimationFrame(() => {
        sheet.classList.add('show');
        scrim.classList.add('show');
        if (seg) {
          void seg.offsetWidth;
          requestAnimationFrame(() => seg.classList.add('seg-land'));
        }
      });
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
      on('tcExportTabWeeks', () => { tcExportSelection.mode = 'weeks'; document.getElementById('tcExportTabWeeks').classList.add('on'); document.getElementById('tcExportTabDays').classList.remove('on'); document.getElementById('tcExportTabWeeks').setAttribute('aria-selected','true'); document.getElementById('tcExportTabDays').setAttribute('aria-selected','false'); const seg = document.getElementById('tcExportSeg'); if (seg) { seg.classList.remove('seg-land'); seg.setAttribute('data-mode','weeks'); } tcRenderExportList(); });
      on('tcExportTabDays', () => { tcExportSelection.mode = 'days'; document.getElementById('tcExportTabDays').classList.add('on'); document.getElementById('tcExportTabWeeks').classList.remove('on'); document.getElementById('tcExportTabDays').setAttribute('aria-selected','true'); document.getElementById('tcExportTabWeeks').setAttribute('aria-selected','false'); const seg = document.getElementById('tcExportSeg'); if (seg) { seg.classList.remove('seg-land'); seg.setAttribute('data-mode','days'); } tcRenderExportList(); });
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
      const tile = document.getElementById('navHomeTime');
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
      const tcJobSelEl = document.getElementById('tcJobSelect');
      if (tcJobSelEl && tcJobSelEl.dataset.tcWeekLineBound !== '1') {
        tcJobSelEl.dataset.tcWeekLineBound = '1';
        tcJobSelEl.addEventListener('change', () => { try { tcRenderJobWeekLine(); } catch (e) {} });
      }
      
      once('btnTcExport', tcOpenExportSheet);
      once('btnTcAddManual', tcOpenManual);
      once('btnTcAddManualWeek', tcOpenManual);
      once('btnTcWeekExport', tcOpenExportSheet);
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
            const nextType = btn.getAttribute('data-type') || 'bakery';
            if (typeof tcSwitchType === 'function') tcSwitchType(nextType);
            else {
              tcState.selectedType = nextType;
              tcRenderStatus();
            }
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

    lxsReady.then(() => tcLoad());

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

    prefetchExportLibs(); lxsReady.then(() => initPunchlist()).catch(err => console.warn('Punchlist init', err));
  

  

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
          await STORE.putPhoto({ id, blob: blob || file, caption: '', createdAt: Date.now() });
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
      // Root-cause guard: this is reachable from a *global*
      // document-level focusout listener that fires on any element
      // anywhere losing focus, with no check that #pl-modal is even
      // open — so it could re-enable this bar's inline
      // pointer-events/visibility/opacity/display (all set !important,
      // which beats the modal's own closed-state CSS) shortly after the
      // modal was legitimately closed. That left a fully interactive,
      // invisible "Save" button sitting on screen wherever the bar is
      // fixed-positioned to, silently re-saving whatever item was last
      // open on the next unrelated tap there (e.g. the "+" FAB).
      // Bailing out here when the modal isn't actually open removes the
      // path entirely rather than racing to clean up after it.
      const modal = document.getElementById('pl-modal');
      if (!modal || !modal.classList.contains('show')) return;
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
      // v152 (Phase 12A Fix 3): bars are only hidden to get them out from
      // under an on-screen keyboard. A device whose main pointer is a
      // mouse or trackpad (desktop PC, Mac) has no on-screen keyboard, so
      // there the bars always stay visible. Checked on every call, so it
      // follows a change (e.g. a 2-in-1 switching to tablet mode).
      // Browsers without matchMedia keep the v151 behavior.
      const hasFinePointer = () => {
        try { return !!(window.matchMedia && window.matchMedia('(pointer: fine)').matches); } catch (e) { return false; }
      };
      // v158 fix: #screenJobForm's and #screenStart's Save/Cancel bar
      // (SEL above) carries z-index 400 and, via apply() below, an
      // inline `display/visibility ... !important` that beats any
      // stylesheet rule — including #genericTextModal's own z-index 340.
      // Without this check, whenever focus left an input (e.g. tapping
      // "Set line" itself, or the sheet's Save/Cancel buttons), the
      // focusout handler re-showed this bar on top of the Set
      // line/Fill in serial/Add placeholder sheet, intercepting taps
      // meant for it. genericModalOpen() makes apply() keep the bar
      // hidden for as long as that sheet is open, regardless of pointer
      // type or keyboard state.
      const genericModalOpen = () => {
        const m = document.getElementById('genericTextModal');
        // v159: the shared type picker sheet (#typePickerModal) is opened
        // from the same screens (job form, screenStart) and needs the same
        // "keep this Save/Cancel bar hidden while I'm open" treatment.
        const t = document.getElementById('typePickerModal');
        return !!((m && m.classList.contains('show')) || (t && t.classList.contains('show')));
      };
      const apply = (hideRequested) => {
        const hide = (!!hideRequested && !hasFinePointer()) || genericModalOpen();
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
      // v158 fix: openGenericTextPrompt()/closeGenericTextModal() call
      // this directly so the Save/Cancel bar hides the instant the sheet
      // opens (rather than waiting on a focus/focusout event to reach
      // apply()) and is correctly restored the instant it closes.
      window.__syncKeyboardPinBars = syncKb;

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

    function systemPrefersLight() {
      try { return window.matchMedia('(prefers-color-scheme: light)').matches; } catch (e) { return false; }
    }
    function applyTheme(mode, persist) {
      if (mode !== 'light' && mode !== 'dark' && mode !== 'system') mode = 'system';
      if (persist !== false) {
        try { localStorage.setItem('lx8_theme', mode); } catch (e) {}
      }
      const light = mode === 'light' || (mode === 'system' && systemPrefersLight());
      document.documentElement.classList.toggle('theme-light', light);
      document.body.classList.toggle('theme-light', light);
      try { document.documentElement.style.colorScheme = light ? 'light' : 'dark'; } catch (e) {}
      const sysBtn = document.getElementById('themeSystem');
      const darkBtn = document.getElementById('themeDark');
      const lightBtn = document.getElementById('themeLight');
      if (sysBtn) sysBtn.classList.toggle('on', mode === 'system');
      if (darkBtn) darkBtn.classList.toggle('on', mode === 'dark');
      if (lightBtn) lightBtn.classList.toggle('on', mode === 'light');
      try {
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', light ? '#e8eaee' : '#000000');
        const cs = document.querySelector('meta[name="color-scheme"]');
        if (cs) cs.setAttribute('content', mode === 'system' ? 'light dark' : (light ? 'light' : 'dark'));
      } catch (e) {}
    }
    function bootTheme() {
      let mode = 'system';
      try { mode = localStorage.getItem('lx8_theme') || 'system'; } catch (e) {}
      if (mode !== 'light' && mode !== 'dark' && mode !== 'system') mode = 'system';
      applyTheme(mode, false);
      [['themeSystem','system'],['themeDark','dark'],['themeLight','light']].forEach(([id, val]) => {
        const btn = document.getElementById(id);
        if (!btn || btn.dataset.themeBound === '1') return;
        btn.dataset.themeBound = '1';
        btn.addEventListener('click', () => applyTheme(val, true));
      });
      try {
        const mq = window.matchMedia('(prefers-color-scheme: light)');
        const onChange = () => {
          let stored = 'system';
          try { stored = localStorage.getItem('lx8_theme') || 'system'; } catch (e) {}
          if (stored === 'system') applyTheme('system', false);
        };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
      } catch (e) {}
    }
    // ========== LOCAL DATA EDITOR (v160 / Phase 15C) ==========
    function isConfirmedTypeSource(src) {
      return src === 'inspection' || src === 'manager';
    }
    function jobProductionLineOf(job) {
      if (!job) return '';
      const direct = String(job.productionLine || '').trim();
      if (direct) return direct;
      try {
        const ids = Array.isArray(job.equipmentIds) ? job.equipmentIds : [];
        const machines = loadMachines() || [];
        for (let i = 0; i < ids.length; i++) {
          const m = machines.find(x => x && x.id === ids[i]);
          if (m && m.productionLine) return String(m.productionLine).trim();
        }
      } catch (e) {}
      return '';
    }
    function suggestProductionLineFromSiteName(name) {
      const s = String(name || '').trim();
      if (!s) return '';
      const m = s.match(/\bline\s*([0-9]+[a-z]?)\b/i);
      if (m) return 'Line ' + m[1];
      if (/\bline\b/i.test(s)) {
        const rest = s.replace(/^.*?\bline\b/i, 'Line').trim();
        const short = rest.split(/\s+/).slice(0, 2).join(' ');
        return short || '';
      }
      return '';
    }
    function siteNameContainsLine(name) {
      return /\bline\b/i.test(String(name || ''));
    }
    function fuzzySerialKey(serial) {
      return String(serial || '').toLowerCase().replace(/[\s\-]+/g, '').replace(/^0+/, '');
    }
    function oldPunchlistSlotText(line) {
      const s = String(line || '').trim();
      if (!s) return false;
      if (/^\d{1,2}$/.test(s)) return true;
      if (/^(lh|rh|epi|left|right)$/i.test(s)) return true;
      return false;
    }
    function editorStripPhotoFields(rec) {
      if (!rec || typeof rec !== 'object') return rec;
      const copy = JSON.parse(JSON.stringify(rec));
      ['photo', 'photos', 'photoId', 'photoDataUrl', 'photoThumb', 'images'].forEach((k) => {
        if (Object.prototype.hasOwnProperty.call(copy, k)) delete copy[k];
      });
      if (Array.isArray(copy.parts)) {
        copy.parts = copy.parts.map((p) => {
          if (!p || typeof p !== 'object') return p;
          const q = Object.assign({}, p);
          delete q.photoId; delete q.photoThumb; delete q.photo;
          return q;
        });
      }
      return copy;
    }
    function editorStableJson(v) {
      return JSON.stringify(v);
    }

    const EDITOR_PIN_KEY = 'lx8_editor_settings';
    const EDITOR_LOG_KEY = 'lx8_edit_log';
    let editorSessionBackupAsked = false;
    let editorView = { name: 'home' };
    let editorPendingApply = null;
    let editorPinMode = 'enter'; // enter | set | confirm | reset
    let editorPinFirst = '';
    let editorNeedsTypeOpen = false;

    function editorSettingsLoad() {
      try {
        const raw = localStorage.getItem(EDITOR_PIN_KEY);
        if (!raw) return { pin: '' };
        const p = JSON.parse(raw);
        return (p && typeof p === 'object') ? p : { pin: '' };
      } catch (e) { return { pin: '' }; }
    }
    function editorSettingsSave(next) {
      const cur = Object.assign({ pin: '' }, editorSettingsLoad(), next || {});
      try { localStorage.setItem(EDITOR_PIN_KEY, JSON.stringify(cur)); } catch (e) {}
      return cur;
    }
    function editorLogLoad() {
      try {
        const src = STORE.load('editLog');
        return Array.isArray(src) ? src : [];
      } catch (e) {
        try { return JSON.parse(localStorage.getItem(EDITOR_LOG_KEY) || '[]'); } catch (e2) { return []; }
      }
    }
    function editorLogSave(list) {
      const next = Array.isArray(list) ? list : [];
      try { return STORE.save('editLog', next); } catch (e) {
        try { localStorage.setItem(EDITOR_LOG_KEY, JSON.stringify(next)); } catch (e2) {}
        return false;
      }
    }
    function editorLogBytes(list) {
      try { return editorStableJson(list || editorLogLoad()).length; } catch (e) { return 0; }
    }

    function editorCustomerName(id) {
      if (!id) return '';
      const c = (loadCustomers() || []).find(x => x && x.id === id);
      return c ? (c.name || '') : '';
    }
    function editorSiteName(id) {
      if (!id) return '';
      const s = (loadSites() || []).find(x => x && x.id === id);
      return s ? (s.name || '') : '';
    }
    function editorWalkPunchlist(cb) {
      let pl = null;
      try { if (typeof window.getPunchlistBackup === 'function') pl = window.getPunchlistBackup(); } catch (e) {}
      if (!pl || !pl.jobs) return;
      Object.keys(pl.jobs).forEach((key) => {
        (pl.jobs[key] || []).forEach((item, idx) => cb(pl, key, item, idx));
      });
    }
    function editorPunchlistSave(pl) {
      if (typeof window.setPunchlistBackup === 'function') return window.setPunchlistBackup(pl);
      return Promise.resolve(false);
    }
    function editorCountUses(equipmentId, serial) {
      const out = { jobs: 0, inspections: 0, punchlistItems: 0, partsHeaders: 0, partsLines: 0, records: [] };
      const norm = normalizeMatchText(serial);
      (loadJobs() || []).forEach((j) => {
        if (!j) return;
        const hit = (j.equipmentIds || []).indexOf(equipmentId) >= 0 ||
          (Array.isArray(j.serials) && j.serials.some(s => normalizeMatchText(s) === norm));
        if (hit) { out.jobs += 1; out.records.push({ kind: 'job', id: j.id, title: jobDisplayName(j) }); }
      });
      (loadInspections() || []).forEach((i) => {
        if (!i) return;
        if (i.equipmentId === equipmentId || (norm && normalizeMatchText(i.serial) === norm)) {
          out.inspections += 1;
          out.records.push({ kind: 'inspection', id: i.id, title: (i.customer || 'Inspection') + ' · ' + (i.serial || '') });
        }
      });
      editorWalkPunchlist((_pl, key, item) => {
        if (!item) return;
        if (item.equipmentId === equipmentId || (norm && normalizeMatchText(item.serial) === norm)) {
          out.punchlistItems += 1;
          out.records.push({ kind: 'punchlist', listKey: key, id: item.id, title: (item.description || item.location || item.serial || 'Item') });
        }
      });
      (loadPartsRequests() || []).forEach((req) => {
        if (!req) return;
        if (req.equipmentId === equipmentId || (norm && normalizeMatchText(req.serial) === norm)) {
          out.partsHeaders += 1;
          out.records.push({ kind: 'parts', id: req.id, title: 'Parts request' + (req.seq ? ' #' + req.seq : '') });
        }
        (req.parts || []).forEach((line) => {
          if (!line) return;
          if (line.equipmentId === equipmentId || (norm && normalizeMatchText(line.serial) === norm)) {
            out.partsLines += 1;
            out.records.push({ kind: 'partsLine', id: line.id, parent: req.id, title: line.description || line.partNumber || 'Part' });
          }
        });
      });
      return out;
    }

    function editorSnapshotRecords(spec) {
      // spec: { machines:[id], jobs:[id], inspections:[id], sites:[id], customers:[id],
      //         partsRequests:[id], punchlistItems:[{listKey,id}] }
      const out = {
        machines: [], jobs: [], inspections: [], sites: [], customers: [],
        partsRequests: [], punchlistItems: []
      };
      const pick = (list, ids, key) => {
        (list || []).forEach((rec) => {
          if (rec && ids.indexOf(rec.id) >= 0) out[key].push(editorStripPhotoFields(rec));
        });
      };
      if (spec.machines) pick(loadMachines(), spec.machines, 'machines');
      if (spec.jobs) pick(loadJobs(), spec.jobs, 'jobs');
      if (spec.inspections) pick(loadInspections(), spec.inspections, 'inspections');
      if (spec.sites) pick(loadSites(), spec.sites, 'sites');
      if (spec.customers) pick(loadCustomers(), spec.customers, 'customers');
      if (spec.partsRequests) pick(loadPartsRequests(), spec.partsRequests, 'partsRequests');
      if (spec.punchlistItems && spec.punchlistItems.length) {
        const want = {};
        spec.punchlistItems.forEach((p) => {
          want[p.listKey + '\t' + p.id] = true;
        });
        editorWalkPunchlist((_pl, key, item) => {
          if (item && want[key + '\t' + item.id]) {
            out.punchlistItems.push({ listKey: key, id: item.id, rec: editorStripPhotoFields(item) });
          }
        });
      }
      return out;
    }

    const EDITOR_PHOTO_KEYS = ['photo', 'photos', 'photoId', 'photoDataUrl', 'photoThumb', 'images'];
    const EDITOR_LINE_PHOTO_KEYS = ['photo', 'photoId', 'photoThumb'];
    function editorReapplyLivePhotos(restored, live) {
      if (!restored || typeof restored !== 'object') return restored;
      if (!live || typeof live !== 'object') return restored;
      EDITOR_PHOTO_KEYS.forEach((k) => {
        if (Object.prototype.hasOwnProperty.call(live, k)) restored[k] = live[k];
        else delete restored[k];
      });
      if (Array.isArray(restored.parts) && Array.isArray(live.parts)) {
        const byId = {};
        live.parts.forEach((p) => { if (p && p.id) byId[p.id] = p; });
        restored.parts.forEach((p, i) => {
          if (!p || typeof p !== 'object') return;
          const liveP = (p.id && byId[p.id]) || live.parts[i];
          if (!liveP) return;
          EDITOR_LINE_PHOTO_KEYS.forEach((k) => {
            if (Object.prototype.hasOwnProperty.call(liveP, k)) p[k] = liveP[k];
            else delete p[k];
          });
        });
      }
      return restored;
    }
    function editorRestoreSnapshot(snap) {
      if (!snap) return;
      const writeById = (loadFn, saveFn, rows) => {
        if (!rows || !rows.length) return;
        const list = loadFn() || [];
        const map = {};
        rows.forEach((r) => { if (r && r.id) map[r.id] = r; });
        const next = list.map((cur) => {
          if (!cur || !map[cur.id]) return cur;
          const restored = JSON.parse(JSON.stringify(map[cur.id]));
          return editorReapplyLivePhotos(restored, cur);
        });
        const have = new Set(next.map(r => r && r.id));
        rows.forEach((r) => {
          if (r && r.id && !have.has(r.id)) next.push(JSON.parse(JSON.stringify(r)));
        });
        saveFn(next);
      };
      writeById(loadMachines, saveMachines, snap.machines);
      writeById(loadJobs, saveJobs, snap.jobs);
      writeById(loadInspections, saveInspections, snap.inspections);
      writeById(loadSites, saveSites, snap.sites);
      writeById(loadCustomers, saveCustomers, snap.customers);
      writeById(loadPartsRequests, savePartsRequests, snap.partsRequests);
      if (snap.punchlistItems && snap.punchlistItems.length && typeof window.getPunchlistBackup === 'function') {
        const pl = window.getPunchlistBackup();
        snap.punchlistItems.forEach((row) => {
          const arr = (pl.jobs && pl.jobs[row.listKey]) || [];
          const idx = arr.findIndex(it => it && it.id === row.id);
          if (idx < 0 || !row.rec) return;
          const restored = Object.assign({}, row.rec);
          editorReapplyLivePhotos(restored, arr[idx]);
          arr[idx] = restored;
        });
        return editorPunchlistSave(pl);
      }
      return Promise.resolve(true);
    }

    function editorCurrentMatchesAfter(after) {
      if (!after) return { ok: true, mismatches: [] };
      const mismatches = [];
      const checkList = (loadFn, rows, label) => {
        (rows || []).forEach((row) => {
          const cur = (loadFn() || []).find(x => x && x.id === row.id);
          if (!cur) { mismatches.push(label + ' ' + row.id + ' missing'); return; }
          if (editorStableJson(editorStripPhotoFields(cur)) !== editorStableJson(editorStripPhotoFields(row))) {
            mismatches.push(label + ' changed since this edit');
          }
        });
      };
      checkList(loadMachines, after.machines, 'Machine');
      checkList(loadJobs, after.jobs, 'Job');
      checkList(loadInspections, after.inspections, 'Inspection');
      checkList(loadSites, after.sites, 'Site');
      checkList(loadCustomers, after.customers, 'Customer');
      checkList(loadPartsRequests, after.partsRequests, 'Parts request');
      (after.punchlistItems || []).forEach((row) => {
        let found = null;
        editorWalkPunchlist((_pl, key, item) => {
          if (key === row.listKey && item && item.id === row.id) found = item;
        });
        if (!found) { mismatches.push('Punchlist item missing'); return; }
        if (editorStableJson(editorStripPhotoFields(found)) !== editorStableJson(editorStripPhotoFields(row.rec))) {
          mismatches.push('Punchlist item changed since this edit');
        }
      });
      return { ok: mismatches.length === 0, mismatches };
    }

    function editorRemoveIds(loadFn, saveFn, ids) {
      const drop = new Set(ids || []);
      saveFn((loadFn() || []).filter(r => r && !drop.has(r.id)));
    }

    function editorDedupeJobPointers(j) {
      if (!j) return;
      if (Array.isArray(j.equipmentIds)) {
        const seen = new Set();
        j.equipmentIds = j.equipmentIds.filter((id) => {
          if (!id || seen.has(id)) return false;
          seen.add(id);
          return true;
        });
      }
      if (Array.isArray(j.serials)) {
        const seen = new Set();
        j.serials = j.serials.filter((s) => {
          const k = normalizeMatchText(s);
          if (!k || seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
    }
    function editorRepointSerialAndId(oldId, newId, oldSerial, newSerial) {
      const oldNorm = normalizeMatchText(oldSerial);
      const swapText = (v) => (normalizeMatchText(v) === oldNorm ? newSerial : v);
      const jobs = loadJobs() || [];
      jobs.forEach((j) => {
        if (!j) return;
        if (Array.isArray(j.equipmentIds)) j.equipmentIds = j.equipmentIds.map(id => id === oldId ? newId : id);
        if (Array.isArray(j.serials)) j.serials = j.serials.map(swapText);
        editorDedupeJobPointers(j);
      });
      saveJobs(jobs);
      const inspections = loadInspections() || [];
      inspections.forEach((i) => {
        if (!i) return;
        if (i.equipmentId === oldId) i.equipmentId = newId;
        if (normalizeMatchText(i.serial) === oldNorm) i.serial = newSerial;
      });
      saveInspections(inspections);
      const reqs = loadPartsRequests() || [];
      reqs.forEach((req) => {
        if (!req) return;
        if (req.equipmentId === oldId) req.equipmentId = newId;
        if (normalizeMatchText(req.serial) === oldNorm) req.serial = newSerial;
        (req.parts || []).forEach((line) => {
          if (!line) return;
          if (line.equipmentId === oldId) line.equipmentId = newId;
          if (normalizeMatchText(line.serial) === oldNorm) line.serial = newSerial;
        });
      });
      savePartsRequests(reqs);
      if (typeof window.getPunchlistBackup === 'function') {
        const pl = window.getPunchlistBackup();
        Object.keys(pl.jobs || {}).forEach((key) => {
          (pl.jobs[key] || []).forEach((item) => {
            if (!item) return;
            if (item.equipmentId === oldId) item.equipmentId = newId;
            if (normalizeMatchText(item.serial) === oldNorm) item.serial = newSerial;
          });
        });
        return editorPunchlistSave(pl);
      }
      return Promise.resolve(true);
    }

    function editorSiteIdsTouched(siteId) {
      const jobs = [], inspections = [], parts = [], punch = [], machines = [];
      (loadJobs() || []).forEach(j => { if (j && j.siteId === siteId) jobs.push(j.id); });
      (loadInspections() || []).forEach(i => { if (i && i.siteId === siteId) inspections.push(i.id); });
      (loadPartsRequests() || []).forEach(r => {
        if (!r) return;
        if (r.siteId === siteId) parts.push(r.id);
        else if ((r.parts || []).some(p => p && p.siteId === siteId)) parts.push(r.id);
      });
      editorWalkPunchlist((_pl, key, item) => {
        if (item && item.siteId === siteId) punch.push({ listKey: key, id: item.id });
      });
      (loadMachines() || []).forEach(m => {
        if (!m) return;
        if (m.currentSiteId === siteId) machines.push(m.id);
        else if ((m.moveLog || []).some(e => e && (e.fromSiteId === siteId || e.toSiteId === siteId))) machines.push(m.id);
      });
      return { jobs, inspections, partsRequests: parts, punchlistItems: punch, machines };
    }

    function editorApplyPrepared(prepared) {
      // prepared.mutate() does the writes. prepared.spec lists records to snapshot.
      return prepared.mutate();
    }

    function editorIdIndex() {
      return {
        machines: (loadMachines() || []).map(x => x && x.id).filter(Boolean),
        sites: (loadSites() || []).map(x => x && x.id).filter(Boolean),
        customers: (loadCustomers() || []).map(x => x && x.id).filter(Boolean)
      };
    }
    function editorCreatedSince(beforeIdx) {
      const now = editorIdIndex();
      const diff = (kind) => now[kind].filter(id => (beforeIdx[kind] || []).indexOf(id) < 0);
      return { machines: diff('machines'), sites: diff('sites'), customers: diff('customers') };
    }
    function editorDeleteCreated(created) {
      if (!created) return;
      if (created.machines && created.machines.length) editorRemoveIds(loadMachines, saveMachines, created.machines);
      if (created.sites && created.sites.length) editorRemoveIds(loadSites, saveSites, created.sites);
      if (created.customers && created.customers.length) editorRemoveIds(loadCustomers, saveCustomers, created.customers);
    }
    function editorPointersToCreated(created) {
      const hits = [];
      if (!created) return hits;
      const siteSet = new Set(created.sites || []);
      const machSet = new Set(created.machines || []);
      const custSet = new Set(created.customers || []);
      if (!siteSet.size && !machSet.size && !custSet.size) return hits;
      (loadJobs() || []).forEach((j) => {
        if (!j) return;
        if (siteSet.has(j.siteId)) hits.push({ kind: 'job', id: j.id, why: 'job still points at the created site' });
        if (custSet.has(j.customerId)) hits.push({ kind: 'job', id: j.id, why: 'job still points at the created customer' });
        (j.equipmentIds || []).forEach((eid) => {
          if (machSet.has(eid)) hits.push({ kind: 'job', id: j.id, why: 'job still points at the created machine' });
        });
      });
      (loadInspections() || []).forEach((i) => {
        if (!i) return;
        if (siteSet.has(i.siteId)) hits.push({ kind: 'inspection', id: i.id, why: 'inspection still points at the created site' });
        if (custSet.has(i.customerId)) hits.push({ kind: 'inspection', id: i.id, why: 'inspection still points at the created customer' });
        if (machSet.has(i.equipmentId)) hits.push({ kind: 'inspection', id: i.id, why: 'inspection still points at the created machine' });
      });
      (loadPartsRequests() || []).forEach((r) => {
        if (!r) return;
        if (siteSet.has(r.siteId)) hits.push({ kind: 'parts', id: r.id, why: 'parts request still points at the created site' });
        if (custSet.has(r.customerId)) hits.push({ kind: 'parts', id: r.id, why: 'parts request still points at the created customer' });
        if (machSet.has(r.equipmentId)) hits.push({ kind: 'parts', id: r.id, why: 'parts request still points at the created machine' });
      });
      (loadSites() || []).forEach((s) => {
        if (s && custSet.has(s.customerId)) hits.push({ kind: 'site', id: s.id, why: 'site still points at the created customer' });
      });
      (loadMachines() || []).forEach((m) => {
        if (!m) return;
        if (siteSet.has(m.currentSiteId)) hits.push({ kind: 'machine', id: m.id, why: 'machine still points at the created site' });
        if (custSet.has(m.currentCustomerId)) hits.push({ kind: 'machine', id: m.id, why: 'machine still points at the created customer' });
      });
      editorWalkPunchlist((_pl, key, item) => {
        if (!item) return;
        if (siteSet.has(item.siteId)) hits.push({ kind: 'punchlist', id: item.id, why: 'punchlist item still points at the created site' });
        if (machSet.has(item.equipmentId)) hits.push({ kind: 'punchlist', id: item.id, why: 'punchlist item still points at the created machine' });
      });
      return hits;
    }
    function editorUnexpectedCreatedPointers(entry) {
      const after = entry && entry.after;
      const expected = {
        job: new Set((after && after.jobs || []).map(r => r && r.id)),
        inspection: new Set((after && after.inspections || []).map(r => r && r.id)),
        parts: new Set((after && after.partsRequests || []).map(r => r && r.id)),
        site: new Set((after && after.sites || []).map(r => r && r.id)),
        machine: new Set((after && after.machines || []).map(r => r && r.id)),
        punchlist: new Set((after && after.punchlistItems || []).map(r => r && r.id))
      };
      return editorPointersToCreated(entry && entry.created).filter((h) => {
        const set = expected[h.kind];
        return !set || !set.has(h.id);
      });
    }
    async function editorCommit(kind, summary, spec, mutateFn) {
      spec = spec || {};
      const idsBefore = editorIdIndex();
      const before = editorSnapshotRecords(spec);
      // v170: every record this change touches is stamped changeSource
      // 'editor' with this log entry's id.
      const entryId = newEntityId('ed');
      const lxsSrc = lxsIsV2Safe() ? LXS.pushSource('editor', entryId) : null;
      try {
      let threw = null;
      try {
        await mutateFn();
      } catch (e) {
        threw = e;
      }
      if (threw) {
        try { await editorRestoreSnapshot(before); } catch (e2) {}
        try { editorDeleteCreated(editorCreatedSince(idsBefore)); } catch (e3) {}
        toast('Change failed — nothing was kept');
        throw threw;
      }
      const created = editorCreatedSince(idsBefore);
      const specAfter = {
        machines: Array.from(new Set([].concat(spec.machines || [], created.machines || []))),
        jobs: (spec.jobs || []).slice(),
        inspections: (spec.inspections || []).slice(),
        sites: Array.from(new Set([].concat(spec.sites || [], created.sites || []))),
        customers: Array.from(new Set([].concat(spec.customers || [], created.customers || []))),
        partsRequests: (spec.partsRequests || []).slice(),
        punchlistItems: (spec.punchlistItems || []).slice()
      };
      const after = editorSnapshotRecords(specAfter);
      const entry = {
        id: entryId,
        at: new Date().toISOString(),
        kind,
        summary,
        before,
        after,
        created,
        affectedIds: specAfter,
        undone: false
      };
      let entryBytes = 0;
      try { entryBytes = editorStableJson(entry).length; } catch (e) {}
      if (entryBytes > 2 * 1024 * 1024) {
        toast('This change would store more than 2 MB in the edit log');
      }
      const log = editorLogLoad();
      log.unshift(entry);
      while (log.length > 50) log.pop();
      editorLogSave(log);
      return entry;
      } finally {
        if (lxsSrc) LXS.popSource(lxsSrc);
      }
    }

    function editorPreviewHtml(lines, warn) {
      let html = '';
      (lines || []).forEach((ln) => {
        html += '<div class="ed-preview-block">' + editorEsc(ln.text || ln);
        if (ln.count) html += '<div class="ed-preview-count">' + editorEsc(ln.count) + '</div>';
        html += '</div>';
      });
      if (warn) html += '<div class="ed-warn">' + editorEsc(warn) + '</div>';
      return html;
    }
    function editorEsc(s) {
      return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function editorOpenSheet(id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.hidden = false;
      el.classList.add('show');
      el.setAttribute('aria-hidden', 'false');
    }
    function editorCloseSheet(id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.hidden = true;
      el.classList.remove('show');
      el.setAttribute('aria-hidden', 'true');
    }
    function editorCloseAllSheets() {
      ['edPinSheet','edPreviewSheet','edFormSheet','edBackupAskSheet'].forEach(editorCloseSheet);
    }

    function editorAskBackupThen(fn) {
      if (editorSessionBackupAsked) { fn(); return; }
      editorOpenSheet('edBackupAskSheet');
      const now = document.getElementById('edBackupNow');
      const skip = document.getElementById('edBackupSkip');
      const finish = (doBackup) => {
        editorCloseSheet('edBackupAskSheet');
        editorSessionBackupAsked = true;
        if (doBackup && typeof exportBackupZip === 'function') {
          Promise.resolve(exportBackupZip()).then(() => fn()).catch(() => fn());
        } else fn();
      };
      if (now) now.onclick = () => finish(true);
      if (skip) skip.onclick = () => finish(false);
    }

    function editorConfirmPreview(title, html, onApply) {
      const t = document.getElementById('edPreviewTitle');
      const b = document.getElementById('edPreviewBody');
      if (t) t.textContent = title || 'Confirm change';
      if (b) b.innerHTML = html || '';
      editorPendingApply = onApply;
      editorOpenSheet('edPreviewSheet');
    }

    async function editorRunApply() {
      const fn = editorPendingApply;
      editorPendingApply = null;
      editorCloseSheet('edPreviewSheet');
      if (!fn) return;
      editorAskBackupThen(async () => {
        try {
          await fn();
          toast('Saved');
          editorRender();
        } catch (e) {
          console.warn(e);
          toast('Change failed — nothing was kept');
        }
      });
    }

    // ----- PIN -----
    function editorPinDigits() {
      return [0,1,2,3].map(i => (document.getElementById('edPin' + i) || {}).value || '').join('');
    }
    function editorClearPinInputs() {
      [0,1,2,3].forEach(i => { const el = document.getElementById('edPin' + i); if (el) el.value = ''; });
      const err = document.getElementById('edPinError');
      if (err) { err.hidden = true; err.textContent = ''; }
    }
    function editorShowPin(mode) {
      editorPinMode = mode;
      editorClearPinInputs();
      const title = document.getElementById('edPinTitle');
      const forgot = document.getElementById('edPinForgot');
      const note = document.getElementById('edPinNote');
      if (mode === 'set') {
        if (title) title.textContent = 'Set a 4-digit PIN';
        if (forgot) forgot.hidden = true;
      } else if (mode === 'confirm') {
        if (title) title.textContent = 'Confirm PIN';
        if (forgot) forgot.hidden = true;
      } else if (mode === 'reset') {
        if (title) title.textContent = 'Set a new PIN';
        if (forgot) forgot.hidden = true;
      } else {
        if (title) title.textContent = 'Enter PIN';
        if (forgot) forgot.hidden = false;
      }
      if (note) note.textContent = 'This PIN only stops accidental edits on this phone. It is not an account login.';
      editorOpenSheet('edPinSheet');
      setTimeout(() => { try { document.getElementById('edPin0').focus(); } catch (e) {} }, 50);
    }
    function editorBindPinInputs() {
      [0,1,2,3].forEach((i) => {
        const el = document.getElementById('edPin' + i);
        if (!el || el.dataset.bound === '1') return;
        el.dataset.bound = '1';
        el.addEventListener('input', () => {
          const v = String(el.value || '').replace(/\D/g, '').slice(0, 1);
          el.value = v;
          if (v && i < 3) {
            const next = document.getElementById('edPin' + (i + 1));
            if (next) next.focus();
          }
        });
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Backspace' && !el.value && i > 0) {
            const prev = document.getElementById('edPin' + (i - 1));
            if (prev) prev.focus();
          }
        });
      });
    }
    function editorHandlePinOk() {
      const digits = editorPinDigits();
      const err = document.getElementById('edPinError');
      const showErr = (m) => { if (err) { err.hidden = false; err.textContent = m; } };
      if (!/^\d{4}$/.test(digits)) { showErr('Enter 4 digits'); return; }
      const settings = editorSettingsLoad();
      if (editorPinMode === 'set' || editorPinMode === 'reset') {
        editorPinFirst = digits;
        editorShowPin('confirm');
        return;
      }
      if (editorPinMode === 'confirm') {
        if (digits !== editorPinFirst) { showErr('PINs did not match'); return; }
        editorSettingsSave({ pin: digits });
        editorCloseSheet('edPinSheet');
        editorEnter();
        return;
      }
      if (settings.pin !== digits) { showErr('Wrong PIN'); return; }
      editorCloseSheet('edPinSheet');
      editorEnter();
    }
    function editorOpenFromSettings() {
      const settings = editorSettingsLoad();
      if (!settings.pin) editorShowPin('set');
      else editorShowPin('enter');
    }
    function editorResetPin() {
      editorCloseSheet('edPinSheet');
      editorAskBackupThen(() => editorShowPin('reset'));
    }

    function editorEnter() {
      editorView = { name: 'home' };
      showScreen('screenEditor');
      setHeader('Editor');
      document.body.classList.add('on-editor');
      editorRender();
    }
    function editorLeave() {
      editorCloseAllSheets();
      document.body.classList.remove('on-editor');
      showScreen('screenSettings');
      setHeader('Settings');
    }

    // ----- Needs Attention -----
    function editorNeedsAttention() {
      const groups = {
        jobType: [],
        noType: [],
        noSo: [],
        dupes: [],
        lineSites: [],
        orphans: [],
        missingEquip: [],
        typeConflict: [],
        firstSeen: [],
        oldLine: []
      };
      const machines = loadMachines() || [];
      const sites = loadSites() || [];
      const inspections = loadInspections() || [];
      const machineById = {};
      machines.forEach(m => { if (m && m.id) machineById[m.id] = m; });
      machines.forEach((m) => {
        if (!m) return;
        if (!m.machineType) groups.noType.push(m);
        else if (m.machineTypeSource === 'job') groups.jobType.push(m);
        if (!m.salesOrder) groups.noSo.push(m);
        if ((m.moveLog || []).some(e => e && !e.type && !e.fromSiteId)) groups.firstSeen.push(m);
      });
      const byFuzzy = {};
      machines.forEach((m) => {
        const k = fuzzySerialKey(m && m.serialNumber);
        if (!k) return;
        if (!byFuzzy[k]) byFuzzy[k] = [];
        byFuzzy[k].push(m);
      });
      Object.keys(byFuzzy).forEach((k) => {
        if (byFuzzy[k].length > 1) groups.dupes.push(byFuzzy[k]);
      });
      sites.forEach((s) => {
        if (s && siteNameContainsLine(s.name)) groups.lineSites.push(s);
      });
      const markOrphan = (rec, label, extra) => {
        if (!rec) return;
        if (rec.equipmentId && !machineById[rec.equipmentId]) groups.orphans.push(Object.assign({ label, rec }, extra || {}));
        if (rec.serial && String(rec.serial).trim() && String(rec.serial).toUpperCase() !== 'TBD' && !rec.equipmentId) {
          groups.missingEquip.push(Object.assign({ label, rec }, extra || {}));
        }
      };
      (loadJobs() || []).forEach(() => {});
      inspections.forEach((i) => {
        markOrphan(i, 'Inspection');
        if (i && i.equipmentId && i.model && machineById[i.equipmentId]) {
          const m = machineById[i.equipmentId];
          if (isConfirmedTypeSource(m.machineTypeSource) && m.machineType &&
              normalizeTypeKey(m.machineType) !== normalizeTypeKey(i.model)) {
            groups.typeConflict.push({ inspection: i, machine: m });
          }
        }
      });
      (loadPartsRequests() || []).forEach((req) => {
        markOrphan(req, 'Parts request');
        (req.parts || []).forEach((line) => markOrphan(line, 'Parts line', { parent: req.id }));
      });
      const oldByList = {};
      editorWalkPunchlist((_pl, key, item) => {
        markOrphan(item, 'Punchlist item', { listKey: key });
        if (item && oldPunchlistSlotText(item.line) && !String(item.serial || '').trim()) {
          if (!oldByList[key]) oldByList[key] = [];
          oldByList[key].push(item);
        }
      });
      Object.keys(oldByList).forEach((key) => groups.oldLine.push({ listKey: key, items: oldByList[key] }));
      const total =
        groups.jobType.length + groups.noType.length + groups.noSo.length + groups.dupes.length + groups.lineSites.length +
        groups.orphans.length + groups.missingEquip.length + groups.typeConflict.length +
        groups.firstSeen.length + groups.oldLine.length;
      return { groups, total };
    }

    // ----- Render -----
    function editorRender() {
      const body = document.getElementById('edBody');
      const title = document.getElementById('edTitle');
      const kicker = document.getElementById('edKicker');
      if (!body) return;
      const view = editorView.name;
      if (title) {
        title.textContent = view === 'home' ? 'Local Data Editor'
          : view === 'machines' ? 'Machines'
          : view === 'machine' ? 'Machine'
          : view === 'sites' ? 'Sites'
          : view === 'site' ? 'Site'
          : view === 'customers' ? 'Customers'
          : view === 'customer' ? 'Customer'
          : view === 'needs' ? 'Needs Attention'
          : view === 'log' ? 'Edit log'
          : 'Editor';
      }
      if (kicker) kicker.textContent = 'Manager';
      if (view === 'home') body.innerHTML = editorHomeHtml();
      else if (view === 'machines') body.innerHTML = editorMachinesHtml();
      else if (view === 'machine') body.innerHTML = editorMachineHtml();
      else if (view === 'sites') body.innerHTML = editorSitesHtml();
      else if (view === 'site') body.innerHTML = editorSiteHtml();
      else if (view === 'customers') body.innerHTML = editorCustomersHtml();
      else if (view === 'customer') body.innerHTML = editorCustomerHtml();
      else if (view === 'needs') body.innerHTML = editorNeedsHtml();
      else if (view === 'log') body.innerHTML = editorLogHtml();
      else body.innerHTML = '';
      editorBindView();
    }
    function editorHomeHtml() {
      const att = editorNeedsAttention();
      const nM = (loadMachines() || []).length;
      const nS = (loadSites() || []).length;
      const nC = (loadCustomers() || []).length;
      return `
        <div class="ed-card" data-ed-go="needs">
          <div class="ed-card-kicker">Review</div>
          <div class="ed-card-title">Needs Attention${att.total ? '<span class="ed-badge">' + att.total + '</span>' : ''}</div>
          <div class="ed-card-sub">${att.total ? att.total + ' item' + (att.total === 1 ? '' : 's') + ' to look at' : 'Nothing flagged'}</div>
        </div>
        <div class="ed-card" data-ed-go="machines">
          <div class="ed-card-kicker">Identity</div>
          <div class="ed-card-title">Machines</div>
          <div class="ed-card-sub">${nM} serial${nM === 1 ? '' : 's'}</div>
        </div>
        <div class="ed-card" data-ed-go="sites">
          <div class="ed-card-title">Sites</div>
          <div class="ed-card-sub">${nS} site${nS === 1 ? '' : 's'}</div>
        </div>
        <div class="ed-card" data-ed-go="customers">
          <div class="ed-card-title">Customers</div>
          <div class="ed-card-sub">${nC} customer${nC === 1 ? '' : 's'}</div>
        </div>
        <div class="ed-card" data-ed-go="log">
          <div class="ed-card-kicker">History</div>
          <div class="ed-card-title">Edit log / Undo</div>
          <div class="ed-card-sub">${editorLogLoad().length} change${editorLogLoad().length === 1 ? '' : 's'} on this phone</div>
        </div>
        <div class="ed-actions">
          <button type="button" class="btn btn-outline" id="edCloseBtn">Close</button>
        </div>`;
    }
    function editorMachinesHtml() {
      const q = String(editorView.q || '').trim().toLowerCase();
      const machines = (loadMachines() || []).slice().sort((a, b) => String(a.serialNumber || '').localeCompare(String(b.serialNumber || '')));
      const rows = machines.filter((m) => {
        if (!q) return true;
        const hay = [m.serialNumber, m.machineType, m.lineLabel, m.productionLine, m.salesOrder,
          editorSiteName(m.currentSiteId), editorCustomerName(m.currentCustomerId)].join(' ').toLowerCase();
        return hay.indexOf(q) >= 0;
      });
      let html = '<div class="ed-search"><input id="edSearch" placeholder="Search machines" value="' + editorEsc(editorView.q || '') + '" /></div>';
      if (!rows.length) html += '<div class="ed-empty">No machines</div>';
      rows.forEach((m) => {
        const line = [m.lineLabel, m.serialNumber, m.machineType].filter(Boolean).join(' · ');
        const sub = [editorCustomerName(m.currentCustomerId), editorSiteName(m.currentSiteId), m.salesOrder].filter(Boolean).join(' · ');
        html += '<div class="ed-row" data-ed-machine="' + editorEsc(m.id) + '"><div class="ed-row-title">' + editorEsc(line || m.id) + '</div><div class="ed-row-sub">' + editorEsc(sub || 'No site yet') + '</div></div>';
      });
      html += '<div class="ed-actions"><button type="button" class="btn-link" id="edMergeMachinesBtn">Merge two machines</button></div>';
      return html;
    }
    function editorMachineHtml() {
      const m = (loadMachines() || []).find(x => x && x.id === editorView.id);
      if (!m) return '<div class="ed-empty">Machine not found</div>';
      const uses = editorCountUses(m.id, m.serialNumber);
      const field = (key, label, value, action) =>
        '<div class="ed-field" data-ed-mfield="' + action + '"><div class="ed-field-label">' + editorEsc(label) + '</div><div class="ed-field-value' + (value ? '' : ' muted') + '">' + editorEsc(value || 'Not set') + '</div></div>';
      let html = '';
      html += field('serial', 'Serial', m.serialNumber, 'serial');
      html += field('type', 'Type', (m.machineType || '') + (m.machineTypeSource ? ' · ' + m.machineTypeSource : ''), 'type');
      html += field('so', 'Sales order', m.salesOrder, 'so');
      html += field('prod', 'Production line', m.productionLine, 'prod');
      html += field('line', 'Machine line label', m.lineLabel, 'line');
      html += field('site', 'Current site', [editorCustomerName(m.currentCustomerId), editorSiteName(m.currentSiteId)].filter(Boolean).join(' · '), 'site');
      html += '<div class="ed-group-label">Used by</div>';
      html += '<div class="ed-field static"><div class="ed-field-value">' +
        uses.jobs + ' jobs · ' + uses.inspections + ' inspections · ' + uses.punchlistItems + ' punchlist items · ' +
        uses.partsLines + ' parts lines</div></div>';
      if (uses.records.length) {
        uses.records.slice(0, 30).forEach((r) => {
          html += '<div class="ed-row static"><div class="ed-row-title">' + editorEsc(r.title || r.kind) + '</div><div class="ed-row-sub">' + editorEsc(r.kind) + '</div></div>';
        });
      }
      html += '<div class="ed-group-label">Move log</div>';
      const log = Array.isArray(m.moveLog) ? m.moveLog : [];
      if (!log.length) html += '<div class="ed-empty">No moves yet</div>';
      log.forEach((e) => {
        const first = e && (e.type === 'placed' || !e.fromSiteId);
        const when = e && e.at ? String(e.at).slice(0, 10) : '';
        const text = first
          ? ('First seen at ' + (editorSiteName(e.toSiteId) || e.toSiteId || 'site'))
          : ((editorSiteName(e.fromSiteId) || '—') + ' → ' + (editorSiteName(e.toSiteId) || '—'));
        html += '<div class="ed-row static"><div class="ed-row-title">' + editorEsc(text) + '</div><div class="ed-row-sub">' + editorEsc(when) + '</div></div>';
      });
      if (log.some(e => e && !e.type && !e.fromSiteId)) {
        html += '<div class="ed-actions"><button type="button" class="btn btn-outline" id="edTidyMoves">Tidy first-seen entries</button></div>';
      }
      html += '<div class="ed-actions"><button type="button" class="btn-link" id="edMergeThis">Merge this machine into another</button></div>';
      return html;
    }
    function editorSitesHtml() {
      const q = String(editorView.q || '').trim().toLowerCase();
      const customers = loadCustomers() || [];
      const sites = loadSites() || [];
      let html = '<div class="ed-search"><input id="edSearch" placeholder="Search sites" value="' + editorEsc(editorView.q || '') + '" /></div>';
      customers.forEach((c) => {
        const mine = sites.filter(s => s && s.customerId === c.id).filter((s) => {
          if (!q) return true;
          return ((s.name || '') + ' ' + (c.name || '')).toLowerCase().indexOf(q) >= 0;
        });
        if (!mine.length && q) return;
        html += '<div class="ed-group-label">' + editorEsc(c.name || 'Customer') + '</div>';
        if (!mine.length) html += '<div class="ed-empty">No sites</div>';
        mine.forEach((s) => {
          html += '<div class="ed-row" data-ed-site="' + editorEsc(s.id) + '"><div class="ed-row-title">' + editorEsc(s.name || 'Untitled site') + '</div></div>';
        });
      });
      return html;
    }
    function editorSiteHtml() {
      const s = (loadSites() || []).find(x => x && x.id === editorView.id);
      if (!s) return '<div class="ed-empty">Site not found</div>';
      const cname = editorCustomerName(s.customerId);
      const nMach = (loadMachines() || []).filter(m => m && m.currentSiteId === s.id).length;
      const nJobs = (loadJobs() || []).filter(j => j && j.siteId === s.id).length;
      return `
        <div class="ed-field static"><div class="ed-field-label">Customer</div><div class="ed-field-value">${editorEsc(cname)}</div></div>
        <div class="ed-field static"><div class="ed-field-label">Site</div><div class="ed-field-value">${editorEsc(s.name)}</div></div>
        <div class="ed-field static"><div class="ed-field-sub"></div><div class="ed-card-sub" style="margin-top:6px;">${nJobs} job${nJobs===1?'':'s'} · ${nMach} machine${nMach===1?'':'s'}</div></div>
        <div class="ed-actions">
          <button type="button" class="btn btn-primary" id="edRenameSite">Rename site</button>
          <button type="button" class="btn btn-outline" id="edMergeSite">Merge this site into…</button>
        </div>`;
    }
    function editorCustomersHtml() {
      const q = String(editorView.q || '').trim().toLowerCase();
      const customers = (loadCustomers() || []).filter(c => !q || String(c.name || '').toLowerCase().indexOf(q) >= 0);
      let html = '<div class="ed-search"><input id="edSearch" placeholder="Search customers" value="' + editorEsc(editorView.q || '') + '" /></div>';
      if (!customers.length) html += '<div class="ed-empty">No customers</div>';
      customers.forEach((c) => {
        const n = (loadSites() || []).filter(s => s && s.customerId === c.id).length;
        html += '<div class="ed-row" data-ed-customer="' + editorEsc(c.id) + '"><div class="ed-row-title">' + editorEsc(c.name || 'Untitled') + '</div><div class="ed-row-sub">' + n + ' site' + (n===1?'':'s') + '</div></div>';
      });
      return html;
    }
    function editorCustomerHtml() {
      const c = (loadCustomers() || []).find(x => x && x.id === editorView.id);
      if (!c) return '<div class="ed-empty">Customer not found</div>';
      return `
        <div class="ed-field static"><div class="ed-field-value">${editorEsc(c.name)}</div></div>
        <div class="ed-actions">
          <button type="button" class="btn btn-primary" id="edRenameCustomer">Rename customer</button>
          <button type="button" class="btn btn-outline" id="edMergeCustomer">Merge this customer into…</button>
        </div>`;
    }
    function editorNeedsHtml() {
      const { groups } = editorNeedsAttention();
      let html = '';
      const block = (title, count, inner) => {
        if (!count) return;
        html += '<div class="ed-collapsed-head" data-ed-toggle="' + editorEsc(title) + '"><div class="ed-row-title">' + editorEsc(title) + '</div><span class="ed-badge">' + count + '</span></div>';
        html += '<div class="ed-needs-group' + (title === 'Type only from a job' && !editorNeedsTypeOpen ? ' hidden' : '') + '" data-ed-group="' + editorEsc(title) + '">' + inner + '</div>';
      };
      let inner = '';
      groups.jobType.forEach((m) => {
        inner += '<div class="ed-row"><div class="ed-row-title">' + editorEsc(m.serialNumber) + ' · ' + editorEsc(m.machineType) + '</div>' +
          '<div class="ed-row-sub"><button type="button" class="btn-link ed-confirm-type" data-id="' + editorEsc(m.id) + '">Confirm type</button> · <button type="button" class="btn-link" data-ed-machine="' + editorEsc(m.id) + '">Open</button></div></div>';
      });
      block('Type only from a job', groups.jobType.length, inner || '');
      inner = '';
      groups.noType.forEach((m) => {
        inner += '<div class="ed-row"><div class="ed-row-title">' + editorEsc(m.serialNumber || m.id) + '</div>' +
          '<div class="ed-row-sub"><button type="button" class="btn-link ed-set-type" data-id="' + editorEsc(m.id) + '">Set type</button></div></div>';
      });
      block('No type yet', groups.noType.length, inner);
      inner = '';
      groups.noSo.forEach((m) => {
        inner += '<div class="ed-row" data-ed-machine="' + editorEsc(m.id) + '"><div class="ed-row-title">' + editorEsc(m.serialNumber) + '</div><div class="ed-row-sub">No sales order</div></div>';
      });
      block('No sales order', groups.noSo.length, inner);
      inner = '';
      groups.dupes.forEach((arr) => {
        inner += '<div class="ed-row ed-dupe" data-ids="' + editorEsc(arr.map(m => m.id).join(',')) + '"><div class="ed-row-title">' + editorEsc(arr.map(m => m.serialNumber).join(' / ')) + '</div><div class="ed-row-sub">Likely the same machine</div></div>';
      });
      block('Likely duplicate machines', groups.dupes.length, inner);
      inner = '';
      groups.lineSites.forEach((s) => {
        inner += '<div class="ed-row" data-ed-site="' + editorEsc(s.id) + '"><div class="ed-row-title">' + editorEsc(s.name) + '</div><div class="ed-row-sub">' + editorEsc(editorCustomerName(s.customerId)) + '</div></div>';
      });
      block('Site name contains “line”', groups.lineSites.length, inner);
      inner = '';
      groups.orphans.forEach((o, i) => {
        inner += '<div class="ed-row ed-orphan" data-i="' + i + '"><div class="ed-row-title">' + editorEsc(o.label) + '</div><div class="ed-row-sub">Points at a machine that is not here</div></div>';
      });
      editorView._orphans = groups.orphans;
      block('Orphan equipment id', groups.orphans.length, inner);
      inner = '';
      groups.missingEquip.forEach((o) => {
        inner += '<div class="ed-row ed-attach" data-serial="' + editorEsc(o.rec.serial || '') + '" data-kind="' + editorEsc(o.label) + '" data-id="' + editorEsc(o.rec.id || '') + '" data-list="' + editorEsc(o.listKey || '') + '"><div class="ed-row-title">' + editorEsc(o.label) + ' · ' + editorEsc(o.rec.serial || '') + '</div><div class="ed-row-sub">Has a serial, no machine id</div></div>';
      });
      block('Serial but no equipment id', groups.missingEquip.length, inner);
      inner = '';
      groups.typeConflict.forEach((o) => {
        inner += '<div class="ed-row" data-ed-machine="' + editorEsc(o.machine.id) + '"><div class="ed-row-title">' + editorEsc(o.machine.serialNumber) + '</div><div class="ed-row-sub">Machine ' + editorEsc(o.machine.machineType) + ' · inspection ' + editorEsc(o.inspection.model) + '</div></div>';
      });
      block('Inspection vs machine type', groups.typeConflict.length, inner);
      inner = '';
      groups.firstSeen.forEach((m) => {
        inner += '<div class="ed-row"><div class="ed-row-title">' + editorEsc(m.serialNumber) + '</div><div class="ed-row-sub"><button type="button" class="btn-link ed-tidy-one" data-id="' + editorEsc(m.id) + '">Tidy</button></div></div>';
      });
      block('First-seen log entries', groups.firstSeen.length, inner);
      inner = '';
      groups.oldLine.forEach((g) => {
        inner += '<div class="ed-row ed-oldline" data-key="' + editorEsc(g.listKey) + '"><div class="ed-row-title">' + editorEsc(punchlistKeyLabel(g.listKey)) + '</div><div class="ed-row-sub">' + g.items.length + ' item' + (g.items.length===1?'':'s') + ' with old line text</div></div>';
      });
      block('Old punchlist line text', groups.oldLine.length, inner);
      if (!html) html = '<div class="ed-empty">Nothing flagged</div>';
      return html;
    }
    function editorLogHtml() {
      const log = editorLogLoad();
      const bytes = editorLogBytes(log);
      let html = '<div class="ed-log-size">Log size ' + (Math.round(bytes / 102.4) / 10) + ' KB</div>';
      if (!log.length) html += '<div class="ed-empty">No editor changes yet</div>';
      const firstUndoable = log.findIndex(e => e && !e.undone);
      log.forEach((e, i) => {
        const when = e.at ? String(e.at).replace('T', ' ').slice(0, 16) : '';
        const can = i === firstUndoable;
        html += '<div class="ed-row"><div class="ed-row-title">' + editorEsc(e.summary || e.kind) + '</div>' +
          '<div class="ed-row-sub">' + editorEsc(when) + (e.undone ? ' · undone' : '') +
          (can && e.preUpgradeNoUndo ? ' · Can\'t undo — made before the storage upgrade' : '') +
          (can && !e.preUpgradeNoUndo ? ' · <button type="button" class="btn-link ed-undo" data-id="' + editorEsc(e.id) + '">Undo this</button>' : '') +
          '</div></div>';
      });
      return html;
    }

    function editorBindView() {
      const body = document.getElementById('edBody');
      if (!body) return;
      body.querySelectorAll('[data-ed-go]').forEach((el) => {
        el.addEventListener('click', () => { editorView = { name: el.getAttribute('data-ed-go') }; editorRender(); });
      });
      const closeBtn = document.getElementById('edCloseBtn');
      if (closeBtn) closeBtn.onclick = editorLeave;
      const search = document.getElementById('edSearch');
      if (search) {
        search.addEventListener('input', () => {
          editorView.q = search.value;
          const pos = search.selectionStart;
          editorRender();
          const again = document.getElementById('edSearch');
          if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) {} }
        });
      }
      body.querySelectorAll('[data-ed-machine]').forEach((el) => {
        el.addEventListener('click', (e) => {
          if (e.target && e.target.closest && e.target.closest('.btn-link')) return;
          editorView = { name: 'machine', id: el.getAttribute('data-ed-machine') };
          editorRender();
        });
      });
      body.querySelectorAll('[data-ed-site]').forEach((el) => {
        el.addEventListener('click', () => { editorView = { name: 'site', id: el.getAttribute('data-ed-site') }; editorRender(); });
      });
      body.querySelectorAll('[data-ed-customer]').forEach((el) => {
        el.addEventListener('click', () => { editorView = { name: 'customer', id: el.getAttribute('data-ed-customer') }; editorRender(); });
      });
      body.querySelectorAll('[data-ed-mfield]').forEach((el) => {
        el.addEventListener('click', () => editorStartMachineField(el.getAttribute('data-ed-mfield')));
      });
      const tidy = document.getElementById('edTidyMoves');
      if (tidy) tidy.onclick = () => editorTidyMoves(editorView.id);
      const mergeThis = document.getElementById('edMergeThis');
      if (mergeThis) mergeThis.onclick = () => editorStartMachineMerge(editorView.id, null);
      const mergeTwo = document.getElementById('edMergeMachinesBtn');
      if (mergeTwo) mergeTwo.onclick = () => editorStartMachineMerge(null, null);
      const renameSite = document.getElementById('edRenameSite');
      if (renameSite) renameSite.onclick = () => editorStartSiteRename(editorView.id);
      const mergeSite = document.getElementById('edMergeSite');
      if (mergeSite) mergeSite.onclick = () => editorStartSiteMerge(editorView.id);
      const renameCust = document.getElementById('edRenameCustomer');
      if (renameCust) renameCust.onclick = () => editorStartCustomerRename(editorView.id);
      const mergeCust = document.getElementById('edMergeCustomer');
      if (mergeCust) mergeCust.onclick = () => editorStartCustomerMerge(editorView.id);
      body.querySelectorAll('.ed-confirm-type').forEach((btn) => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); editorConfirmJobType(btn.getAttribute('data-id')); });
      });
      body.querySelectorAll('.ed-set-type').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const m = (loadMachines() || []).find(x => x && x.id === btn.getAttribute('data-id'));
          if (!m) return;
          if (typeof openTypePicker === 'function') {
            openTypePicker({
              title: 'Machine type',
              current: m.machineType || '',
              restrictToChecklist: false,
              onSelect: (t) => editorApplyMachineType(m.id, t)
            });
          }
        });
      });
      body.querySelectorAll('.ed-tidy-one').forEach((btn) => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); editorTidyMoves(btn.getAttribute('data-id')); });
      });
      body.querySelectorAll('.ed-dupe').forEach((el) => {
        el.addEventListener('click', () => {
          const ids = String(el.getAttribute('data-ids') || '').split(',');
          editorStartMachineMerge(ids[0], ids[1]);
        });
      });
      body.querySelectorAll('.ed-oldline').forEach((el) => {
        el.addEventListener('click', () => editorMoveOldLineText(el.getAttribute('data-key')));
      });
      body.querySelectorAll('.ed-attach').forEach((el) => {
        el.addEventListener('click', () => editorAttachSerial(el.getAttribute('data-serial')));
      });
      body.querySelectorAll('[data-ed-toggle]').forEach((el) => {
        el.addEventListener('click', () => {
          const name = el.getAttribute('data-ed-toggle');
          if (name === 'Type only from a job') editorNeedsTypeOpen = !editorNeedsTypeOpen;
          const grp = body.querySelector('[data-ed-group="' + name + '"]');
          if (grp) grp.classList.toggle('hidden');
        });
      });
      body.querySelectorAll('.ed-undo').forEach((btn) => {
        btn.addEventListener('click', () => editorUndo(btn.getAttribute('data-id')));
      });
    }

    function editorOpenForm(title, fieldsHtml, onSave) {
      const t = document.getElementById('edFormTitle');
      const b = document.getElementById('edFormBody');
      if (t) t.textContent = title;
      if (b) b.innerHTML = fieldsHtml;
      editorOpenSheet('edFormSheet');
      const save = document.getElementById('edFormSave');
      if (save) save.onclick = () => { const keep = onSave(); if (keep !== false) editorCloseSheet('edFormSheet'); };
    }

    function editorStartMachineField(field) {
      const m = (loadMachines() || []).find(x => x && x.id === editorView.id);
      if (!m) return;
      if (field === 'type') {
        if (typeof openTypePicker === 'function') {
          openTypePicker({
            title: 'Machine type',
            current: m.machineType || '',
            restrictToChecklist: false,
            onSelect: (t) => editorApplyMachineType(m.id, t)
          });
        }
        return;
      }
      if (field === 'serial') {
        editorOpenForm('Correct serial',
          '<div class="form-group"><label>New serial</label><input type="text" id="edFieldInput" value="' + editorEsc(m.serialNumber || '') + '" /></div>',
          () => { editorApplySerialCorrection(m.id, (document.getElementById('edFieldInput') || {}).value); });
        return;
      }
      if (field === 'so' || field === 'prod' || field === 'line') {
        const label = field === 'so' ? 'Sales order' : field === 'prod' ? 'Production line' : 'Machine line label';
        const cur = field === 'so' ? m.salesOrder : field === 'prod' ? m.productionLine : m.lineLabel;
        editorOpenForm(label,
          '<div class="form-group"><label>' + label + '</label><input type="text" id="edFieldInput" value="' + editorEsc(cur || '') + '" /></div>',
          () => { editorApplyMachineText(m.id, field, (document.getElementById('edFieldInput') || {}).value); });
        return;
      }
      if (field === 'site') editorStartMachineSite(m.id);
    }

    function editorApplyMachineType(machineId, type) {
      const m = (loadMachines() || []).find(x => x && x.id === machineId);
      if (!m) return;
      const next = String(type || '').trim();
      editorConfirmPreview('Set type', editorPreviewHtml([
        { text: (m.serialNumber || '') + ': ' + (m.machineType || 'none') + ' → ' + next, count: 'Source becomes manager. Job form will lock this type.' }
      ]), async () => {
        await editorCommit('machine-type', 'Set type on ' + (m.serialNumber || '') + ' to ' + next, { machines: [machineId] }, () => {
          applyMachineUpdate(machineId, { machineType: next, machineTypeSource: 'manager' }, { source: 'manager' });
          // force manager even if applyMachineUpdate treated it as conflict
          const all = loadMachines();
          const rec = all.find(x => x && x.id === machineId);
          if (rec) {
            rec.machineType = next;
            rec.machineTypeSource = 'manager';
            rec.updatedAt = new Date().toISOString();
            saveMachines(all);
          }
        });
      });
    }
    function editorConfirmJobType(machineId) {
      const m = (loadMachines() || []).find(x => x && x.id === machineId);
      if (!m || !m.machineType) return;
      editorApplyMachineType(machineId, m.machineType);
    }
    function editorApplyMachineText(machineId, field, value) {
      const m = (loadMachines() || []).find(x => x && x.id === machineId);
      if (!m) return;
      const next = String(value || '').trim();
      const label = field === 'so' ? 'sales order' : field === 'prod' ? 'production line' : 'line label';
      editorConfirmPreview('Set ' + label, editorPreviewHtml([{ text: (m.serialNumber || '') + ': ' + label + ' → ' + (next || '(empty)') }]), async () => {
        await editorCommit('machine-text', 'Set ' + label + ' on ' + (m.serialNumber || ''), { machines: [machineId] }, () => {
          const all = loadMachines();
          const rec = all.find(x => x && x.id === machineId);
          if (!rec) return;
          if (field === 'so') rec.salesOrder = next;
          if (field === 'prod') rec.productionLine = next;
          if (field === 'line') rec.lineLabel = next;
          rec.updatedAt = new Date().toISOString();
          saveMachines(all);
        });
      });
    }
    function editorStartMachineSite(machineId) {
      const customers = loadCustomers() || [];
      const sites = loadSites() || [];
      let html = '<div class="form-group"><label>Customer</label><select id="edSiteCust">';
      html += '<option value="">Select</option>';
      customers.forEach(c => { html += '<option value="' + editorEsc(c.id) + '">' + editorEsc(c.name) + '</option>'; });
      html += '</select></div><div class="form-group"><label>Site</label><select id="edSiteSite"></select></div>';
      editorOpenForm('Move machine', html, () => {
        const cid = (document.getElementById('edSiteCust') || {}).value;
        const sid = (document.getElementById('edSiteSite') || {}).value;
        if (!sid) { toast('Pick a site'); return false; }
        editorApplyMachineMove(machineId, cid, sid);
      });
      const cust = document.getElementById('edSiteCust');
      const fill = () => {
        const sel = document.getElementById('edSiteSite');
        if (!sel) return;
        const cid = cust.value;
        sel.innerHTML = sites.filter(s => s.customerId === cid).map(s => '<option value="' + editorEsc(s.id) + '">' + editorEsc(s.name) + '</option>').join('');
      };
      if (cust) cust.addEventListener('change', fill);
    }
    function editorApplyMachineMove(machineId, customerId, siteId) {
      const m = (loadMachines() || []).find(x => x && x.id === machineId);
      if (!m) return;
      editorConfirmPreview('Move machine', editorPreviewHtml([
        { text: (m.serialNumber || '') + ' moves to ' + editorSiteName(siteId), count: 'Line label and production line will be cleared.' }
      ]), async () => {
        await editorCommit('machine-move', 'Moved ' + (m.serialNumber || '') + ' to ' + editorSiteName(siteId), { machines: [machineId] }, () => {
          applyMachineUpdate(machineId, { siteId: siteId, customerId: customerId }, { source: 'manager', asOf: new Date().toISOString() });
        });
      });
    }

    function editorApplySerialCorrection(machineId, newSerialRaw) {
      const m = (loadMachines() || []).find(x => x && x.id === machineId);
      if (!m) return;
      const newSerial = String(newSerialRaw || '').trim();
      if (!newSerial) { toast('Serial required'); return; }
      if (normalizeMatchText(newSerial) === normalizeMatchText(m.serialNumber)) return;
      const existing = findMachineBySerial(newSerial);
      if (existing && existing.id !== m.id) {
        editorStartMachineMerge(existing.id, m.id);
        return;
      }
      const uses = editorCountUses(m.id, m.serialNumber);
      const spec = {
        machines: [machineId],
        jobs: uses.records.filter(r => r.kind === 'job').map(r => r.id),
        inspections: uses.records.filter(r => r.kind === 'inspection').map(r => r.id),
        partsRequests: uses.records.filter(r => r.kind === 'parts' || r.kind === 'partsLine').map(r => r.parent || r.id),
        punchlistItems: uses.records.filter(r => r.kind === 'punchlist').map(r => ({ listKey: r.listKey, id: r.id }))
      };
      editorConfirmPreview('Correct serial', editorPreviewHtml([
        { text: (m.serialNumber || '') + ' → ' + newSerial,
          count: uses.jobs + ' jobs, ' + uses.inspections + ' inspections, ' + uses.punchlistItems + ' punchlist items, ' + uses.partsLines + ' parts lines' }
      ]), async () => {
        const newId = machineIdForSerial(newSerial);
        spec.machines = [machineId, newId];
        await editorCommit('serial-correct', 'Corrected serial ' + m.serialNumber + ' → ' + newSerial, spec, async () => {
          const all = loadMachines();
          const rec = all.find(x => x && x.id === machineId);
          const copy = Object.assign({}, rec, {
            id: newId,
            serialNumber: newSerial,
            serialNumberNormalized: normalizeMatchText(newSerial),
            updatedAt: new Date().toISOString()
          });
          all.push(copy);
          saveMachines(all.filter(x => x && x.id !== machineId));
          await editorRepointSerialAndId(machineId, newId, m.serialNumber, newSerial);
        });
        editorView = { name: 'machine', id: newId };
      });
    }

    function editorStartMachineMerge(keepId, dropId) {
      const machines = loadMachines() || [];
      if (!keepId || !dropId) {
        let html = '<div class="form-group"><label>Keep</label><select id="edKeep">';
        machines.forEach(m => { html += '<option value="' + editorEsc(m.id) + '"' + (m.id === keepId ? ' selected' : '') + '>' + editorEsc(m.serialNumber) + '</option>'; });
        html += '</select></div><div class="form-group"><label>Merge away</label><select id="edDrop">';
        machines.forEach(m => { html += '<option value="' + editorEsc(m.id) + '"' + (m.id === dropId ? ' selected' : '') + '>' + editorEsc(m.serialNumber) + '</option>'; });
        html += '</select></div>';
        editorOpenForm('Merge machines', html, () => {
          const a = (document.getElementById('edKeep') || {}).value;
          const b = (document.getElementById('edDrop') || {}).value;
          if (!a || !b || a === b) { toast('Pick two different machines'); return false; }
          editorPreviewMachineMerge(a, b);
        });
        return;
      }
      editorPreviewMachineMerge(keepId, dropId);
    }
    function editorPreviewMachineMerge(keepId, dropId) {
      const keep = (loadMachines() || []).find(x => x && x.id === keepId);
      const drop = (loadMachines() || []).find(x => x && x.id === dropId);
      if (!keep || !drop) return;
      const keepConfirmed = isConfirmedTypeSource(keep.machineTypeSource) && keep.machineType;
      const dropConfirmed = isConfirmedTypeSource(drop.machineTypeSource) && drop.machineType;
      const typeClash = keepConfirmed && dropConfirmed && normalizeTypeKey(keep.machineType) !== normalizeTypeKey(drop.machineType);
      const uses = editorCountUses(drop.id, drop.serialNumber);
      let extra = '';
      if (typeClash) {
        extra = '<div class="form-group"><label>Type to keep</label><select id="edMergeType">' +
          '<option value="' + editorEsc(keep.machineType) + '">' + editorEsc(keep.machineType + ' (kept machine)') + '</option>' +
          '<option value="' + editorEsc(drop.machineType) + '">' + editorEsc(drop.machineType + ' (other machine)') + '</option>' +
          '</select></div>';
        const b = document.getElementById('edPreviewBody');
        editorConfirmPreview('Merge machines', editorPreviewHtml([
          { text: 'Keep ' + keep.serialNumber + ', drop ' + drop.serialNumber,
            count: uses.jobs + ' jobs, ' + uses.inspections + ' inspections, ' + uses.punchlistItems + ' punchlist items' }
        ], 'Both have a confirmed type. Choose which type to keep.') + extra, async () => {
          const chosen = (document.getElementById('edMergeType') || {}).value || keep.machineType;
          await editorDoMachineMerge(keep, drop, chosen);
        });
        return;
      }
      editorConfirmPreview('Merge machines', editorPreviewHtml([
        { text: 'Keep ' + keep.serialNumber + ', drop ' + drop.serialNumber,
          count: uses.jobs + ' jobs, ' + uses.inspections + ' inspections, ' + uses.punchlistItems + ' punchlist items, ' + uses.partsLines + ' parts lines' }
      ]), async () => editorDoMachineMerge(keep, drop, keep.machineType || drop.machineType));
    }
    async function editorDoMachineMerge(keep, drop, chosenType) {
      const uses = editorCountUses(drop.id, drop.serialNumber);
      const spec = {
        machines: [keep.id, drop.id],
        jobs: uses.records.filter(r => r.kind === 'job').map(r => r.id),
        inspections: uses.records.filter(r => r.kind === 'inspection').map(r => r.id),
        partsRequests: uses.records.filter(r => r.kind === 'parts' || r.kind === 'partsLine').map(r => r.parent || r.id),
        punchlistItems: uses.records.filter(r => r.kind === 'punchlist').map(r => ({ listKey: r.listKey, id: r.id }))
      };
      await editorCommit('machine-merge', 'Merged ' + drop.serialNumber + ' into ' + keep.serialNumber, spec, async () => {
        const all = loadMachines();
        const rec = all.find(x => x && x.id === keep.id);
        const other = all.find(x => x && x.id === drop.id);
        ['salesOrder','lineLabel','productionLine','currentSiteId','currentCustomerId','machineType'].forEach((k) => {
          if (rec && other && !rec[k] && other[k]) rec[k] = other[k];
        });
        if (chosenType) {
          rec.machineType = chosenType;
          if (!isConfirmedTypeSource(rec.machineTypeSource)) rec.machineTypeSource = other.machineTypeSource || rec.machineTypeSource || 'manager';
        }
        rec.moveLog = (Array.isArray(rec.moveLog) ? rec.moveLog : []).concat(Array.isArray(other.moveLog) ? other.moveLog : [])
          .slice().sort((a, b) => String(a && a.at || '').localeCompare(String(b && b.at || '')));
        rec.updatedAt = new Date().toISOString();
        saveMachines(all.filter(x => x && x.id !== drop.id));
        await editorRepointSerialAndId(drop.id, keep.id, drop.serialNumber, keep.serialNumber);
      });
      editorView = { name: 'machine', id: keep.id };
    }

    function editorStartSiteRename(siteId) {
      const s = (loadSites() || []).find(x => x && x.id === siteId);
      if (!s) return;
      const suggest = suggestProductionLineFromSiteName(s.name);
      editorOpenForm('Rename site',
        '<div class="form-group"><label>New name</label><input type="text" id="edFieldInput" value="' + editorEsc(s.name) + '" /></div>' +
        '<div class="form-group"><label>Set production line on machines and jobs at this site</label>' +
        '<input type="text" id="edProdInput" value="' + editorEsc(suggest) + '" placeholder="e.g. Line 9" /></div>',
        () => {
          const name = String((document.getElementById('edFieldInput') || {}).value || '').trim();
          const prod = String((document.getElementById('edProdInput') || {}).value || '').trim();
          if (!name) { toast('Name required'); return false; }
          editorApplySiteRename(siteId, name, prod);
        });
    }
    function editorApplySiteRename(siteId, newName, prodLine) {
      const s = (loadSites() || []).find(x => x && x.id === siteId);
      if (!s) return;
      const touched = editorSiteIdsTouched(siteId);
      const jobsAt = (loadJobs() || []).filter(j => j && j.siteId === siteId);
      const warn = (!prodLine && siteNameContainsLine(s.name))
        ? ('“' + s.name + '” will no longer appear on ' + jobsAt.length + ' job' + (jobsAt.length === 1 ? '' : 's') + '.')
        : '';
      editorConfirmPreview('Rename site', editorPreviewHtml([
        { text: (s.name || '') + ' → ' + newName,
          count: jobsAt.length + ' jobs, ' + touched.machines.length + ' machines' + (prodLine ? (', production line “' + prodLine + '”') : '') }
      ], warn), async () => {
        await editorCommit('site-rename', 'Renamed site ' + s.name + ' → ' + newName, Object.assign({ sites: [siteId] }, touched), () => {
          const sites = loadSites();
          const rec = sites.find(x => x && x.id === siteId);
          if (rec) {
            rec.name = newName;
            rec.nameNormalized = normalizeMatchText(newName);
            rec.updatedAt = new Date().toISOString();
            saveSites(sites);
          }
          const jobs = loadJobs();
          jobs.forEach((j) => {
            if (!j || j.siteId !== siteId) return;
            j.site = newName;
            if (prodLine && !j.productionLine) j.productionLine = prodLine;
          });
          saveJobs(jobs);
          const reqs = loadPartsRequests();
          reqs.forEach((r) => { if (r && r.siteId === siteId) r.site = newName; });
          savePartsRequests(reqs);
          if (prodLine) {
            const machines = loadMachines();
            machines.forEach((m) => {
              if (m && m.currentSiteId === siteId && !m.productionLine) m.productionLine = prodLine;
            });
            saveMachines(machines);
          }
        });
        editorView = { name: 'site', id: siteId };
      });
    }

    function editorStartSiteMerge(fromId) {
      const from = (loadSites() || []).find(x => x && x.id === fromId);
      if (!from) return;
      const others = (loadSites() || []).filter(s => s && s.customerId === from.customerId && s.id !== fromId);
      const suggest = suggestProductionLineFromSiteName(from.name);
      let html = '<div class="form-group"><label>Merge into</label><select id="edTarget">';
      html += '<option value="__new__">+ New site name…</option>';
      others.forEach(s => { html += '<option value="' + editorEsc(s.id) + '">' + editorEsc(s.name) + '</option>'; });
      html += '</select></div>';
      html += '<div class="form-group" id="edNewSiteWrap"><label>New site name</label><input type="text" id="edNewSiteName" placeholder="e.g. Bolingbrook" /></div>';
      html += '<div class="form-group"><label>Set production line on the machines at “' + editorEsc(from.name) + '”</label>' +
        '<input type="text" id="edProdInput" value="' + editorEsc(suggest) + '" /></div>';
      editorOpenForm('Merge site', html, () => {
        const target = (document.getElementById('edTarget') || {}).value;
        const newName = String((document.getElementById('edNewSiteName') || {}).value || '').trim();
        const prod = String((document.getElementById('edProdInput') || {}).value || '').trim();
        if (target === '__new__') {
          if (!newName) { toast('Enter a new site name'); return false; }
          editorApplySiteMerge(fromId, null, newName, prod);
        } else {
          editorApplySiteMerge(fromId, target, '', prod);
        }
      });
      const sel = document.getElementById('edTarget');
      const wrap = document.getElementById('edNewSiteWrap');
      const sync = () => { if (wrap) wrap.style.display = (sel && sel.value === '__new__') ? '' : 'none'; };
      if (sel) sel.addEventListener('change', sync);
      sync();
    }
    function editorApplySiteMerge(fromId, toId, newName, prodLine) {
      const from = (loadSites() || []).find(x => x && x.id === fromId);
      if (!from) return;
      const jobsAt = (loadJobs() || []).filter(j => j && j.siteId === fromId);
      const warn = (!prodLine && siteNameContainsLine(from.name))
        ? ('“' + from.name + '” will no longer appear on ' + jobsAt.length + ' job' + (jobsAt.length === 1 ? '' : 's') + '.')
        : '';
      const touched = editorSiteIdsTouched(fromId);
      editorConfirmPreview('Merge site', editorPreviewHtml([
        { text: 'Merge “' + from.name + '” into “' + (newName || editorSiteName(toId)) + '”',
          count: jobsAt.length + ' jobs, ' + touched.machines.length + ' machines' + (prodLine ? (', production line “' + prodLine + '”') : '') }
      ], warn), async () => {
        let destId = toId;
        const destNameGuess = newName || editorSiteName(toId);
        touched.sites = [fromId].concat(toId ? [toId] : []);
        await editorCommit('site-merge', 'Merged site ' + from.name + ' into ' + destNameGuess, touched, async () => {
          if (!destId) {
            const created = findOrCreateSite(from.customerId, newName);
            destId = created && created.id;
          }
          if (!destId) throw new Error('no-dest-site');
          const dest = (loadSites() || []).find(x => x && x.id === destId);
          const destName = dest ? dest.name : newName;
          const remap = (rec) => {
            if (!rec) return;
            if (rec.siteId === fromId) rec.siteId = destId;
          };
          const jobs = loadJobs();
          jobs.forEach((j) => {
            if (!j) return;
            if (j.siteId === fromId) {
              j.siteId = destId;
              j.site = destName;
              if (prodLine && !j.productionLine) j.productionLine = prodLine;
            }
          });
          saveJobs(jobs);
          const inspections = loadInspections();
          inspections.forEach(remap);
          saveInspections(inspections);
          const reqs = loadPartsRequests();
          reqs.forEach((r) => {
            if (!r) return;
            if (r.siteId === fromId) { r.siteId = destId; r.site = destName; }
            (r.parts || []).forEach((p) => { if (p && p.siteId === fromId) p.siteId = destId; });
          });
          savePartsRequests(reqs);
          if (typeof window.getPunchlistBackup === 'function') {
            const pl = window.getPunchlistBackup();
            Object.keys(pl.jobs || {}).forEach((key) => {
              (pl.jobs[key] || []).forEach((item) => { if (item && item.siteId === fromId) item.siteId = destId; });
            });
            await editorPunchlistSave(pl);
          }
          const machines = loadMachines();
          machines.forEach((m) => {
            if (!m) return;
            if (m.currentSiteId === fromId) {
              m.currentSiteId = destId;
              if (prodLine && !m.productionLine) m.productionLine = prodLine;
            }
            (m.moveLog || []).forEach((e) => {
              if (!e) return;
              if (e.fromSiteId === fromId) e.fromSiteId = destId;
              if (e.toSiteId === fromId) e.toSiteId = destId;
            });
          });
          saveMachines(machines);
          saveSites((loadSites() || []).filter(s => s && s.id !== fromId));
          editorView = { name: 'site', id: destId };
        });
      });
    }

    function editorStartCustomerRename(id) {
      const c = (loadCustomers() || []).find(x => x && x.id === id);
      if (!c) return;
      editorOpenForm('Rename customer',
        '<div class="form-group"><label>Name</label><input type="text" id="edFieldInput" value="' + editorEsc(c.name) + '" /></div>',
        () => {
          const name = String((document.getElementById('edFieldInput') || {}).value || '').trim();
          if (!name) { toast('Name required'); return false; }
          editorApplyCustomerRename(id, name);
        });
    }
    function editorApplyCustomerRename(id, newName) {
      const c = (loadCustomers() || []).find(x => x && x.id === id);
      if (!c) return;
      const jobIds = (loadJobs() || []).filter(j => j && j.customerId === id).map(j => j.id);
      const partIds = (loadPartsRequests() || []).filter(r => r && r.customerId === id).map(r => r.id);
      editorConfirmPreview('Rename customer', editorPreviewHtml([{ text: c.name + ' → ' + newName, count: jobIds.length + ' jobs' }]), async () => {
        await editorCommit('customer-rename', 'Renamed customer ' + c.name + ' → ' + newName, { customers: [id], jobs: jobIds, partsRequests: partIds }, () => {
          const list = loadCustomers();
          const rec = list.find(x => x && x.id === id);
          if (rec) { rec.name = newName; rec.nameNormalized = normalizeMatchText(newName); rec.updatedAt = new Date().toISOString(); saveCustomers(list); }
          const jobs = loadJobs();
          jobs.forEach(j => { if (j && j.customerId === id) j.customer = newName; });
          saveJobs(jobs);
          const reqs = loadPartsRequests();
          reqs.forEach(r => { if (r && r.customerId === id) r.customer = newName; });
          savePartsRequests(reqs);
        });
      });
    }
    function editorStartCustomerMerge(fromId) {
      const from = (loadCustomers() || []).find(x => x && x.id === fromId);
      if (!from) return;
      const others = (loadCustomers() || []).filter(c => c && c.id !== fromId);
      let html = '<div class="form-group"><label>Merge into</label><select id="edTarget">';
      others.forEach(c => { html += '<option value="' + editorEsc(c.id) + '">' + editorEsc(c.name) + '</option>'; });
      html += '</select></div>';
      editorOpenForm('Merge customer', html, () => {
        const toId = (document.getElementById('edTarget') || {}).value;
        if (!toId) return false;
        editorApplyCustomerMerge(fromId, toId);
      });
    }
    function editorApplyCustomerMerge(fromId, toId) {
      const from = (loadCustomers() || []).find(x => x && x.id === fromId);
      const to = (loadCustomers() || []).find(x => x && x.id === toId);
      if (!from || !to) return;
      const jobIds = (loadJobs() || []).filter(j => j && j.customerId === fromId).map(j => j.id);
      const siteIds = (loadSites() || []).filter(s => s && s.customerId === fromId).map(s => s.id);
      const destNames = new Set((loadSites() || []).filter(s => s && s.customerId === toId).map(s => s.nameNormalized));
      const collisions = (loadSites() || []).filter(s => s && s.customerId === fromId && destNames.has(s.nameNormalized));
      editorConfirmPreview('Merge customer', editorPreviewHtml([
        { text: 'Merge ' + from.name + ' into ' + to.name, count: siteIds.length + ' sites, ' + jobIds.length + ' jobs' }
      ], collisions.length ? (collisions.length + ' site name' + (collisions.length===1?'':'s') + ' will also exist under ' + to.name + ' — merge those by hand.') : ''), async () => {
        const inspIds = (loadInspections() || []).filter(i => i && i.customerId === fromId).map(i => i.id);
        const partIds = (loadPartsRequests() || []).filter(r => r && r.customerId === fromId).map(r => r.id);
        const punch = [];
        editorWalkPunchlist((_pl, key, item) => { if (item && item.customerId === fromId) punch.push({ listKey: key, id: item.id }); });
        const machIds = (loadMachines() || []).filter(m => m && m.currentCustomerId === fromId).map(m => m.id);
        await editorCommit('customer-merge', 'Merged customer ' + from.name + ' into ' + to.name, {
          customers: [fromId, toId], sites: siteIds, jobs: jobIds, inspections: inspIds,
          partsRequests: partIds, punchlistItems: punch, machines: machIds
        }, async () => {
          const jobs = loadJobs();
          jobs.forEach(j => { if (j && j.customerId === fromId) { j.customerId = toId; j.customer = to.name; } });
          saveJobs(jobs);
          const inspections = loadInspections();
          inspections.forEach(i => { if (i && i.customerId === fromId) i.customerId = toId; });
          saveInspections(inspections);
          const reqs = loadPartsRequests();
          reqs.forEach(r => { if (r && r.customerId === fromId) { r.customerId = toId; r.customer = to.name; } });
          savePartsRequests(reqs);
          if (typeof window.getPunchlistBackup === 'function') {
            const pl = window.getPunchlistBackup();
            Object.keys(pl.jobs || {}).forEach((key) => {
              (pl.jobs[key] || []).forEach((item) => { if (item && item.customerId === fromId) item.customerId = toId; });
            });
            await editorPunchlistSave(pl);
          }
          const sites = loadSites();
          sites.forEach(s => { if (s && s.customerId === fromId) s.customerId = toId; });
          saveSites(sites);
          const machines = loadMachines();
          machines.forEach(m => { if (m && m.currentCustomerId === fromId) m.currentCustomerId = toId; });
          saveMachines(machines);
          saveCustomers((loadCustomers() || []).filter(c => c && c.id !== fromId));
        });
        editorView = { name: 'customer', id: toId };
      });
    }

    function editorTidyMoves(machineId) {
      const m = (loadMachines() || []).find(x => x && x.id === machineId);
      if (!m) return;
      editorConfirmPreview('Tidy move log', editorPreviewHtml([{ text: 'Rewrite first-seen entries on ' + (m.serialNumber || '') + ' as placements. History is kept.' }]), async () => {
        await editorCommit('move-tidy', 'Tidied first-seen log on ' + (m.serialNumber || ''), { machines: [machineId] }, () => {
          const all = loadMachines();
          const rec = all.find(x => x && x.id === machineId);
          if (!rec) return;
          rec.moveLog = (rec.moveLog || []).map((e) => {
            if (!e || e.type === 'placed' || e.fromSiteId) return e;
            return Object.assign({}, e, { type: 'placed' });
          });
          rec.updatedAt = new Date().toISOString();
          saveMachines(all);
        });
      });
    }

    function editorMoveOldLineText(listKey) {
      const items = [];
      editorWalkPunchlist((_pl, key, item) => {
        if (key === listKey && item && oldPunchlistSlotText(item.line) && !String(item.serial || '').trim()) items.push(item);
      });
      if (!items.length) return;
      const preview = items.slice(0, 12).map(it => (it.description || it.location || 'Item') + ': “' + it.line + '” → comments').join('\n');
      editorConfirmPreview('Move old line text', editorPreviewHtml([
        { text: punchlistKeyLabel(listKey), count: items.length + ' item' + (items.length===1?'':'s') + '. Line text is copied into comments, then the line field is cleared.' }
      ]) + '<pre style="white-space:pre-wrap;font-size:12px;color:var(--muted);">' + editorEsc(preview) + '</pre>', async () => {
        await editorCommit('pl-old-line', 'Moved old line text into comments on ' + punchlistKeyLabel(listKey), {
          punchlistItems: items.map(it => ({ listKey, id: it.id }))
        }, async () => {
          const pl = window.getPunchlistBackup();
          (pl.jobs[listKey] || []).forEach((item) => {
            if (!item || !oldPunchlistSlotText(item.line) || String(item.serial || '').trim()) return;
            const bit = String(item.line).trim();
            item.comments = item.comments ? (String(item.comments) + '\n' + bit) : bit;
            item.line = '';
          });
          await editorPunchlistSave(pl);
        });
      });
    }

    function editorAttachSerial(serial) {
      const m = findMachineBySerial(serial);
      if (!m) { toast('No machine for that serial'); return; }
      editorConfirmPreview('Attach machine id', editorPreviewHtml([{ text: 'Point records with serial ' + serial + ' at ' + m.id }]), async () => {
        const punch = [];
        editorWalkPunchlist((_pl, key, item) => {
          if (item && normalizeMatchText(item.serial) === normalizeMatchText(serial) && !item.equipmentId) punch.push({ listKey: key, id: item.id });
        });
        const insp = (loadInspections() || []).filter(i => i && normalizeMatchText(i.serial) === normalizeMatchText(serial) && !i.equipmentId);
        const reqs = (loadPartsRequests() || []).filter(r => r && (normalizeMatchText(r.serial) === normalizeMatchText(serial) && !r.equipmentId || (r.parts || []).some(p => p && normalizeMatchText(p.serial) === normalizeMatchText(serial) && !p.equipmentId)));
        await editorCommit('attach-id', 'Attached equipment id for ' + serial, {
          inspections: insp.map(i => i.id),
          partsRequests: reqs.map(r => r.id),
          punchlistItems: punch
        }, async () => {
          const inspections = loadInspections();
          inspections.forEach(i => {
            if (i && normalizeMatchText(i.serial) === normalizeMatchText(serial) && !i.equipmentId) i.equipmentId = m.id;
          });
          saveInspections(inspections);
          const parts = loadPartsRequests();
          parts.forEach(r => {
            if (!r) return;
            if (normalizeMatchText(r.serial) === normalizeMatchText(serial) && !r.equipmentId) r.equipmentId = m.id;
            (r.parts || []).forEach(p => {
              if (p && normalizeMatchText(p.serial) === normalizeMatchText(serial) && !p.equipmentId) p.equipmentId = m.id;
            });
          });
          savePartsRequests(parts);
          if (typeof window.getPunchlistBackup === 'function') {
            const pl = window.getPunchlistBackup();
            Object.keys(pl.jobs || {}).forEach((key) => {
              (pl.jobs[key] || []).forEach((item) => {
                if (item && normalizeMatchText(item.serial) === normalizeMatchText(serial) && !item.equipmentId) item.equipmentId = m.id;
              });
            });
            await editorPunchlistSave(pl);
          }
        });
      });
    }

    async function editorUndo(id) {
      const log = editorLogLoad();
      const entry = log.find(e => e && e.id === id);
      if (!entry || entry.undone) return;
      if (entry.preUpgradeNoUndo) { toast('Can\'t undo — made before the storage upgrade'); return; }
      const newestOpen = log.find(e => e && !e.undone);
      if (!newestOpen || newestOpen.id !== id) { toast('Undo the newest change first'); return; }
      const chk = editorCurrentMatchesAfter(entry.after);
      if (!chk.ok) {
        editorConfirmPreview('Undo blocked', editorPreviewHtml([
          { text: 'A record changed after this edit. Undo would wipe that later work.' }
        ].concat(chk.mismatches.slice(0, 8).map(m => ({ text: m })))), null);
        const apply = document.getElementById('edPreviewApply');
        if (apply) apply.style.display = 'none';
        return;
      }
      const unexpected = editorUnexpectedCreatedPointers(entry);
      if (unexpected.length) {
        editorConfirmPreview('Undo blocked', editorPreviewHtml([
          { text: 'Cannot remove what this change created — something else still points at it.' }
        ].concat(unexpected.slice(0, 8).map(h => ({ text: h.why })))), null);
        const apply = document.getElementById('edPreviewApply');
        if (apply) apply.style.display = 'none';
        return;
      }
      const applyBtn = document.getElementById('edPreviewApply');
      if (applyBtn) applyBtn.style.display = '';
      editorConfirmPreview('Undo', editorPreviewHtml([{ text: entry.summary || entry.kind }]), async () => {
        const lxsSrc = lxsIsV2Safe() ? LXS.pushSource('undo', entry.id) : null;
        try {
        await editorRestoreSnapshot(entry.before);
        editorDeleteCreated(entry.created);
        const leftover = editorPointersToCreated(entry.created).filter((h) => {
          // After restore, created records must not still be pointed at.
          return true;
        });
        if (leftover.length) {
          // Put the change back rather than leave dangling pointers.
          try { await editorRestoreSnapshot(entry.after); } catch (e) {}
          toast('Undo refused — ' + leftover[0].why);
          return;
        }
        const latest = editorLogLoad();
        const row = latest.find(e => e && e.id === id);
        if (row) row.undone = true;
        editorLogSave(latest);
        toast('Undone');
        } finally {
          if (lxsSrc) LXS.popSource(lxsSrc);
        }
      });
    }

    function editorBindChrome() {
      editorBindPinInputs();
      const pinOk = document.getElementById('edPinOk');
      const pinCancel = document.getElementById('edPinCancel');
      const pinForgot = document.getElementById('edPinForgot');
      if (pinOk && pinOk.dataset.bound !== '1') { pinOk.dataset.bound = '1'; pinOk.onclick = editorHandlePinOk; }
      if (pinCancel && pinCancel.dataset.bound !== '1') { pinCancel.dataset.bound = '1'; pinCancel.onclick = () => editorCloseSheet('edPinSheet'); }
      if (pinForgot && pinForgot.dataset.bound !== '1') { pinForgot.dataset.bound = '1'; pinForgot.onclick = editorResetPin; }
      const prevApply = document.getElementById('edPreviewApply');
      const prevCancel = document.getElementById('edPreviewCancel');
      if (prevApply && prevApply.dataset.bound !== '1') { prevApply.dataset.bound = '1'; prevApply.onclick = editorRunApply; }
      if (prevCancel && prevCancel.dataset.bound !== '1') {
        prevCancel.dataset.bound = '1';
        prevCancel.onclick = () => { editorPendingApply = null; editorCloseSheet('edPreviewSheet'); const a = document.getElementById('edPreviewApply'); if (a) a.style.display = ''; };
      }
      const formCancel = document.getElementById('edFormCancel');
      if (formCancel && formCancel.dataset.bound !== '1') { formCancel.dataset.bound = '1'; formCancel.onclick = () => editorCloseSheet('edFormSheet'); }
      const openBtn = document.getElementById('btnOpenEditor');
      if (openBtn && openBtn.dataset.bound !== '1') { openBtn.dataset.bound = '1'; openBtn.onclick = editorOpenFromSettings; }
    }

    function editorOnHeaderBack() {
      const open = ['edPinSheet','edPreviewSheet','edFormSheet','edBackupAskSheet'].some((id) => {
        const el = document.getElementById(id);
        return el && el.classList.contains('show');
      });
      if (open) { editorCloseAllSheets(); return true; }
      if (editorView && editorView.name !== 'home') {
        editorView = { name: 'home' };
        editorRender();
        return true;
      }
      editorLeave();
      return true;
    }

    window.editorOpenFromSettings = editorOpenFromSettings;
    window.editorLeave = editorLeave;
    window.editorCloseAllSheets = editorCloseAllSheets;
    window.editorOnHeaderBack = editorOnHeaderBack;
    window.editorBindChrome = editorBindChrome;
    window.__editorNeedsAttention = editorNeedsAttention;
    window.__editorLogLoad = editorLogLoad;
    window.__editorApplySiteRename = editorApplySiteRename;
    window.__editorApplySiteMerge = editorApplySiteMerge;
    window.__editorApplyMachineType = editorApplyMachineType;
    window.__editorDoMachineMerge = editorDoMachineMerge;
    window.__editorUndo = editorUndo;
    window.__editorCurrentMatchesAfter = editorCurrentMatchesAfter;
    window.__editorCommit = editorCommit;
    window.__editorStripPhotoFields = editorStripPhotoFields;
    window.__jobProductionLineOf = jobProductionLineOf;
    window.__editorSkipBackup = function () { editorSessionBackupAsked = true; };
    window.__editorDedupeJobPointers = editorDedupeJobPointers;
    window.__editorDeleteCreated = editorDeleteCreated;
    window.__applyMachineUpdate = applyMachineUpdate;
    window.__runEquipmentBackfill = runEquipmentBackfill;
    window.__editorDumpStores = function () {
      let punchlist = null;
      try { if (typeof window.getPunchlistBackup === 'function') punchlist = window.getPunchlistBackup(); } catch (e) {}
      return {
        customers: JSON.parse(JSON.stringify(loadCustomers() || [])),
        sites: JSON.parse(JSON.stringify(loadSites() || [])),
        machines: JSON.parse(JSON.stringify(loadMachines() || [])),
        jobs: JSON.parse(JSON.stringify(loadJobs() || [])),
        inspections: JSON.parse(JSON.stringify(loadInspections() || [])),
        partsRequests: JSON.parse(JSON.stringify(loadPartsRequests() || [])),
        punchlist: punchlist ? JSON.parse(JSON.stringify(punchlist)) : null,
        serials: JSON.parse(JSON.stringify(loadSerials() || []))
      };
    };
    window.__editorInstallStores = async function (data) {
      if (data.customers) saveCustomers(data.customers);
      if (data.sites) saveSites(data.sites);
      if (data.machines) saveMachines(data.machines);
      if (data.jobs) saveJobs(data.jobs);
      if (data.inspections) saveInspections(data.inspections);
      if (data.partsRequests) savePartsRequests(data.partsRequests);
      if (data.serials) saveSerials(data.serials);
      if (data.punchlist && typeof window.setPunchlistBackup === 'function') {
        await window.setPunchlistBackup(data.punchlist);
      }
      return true;
    };
    window.__editorApplyCustomerMerge = editorApplyCustomerMerge;
    window.__editorApplySerialCorrection = editorApplySerialCorrection;
    window.__editorApplyMachineMove = editorApplyMachineMove;
    window.__editorApplyMachineText = editorApplyMachineText;


    bootTheme();
    bindProfileForm();
    fillProfileForm();
    try { if (typeof editorBindChrome === 'function') editorBindChrome(); } catch (e) {}

    })();


