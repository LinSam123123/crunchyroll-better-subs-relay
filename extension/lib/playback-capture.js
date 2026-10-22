// Bounded, memory-only capture of playback data arriving before SPA navigation.
(function () {
  'use strict';
  const NS = self.CRSubFix;
  NS.createPlaybackCapture = function ({ current, watchGuid, apply, now = Date.now }) {
    const entries = new Map();
    let sequence = 0;
    const matches = (entry, guid) => entry.guid === guid ||
      NS.playbackApi.audioVersions(entry.data).some(v => v.guid === guid);
    function prune() {
      for (const [key, entry] of entries) {
        if (now() - entry.created > 120000 || entry.owner?.disposed) entries.delete(key);
      }
      while (entries.size > 4) entries.delete(entries.keys().next().value);
    }
    function begin(guid, auth) {
      const ep = current();
      const owner = ep && (ep.guid === guid || ep.catalog.versions().some(v => v.guid === guid)) ? ep : null;
      return { guid, auth, owner, sequence: ++sequence, created: now() };
    }
    function drain() {
      prune();
      const ep = current();
      if (!ep || ep.disposed || ep.guid !== watchGuid()) return;
      for (const entry of entries.values()) {
        if (entry.applied === ep || !matches(entry, ep.guid)) continue;
        entry.applied = ep;
        entry.owner = ep;
        apply(ep, entry.data, entry.guid, entry.auth);
      }
    }
    function receive(entry, data) {
      if (now() - entry.created > 120000 || entry.owner?.disposed ||
          !data || typeof data.audioLocale !== 'string') return;
      if ((entries.get(entry.guid)?.sequence || 0) > entry.sequence) return;
      entries.delete(entry.guid);
      entries.set(entry.guid, { ...entry, data });
      drain();
    }
    return { begin, receive, drain };
  };
})();
