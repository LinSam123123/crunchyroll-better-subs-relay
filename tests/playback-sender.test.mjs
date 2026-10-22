import test from 'node:test';
import assert from 'node:assert/strict';
import { background, savePayload, config, json } from './helpers.mjs';

async function fixture(stream = false) {
  const app = background({ fetcher: stream ? async () => {
    const content = JSON.stringify({ id: '0', text: 'Translated' }) + '\n';
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n` +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
  } : undefined });
  await app.send('MT_SAVE_CONFIG', savePayload({ config: { ...config, translationMode: stream ? 'episode-stream' : 'batch' } }));
  let guid = 'NEXT';
  const probes = [];
  app.ctx.chrome.tabs.sendMessage = async (tab, message, options) => {
    if (message.type !== 'WORK_PAGE_CHECK') return;
    probes.push(json({ tab, options }));
    return { guid, url: `https://www.crunchyroll.com/zh-tw/watch/${guid}/title` };
  };
  app.ctx.chrome.tabs.create = async () => ({ id: 2 });
  const sender = { ...app.content, url: 'https://www.crunchyroll.com/zh-tw/series/SERIES/title', documentId: 'same-document' };
  const cache = { guid, key: 'sender:next', total: 1, configTag: app.local.mtConfigTag };
  const payload = { texts: ['Hello'], items: [{ id: '0', text: 'Hello' }], indices: [0], source: 'en-US',
    target: 'zh-CN', provider: 'relay', configTag: app.local.mtConfigTag, cache };
  return { app, sender, cache, payload, probes, navigate: id => { guid = id; } };
}
async function done(port) {
  for (let i = 0; i < 200; i++) {
    if (port.messages.some(m => m.type === 'done')) return port.messages.at(-1);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Stream did not finish');
}
const fetchCount = app => app.calls.filter(call => Array.isArray(call) && call[0] === 'fetch').length;

test('series-page sender can translate, save progress and open work on the current SPA episode', async () => {
  const w = await fixture();
  assert.equal((await w.app.send('WORK_CONTEXT', { guid: 'NEXT' }, w.sender)).ok, true);
  assert.equal((await w.app.send('MT_TRANSLATE', w.payload, w.sender)).ok, true);
  assert.equal((await w.app.send('MT_PROGRESS', { ...w.cache, action: 'save', entries: [{ index: 0, text: 'Saved' }] }, w.sender)).ok, true);
  assert.deepEqual((await w.app.send('MT_PROGRESS', { ...w.cache, action: 'get' }, w.sender)).values, ['Saved']);
  const work = await w.app.send('WORK_OPEN', { guid: 'NEXT', samples: [] }, w.sender);
  assert.equal(work.ok, true);
  assert.equal((await w.app.send('WORK_UPDATE', { guid: 'NEXT', snapshot: work.snapshot, samples: ['Hello'] }, w.sender)).ok, true);
  assert.ok(w.probes.every(probe => probe.tab === 1 && probe.options.frameId === 0 && probe.options.documentId === 'same-document'));
});

test('old watch sender follows current episode but stale cache and work requests remain rejected', async () => {
  const w = await fixture();
  w.sender.url = w.app.content.url;
  assert.equal((await w.app.send('MT_TRANSLATE', w.payload, w.sender)).ok, true);
  w.navigate('THIRD');
  for (const [type, payload] of [['MT_TRANSLATE', w.payload], ['MT_PROGRESS', { ...w.cache, action: 'clear' }],
    ['WORK_CONTEXT', { guid: 'NEXT' }], ['WORK_OPEN', { guid: 'NEXT', samples: [] }]]) {
    assert.equal((await w.app.send(type, payload, w.sender)).error, 'SENDER_NOT_ALLOWED');
  }
  assert.equal(fetchCount(w.app), 1);
});

test('missing, inconsistent, foreign and non-watch page checks fail closed without provider calls', async () => {
  const w = await fixture();
  for (const reply of [undefined, { guid: 'NEXT' }, { guid: 'OTHER', url: 'https://www.crunchyroll.com/watch/NEXT/x' },
    { guid: 'NEXT', url: 'https://evil.example/watch/NEXT/x' }, { guid: 'NEXT', url: 'https://www.crunchyroll.com/series/NEXT/x' }]) {
    w.app.ctx.chrome.tabs.sendMessage = async () => reply;
    assert.equal((await w.app.send('MT_TRANSLATE', w.payload, w.sender)).error, 'SENDER_NOT_ALLOWED');
  }
  w.app.ctx.chrome.tabs.sendMessage = async () => { throw new Error('Document closed'); };
  assert.equal((await w.app.send('MT_TRANSLATE', w.payload, w.sender)).error, 'SENDER_NOT_ALLOWED');
  assert.equal(fetchCount(w.app), 0);
});

test('stream started after an SPA hop validates the current document and saves the current episode', async () => {
  const w = await fixture(true);
  const port = w.app.connect(w.sender);
  port.post({ type: 'start', payload: w.payload });
  assert.equal((await done(port)).ok, true);
  assert.deepEqual(w.app.local['mtProgress:sender:next'].values, ['Translated']);
  w.navigate('THIRD');
  const stale = w.app.connect(w.sender);
  stale.post({ type: 'start', payload: w.payload });
  assert.equal((await done(stale)).error, 'SENDER_NOT_ALLOWED');
  assert.equal(fetchCount(w.app), 1);
});

test('disconnect during page verification cannot start a paid stream afterwards', async () => {
  const w = await fixture(true);
  let release;
  w.app.ctx.chrome.tabs.sendMessage = () => new Promise(resolve => { release = resolve; });
  const port = w.app.connect(w.sender);
  port.post({ type: 'start', payload: w.payload });
  port.disconnect();
  release({ guid: 'NEXT', url: 'https://www.crunchyroll.com/watch/NEXT/x' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fetchCount(w.app), 0);
  assert.deepEqual(port.messages, []);
});
