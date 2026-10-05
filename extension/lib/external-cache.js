(function () {
  'use strict';
  function create(factory = self.indexedDB) {
    if (!factory) return null;
    let opening;
    function open() {
      if (!opening) opening = new Promise((resolve, reject) => {
        const request = factory.open('cr-external-subtitles', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('cache');
        request.onerror = () => reject(new Error('EXTERNAL_CACHE_SAVE_FAILED'));
        request.onblocked = () => reject(new Error('EXTERNAL_CACHE_SAVE_FAILED'));
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); opening = null; };
          resolve(db);
        };
      }).catch(error => { opening = null; throw error; });
      return opening;
    }
    async function transaction(mode, operation) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('cache', mode);
        const request = operation(tx.objectStore('cache'));
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = tx.onerror = () => reject(new Error('EXTERNAL_CACHE_SAVE_FAILED'));
      });
    }
    return {
      get: () => transaction('readonly', store => store.get('externalSubCache')),
      set: value => transaction('readwrite', store => store.put(value, 'externalSubCache')),
    };
  }
  self.CRSubFix = self.CRSubFix || {};
  self.CRSubFix.externalCache = { create };
})();
