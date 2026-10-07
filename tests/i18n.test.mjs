import assert from 'node:assert/strict';
import test from 'node:test';
import { context, load, background } from './helpers.mjs';

test('interface locale resolves browser preference and falls back without API calls', () => {
  for (const [browser, expected] of [['zh-CN', 'zh-Hans'], ['zh-SG', 'zh-Hans'], ['zh-TW', 'zh-Hant'],
    ['zh-HK', 'zh-Hant'], ['zh-Hant', 'zh-Hant'], ['ja-JP', 'ja'], ['en-US', 'en'], ['fr-FR', 'en']]) {
    const ctx = context({ navigator: { languages: [browser, 'ja'] }, fetch() { throw new Error('UNEXPECTED_NETWORK'); } });
    load(ctx, 'lib/i18n.js');
    assert.equal(ctx.CRSubFix.i18n.getLanguage(), expected);
    assert.equal(ctx.CRSubFix.i18n.resolve('zh-Hans'), 'zh-Hans');
  }
});

test('catalog lookup interpolates plain text and treats unknown content as data', () => {
  const ctx = context(); load(ctx, 'lib/i18n.js');
  const I = ctx.CRSubFix.i18n;
  I.add({ '第 {n} 集': { en: 'Episode {n}', ja: '第 {n} 話', 'zh-Hant': '第 {n} 集' },
    Save: { en: 'Save', ja: '保存', 'zh-Hans': '保存', 'zh-Hant': '儲存' } });
  I.setLanguage('ja');
  assert.equal(I.t('第 {n} 集', { n: 3 }), '第 3 話');
  assert.equal(I.t('第 {n} 集', { n: '<script>data</script>' }), '第 <script>data</script> 話');
  assert.equal(I.t('[Release] Work S01E03.ja.srt'), '[Release] Work S01E03.ja.srt');
  I.setLanguage('zh-Hans'); assert.equal(I.t('Save'), '保存');
  I.setLanguage('zh-Hant'); assert.equal(I.t('已保存。'), '已儲存。');
});

test('interface preference reads and writes only its own storage key on trusted pages', async () => {
  const calls = [], changed = [];
  const ctx = context({ location: { protocol: 'chrome-extension:' }, navigator: { language: 'en' }, chrome: {
    storage: { local: { async get(key) { calls.push(['get', key]); return { uiLanguage: 'ja' }; },
      async set(data) { calls.push(['set', data]); } }, onChanged: { addListener(fn) { changed.push(fn); } } },
  } });
  load(ctx, 'lib/i18n.js'); await ctx.CRSubFix.i18n.ready;
  assert.equal(ctx.CRSubFix.i18n.getLanguage(), 'ja');
  await ctx.CRSubFix.i18n.saveLanguage('zh-Hant');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['get', 'uiLanguage'], ['set', { uiLanguage: 'zh-Hant' }]]);
  assert.equal(ctx.CRSubFix.i18n.getPreference(), 'zh-Hant');
  changed[0]({ uiLanguage: { newValue: 'en' } }, 'local');
  assert.equal(ctx.CRSubFix.i18n.getLanguage(), 'en');
  await assert.rejects(() => ctx.CRSubFix.i18n.saveLanguage('invalid'), /INVALID_UI_LANGUAGE/);
});

test('website runtime does not read trusted storage or rewrite website content', async () => {
  const ctx = context({ location: { protocol: 'https:' }, chrome: { storage: { local: {
    get() { throw new Error('UNAUTHORIZED_READ'); }, set() { throw new Error('UNAUTHORIZED_WRITE'); },
  } } } });
  load(ctx, 'lib/i18n.js'); await ctx.CRSubFix.i18n.ready;
  await assert.rejects(() => ctx.CRSubFix.i18n.saveLanguage('ja'), /UI_LANGUAGE_STORAGE_UNAVAILABLE/);
});

test('public interface language setting cannot change subtitle target or relay configuration', async () => {
  const b = background({ data: { mtTarget: 'zh-CN', relayConfig: { model: 'synthetic-model' } } });
  const before = JSON.stringify(b.local.relayConfig);
  const type = b.ctx.CRSubFix.protocol.MSG.SET_PUBLIC_SETTING;
  assert.ok(type);
  const result = await b.send(type, { key: 'uiLanguage', value: 'ja' }, b.content);
  assert.equal(result.ok, true); assert.equal(b.local.uiLanguage, 'ja');
  assert.equal(b.local.mtTarget, 'zh-CN'); assert.equal(JSON.stringify(b.local.relayConfig), before);
  const invalid = await b.send(type, { key: 'uiLanguage', value: 'untrusted' }, b.content);
  assert.equal(invalid.ok, false); assert.equal(b.local.uiLanguage, 'ja');
});

test('bundled catalogs cover all four locales and preserve substitution slots', () => {
  const ctx = context(); load(ctx, 'lib/i18n.js');
  for (const name of ['translation', 'subtitles', 'work', 'player']) {
    const before = Object.keys(ctx.CRSubFix.i18n.catalog()).length;
    load(ctx, `lib/i18n-${name}.js`);
    assert.ok(Object.keys(ctx.CRSubFix.i18n.catalog()).length - before > 30, `${name}: incomplete catalog`);
  }
  const I = ctx.CRSubFix.i18n;
  const slots = text => [...String(text).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  load(ctx, 'lib/i18n-local.js');
  const catalog = I.catalog();
  assert.ok(Object.keys(catalog).length > 100);
  for (const [source, entry] of Object.entries(catalog)) {
    if (!/[\p{Script=Han}]/u.test(entry.source) && /[\p{Script=Han}]/u.test(entry['zh-Hant'])) {
      assert.equal(typeof entry['zh-Hans'], 'string', `Missing Simplified Chinese: ${source}`);
    }
    for (const language of ['en', 'ja', 'zh-Hant']) {
      assert.equal(typeof entry[language], 'string', `${language}: ${source}`);
      assert.ok(entry[language].trim(), `${language}: ${source}`);
      assert.deepEqual(slots(entry[language]), slots(entry.source), `${language}: placeholder mismatch: ${source}`);
    }
  }
});
