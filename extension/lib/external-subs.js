(function () {
  'use strict';
  const fail = code => { throw new Error(code); };
  const A = self.CRSubFix.assrt, D = self.CRSubFix.subdl, J = self.CRSubFix.jimaku, W = self.CRSubFix.workProfiles;
  const sourceOf = p => p?.source === undefined ? 'assrt' : ['assrt', 'subdl', 'jimaku'].includes(p.source) ? p.source : fail('EXTERNAL_INVALID_SOURCE');
  const sourceName = f => f.source || 'assrt';
  const adapter = source => source === 'subdl' ? D : source === 'jimaku' ? J : A;
  const keyName = source => ({ assrt: 'assrtApiKey', subdl: 'subdlApiKey', jimaku: 'jimakuApiKey' })[source];
  const errorCode = (source, code) => `${source.toUpperCase()}_${code}`;
  const recordId = record => `custom:${sourceName(record)}:${record.subId}:${record.key.split(':').at(-1)}`;
  const publicItem = item => ({ ...item, archiveUrl: undefined,
    files: item.files.map(({ url: _url, ...f }) => f) });
  const C = self.CRSubFix.collectionMatch;
  const KEY = 'externalSubCache', TTL = 24 * 60 * 60 * 1000;
  const MAX_CACHE_BYTES = 32 * 1024 * 1024;
  const bytes = value => Math.max(JSON.stringify(value).length * 2, new TextEncoder().encode(JSON.stringify(value)).length);
  const validGuid = guid => typeof guid === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(guid);
  const pageIdentity = meta => ({ seriesId: meta.seriesId, title: meta.title, season: meta.season, episode: meta.episode });
  function sync(value) {
    if (value?.mode === 'none') return { mode: 'none' };
    if (value?.mode !== 'linear' || !Number.isFinite(value.scale) || value.scale < 0.5 || value.scale > 2 ||
        !Number.isFinite(value.offset) || Math.abs(value.offset) > 3600) fail('EXTERNAL_INVALID_SYNC');
    return { mode: 'linear', scale: value.scale, offset: value.offset };
  }
  function create(chrome, { fetcher = (...args) => fetch(...args), cacheStore = self.CRSubFix.externalCache?.create() } = {}) {
    let writes = Promise.resolve(), requests = Promise.resolve(), subdlRequests = Promise.resolve(), jimakuRequests = Promise.resolve();
    const following = new Map();
    const cacheLimit = cacheStore ? MAX_CACHE_BYTES : 1024 * 1024;
    const empty = () => ({ searches: [], files: [], selections: {}, seriesOffsets: {}, identities: {} });
    async function read() {
      if (cacheStore) {
        const db = await cacheStore.get();
        if (db) return db;
      }
      const legacy = (await chrome.storage.local.get(KEY))[KEY];
      return legacy ? JSON.parse(JSON.stringify(legacy)) : empty();
    }
    function write(change) {
      const run = writes.then(async () => {
        const db = await read();
        db.followRules = db.followRules || {};
        db.subdlItems = db.subdlItems || {};
        db.nameProfiles = db.nameProfiles || {};
        db.collections = db.collections || {};
        const result = await change(db);
        db.searches = db.searches.filter(s => s.expires > Date.now()).slice(-20);
        for (const [key, value] of Object.entries(db.collections)) if (value.expires < Date.now()) delete db.collections[key];
        while (Object.keys(db.collections).length > 12 || bytes(db.collections) > cacheLimit / 4)
          delete db.collections[Object.keys(db.collections)[0]];
        let size = bytes(db);
        while (db.searches.length && size > cacheLimit) {
          db.searches.shift();
          size = bytes(db);
        }
        while (db.files.length > 8 || size > cacheLimit) {
          const removed = db.files.shift();
          if (!removed) fail('EXTERNAL_CACHE_FULL');
          db.selections = Object.fromEntries(Object.entries(db.selections).filter(([, v]) => v.key !== removed.key));
          size = bytes(db);
        }
        const guids = Object.keys(db.identities);
        while (guids.length > 100) delete db.identities[guids.shift()];
        if (Object.keys(db.seriesOffsets).length > 100) delete db.seriesOffsets[Object.keys(db.seriesOffsets)[0]];
        while (Object.keys(db.followRules).length > 50) delete db.followRules[Object.keys(db.followRules)[0]];
        while (Object.keys(db.subdlItems).length > 100) delete db.subdlItems[Object.keys(db.subdlItems)[0]];
        while (Object.keys(db.nameProfiles).length > 80) delete db.nameProfiles[Object.keys(db.nameProfiles)[0]];
        try {
          if (cacheStore) {
            await cacheStore.set(db);
            // Remove the legacy copy only after the durable transaction commits.
            await chrome.storage.local.remove(KEY).catch(() => {});
          } else await chrome.storage.local.set({ [KEY]: db });
        }
        catch (_) { fail('EXTERNAL_CACHE_SAVE_FAILED'); }
        return result;
      });
      writes = run.catch(() => {});
      return run;
    }
    async function context(key) {
      if (typeof key !== 'string' || !/^[a-f0-9-]{36}$/.test(key)) fail('EXTERNAL_CONTEXT_EXPIRED');
      const value = (await chrome.storage.session.get(`externalSnapshot:${key}`))[`externalSnapshot:${key}`];
      if (!value || value.expires < Date.now()) fail('EXTERNAL_CONTEXT_EXPIRED');
      let current;
      try { current = await self.CRSubFix.mtUtils.withTimeout(chrome.tabs.sendMessage(value.tabId,
        { type: self.CRSubFix.protocol.MSG.WORK_PAGE_CHECK }, { frameId: 0 }), 3000, 'EXTERNAL_CONTEXT_EXPIRED'); }
      catch (_) {}
      if (current?.guid !== value.meta.guid) fail('EXTERNAL_CONTEXT_EXPIRED');
      const M = self.CRSubFix.episodeMetadata;
      const meta = current.metadata?.guid === value.meta.guid ? M.reconcile(M.validate(current.metadata, value.meta.guid), value.meta) : value.meta;
      return { ...value, meta };
    }
    async function open(payload, sender) {
      const guid = W.route(sender.url, 'watch');
      if (!guid || guid !== payload?.guid) fail('SENDER_NOT_ALLOWED');
      const meta = self.CRSubFix.episodeMetadata.validate(payload.metadata, guid);
      const key = crypto.randomUUID();
      const all = await chrome.storage.session.get(null);
      const old = Object.entries(all).filter(([k]) => k.startsWith('externalSnapshot:')).sort((a, b) => a[1].expires - b[1].expires);
      while (old.length && (old[0][1].expires < Date.now() || old.length >= 10)) await chrome.storage.session.remove(old.shift()[0]);
      await chrome.storage.session.set({ [`externalSnapshot:${key}`]: {
        tabId: sender.tab.id, meta, expires: Date.now() + 3600000,
      } });
      try { await chrome.tabs.create({ url: chrome.runtime.getURL(`subtitles.html?snapshot=${key}`), active: true }); }
      catch (_) { await chrome.storage.session.remove(`externalSnapshot:${key}`); fail('EXTERNAL_OPEN_FAILED'); }
      return { ok: true };
    }
    async function configuration() {
      const stored = await chrome.storage.local.get({ assrtApiKey: '', assrtHttpDownloads: false, subdlApiKey: '', jimakuApiKey: '' });
      return { hasKey: !!stored.assrtApiKey, authorized: await chrome.permissions.contains({ origins: A.ORIGINS }),
        httpDownloads: stored.assrtHttpDownloads === true && await chrome.permissions.contains({ origins: A.HTTP_ORIGINS }),
        subdl: { hasKey: !!stored.subdlApiKey, authorized: await chrome.permissions.contains({ origins: D.ORIGINS }) },
        jimaku: { hasKey: !!stored.jimakuApiKey, authorized: await chrome.permissions.contains({ origins: J.ORIGINS }) } };
    }
    async function setHttpDownloads(enabled) {
      if (typeof enabled !== 'boolean') fail('ASSRT_INVALID_CONFIG');
      if (enabled && !await chrome.permissions.contains({ origins: A.HTTP_ORIGINS })) fail('ASSRT_HTTP_PERMISSION_REQUIRED');
      await chrome.storage.local.set({ assrtHttpDownloads: enabled });
      return { ok: true, ...await configuration() };
    }
    async function httpAllowed() {
      const value = (await chrome.storage.local.get({ assrtHttpDownloads: false })).assrtHttpDownloads;
      if (value !== true) return false;
      if (!await chrome.permissions.contains({ origins: A.HTTP_ORIGINS })) fail('ASSRT_HTTP_PERMISSION_REQUIRED');
      return true;
    }
    async function saveKey(value, requestedSource) {
      const source = sourceOf({ source: requestedSource }), provider = adapter(source), key = provider.token(value);
      if (!await chrome.permissions.contains({ origins: provider.ORIGINS })) fail(errorCode(source, 'PERMISSION_REQUIRED'));
      await chrome.storage.local.set({ [keyName(source)]: key });
      return { ok: true, ...await configuration() };
    }
    async function removeKey(requestedSource) {
      const source = sourceOf({ source: requestedSource });
      await chrome.storage.local.set({ [keyName(source)]: '' });
      return { ok: true, ...await configuration() };
    }
    function api(operation) {
      const run = requests.then(async () => {
        const key = (await chrome.storage.local.get({ assrtApiKey: '' })).assrtApiKey;
        if (!key) fail('ASSRT_KEY_REQUIRED');
        if (!await chrome.permissions.contains({ origins: A.ORIGINS })) fail('ASSRT_PERMISSION_REQUIRED');
        const now = Date.now();
        const old = (await chrome.storage.local.get('assrtRate')).assrtRate;
        const rate = old && now - old.started < 60000 ? old : { started: now, count: 0, until: 0 };
        // Conservative allowance; quota is remaining requests, not a reliable per-minute maximum.
        if (rate.until > now || rate.count >= 5) {
          const error = new Error('ASSRT_RATE_LIMIT');
          error.retryAfter = Math.max(1, Math.ceil((Math.max(rate.until, rate.started + 60000) - now) / 1000));
          throw error;
        }
        rate.count++;
        await chrome.storage.local.set({ assrtRate: rate });
        try { return await operation(key); }
        catch (error) {
          if (error.message === 'ASSRT_RATE_LIMIT') {
            rate.until = Date.now() + 60000;
            await chrome.storage.local.set({ assrtRate: rate });
            error.retryAfter = 60;
          }
          throw error;
        }
      });
      requests = run.catch(() => {});
      return run;
    }
    function subdlApi(operation) {
      const run = subdlRequests.then(async () => {
        const stored = await chrome.storage.local.get({ subdlApiKey: '', subdlUntil: 0 });
        if (!stored.subdlApiKey) fail('SUBDL_KEY_REQUIRED');
        if (!await chrome.permissions.contains({ origins: D.ORIGINS })) fail('SUBDL_PERMISSION_REQUIRED');
        if (stored.subdlUntil > Date.now()) {
          const e = new Error('SUBDL_RATE_LIMIT'); e.retryAfter = Math.ceil((stored.subdlUntil - Date.now()) / 1000); throw e;
        }
        try { return await operation(stored.subdlApiKey); }
        catch (e) {
          if (e.message === 'SUBDL_RATE_LIMIT') await chrome.storage.local.set({ subdlUntil: Date.now() + (e.retryAfter || 60) * 1000 });
          throw e;
        }
      });
      subdlRequests = run.catch(() => {});
      return run;
    }
    function jimakuApi(operation) {
      const run = jimakuRequests.then(async () => {
        const stored = await chrome.storage.local.get({ jimakuApiKey: '', jimakuUntil: 0 });
        if (!stored.jimakuApiKey) fail('JIMAKU_KEY_REQUIRED');
        if (!await chrome.permissions.contains({ origins: J.ORIGINS })) fail('JIMAKU_PERMISSION_REQUIRED');
        if (stored.jimakuUntil > Date.now()) {
          const e = new Error('JIMAKU_RATE_LIMIT'); e.retryAfter = Math.ceil((stored.jimakuUntil - Date.now()) / 1000); throw e;
        }
        try { return await operation(stored.jimakuApiKey); }
        catch (e) {
          if (e.message === 'JIMAKU_RATE_LIMIT') await chrome.storage.local.set({ jimakuUntil: Date.now() + (e.retryAfter || 60) * 1000 });
          throw e;
        } finally {
          if (J.rate()) await chrome.storage.local.set({ jimakuRate: J.rate() });
        }
      });
      jimakuRequests = run.catch(() => {});
      return run;
    }
    async function subdlDescriptor(ctx, subId) {
      const value = (await read()).subdlItems?.[`${ctx.meta.guid}:${D.id(subId)}`];
      if (!value) fail('SUBDL_SELECTION_EXPIRED');
      return value;
    }
    async function providerDetail(ctx, source, subId, descriptor = null) {
      if (source === 'assrt') return api(key => A.detail(key, subId, fetcher));
      if (source === 'jimaku') {
        const db = await read();
        if (!descriptor && !db.searches.some(s => s.guid === ctx.meta.guid && s.source === source && s.expires > Date.now() &&
          s.items.some(v => v.id === J.id(subId))) && !db.files.some(f => f.guid === ctx.meta.guid && sourceName(f) === source && f.subId === subId))
          fail('JIMAKU_SELECTION_EXPIRED');
        const value = await jimakuApi(key => J.detail(key, subId, fetcher));
        await context(ctx.snapshot); return value;
      }
      const item = descriptor || await subdlDescriptor(ctx, subId);
      const detail = await subdlApi(key => D.detail(key, item, fetcher));
      await context(ctx.snapshot);
      return D.expand(detail, fetcher);
    }
    async function get(snapshot) {
      const ctx = await context(snapshot), db = await read();
      const saved = db.identities[ctx.meta.guid], metadata = self.CRSubFix.episodeMetadata.reconcile(ctx.meta, saved);
      const mismatched = metadata.title && (!saved?.title || saved.title !== metadata.title) ||
        ctx.meta.seriesId && saved?.seriesId && ctx.meta.seriesId !== saved.seriesId;
      const stale = db.searches.filter(s => s.guid === ctx.meta.guid && !s.pageIdentity && !s.staleIdentity && mismatched);
      if (stale.length) await write(value => {
        for (const search of value.searches) if (stale.some(s => s.key === search.key)) search.staleIdentity = true;
      });
      const matches = search => !search.staleIdentity && (!search.pageIdentity ||
        !!ctx.meta.seriesId && search.pageIdentity.seriesId === ctx.meta.seriesId &&
        (!ctx.meta.title || search.pageIdentity.title === ctx.meta.title));
      const selected = db.selections[ctx.meta.guid];
      const file = db.files.find(f => f.key === selected?.key);
      return { ok: true, ...await configuration(), metadata,
        cachedSearches: db.searches.filter(s => s.guid === ctx.meta.guid && s.expires > Date.now() && !stale.includes(s) && matches(s)),
        selected: file ? { key: file.key, filename: file.name, subId: file.subId, source: sourceName(file), fileId: file.fileId || '', requestedEncoding: file.requestedEncoding,
          sync: selected.sync, lang: selected.lang, language: file.language } : null,
        followRule: db.followRules?.[C.key(metadata)] || (metadata.season === null &&
          Object.values(db.followRules || {}).filter(r => r.seriesId === metadata.seriesId).length === 1
          ? Object.values(db.followRules).find(r => r.seriesId === metadata.seriesId) : null),
        seriesOffset: metadata.seriesId ? db.seriesOffsets[metadata.seriesId] ?? null : null,
        nameState: db.nameProfiles?.[C.key(metadata)] || { records: [], choices: {} },
        collectionFiles: file ? db.collections?.[collectionKey(metadata, sourceName(file), file.subId)]?.files || [] : [] };
    }
    async function names(payload, records = null) {
      const ctx = await context(payload.snapshot), N = self.CRSubFix.searchNames;
      const currentDb = await read(), profileKey = C.key(self.CRSubFix.episodeMetadata.reconcile(ctx.meta, currentDb.identities[ctx.meta.guid]));
      if (!ctx.meta.seriesId) fail('FOLLOW_METADATA_REQUIRED');
      if (!records && payload.action === 'official') {
        const old = (await read()).nameProfiles?.[profileKey];
        if (old?.officialAt && Date.now() - old.officialAt < TTL && payload.refresh !== true)
          return { ok: true, nameState: old, cached: true, unavailable: old.unavailable || [] };
        const value = await chrome.tabs.sendMessage(ctx.tabId, { type: self.CRSubFix.protocol.MSG.EXTERNAL_OFFICIAL_NAMES,
          payload: { guid: ctx.meta.guid, seriesId: ctx.meta.seriesId } }, { frameId: 0 });
        if (!value?.ok) fail(value?.error === 'EXTERNAL_CONTEXT_EXPIRED' ? value.error : 'OFFICIAL_NAMES_UNAVAILABLE');
        await context(payload.snapshot);
        records = N.merge(value.records).filter(r => r.source === 'official' && W.route(r.url, 'series') === ctx.meta.seriesId);
        return write(db => {
          const old = db.nameProfiles[profileKey] || { records: [], choices: {} };
          const next = { ...old, records: N.merge(old.records, records),
            officialAt: records.length ? Date.now() : 0, unavailable: Array.isArray(value.unavailable) ? value.unavailable.filter(l => N.languages[l]) : [] };
          db.nameProfiles[profileKey] = next;
          return { ok: true, nameState: next, unavailable: next.unavailable };
        });
      }
      return write(db => {
        const old = db.nameProfiles[profileKey] || { records: [], choices: {} };
        if (records) old.records = N.merge(old.records, records);
        else if (payload.action === 'select') {
          const source = sourceOf(payload), name = typeof payload.name === 'string' ? payload.name.trim() : '';
          if (!name || name.length > 200 || !N.languages[payload.language]) fail('ASSIST_INVALID_INPUT');
          old.choices[source] = { name, language: payload.language };
          const existing = old.records.find(r => r.name === name && r.language === payload.language);
          old.records = N.merge(old.records, [{ ...(existing || { name, language: payload.language, source: 'manual' }), confirmed: true }]);
        } else fail('ASSIST_INVALID_INPUT');
        db.nameProfiles[profileKey] = old;
        return { ok: true, nameState: old };
      });
    }
    const memoKey = (snapshot, source, id) => `externalCollection:${snapshot}:${source}:${id}`;
    const collectionKey = (meta, source, id) => JSON.stringify([meta.seriesId, meta.season, source, String(id)]);
    async function collection(payload) {
      const ctx = await context(payload.snapshot), source = sourceOf(payload), id = adapter(source).id(payload.id);
      const db = await read(), meta = self.CRSubFix.episodeMetadata.reconcile(ctx.meta, db.identities[ctx.meta.guid]);
      const value = (await chrome.storage.session.get(memoKey(payload.snapshot, source, id)))[memoKey(payload.snapshot, source, id)] ||
        db.collections?.[collectionKey(meta, source, id)];
      if (!value || value.expires < Date.now()) fail('ASSIST_FILES_EXPIRED');
      return { ctx, files: value.files };
    }
    async function search(payload) {
      const ctx = await context(payload.snapshot), source = sourceOf(payload), provider = adapter(source);
      const metadata = self.CRSubFix.episodeMetadata.validate({ ...ctx.meta, ...payload.metadata, guid: ctx.meta.guid,
        seriesId: ctx.meta.seriesId }, ctx.meta.guid);
      const anilistId = source === 'jimaku' && payload.anilistId ? J.id(payload.anilistId) : null;
      const q = anilistId ? `AniList:${anilistId}` : provider.query(payload.query), pos = payload.pos ?? 0, fileMode = payload.fileMode === true;
      if (source !== 'assrt' && pos !== 0) fail(errorCode(source, 'INVALID_QUERY'));
      const cacheKey = JSON.stringify([ctx.meta.guid, metadata.seriesId, metadata.season, metadata.episode, q, pos, fileMode, source]);
      const old = (await read()).searches.find(s => s.key === cacheKey && s.expires > Date.now());
      if (old && payload.refresh !== true) {
        const scope = pageIdentity(ctx.meta);
        await write(db => {
          db.identities[ctx.meta.guid] = { ...metadata, pageIdentity: scope };
          const search = db.searches.find(s => s.key === cacheKey);
          if (search) { search.pageIdentity = scope; search.staleIdentity = false; }
        });
        return { ok: true, ...old, pageIdentity: scope, staleIdentity: false, cached: true };
      }
      const items = source === 'assrt' ? await api(key => A.search(key, q, pos, fileMode, fetcher)) : source === 'jimaku' ?
        await jimakuApi(key => J.search(key, q, { anilistId }, fetcher)) : await subdlApi(key => D.search(key, q, fetcher));
      await context(payload.snapshot);
      const value = { key: cacheKey, guid: ctx.meta.guid, source, query: q, pos, fileMode, items, at: Date.now(), expires: Date.now() + TTL,
        pageIdentity: pageIdentity(ctx.meta),
        ...(source !== 'assrt' ? { hasMore: false, anilistId } : {}) };
      await write(db => {
        db.identities[ctx.meta.guid] = { ...metadata, pageIdentity: pageIdentity(ctx.meta) };
        db.searches = db.searches.filter(s => s.key !== cacheKey).concat(value).slice(-20);
      });
      return { ok: true, ...value, cached: false };
    }
    async function details(payload) {
      const ctx = await context(payload.snapshot), source = sourceOf(payload);
      ctx.snapshot = payload.snapshot;
      if (source === 'subdl' && payload.kind === 'title') {
        const db = await read();
        const meta = self.CRSubFix.episodeMetadata.validate({ ...ctx.meta, ...payload.metadata,
          guid: ctx.meta.guid, seriesId: ctx.meta.seriesId }, ctx.meta.guid);
        if (!db.searches.some(s => s.guid === ctx.meta.guid && s.source === 'subdl' && s.expires > Date.now() &&
            s.items.some(i => i.kind === 'title' && i.id === D.titleId(payload.id)))) fail('SUBDL_SELECTION_EXPIRED');
        const searchLanguage = payload.searchLanguage || 'all', searchPage = payload.searchPage ?? 1;
        if (!['all', 'zh', 'en', 'ja'].includes(searchLanguage) || !Number.isInteger(searchPage) || searchPage < 1 || searchPage > 10000)
          fail('SUBDL_INVALID_QUERY');
        const listingKey = JSON.stringify(['subdl-list', ctx.meta.guid, payload.id, meta.season, searchLanguage, searchPage]);
        const cached = db.searches.find(s => s.key === listingKey && s.expires > Date.now());
        if (cached && payload.refresh !== true) return { ok: true, ...cached, titleId: payload.id, cached: true };
        const items = await subdlApi(key => D.subtitles(key, payload.id, { ...meta, searchLanguage, searchPage }, fetcher));
        await context(payload.snapshot);
        await write(db => {
          db.identities[ctx.meta.guid] = { ...meta, pageIdentity: pageIdentity(ctx.meta) };
          for (const item of items) db.subdlItems[`${ctx.meta.guid}:${item.id}`] = item;
          const title = db.searches.find(s => s.guid === ctx.meta.guid && s.source === 'subdl' && s.items.some(i => i.kind === 'title' && i.id === D.titleId(payload.id)))
            ?.items.find(i => i.id === D.titleId(payload.id));
          db.searches = db.searches.filter(s => s.key !== listingKey).concat({ key: listingKey, guid: ctx.meta.guid,
            pageIdentity: pageIdentity(ctx.meta),
            source, query: title?.name || '', pos: (searchPage - 1) * 30, fileMode: false, items: items.map(publicItem),
            titleId: payload.id, searchLanguage, searchPage, subtitleList: true, hasMore: items.hasMore === true,
            at: Date.now(), expires: Date.now() + TTL });
        });
        return { ok: true, items: items.map(publicItem), source, hasMore: items.hasMore === true,
          titleId: payload.id, searchLanguage, searchPage, pos: (searchPage - 1) * 30 };
      }
      const value = await providerDetail(ctx, source, adapter(source).id(payload.id));
      await context(payload.snapshot);
      const files = adapter(source).files(value).map(({ url: _url, ...f }) => f);
      const memo = { files, expires: Date.now() + 1800000 }, key = memoKey(payload.snapshot, source, payload.id);
      const all = await chrome.storage.session.get(null);
      const older = Object.entries(all).filter(([k]) => k.startsWith('externalCollection:') && k !== key).sort((a, b) => a[1].expires - b[1].expires);
      let total = bytes(memo) + older.reduce((n, [, v]) => n + bytes(v), 0);
      while (older.length && (older[0][1].expires < Date.now() || total > 2 * 1024 * 1024)) {
        const [oldKey, oldValue] = older.shift(); total -= bytes(oldValue); await chrome.storage.session.remove(oldKey);
      }
      if (bytes(memo) <= 2 * 1024 * 1024) await chrome.storage.session.set({ [key]: memo });
      if (ctx.meta.seriesId) await write(db => {
        const meta = self.CRSubFix.episodeMetadata.reconcile(ctx.meta, db.identities[ctx.meta.guid]);
        db.collections[collectionKey(meta, source, payload.id)] = { files, expires: Date.now() + TTL };
      });
      let nameState;
      if (source === 'jimaku' && ctx.meta.seriesId) {
        const item = J.summary(value);
        nameState = (await names(payload, [
          { name: item.englishName, language: 'en', source: 'jimaku' },
          { name: item.originalName, language: 'ja', source: 'jimaku' },
          { name: /^[\x20-\x7e]+$/.test(item.romajiName) ? item.romajiName : '', language: 'romaji', source: 'jimaku' },
        ])).nameState;
      }
      return { ok: true, item: publicItem(adapter(source).summary(value)), files, nameState };
    }
    async function openDownload(payload) {
      const ctx = await context(payload.snapshot), source = sourceOf(payload), provider = adapter(source);
      ctx.snapshot = payload.snapshot;
      if (source === 'subdl' && payload.archive === true) {
        const descriptor = await subdlDescriptor(ctx, payload.id);
        const current = await subdlApi(key => D.detail(key, descriptor, fetcher));
        await context(payload.snapshot);
        await chrome.tabs.create({ url: D.downloadUrl(current.archiveUrl), active: true });
        return { ok: true };
      }
      const value = await providerDetail(ctx, source, provider.id(payload.id));
      await context(payload.snapshot);
      const files = provider.files(value).filter(f => f.name === payload.filename && (!payload.fileId || f.fileId === payload.fileId));
      if (files.length !== 1) fail(errorCode(source, 'FILE_CHANGED'));
      if (!files[0].format && !(source === 'jimaku' && /\.zip$/i.test(files[0].name))) fail(errorCode(source, 'UNSUPPORTED_FILE'));
      const url = source === 'assrt' ? A.downloadUrl(files[0].url, await httpAllowed()) : source === 'jimaku' ?
        J.downloadUrl(files[0].url, value.id, files[0].name) : D.downloadUrl(files[0].url || value.archiveUrl);
      // This explicit user action navigates to a fresh validated URL without API credentials.
      await chrome.tabs.create({ url, active: true });
      return { ok: true };
    }
    function fileResult(file, selected, cached) {
      const cues = self.CRSubFix.parser.parseSubtitles(file.text, file.name);
      return { ok: true, key: file.key, name: file.name, source: sourceName(file), fileId: file.fileId || '', encoding: file.encoding, bytes: file.bytes,
        language: file.language, count: cues.length, cues: cues.map(c => ({ start: c.start, end: c.end, text: c.text })),
        sync: selected?.key === file.key ? selected.sync : { mode: 'none' }, cached };
    }
    async function preview(payload, resolvedDetail = null) {
      const ctx = await context(payload.snapshot), source = sourceOf(payload), provider = adapter(source), subId = provider.id(payload.id), db = await read();
      ctx.snapshot = payload.snapshot;
      if (typeof payload.filename !== 'string' || !payload.filename || payload.filename.length > 700) fail('ASSRT_FILE_CHANGED');
      const cached = db.files.find(f => f.guid === ctx.meta.guid && sourceName(f) === source && f.subId === subId && f.name === payload.filename &&
        (!payload.fileId || f.fileId === payload.fileId) &&
        f.requestedEncoding === (payload.encoding || 'auto'));
      if (cached && payload.refresh !== true) return fileResult(cached, db.selections[ctx.meta.guid], true);
      const detail = resolvedDetail || await providerDetail(ctx, source, subId);
      await context(payload.snapshot);
      if (!await chrome.permissions.contains({ origins: provider.ORIGINS })) fail(errorCode(source, 'PERMISSION_REQUIRED'));
      const file = source === 'assrt' ? await A.download(detail, payload.filename, payload.encoding || 'auto', fetcher, await httpAllowed()) :
        source === 'jimaku' ? await jimakuApi(() => J.download(detail, payload.filename, payload.encoding || 'auto', fetcher, payload.fileId || '')) :
          await D.download(detail, payload.filename, payload.encoding || 'auto', fetcher, payload.fileId || '');
      const cues = self.CRSubFix.parser.parseSubtitles(file.text, file.name);
      if (!cues.length || cues.length > 30000 || cues.some(c => !Number.isFinite(c.start) || !Number.isFinite(c.end) ||
          c.start < 0 || c.end <= c.start || c.text.length > 30000)) fail(errorCode(source, 'INVALID_FILE'));
      if (source === 'jimaku') file.language = J.detectLanguage(cues, file.language);
      await context(payload.snapshot);
      const hash = await self.CRSubFix.mtUtils.fingerprint(cues, source !== 'assrt' ? `${file.fileId || ''}:${file.name}\n${file.text}` : file.text);
      const identity = db.identities[ctx.meta.guid] || ctx.meta;
      const record = { ...file, subId, guid: ctx.meta.guid, seriesId: identity.seriesId,
        season: identity.season, episode: identity.episode, source, key: `${ctx.meta.guid}:${source}:${subId}:${hash}`,
        sdId: source === 'subdl' ? detail.sdId : undefined, searchPage: detail.searchPage, searchLanguage: detail.searchLanguage,
        fileSeason: file.season, fileEpisode: file.episode,
        requestedEncoding: payload.encoding || 'auto', language: file.language || provider.summary(detail).language, at: Date.now() };
      if (bytes(record) > cacheLimit - 8192) fail('EXTERNAL_CACHE_FULL');
      await write(db => {
        record.approved = db.files.find(f => f.key === record.key)?.approved === true;
        db.files = db.files.filter(f => f.key !== record.key).concat(record);
      });
      if (!(await read()).files.some(f => f.key === record.key)) fail('EXTERNAL_CACHE_FULL');
      return fileResult(record, db.selections[ctx.meta.guid], false);
    }
    async function captureTime(payload) {
      const ctx = await context(payload.snapshot);
      const result = await chrome.tabs.sendMessage(ctx.tabId, { type: self.CRSubFix.protocol.MSG.EXTERNAL_TIME,
        payload: { guid: ctx.meta.guid } }, { frameId: 0 });
      if (result?.guid !== ctx.meta.guid || !Number.isFinite(result.time) || result.time < 0) fail('EXTERNAL_TIME_UNAVAILABLE');
      return { ok: true, time: result.time };
    }
    async function apply(payload) {
      const ctx = await context(payload.snapshot), db = await read();
      const record = db.files.find(f => f.key === payload.key && f.guid === ctx.meta.guid);
      if (!record) fail('EXTERNAL_FILE_EXPIRED');
      const timing = sync(payload.sync);
      const lang = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', ''].includes(payload.lang) ? payload.lang : fail('INVALID_LANGUAGE');
      const identity = self.CRSubFix.episodeMetadata.validate({ ...ctx.meta, ...payload.metadata,
        guid: ctx.meta.guid, seriesId: ctx.meta.seriesId }, ctx.meta.guid);
      let rule = null;
      if (payload.follow === true) {
        const parsed = C.parse(record.name);
        if (!C.identity(identity)) fail('FOLLOW_METADATA_REQUIRED');
        const mapping = payload.collectionMap?.length ? C.validateMap((await collection({ snapshot: payload.snapshot,
          source: sourceName(record), id: record.subId })).files, payload.collectionMap, { name: record.name, fileId: record.fileId || '' }, identity) : null;
        const structured = sourceName(record) === 'subdl' && record.fileEpisode === identity.episode && record.fileSeason === identity.season;
        if (C.special(record.name)) fail('FOLLOW_FILENAME_UNCLEAR');
        if ((!parsed || parsed.episode !== identity.episode || (parsed.season !== null && parsed.season !== identity.season)) && !structured && !mapping)
          fail('FOLLOW_FILENAME_UNCLEAR');
        if (sourceName(record) === 'subdl' && ((parsed && parsed.episode !== identity.episode) ||
            (parsed?.season != null && parsed.season !== identity.season) ||
            (record.fileEpisode != null && record.fileEpisode !== identity.episode) ||
            (record.fileSeason != null && record.fileSeason !== identity.season))) fail('FOLLOW_FILENAME_UNCLEAR');
        rule = { seriesId: identity.seriesId, season: identity.season, subId: record.subId, template: parsed?.template,
          signature: parsed?.signature, mapping,
          source: sourceName(record), sdId: record.sdId, searchPage: record.searchPage, searchLanguage: record.searchLanguage,
          fileLanguage: record.language, fileFormat: record.format, structured,
          encoding: record.requestedEncoding, lang, revision: crypto.randomUUID(), label: record.name,
          offset: payload.inheritOffset === true ? (timing.mode === 'linear' ? timing.offset : 0) : null };
      }
      const response = await chrome.tabs.sendMessage(ctx.tabId, { type: self.CRSubFix.protocol.MSG.EXTERNAL_APPLY,
        payload: { guid: ctx.meta.guid, id: recordId(record),
          filename: record.name, text: record.text, lang, sync: timing, provider: sourceName(record) } }, { frameId: 0 });
      if (!response?.ok) fail(response?.error === 'EXTERNAL_INVALID_FILE' ? errorCode(sourceName(record), 'INVALID_FILE') : 'EXTERNAL_APPLY_FAILED');
      await context(payload.snapshot);
      await write(db => {
        const file = db.files.find(f => f.key === record.key);
        if (!file) fail('EXTERNAL_FILE_EXPIRED');
        file.approved = true;
        file.seriesId = identity.seriesId; file.season = identity.season; file.episode = identity.episode;
        db.selections[ctx.meta.guid] = { key: record.key, sync: timing, lang, active: true, at: Date.now() };
        db.identities[ctx.meta.guid] = { ...identity, pageIdentity: pageIdentity(ctx.meta) };
        if (rule) db.followRules[C.key(identity)] = rule;
        if (payload.rememberOffset === true && ctx.meta.seriesId) {
          db.seriesOffsets[ctx.meta.seriesId] = { offset: timing.mode === 'linear' ? timing.offset : 0, at: Date.now() };
        }
      });
      return { ok: true, followRule: rule };
    }
    async function clearFollow(payload) {
      const ctx = await context(payload.snapshot);
      const metadata = self.CRSubFix.episodeMetadata.validate({ ...ctx.meta, ...payload.metadata,
        guid: ctx.meta.guid, seriesId: ctx.meta.seriesId }, ctx.meta.guid);
      const season = Number.isInteger(payload.season) && payload.season > 0 ? payload.season : metadata.season;
      await write(db => { delete db.followRules[C.key({ ...metadata, season })]; });
      return { ok: true };
    }
    async function follow(guid, meta, sender, rule) {
      const tabId = sender.tab.id, attemptKey = `externalFollowAttempt:${tabId}`;
      const tag = JSON.stringify([guid, rule.revision, meta.episode]);
      const previous = (await chrome.storage.session.get(attemptKey))[attemptKey];
      if (previous?.tag === tag) return { ok: true, record: null, followError: previous.error || null };
      await chrome.storage.session.set({ [attemptKey]: { tag } });
      const snapshot = crypto.randomUUID();
      await chrome.storage.session.set({ [`externalSnapshot:${snapshot}`]: { tabId, meta, expires: Date.now() + 120000 } });
      async function allowed() {
        await context(snapshot);
        const db = await read();
        if (db.followRules?.[C.key(meta)]?.revision !== rule.revision || db.selections[guid]) fail('FOLLOW_CANCELLED');
        return db;
      }
      try {
        const source = sourceName(rule), provider = adapter(source);
        const timing = rule.offset == null || rule.offset === 0 ? { mode: 'none' } :
          sync({ mode: 'linear', scale: 1, offset: rule.offset });
        const db = await allowed();
        let record;
        const candidates = db.files.filter(f => f.approved && f.seriesId === meta.seriesId &&
          f.season === meta.season && f.episode === meta.episode && sourceName(f) === source && f.subId === rule.subId && f.requestedEncoding === rule.encoding);
        const structuredOnly = source === 'subdl' && rule.structured && !rule.signature && !rule.mapping?.length;
        const cached = structuredOnly ? candidates.filter(f =>
          f.fileEpisode === meta.episode && f.fileSeason === meta.season && f.language === rule.fileLanguage &&
          (!rule.fileFormat || f.format === rule.fileFormat)) : C.select(candidates, rule, meta);
        if (cached.length === 1) {
          record = { ...cached[0], guid, key: `${guid}:${source}:${rule.subId}:${cached[0].key.split(':').at(-1)}` };
        } else {
          const detail = await providerDetail({ tabId, meta, snapshot }, source, rule.subId,
            source === 'subdl' ? { id: rule.subId, sdId: rule.sdId, season: rule.season,
              searchPage: rule.searchPage, searchLanguage: rule.searchLanguage } : source === 'jimaku' ? { id: rule.subId } : null);
          await allowed();
          const matches = structuredOnly ? provider.files(detail).filter(f =>
            f.episode === meta.episode && f.season === meta.season && f.language === rule.fileLanguage &&
            (!rule.fileFormat || f.format === rule.fileFormat) &&
            !C.special(f.name) && (!C.parse(f.name) || C.parse(f.name).episode === meta.episode &&
              (C.parse(f.name).season === null || C.parse(f.name).season === meta.season))) : C.select(provider.files(detail), rule, meta);
          if (matches.length !== 1) fail(matches.length ? 'FOLLOW_AMBIGUOUS' : 'FOLLOW_NOT_FOUND');
          const result = await preview({ snapshot, source, id: rule.subId, fileId: matches[0].fileId, filename: matches[0].name, encoding: rule.encoding }, detail);
          record = (await read()).files.find(f => f.key === result.key);
        }
        await allowed();
        await write(db => {
          if (db.followRules?.[C.key(meta)]?.revision !== rule.revision || db.selections[guid]) fail('FOLLOW_CANCELLED');
          record.approved = true;
          record.seriesId = meta.seriesId; record.season = meta.season; record.episode = meta.episode;
          db.files = db.files.filter(f => f.key !== record.key).concat(record);
          db.identities[guid] = meta;
          db.selections[guid] = { key: record.key, sync: timing, lang: rule.lang, active: true, at: Date.now() };
        });
        return restore(guid);
      } catch (error) {
        const code = /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'ASSRT_DOWNLOAD_NETWORK';
        if ((await chrome.storage.session.get(attemptKey))[attemptKey]?.tag === tag)
          await chrome.storage.session.set({ [attemptKey]: { tag, error: code } });
        return { ok: true, record: null, followError: code };
      } finally { await chrome.storage.session.remove(`externalSnapshot:${snapshot}`); }
    }
    async function restore(guid, metadata, sender) {
      if (!validGuid(guid)) fail('SENDER_NOT_ALLOWED');
      const db = await read(), selected = db.selections[guid];
      const record = db.files.find(f => f.key === selected?.key && f.guid === guid);
      if (!record && !selected && sender?.tab && metadata) {
        const detected = self.CRSubFix.episodeMetadata.validate(metadata, guid);
        const meta = self.CRSubFix.episodeMetadata.reconcile(detected, db.identities[guid]);
        const rules = Object.values(db.followRules || {}).filter(r => r.seriesId === meta.seriesId);
        if (!C.identity(meta)) return { ok: true, record: null, metadataPending: true,
          followError: rules.length ? 'FOLLOW_METADATA_REQUIRED' : null };
        const rule = db.followRules?.[C.key(meta)];
        if (rule) {
          const key = `${sender.tab.id}:${guid}`;
          if (following.has(key)) return following.get(key);
          const task = follow(guid, meta, sender, rule).finally(() => following.delete(key));
          following.set(key, task);
          return task;
        }
      }
      return { ok: true, active: selected?.active !== false, record: record ? { guid, id: recordId(record),
        filename: record.name, text: record.text, lang: selected.lang, sync: selected.sync, provider: sourceName(record) } : null };
    }
    async function setActive(payload) {
      if (payload.id === '') {
        const selected = (await read()).selections[payload.guid];
        if (selected && selected.active !== false) await write(db => {
          if (db.selections[payload.guid]) db.selections[payload.guid].active = false;
        });
        if (!selected) await write(db => { db.selections[payload.guid] = { key: '', active: false }; });
      } else {
        const timing = sync(payload.sync);
        if (!['zh-CN', 'zh-TW', 'en-US', 'ja-JP', ''].includes(payload.lang)) fail('INVALID_LANGUAGE');
        await write(db => {
          const record = db.files.find(f => f.guid === payload.guid && recordId(f) === payload.id);
          if (!record || (!record.approved && db.selections[payload.guid]?.key !== record.key)) fail('EXTERNAL_FILE_EXPIRED');
          db.selections[payload.guid] = { key: record.key, sync: timing, lang: payload.lang, active: true, at: Date.now() };
        });
      }
      return { ok: true };
    }
    async function updateSync(payload) {
      const timing = sync(payload?.sync);
      await write(db => {
        const selected = db.selections[payload.guid], record = db.files.find(f => f.key === selected?.key);
        if (!record || record.guid !== payload.guid || recordId(record) !== payload.id) fail('EXTERNAL_FILE_EXPIRED');
        selected.sync = timing;
      });
      return { ok: true };
    }
    async function forget(payload) {
      await write(db => {
        const selected = db.selections[payload.guid], record = db.files.find(f => f.key === selected?.key);
        if (record && recordId(record) === payload.id) delete db.selections[payload.guid];
      });
      return { ok: true };
    }
    return { open, get, saveKey, removeKey, setHttpDownloads, clearFollow, search, details, openDownload, preview, captureTime, apply, restore, updateSync, setActive, forget,
      context, collection, names,
      quota: async requestedSource => {
        if (sourceOf({ source: requestedSource }) === 'jimaku') {
          return { ok: true, source: 'jimaku', rate: (await chrome.storage.local.get('jimakuRate')).jimakuRate || null };
        }
        if (sourceOf({ source: requestedSource }) === 'subdl') {
          const result = await subdlApi(key => D.request(key, 'me', {}, fetcher));
          const number = n => Number.isFinite(n) && n >= 0 ? n : null;
          return { ok: true, source: 'subdl', searches: number(result.usage?.search?.remaining), downloads: number(result.usage?.downloads?.remaining) };
        }
        const result = await api(key => A.request(key, 'user/quota', {}, fetcher));
        return { ok: true, quota: Number.isFinite(result.user?.quota) ? result.user.quota : null };
      } };
  }
  self.CRSubFix.externalSubs = { create, sync };
})();
