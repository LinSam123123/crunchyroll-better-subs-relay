(function () {
  'use strict';
  const R = self.CRSubFix.translationReview;
  const { t } = self.CRSubFix.i18n;
  const { bind } = self.CRSubFix.workI18n;
  function issueText(issue) {
    if (issue.startsWith('译名待核对：')) return t('译名待核对：{term}', { term: issue.slice('译名待核对：'.length) });
    if (issue.startsWith('专名候选缺少确认译名：') && issue.endsWith('（可能误报）')) {
      return t('专名候选缺少确认译名：{name}（可能误报）', {
        name: issue.slice('专名候选缺少确认译名：'.length, -'（可能误报）'.length),
      });
    }
    if (issue === '称谓待核对：-chan 与同学/小姐') return t('称谓待核对：-chan 与同学/小姐');
    if (issue === '称谓待核对：-san 的社交身份需结合场景') return t('称谓待核对：-san 的社交身份需结合场景');
    return issue;
  }
  self.CRSubFix.workReviewUI = function (api) {
    const { el } = api;
    let runs = [], pending = false, edited = false, page = 0;
    const node = (tag, text, className) => {
      const n = document.createElement(tag);
      n.setAttribute('data-i18n-ignore', '');
      if (typeof text === 'function') n.append(bind(document.createTextNode(''), text));
      else if (text !== undefined) n.textContent = text;
      if (className) n.className = className;
      return n;
    };
    const notice = (text, error = false) => {
      bind(el('review-status'), text); el('review-status').dataset.error = String(error);
    };
    const time = seconds => {
      const value = Math.floor(seconds);
      return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
    };
    function checkCoverage() {
      try {
        const state = api.state(), draft = api.profile();
        const glossary = { ...state.globalGlossary, ...draft.glossary };
        const corpus = state.snapshot?.corpus || state.snapshot?.samples || [];
        const rows = R.coverage(corpus, glossary);
        bind(el('coverage-summary'), () => !state.snapshot ? t('未关联本集字幕。') :
          t('草稿检查：{count} 项候选，{missing} 项无对应译名。', { count: rows.length, missing: rows.filter(r => !r.key).length }) +
          (el('enabled').checked ? '' : t('作品资料辅助翻译当前未勾选。')));
        el('coverage-rows').replaceChildren();
        for (const row of rows) {
          const item = node('div', undefined, 'coverage-row');
          item.append(node('strong', row.source), node('span', () => t('{count} 条 · {translation}', { count: row.count,
            translation: row.key ? t('{target}（{origin}）', { target: row.target,
              origin: Object.hasOwn(draft.glossary, row.key) ? t('作品草稿') : t('全局词表') }) : t('无对应译名'),
          }), 'meta'));
          const example = node('details');
          example.append(node('summary', () => t('原文片段')), node('p', row.sample, 'review-source'));
          item.append(example);
          if (!row.key) {
            const fields = node('div', undefined, 'lookup-search');
            const input = node('input');
            input.maxLength = 200; bind(input, () => t('{source} 的确认译名', { source: row.source }), 'aria-label');
            const add = node('button', () => t('加入草稿'));
            add.type = 'button';
            add.addEventListener('click', () => {
              try {
                const current = api.profile(), target = input.value.trim();
                if (!target) { input.focus(); return; }
                if (Object.hasOwn(current.glossary, row.source) && current.glossary[row.source] !== target &&
                    !confirm(t('替换草稿中的 {source}：{previous} → {target}？', { source: row.source, previous: current.glossary[row.source], target }))) return;
                const next = self.CRSubFix.workProfiles.profile({ ...current,
                  glossary: { ...current.glossary, [row.source]: target } });
                el('glossary').value = JSON.stringify(next.glossary, null, 2);
                api.dirty(); checkCoverage();
              } catch (e) { api.failure(e); }
            });
            fields.append(input, add); item.append(fields);
          }
          el('coverage-rows').append(item);
        }
      } catch (e) { api.failure(e); }
    }
    function controls() {
      el('review-refresh').disabled = pending || !api.state()?.snapshot;
      el('review-runs').disabled = pending;
      el('review-filter').disabled = pending;
      el('review-query').disabled = pending;
      el('review-search').disabled = pending;
      el('review-prev').disabled = pending || page === 0;
      if (pending) el('review-next').disabled = true;
      el('coverage-check').disabled = api.busy() || !api.state()?.snapshot || api.state()?.snapshot?.subtitleState === 'loading';
    }
    function discard() { return !edited || confirm(t('放弃尚未保存的字幕修正？')); }
    function renderRows() {
      const run = runs.find(r => r.key === el('review-runs').value);
      el('review-content').hidden = !run;
      el('review-rows').replaceChildren();
      if (!run) { controls(); return; }
      const profile = run.info.profile;
      bind(el('review-summary'), () => t('{state} · {completed}/{total} 条 · 本版请求记录 {entries} 条 · {issues} 条待核对', {
        state: run.complete ? t('已完成') : run.cached ? t('部分完成') : t('译文缓存不可用'),
        completed: run.completed, total: run.total, entries: run.entries.length,
        issues: run.entries.filter(e => e.issues.length).length,
      }));
      bind(el('review-profile'), () => profile ? `${profile.title} · ${profile.revision}` :
        run.info.workEnabled ? t('已启用，但本次未匹配到作品资料') : t('本次未启用作品资料'));
      el('review-model').textContent = `${run.info.model} · ${run.info.protocol} · ${run.modes.join(', ')} · ${run.ruleVersions.join(', ')}`;
      bind(el('review-reference'), () => [profile?.aliases, profile?.context, profile?.tone].filter(Boolean).join('\n') || t('无背景或风格资料'));
      el('review-glossary').textContent = JSON.stringify(run.info.glossary, null, 2);
      bind(el('review-origins'), () => Object.entries(run.info.origins).map(([key, origin]) =>
        `${key}：${origin === 'work' ? t('作品资料') : t('全局词表')}`).join('；') || t('无术语'));
      const query = el('review-query').value.trim().toLocaleLowerCase();
      const filter = el('review-filter').value;
      const rows = run.entries.filter(e => (filter !== 'issues' || e.issues.length) &&
        (filter !== 'corrected' || e.corrected) &&
        (!query || `${e.text}\n${e.translated || ''}`.toLocaleLowerCase().includes(query)));
      const pages = Math.max(1, Math.ceil(rows.length / 20));
      page = Math.min(page, pages - 1);
      bind(el('review-page'), () => t('{page} / {pages} · {count} 条', { page: page + 1, pages, count: rows.length }));
      el('review-next').disabled = pending || page + 1 >= pages;
      for (const entry of rows.slice(page * 20, page * 20 + 20)) {
        const row = node('div', undefined, 'review-row');
        row.dataset.index = entry.index;
        row.append(node('h3', () => `#${entry.index + 1} · ${entry.timing ? time(entry.timing.start) : t('告示 / 无时间记录')}${entry.corrected ? t(' · 已手动修正') : ''}`));
        row.append(node('p', entry.text, 'review-source'));
        if (entry.sourceLanguage) row.append(node('p', () => t('本次输入语言：{language} · 来源轨：{source}', { language: entry.sourceLanguage, source: run.info.source }), 'meta'));
        if (run.modes.length > 1 || run.ruleVersions.length > 1) row.append(node('p', `${entry.mode} · ${entry.rules}`, 'meta'));
        if (entry.issues.length) row.append(node('p', () => entry.issues.map(issueText).join('；'), 'term-note'));
        const text = node('textarea');
        text.value = entry.translated || ''; text.rows = 2; text.maxLength = 30000;
        bind(text, () => t('第 {index} 条译文', { index: entry.index + 1 }), 'aria-label');
        text.disabled = pending || !run.complete || !entry.timing;
        text.addEventListener('input', () => { edited = true; });
        row.append(text);
        if (run.complete && entry.timing) {
          const save = node('button', () => t('保存本条修正'));
          save.type = 'button'; save.disabled = pending;
          save.addEventListener('click', async () => {
            if (pending || text.value === entry.translated) return;
            if (!text.value.trim()) { notice(() => t('修正译文不能为空。'), true); return; }
            if (!confirm(t('只修改第 {index} 条本地译文，不调用 API。其他未保存的字幕编辑将保留在当前页。继续？', { index: entry.index + 1 }))) return;
            pending = true; controls();
            el('review-rows').querySelectorAll('button, textarea').forEach(n => { n.disabled = true; });
            try {
              const result = await api.save({ key: run.key, index: entry.index, previous: entry.translated, text: text.value });
              const latest = result.runs.find(r => r.key === run.key);
              const updated = latest?.entries.find(e => e.index === entry.index);
              if (!updated) throw new Error('REVIEW_CACHE_EXPIRED');
              // Keep other unsaved textareas intact; only acknowledge this row.
              Object.assign(entry, updated);
              bind(el('review-summary'), () => t('{state} · {completed}/{total} 条 · 本版请求记录 {entries} 条 · {issues} 条待核对', {
                state: t('已完成'), completed: run.completed, total: run.total, entries: run.entries.length,
                issues: run.entries.filter(e => e.issues.length).length,
              }));
              text.value = updated.translated;
              bind(row.querySelector('h3'), () => `#${entry.index + 1} · ${time(entry.timing.start)}${t(' · 已手动修正')}`);
              const note = row.querySelector('.term-note');
              if (note) bind(note, () => entry.issues.map(issueText).join('；'));
              edited = [...el('review-rows').querySelectorAll('.review-row')].some(r => {
                const original = run.entries.find(e => e.index === Number(r.dataset.index));
                return r.querySelector('textarea').value !== (original?.translated || '');
              });
              notice(() => t('本条已保存到本地缓存并通知播放页。未调用 API；作品词表未改变。'));
            } catch (e) { notice(api.errorText(e), true); }
            finally {
              pending = false; controls();
              el('review-rows').querySelectorAll('.review-row').forEach(r => {
                const e = run.entries.find(v => v.index === Number(r.dataset.index));
                r.querySelector('textarea').disabled = !run.complete || !e?.timing;
                r.querySelectorAll('button').forEach(b => { b.disabled = false; });
              });
            }
          });
          row.append(save);
        }
        el('review-rows').append(row);
      }
      edited = false; controls();
    }
    async function refresh() {
      if (pending || !discard()) return;
      pending = true; controls(); notice(() => t('正在读取本地请求记录…'));
      try {
        const key = el('review-runs').value;
        runs = (await api.load()).runs;
        el('review-runs').replaceChildren(...runs.map(r => bind(new Option('', r.key), () =>
          `${new Date(r.updated).toLocaleString()} · ${r.info.source} → ${r.info.target} · ${r.info.profile?.title || t('无作品资料')}`)));
        if (runs.some(r => r.key === key)) el('review-runs').value = key;
        page = 0;
        const hasRuns = !!runs.length;
        notice(() => hasRuns ? t('记录为实际提交请求时的资料快照；待核对项不是确定错译。') :
          t('暂无本集请求记录。旧译文或只命中旧缓存的翻译无法反推出当时使用的资料。'));
      } catch (e) { notice(api.errorText(e), true); }
      finally { pending = false; renderRows(); }
    }
    el('coverage-check').addEventListener('click', checkCoverage);
    el('review-refresh').addEventListener('click', refresh);
    let previousKey = '', previousFilter = el('review-filter').value;
    el('review-runs').addEventListener('focus', () => { previousKey = el('review-runs').value; });
    el('review-runs').addEventListener('change', () => {
      if (!discard()) { el('review-runs').value = previousKey; return; }
      previousKey = el('review-runs').value; page = 0; renderRows();
    });
    el('review-filter').addEventListener('change', () => {
      if (!discard()) { el('review-filter').value = previousFilter; return; }
      previousFilter = el('review-filter').value;
      page = 0; renderRows();
    });
    el('review-search').addEventListener('click', () => { if (!pending && discard()) { page = 0; renderRows(); } });
    for (const [id, step] of [['review-prev', -1], ['review-next', 1]]) {
      el(id).addEventListener('click', () => { if (!pending && discard()) { page += step; renderRows(); } });
    }
    return { controls, refresh, hasPending: () => edited || pending };
  };
})();
