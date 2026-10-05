(function () {
  'use strict';
  function init({ el, send, run, status, metadata, chosen, invalidatePreview, fileId }) {
    const NS = self.CRSubFix, N = NS.searchNames, C = NS.collectionMatch, MSG = NS.protocol.MSG;
    const I = NS.i18n, t = (source, params) => I.t(source, params), labels = new Map();
    const list = values => values.join(I.getLanguage() === 'en' ? ', ' : '、');
    function ui(node, render, property = 'textContent') {
      node.setAttribute('data-i18n-ignore', '');
      if (!labels.has(node)) labels.set(node, new Map());
      labels.get(node).set(property, render);
      node[property] = render();
    }
    // Update existing options and attributes without touching selection or map edits.
    function refreshLabels() {
      for (const [node, properties] of labels) {
        if (!node.isConnected) { labels.delete(node); continue; }
        for (const [property, render] of properties) node[property] = render();
      }
    }
    I.watch(refreshLabels);
    I.ready.then(refreshLabels);
    let nameState = { records: [], choices: {} }, records = [], files = [], groups = [], confirmed = null, available = false;
    let analysisConfig = null;
    const modelLabel = () => available ? `${t(analysisConfig.independent ? '独立分析 API' : '沿用翻译 API')} · ${analysisConfig.model}` : t('未启用 AI 分析');
    let simplified, traditional;
    const selectedFile = () => files.find(f => f.name === el('files').value && (f.fileId || '') === fileId());
    const selectedGroup = () => groups.find(g => g.files.some(f => f.name === selectedFile()?.name && (f.fileId || '') === fileId()));
    function names(meta, state = nameState) {
      nameState = state || { records: [], choices: {} };
      simplified ||= self.OpenCC.Converter({ from: 'tw', to: 'cn' });
      traditional ||= self.OpenCC.Converter({ from: 'cn', to: 'tw' });
      records = N.merge(N.base(meta, { simplified, traditional }), nameState.records || []);
      renderNames();
    }
    function renderNames() {
      const previous = el('nameCandidates').selectedOptions[0]?.dataset, language = el('nameLanguage').value;
      const preferred = el('source').value === 'jimaku' ? ['ja', 'romaji', 'en'] : el('source').value === 'subdl' ? ['en', 'romaji'] : ['zh-CN', 'zh-TW', 'en'];
      const rows = records.filter(r => language === 'auto' || r.language === language)
        .map((r, index) => ({ ...r, index: records.indexOf(r), order: preferred.includes(r.language) ? preferred.indexOf(r.language) : preferred.length }));
      if (language === 'auto') rows.sort((a, b) => a.order - b.order);
      el('nameCandidates').replaceChildren(...rows.map(r => {
        const option = new Option('', String(r.index));
        ui(option, () => `${r.name} · ${t(N.languages[r.language])} · ${t(r.source === 'ai' && r.confirmed ? 'AI 候选 · 已确认' : N.sources[r.source])}`);
        option.dataset.name = r.name; option.dataset.language = r.language; return option;
      }));
      const matched = rows.find(r => r.name === previous?.name && r.language === previous?.language);
      if (matched) el('nameCandidates').value = String(matched.index);
      if (!rows.length) { const option = new Option('', ''); ui(option, () => t('暂无此语种名称')); el('nameCandidates').append(option); }
      el('useSearchName').disabled = !rows.length;
    }
    function defaultQuery() {
      const saved = nameState.choices?.[el('source').value];
      if (saved) {
        el('nameLanguage').value = saved.language; renderNames();
        const index = records.findIndex(r => r.name === saved.name && r.language === saved.language);
        if (index >= 0) el('nameCandidates').value = String(index);
        return saved.name;
      }
      el('nameCandidates').selectedIndex = -1;
      el('nameLanguage').value = 'auto'; renderNames();
      return records[Number(el('nameCandidates').value)]?.name || metadata().title || '';
    }
    function config(value) {
      analysisConfig = value;
      available = value.available === true;
      ui(el('assistConnection'), () => t(available ? '· 已配置' : '· 未配置可用分析 API'));
      ui(el('assistModel'), modelLabel);
      if (value.config) {
        el('assistBase').value = value.config.baseUrl; el('assistModelInput').value = value.config.model;
        el('assistProtocol').value = value.config.protocol;
      }
      controls();
    }
    function controls() {
      refreshLabels();
      el('aiNames').disabled = !available;
      el('aiFiles').disabled = !available || !files.length;
      ui(el('aiNames'), () => t('AI 补充名称…'));
      ui(el('aiFiles'), () => t('AI 辅助识别…'));
      ui(el('aiNames'), () => available ? t('调用 {model}；发送作品名称；结果需自行确认', { model: modelLabel() }) : t('可选功能，需要支持分析的中转 API；基础搜索不受影响'), 'title');
      ui(el('aiFiles'), () => available ? t('调用 {model}；仅发送作品信息及文件名；结果需确认', { model: modelLabel() }) : t('可选功能，需要支持分析的中转 API；基础搜索不受影响'), 'title');
    }
    function renderFiles(preferred) {
      const signature = el('versions').value;
      const visible = signature === '*' ? files : groups.find(g => g.signature === signature)?.files || [];
      el('files').replaceChildren(...visible.map(file => {
        const p = C.parse(file.name), episode = p?.episode ?? file.episode;
        const option = new Option('', file.name);
        ui(option, () => `${episode ? t('第 {n} 集 · ', { n: episode }) : ''}${file.name} · ${file.format || t('压缩包 / 未知格式')} · ${file.language || t('语种待核对')}${file.oversized ? t(' · 超过在线加载上限') : ''}`);
        option.dataset.fileId = file.fileId || '';
        option.disabled = !file.format && !(chosen()?.source === 'jimaku' && /\.zip$/i.test(file.name));
        return option;
      }));
      const target = visible.find(f => f.name === preferred?.name && (f.fileId || '') === (preferred?.fileId || '')) ||
        visible.find(f => (C.parse(f.name)?.episode ?? f.episode) === Number(metadata().episode) && f.format) || visible.find(f => f.format) || visible[0];
      if (target) el('files').selectedIndex = visible.indexOf(target);
      fileChanged(false);
    }
    function setFiles(value, rule, selected) {
      files = value; groups = C.groups(files); confirmed = null;
      if (rule?.mapping?.length) {
        const mapped = rule.mapping.map(row => {
          const file = files.find(f => f.name === row.name && (f.fileId || '') === row.fileId);
          return file ? { ...file, episode: row.episode, season: rule.season } : null;
        }).filter(Boolean);
        if (mapped.length) {
          groups = groups.map(g => {
            const remaining = g.files.filter(f => !mapped.some(m => m.name === f.name && (m.fileId || '') === (f.fileId || '')));
            return { ...g, files: remaining, episodes: [...new Set(remaining.map(f => f.episode).filter(Boolean))].sort((a, b) => a - b) };
          }).filter(g => g.files.length);
          groups.unshift({ signature: `confirmed:${rule.revision}`, label: rule.label, traits: C.traits(rule.label),
            files: mapped, episodes: mapped.map(f => f.episode).sort((a, b) => a - b) });
        }
      }
      groups.sort((a, b) => b.files.length - a.files.length);
      const all = new Option('', '*'); ui(all, () => t('全部版本'));
      el('versions').replaceChildren(all, ...groups.map(g => {
        const traits = g.traits, marker = traits.group ? `[${traits.group}]` : g.label.split(/S\d+E\d+| - \d+/i)[0].slice(0, 65);
        const option = new Option('', g.signature);
        ui(option, () => [marker, traits.platforms, traits.format.toUpperCase(), traits.accessibility.toUpperCase(), traits.revision,
          t('{episodes} 集 / {files} 文件', { episodes: g.episodes.length, files: g.files.length })].filter(Boolean).join(' · '));
        return option;
      }));
      const preferred = selected && groups.find(g => g.files.some(f => f.name === selected.name && (f.fileId || '') === (selected.fileId || ''))) ||
        groups.find(g => g.signature === `confirmed:${rule?.revision}`) || groups.find(g => g.signature === (rule?.signature || C.parse(rule?.label)?.signature)) ||
        groups.find(g => g.episodes.includes(Number(metadata().episode))) || groups.find(g => g.files.some(f => f.format));
      el('versions').value = preferred?.signature || '*';
      renderFiles(selected); controls();
      if (rule?.mapping?.length && rule.mapping.some(row => row.name === selectedFile()?.name && row.fileId === fileId())) {
        try {
          renderMap(rule.mapping.map(row => ({ ...row, selected: true })));
          confirmed = C.validateMap(files, rule.mapping, selectedFile(), { ...metadata(), season: Number(metadata().season), episode: Number(metadata().episode) });
          const n = confirmed.length; ui(el('mapInfo'), () => t('· 已保存 {n} 集', { n }));
        } catch (_) { confirmed = null; }
      }
    }
    function fileChanged(regroup = true) {
      confirmed = null; invalidatePreview();
      const group = selectedGroup(), anchor = selectedFile();
      if (regroup && el('versions').value === '*' && group) {
        el('versions').value = group.signature; renderFiles(anchor); return;
      }
      const duplicates = group?.episodes.filter(ep => group.files.filter(f => f.episode === ep).length > 1) || [];
      ui(el('groupInfo'), () => group ? t('本版本已识别集数：{episodes}', { episodes: list(group.episodes) || t('待校正') }) +
        (duplicates.length ? t(' · 第 {episodes} 集有多个文件，需选择', { episodes: list(duplicates) }) : '') : '');
      renderMap();
    }
    function renderMap(suggestions = null) {
      confirmed = null;
      const anchor = selectedFile(), group = selectedGroup();
      ui(el('mapInfo'), () => suggestions ? t('· AI 候选未确认') : '');
      el('mappingRows').replaceChildren();
      if (!anchor) return;
      for (const file of files.filter(f => f.format && C.compatible(anchor.name, f.name))) {
        const parsed = C.parse(file.name), suggestion = suggestions?.find(s => s.name === file.name && (s.fileId || '') === (file.fileId || '')), tr = document.createElement('tr');
        const selected = file.name === anchor.name && (file.fileId || '') === (anchor.fileId || '');
        const check = document.createElement('input'); check.type = 'checkbox';
        check.checked = selected || (suggestions ? suggestion?.selected === true : group?.files.some(f => f.name === file.name && (f.fileId || '') === (file.fileId || '')));
        check.disabled = selected; ui(check, () => t('包含 {name}', { name: file.name }), 'ariaLabel');
        const input = document.createElement('input'); input.type = 'number'; input.min = '1'; input.max = '9999'; input.step = '1';
        input.value = String(parsed?.episode ?? (suggestions ? suggestion?.episode : file.episode) ?? (selected ? metadata().episode : '') ?? '');
        input.readOnly = !!parsed; ui(input, () => t('{name} 的集数', { name: file.name }), 'ariaLabel');
        tr.dataset.name = file.name; tr.dataset.fileId = file.fileId || '';
        for (const child of [check, input, document.createTextNode(file.name)]) { const td = document.createElement('td'); td.append(child); tr.append(td); }
        for (const control of [check, input]) control.addEventListener('input', () => { confirmed = null; ui(el('mapInfo'), () => t('· 修改未确认')); });
        el('mappingRows').append(tr);
      }
    }
    el('confirmMap').addEventListener('click', () => run(async () => {
      const rows = [...el('mappingRows').children].filter(tr => tr.querySelector('input[type=checkbox]').checked)
        .map(tr => ({ name: tr.dataset.name, fileId: tr.dataset.fileId, episode: Number(tr.querySelector('input[type=number]').value) }));
      const meta = { ...metadata(), season: Number(metadata().season), episode: Number(metadata().episode) };
      confirmed = C.validateMap(files, rows, selectedFile(), meta);
      const n = confirmed.length; ui(el('mapInfo'), () => t('· 已确认 {n} 集', { n }));
      status(() => t('集数对应已确认，加载并勾选跟随后保存。'));
    }));
    el('resetMap').addEventListener('click', () => renderMap());
    el('versions').addEventListener('change', () => renderFiles());
    el('nameLanguage').addEventListener('change', renderNames);
    el('useSearchName').addEventListener('click', () => run(async () => {
      const row = records[Number(el('nameCandidates').value)]; if (!row || el('nameCandidates').value === '') return;
      el('query').value = row.name; el('jimakuAnilist').value = '';
      const value = await send(MSG.EXTERNAL_NAMES, { action: 'select', name: row.name, language: row.language });
      names(metadata(), value.nameState); status(() => t('搜索名称已选择，尚未发起搜索。'));
    }));
    el('officialNames').addEventListener('click', () => run(async () => {
      status(() => t('正在查询官方多语言名称…'));
      const value = await send(MSG.EXTERNAL_NAMES, { action: 'official' });
      names(metadata(), value.nameState);
      status(() => value.unavailable?.length ? t('官方名称查询完成；{languages}暂未取得，已有名称保留。', { languages: list(value.unavailable.map(l => t(N.languages[l]))) }) : t('官方名称候选已更新。'));
    }));
    el('aiNames').addEventListener('click', () => run(async () => {
      status(() => t('正在生成 AI 名称候选…'));
      const value = await send(MSG.EXTERNAL_ASSIST, { action: 'names', metadata: metadata() });
      names(metadata(), value.nameState); status(() => t('AI 名称候选已生成，请确认名称后搜索。'));
    }));
    el('aiFiles').addEventListener('click', () => run(async () => {
      const anchor = selectedFile(); if (!anchor) return;
      status(() => t('正在分析所选版本的文件名…'));
      const value = await send(MSG.EXTERNAL_ASSIST, { action: 'files', source: chosen().source, id: chosen().id,
        filename: anchor.name, fileId: anchor.fileId || '', metadata: metadata() });
      renderMap(value.suggestions); el('mapEditor').open = true; status(() => t('AI 集数候选已生成，尚未确认或保存。'));
    }));
    el('assistSave').addEventListener('click', () => {
      let url;
      try { url = new URL(el('assistBase').value); if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error(); }
      catch (_) { status(() => t('分析 API 地址无效，需要 HTTPS。'), true); return; }
      const grant = chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
      run(async () => {
        if (!await grant) throw new Error('PERMISSION_DENIED');
        config(await send(MSG.EXTERNAL_ASSIST_SAVE, { config: { baseUrl: el('assistBase').value,
          model: el('assistModelInput').value, protocol: el('assistProtocol').value, timeoutMs: 60000 }, apiKey: el('assistKey').value }));
        el('assistKey').value = ''; el('assistSettings').open = false; status(() => t('独立分析 API 已保存；字幕翻译设置未改变。'));
      });
    });
    el('assistClear').addEventListener('click', () => run(async () => {
      config(await send(MSG.EXTERNAL_ASSIST_CLEAR)); el('assistKey').value = ''; status(() => t('独立分析 API 已清除。'));
    }));
    el('assistKeyFile').addEventListener('change', () => run(async () => {
      const file = el('assistKeyFile').files[0]; el('assistKeyFile').value = '';
      if (!file || file.size > 16384) throw new Error('INVALID_KEY');
      const key = (await file.text()).trim();
      if (!key || key.length > 4096 || /\s/.test(key)) throw new Error('INVALID_KEY');
      el('assistKey').value = key; status(() => t('分析 Key 已读取，尚未保存。'));
    }));
    return { names, defaultQuery, setFiles, fileChanged, controls, config, collectionMap: () => confirmed };
  }
  self.CRSubFix.subtitleAssistUI = { init };
})();
