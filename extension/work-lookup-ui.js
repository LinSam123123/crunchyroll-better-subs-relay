(function () {
  'use strict';
  const L = self.CRSubFix.workLookup;
  const errors = {
    LOOKUP_INVALID_INPUT: '请填写作品名，或检查作品编号。',
    LOOKUP_PERMISSION: '未获得 Bangumi 访问权限，未发送查询。',
    LOOKUP_HTTP_429: 'Bangumi 请求限流，请稍后手动重试。',
    LOOKUP_HTTP_404: '未找到该条目，已有资料保持不变。',
    LOOKUP_NETWORK: '无法连接 Bangumi，已有资料保持不变。',
    LOOKUP_TIMEOUT: 'Bangumi 查询超时，未自动重试。',
    LOOKUP_INVALID_RESPONSE: 'Bangumi 返回了无法读取的资料。',
    LOOKUP_BUSY: '其他资料页正在查询，请稍后重试。',
    LOOKUP_BUDGET: '达到本小时联网查询上限，请稍后再试。',
    LOOKUP_EMPTY_TERM: '勾选项的字幕原文和中文译名都不能为空。',
    LOOKUP_DUPLICATE_TERM: '同一原文勾选了不同译名，请只保留一个。',
    INVALID_WORK_PROFILE: '合并后术语表超出限制或格式无效，草稿未改变。',
  };
  self.CRSubFix.workLookupUI = function (api) {
    const $ = api.el;
    let sources = {}, current = null, nextOffset = null, retryOffset = null, rows = [];
    let modelDraft = null, pending = false, loadedIds = new Set();
    function node(tag, text, className) {
      const n = document.createElement(tag);
      if (text) n.textContent = text;
      if (className) n.className = className;
      return n;
    }
    function link(text, url) {
      const a = node('a', text);
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      return a;
    }
    function status(text, error = false) {
      $('lookup-status').textContent = text;
      $('lookup-status').dataset.error = String(error);
    }
    function glossary() {
      let value;
      try { value = JSON.parse($('glossary').value || '{}'); } catch (_) { throw new Error('INVALID_WORK_PROFILE'); }
      return self.CRSubFix.workProfiles.profile({ title: 'validation', glossary: value }).glossary;
    }
    function renderSources() {
      let refs = {};
      try { refs = L.provenance(sources, glossary()); } catch (_) {}
      $('term-source-list').replaceChildren();
      for (const [name, item] of Object.entries(refs)) {
        const li = node('li');
        li.append(document.createTextNode(`${name} → ${item.target} · `),
          link('Bangumi 角色', L.sourceUrl('character', item.characterId)), document.createTextNode(' · '),
          link('作品', L.sourceUrl('subject', item.subjectId)),
          document.createTextNode(` · ${item.method === 'model-assisted' ? '模型整理参考 · ' : ''}${new Date(item.fetchedAt).toLocaleDateString()}`));
        $('term-source-list').append(li);
      }
      $('term-sources').hidden = !Object.keys(refs).length;
    }
    function renderGlossary(message = '') {
      $('glossary-entries').replaceChildren();
      let entries;
      try { entries = glossary(); }
      catch (_) { $('glossary-status').textContent = '术语表 JSON 无效，暂不能逐项编辑。'; return; }
      $('glossary-status').textContent = message || `当前草稿 ${Object.keys(entries).length} 项。未勾选的候选不会删除已有词条。`;
      const risks = self.CRSubFix.translationReview.glossaryRisks(entries);
      for (const [source, target] of Object.entries(entries)) {
        const row = node('div', '', 'glossary-entry');
        row.dataset.source = source;
        const input = document.createElement('input');
        input.value = target; input.maxLength = 200;
        input.setAttribute('aria-label', `${source} 的草稿译名`);
        const apply = node('button', '应用'), remove = node('button', '删除', 'danger');
        apply.type = remove.type = 'button';
        const change = value => {
          if (api.busy()) return;
          try {
            const current = glossary();
            if (current[source] !== target) { renderGlossary('词条已变更，请重新核对。'); return; }
            if (value === null) {
              if (!confirm(`从草稿删除 ${source} → ${target}？已保存资料和现有字幕不变，确认并保存后才影响后续翻译。`)) return;
              delete current[source];
            } else {
              value = value.trim();
              if (!value) { input.focus(); return; }
              current[source] = value;
            }
            const next = self.CRSubFix.workProfiles.profile({ title: 'validation', glossary: current }).glossary;
            $('glossary').value = JSON.stringify(next, null, 2);
            sources = L.provenance(sources, next);
            api.dirty(); renderSources(); refreshNotes();
            const global = api.state()?.globalGlossary || {};
            renderGlossary(`${source} 已${value === null ? '从草稿删除' : '更新到草稿'}，尚未保存。未调用 API。` +
              (value === null && Object.hasOwn(global, source) ? ` 全局词表仍有 ${source} → ${global[source]}，可在翻译设置核对。` : ''));
          } catch (e) { status(errors[e.message] || '词条修改失败，草稿保持不变。', true); }
        };
        apply.addEventListener('click', () => change(input.value));
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); change(input.value); }
        });
        remove.addEventListener('click', () => change(null));
        row.append(node('strong', source), input, apply, remove);
        if (risks.some(risk => risk.source === source)) row.append(node('p', '称谓固定为社交身份，需按人物关系核对。', 'term-note'));
        $('glossary-entries').append(row);
      }
    }
    function controls() {
      const supported = (api.state()?.snapshot?.target || api.state()?.profiles?.find(p =>
        p.key === $('profiles').value)?.target || api.state()?.target) === 'zh-CN';
      $('lookup-search').disabled = api.busy() || !supported || api.state()?.snapshot?.subtitleState === 'loading';
      $('lookup-organize').disabled = api.busy() || !supported || !api.state()?.canGenerate || !loadedIds.size ||
        api.state()?.snapshot?.subtitleState === 'loading';
      $('generate').textContent = current ? '用联网资料整理草稿（调用 API）' : '仅凭字幕生成资料（调用 API）';
      if (!supported) status('Bangumi 中文术语候选目前仅支持目标语言 zh-CN。');
    }
    function reset(value) {
      sources = value?.glossarySources || {};
      current = null; rows = []; nextOffset = null; retryOffset = null;
      modelDraft = null; pending = false; loadedIds = new Set();
      $('organized-reference').hidden = true;
      $('organize-summary').textContent = '';
      $('lookup-query').value = value?.title || '';
      $('lookup-subjects').replaceChildren();
      $('lookup-rows').replaceChildren();
      $('lookup-terms').hidden = true;
      $('lookup-more').hidden = true;
      $('lookup-retry').hidden = true;
      $('lookup-replace').checked = false;
      $('lookup-matched').checked = !!api.state()?.snapshot;
      const savedCount = Object.keys(value?.glossary || {}).length;
      status(savedCount ? `已载入 ${savedCount} 项术语；来源记录见下方。本页未发起新查询。` : '本页未查询；当前资料没有术语。');
      renderSources();
      renderGlossary();
      controls();
    }
    async function run(fn, message) {
      if (api.busy()) return;
      api.setBusy(true); status(message);
      try { await fn(); }
      catch (e) { status(errors[e.message] || api.errorText(e) || '联网查询未完成，草稿和已保存资料保持不变。', true); }
      finally { api.setBusy(false); }
    }
    function filter() {
      let count = 0;
      for (const row of rows) {
        row.element.hidden = $('lookup-matched').checked && !row.matched;
        if (row.element.hidden) row.pick.checked = false;
        else count++;
      }
      $('lookup-empty')?.remove();
      if (!count) {
        const empty = node('p', rows.length ? '本集没有精确匹配。可取消上方筛选，核对原文拼写。' : '暂无角色候选。', 'meta');
        empty.id = 'lookup-empty'; $('lookup-rows').append(empty);
      }
    }
    function refreshNotes() {
      let existing;
      try { existing = glossary(); } catch (_) { return; }
      for (const row of rows) {
        const key = row.source.value.trim();
        const old = Object.hasOwn(existing, key) ? existing[key] : '';
        const conflict = old && old !== row.target.value.trim();
        row.note.textContent = old
          ? `已有译名：${old}${conflict ? ' · 冲突项默认保留原值' : ' · 与候选一致'}`
          : row.modelNote ? row.modelNote
          : row.fragment ? '仅匹配姓名片段，中文简称待填写；不会预填角色全名。'
            : row.matched ? '原文精确匹配，译名待确认。' : '未在本集匹配，请核对字幕原文；没有对应别名时需手动填写。';
        if (old && row.modelNote) row.note.textContent += ` · ${row.modelNote}`;
      }
    }
    function appendCharacters(result) {
      pending = true;
      const existing = glossary();
      const texts = [...(api.state()?.snapshot?.corpus || api.state()?.snapshot?.samples || []), ...Object.keys(existing)];
      for (const character of result.characters) {
        loadedIds.add(character.id);
        if (rows.some(row => row.characterId === character.id)) continue;
        const matches = L.matches(character, texts);
        const fallback = character.aliases.find(alias => /^[A-Za-z]/.test(alias)) || character.name;
        const candidates = matches.length ? matches : [{ source: fallback, fragment: false }];
        for (const match of candidates) {
          const element = node('div', '', 'lookup-row');
          const pickLabel = node('label', '', 'term-pick'), pick = document.createElement('input');
          pick.type = 'checkbox';
          pickLabel.append(pick, document.createTextNode(`${character.nameCn || '暂无中文名'} · ${character.name}`));
          const fields = node('div', '', 'term-fields');
          const source = document.createElement('input'), target = document.createElement('input');
          source.maxLength = target.maxLength = 200;
          source.value = match.source;
          target.value = match.fragment ? '' : character.nameCn;
          source.setAttribute('aria-label', '字幕原文'); target.setAttribute('aria-label', '中文译名');
          for (const [labelText, input] of [['字幕原文', source], ['中文译名', target]]) {
            const label = node('label', labelText); label.append(input); fields.append(label);
          }
          const note = node('p', '', 'meta term-note');
          element.append(pickLabel, fields, note,
            link('Bangumi 角色来源', character.url));
          $('lookup-rows').append(element);
          const row = { element, pick, source, target, note, characterId: character.id,
            matched: matches.length > 0, fragment: match.fragment,
            provenance: { provider: 'bangumi', subjectId: result.subjectId, characterId: character.id,
              fetchedAt: result.fetchedAt } };
          rows.push(row);
          source.addEventListener('input', refreshNotes); target.addEventListener('input', refreshNotes);
        }
      }
      nextOffset = result.nextOffset;
      if (result.failedIds.length) retryOffset = result.offset;
      else if (retryOffset === result.offset) retryOffset = null;
      $('lookup-more').hidden = nextOffset === null;
      $('lookup-more').disabled = retryOffset !== null;
      $('lookup-retry').hidden = retryOffset === null;
      refreshNotes(); filter();
      status(`${result.cached ? '缓存' : '联网'}角色资料：本页 ${result.characters.length} 项，共 ${result.total} 个角色。` +
        (result.failedIds.length ? ` ${result.failedIds.length} 项未能读取，可手动重试。` : '') +
        ' 候选未合并、未保存。', result.failedIds.length > 0);
      $('organize-summary').textContent = `已载入 ${loadedIds.size} 个角色 / 共 ${result.total} 个；模型只使用已载入资料。`;
    }
    async function loadCharacters(offset) {
      const result = await api.send({ action: 'characters', subjectId: current.id, offset, refresh: offset === retryOffset });
      appendCharacters(result);
    }
    $('lookup-search').addEventListener('click', () => {
      if (api.busy()) return;
      let query;
      try { query = L.query($('lookup-query').value); }
      catch (e) { status(errors[e.message], true); return; }
      if (!confirm('向 Bangumi 查询此作品名及后续选定的角色条目？不会发送字幕、背景、API Key，也不会调用中转模型。')) return;
      // Permission is requested directly inside the user gesture, before awaiting.
      const permission = chrome.permissions.request({ origins: [L.PERMISSION] });
      run(async () => {
        if (!await permission) throw new Error('LOOKUP_PERMISSION');
        const result = await api.send({ action: 'search', query });
        current = null; rows = []; nextOffset = null; retryOffset = null;
        loadedIds = new Set(); modelDraft = null; pending = false;
        $('organized-reference').hidden = true;
        $('lookup-terms').hidden = true;
        $('lookup-subjects').replaceChildren();
        for (const subject of result.subjects) {
          const entry = node('div', '', 'lookup-subject');
          const text = node('div');
          text.append(node('strong', subject.nameCn || subject.name),
            node('p', [subject.name, subject.date, subject.platform].filter(Boolean).join(' · '), 'meta'),
            link('Bangumi 来源', subject.url));
          const choose = node('button', '选择此作品');
          choose.type = 'button';
          choose.addEventListener('click', () => run(async () => {
            const response = await api.send({ action: 'characters', subjectId: subject.id, offset: 0 });
            current = subject; rows = []; retryOffset = null; loadedIds = new Set(); modelDraft = null;
            $('organized-reference').hidden = true;
            $('lookup-rows').replaceChildren();
            $('lookup-replace').checked = false;
            $('lookup-title').textContent = subject.nameCn || subject.name;
            $('lookup-source').href = subject.url;
            $('lookup-terms').hidden = false;
            appendCharacters(response);
          }, '正在读取角色名称…'));
          entry.append(text, choose); $('lookup-subjects').append(entry);
        }
        status(result.subjects.length
          ? `${result.cached ? '缓存' : '联网'}返回 ${result.subjects.length} 部作品，请核对季度和日期后选择。`
          : '没有找到匹配作品。请尝试较短的中文名、日文原名或其他别名。');
      }, '正在查询 Bangumi…');
    });
    $('lookup-query').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); $('lookup-search').click(); }
    });
    $('lookup-section').addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault();
    });
    $('lookup-matched').addEventListener('change', filter);
    $('lookup-more').addEventListener('click', () => run(() => loadCharacters(nextOffset), '正在读取更多角色…'));
    $('lookup-retry').addEventListener('click', () => run(() => loadCharacters(retryOffset), '正在重试未完整页…'));
    $('lookup-merge').addEventListener('click', () => {
      if (api.busy()) return;
      const picked = rows.filter(row => row.pick.checked && !row.element.hidden);
      const adoptContext = !!modelDraft && $('adopt-context').checked;
      const adoptTone = !!modelDraft && $('adopt-tone').checked;
      if (!picked.length && !adoptContext && !adoptTone) { status('请先勾选需要的术语或候选背景/风格。', true); return; }
      try {
        const before = glossary();
        const merged = L.merge(before, sources, picked.map(row => ({
          source: row.source.value, target: row.target.value, provenance: row.provenance,
        })), $('lookup-replace').checked);
        self.CRSubFix.workProfiles.profile({ title: 'validation', glossary: merged.glossary, glossarySources: merged.sources });
        const replaced = Object.keys(before).filter(key => before[key] !== merged.glossary[key]);
        if (replaced.length && !confirm(`确认替换以下已编辑译名？\n${replaced.map(k => `${k}: ${before[k]} → ${merged.glossary[k]}`).join('\n')}`)) return;
        $('glossary').value = JSON.stringify(merged.glossary, null, 2);
        if (adoptContext) $('context').value = $('organized-context').value;
        if (adoptTone) $('tone').value = $('organized-tone').value;
        sources = merged.sources;
        pending = false; modelDraft = null;
        $('organized-reference').hidden = true;
        api.dirty();
        renderSources(); refreshNotes();
        renderGlossary();
        picked.forEach(row => { row.pick.checked = false; });
        status(`已合并到草稿：${Object.keys(merged.glossary).length} 项术语，尚未保存。${merged.conflicts.length ? ` 保留 ${merged.conflicts.length} 项冲突译名：${merged.conflicts.join('、')}` : ''}`);
      } catch (e) { status(errors[e.message] || '合并失败，草稿未改变。', true); }
    });
    function showOrganized(draft) {
      modelDraft = draft; pending = true;
      rows = []; $('lookup-rows').replaceChildren();
      $('lookup-more').hidden = true; $('lookup-retry').hidden = true;
      $('organized-reference').hidden = false;
      $('organized-context').value = draft.context;
      $('organized-tone').value = draft.tone;
      $('adopt-context').checked = !$('context').value.trim() && !!draft.context;
      $('adopt-tone').checked = !$('tone').value.trim() && !!draft.tone;
      $('lookup-matched').checked = false;
      const existing = glossary();
      for (const term of draft.terms) {
        const element = node('div', '', 'lookup-row');
        const label = node('label', '', 'term-pick'), pick = document.createElement('input');
        pick.type = 'checkbox';
        pick.checked = term.status === 'suggested' &&
          (!Object.hasOwn(existing, term.source) || existing[term.source] === term.target);
        label.append(pick, document.createTextNode(term.status === 'suggested' ? '模型建议 · 待确认' : '不确定 · 需手动核对'));
        const fields = node('div', '', 'term-fields');
        const source = document.createElement('input'), target = document.createElement('input');
        source.maxLength = target.maxLength = 200;
        source.value = term.source; target.value = term.target;
        for (const [text, input] of [['字幕原文', source], ['中文译名', target]]) {
          input.setAttribute('aria-label', text);
          const field = node('label', text); field.append(input); fields.append(field);
        }
        const note = node('p', term.note, 'meta term-note');
        element.append(label, fields, note);
        if (term.provenance) element.append(link('模型参考的 Bangumi 角色', L.sourceUrl('character', term.characterId)));
        $('lookup-rows').append(element);
        rows.push({ element, pick, source, target, note, matched: true, characterId: term.characterId,
          provenance: term.provenance, modelNote: term.note || '模型整理建议，仍需核对。' });
        source.addEventListener('input', refreshNotes); target.addEventListener('input', refreshNotes);
      }
      refreshNotes(); filter();
      status(`整理完成：${draft.terms.length} 项候选，其中 ${draft.terms.filter(t => t.status === 'uncertain').length} 项不确定。尚未合并或保存。`);
      $('organized-reference').scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    async function organize() {
      if (api.busy() || !current || !loadedIds.size || !api.state()?.canGenerate ||
          api.state()?.snapshot?.subtitleState === 'loading') return;
      let profile;
      try { profile = api.profile(); } catch (_) { status(errors.INVALID_WORK_PROFILE, true); return; }
      if (!confirm(`将向中转模型 ${api.state().model} 发送已载入的 ${Math.min(60, loadedIds.size)} 个角色名称资料、本集原文（最多 40,000 字符）、开头背景样本和当前编辑资料。可能计费，不自动重试。结果仅进入预览，不覆盖已有词表。继续？`)) return;
      await run(async () => {
        const result = await api.organize({ subjectId: current.id, characterIds: [...loadedIds].slice(0, 60), profile });
        showOrganized(result.draft);
      }, '正在结合联网资料整理候选，请等待…');
    }
    function beforeSave(profile) {
      const unapplied = [...$('glossary-entries').children].some(row =>
        row.querySelector('input').value.trim() !== profile.glossary[row.dataset.source]);
      if (unapplied) {
        api.warning('逐项编辑区还有未应用的译名，请先应用该词条或恢复原值。');
        $('glossary-editor').open = true;
        return false;
      }
      if (rows.some(row => row.pick.checked) || modelDraft) {
        api.warning('还有候选尚未合并。请先点击“合并勾选项到草稿”，再保存。');
        $('lookup-merge').scrollIntoView({ block: 'center' }); $('lookup-merge').focus();
        return false;
      }
      if (pending && !Object.keys(profile.glossary).length && !profile.context && !profile.tone) {
        api.warning('查询结果尚未加入资料，术语表仍为空。请先整理或勾选合并候选，不能直接保存成空资料。');
        $('lookup-organize').scrollIntoView({ block: 'center' }); $('lookup-organize').focus();
        return false;
      }
      const risks = self.CRSubFix.translationReview.glossaryRisks({ ...api.state()?.globalGlossary, ...profile.glossary });
      if (risks.length && !confirm(`草稿仍有固定称谓词条：\n${risks.map(r => `${r.source} → ${r.target}`).join('\n')}\n未勾选候选不会删除这些词条。仍保留并保存？`)) return false;
      return !pending || confirm('还有未采用的联网候选。本次只保存下面编辑区的资料，不采用这些候选。继续？');
    }
    function saved(value) {
      sources = value?.glossarySources || {}; pending = false;
      renderSources(); refreshNotes();
      renderGlossary();
      status(`已保存 ${Object.keys(value?.glossary || {}).length} 项术语，${Object.keys(sources).length} 项有来源记录。未发起翻译。`);
    }
    $('lookup-organize').addEventListener('click', organize);
    $('lookup-discard').addEventListener('click', () => {
      if (api.busy() || !confirm('放弃本次未合并的候选？下面已编辑的资料和已保存资料不会改变。')) return;
      rows = []; modelDraft = null; pending = false;
      $('lookup-rows').replaceChildren(); $('organized-reference').hidden = true;
      $('lookup-more').hidden = true; $('lookup-retry').hidden = true;
      status('本次候选已放弃，编辑区和已保存资料保持不变。');
    });
    $('glossary').addEventListener('input', () => { renderSources(); refreshNotes(); renderGlossary(); });
    $('glossary-editor').addEventListener('toggle', () => {
      if ($('glossary-editor').open && !$('glossary-entries').children.length) renderGlossary();
    });
    return { reset, controls, organize, beforeSave, saved, hasSelection: () => !!current,
      hasPending: () => !!modelDraft || rows.some(row => row.pick.checked),
      sources: () => L.provenance(sources, glossary()) };
  };
})();
