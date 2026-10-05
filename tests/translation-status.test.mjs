import test from 'node:test';
import assert from 'node:assert/strict';
import { context, load } from './helpers.mjs';

function status() {
  const label = {}, fill = { style: {} };
  const anchor = { style: {}, dataset: {}, attributes: {},
    setAttribute(k, v) { this.attributes[k] = v; },
    querySelector: selector => selector === '[data-label]' ? label : fill };
  const ctx = context({ clearTimeout, CRSubFix: { ui: {} } });
  load(ctx, 'lib/translation-status.js');
  const ui = ctx.CRSubFix.ui.makeTranslationStatus(() => null, { getAnchor: () => anchor, onPause() {} });
  return { ui, anchor, label, fill };
}
test('ordinary progress only updates the controls button and never needs a panel', () => {
  const { ui, anchor, label, fill } = status();
  ui.start(() => {});
  ui.update(15, 60, 'Ready through 1:00');
  assert.equal(label.textContent, '25%');
  assert.equal(fill.style.width, '25%');
  assert.equal(anchor.attributes['aria-expanded'], 'false');
  ui.finish({ paused: true });
  assert.equal(anchor.dataset.state, 'paused');
});
test('completed final batch and cached completion do not remain in a paused/loading state', () => {
  const { ui, anchor, fill } = status();
  ui.start(() => {});
  ui.update(60, 60, 'Complete');
  ui.finish({ paused: true });
  assert.equal(anchor.dataset.state, 'complete');
  ui.start(() => {});
  ui.finish();
  assert.equal(anchor.dataset.state, 'complete');
  assert.equal(fill.style.width, '100%');
});
