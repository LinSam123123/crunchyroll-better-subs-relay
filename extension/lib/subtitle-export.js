(function () {
  'use strict';
  const NS = self.CRSubFix = self.CRSubFix || {};

  function timestamp(seconds) {
    const ms = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000));
    const pad = (n, size = 2) => String(n).padStart(size, '0');
    return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:` +
      `${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
  }

  function snapshot(record, cues, metadata = {}) {
    const mt = record.kind === 'mt';
    const rows = cues.map((cue, index) => {
      // Equality with the source is not evidence that a cue is untranslated.
      const status = !mt ? 'source_only'
        : cue.translationStatus === 'translated' ? 'translated'
        : cue.translationStatus === 'pending' ? 'pending'
        : record.incomplete ? 'unknown' : 'translated';
      return {
        index: index + 1,
        start: cue.start, end: cue.end,
        status,
        source_text: mt ? (typeof cue.srcText === 'string' ? cue.srcText : null) : (cue.text || ''),
        translated_text: status === 'translated' ? (cue.text || '') : null,
        displayed_text: cue.text || '',
        correction: '', notes: '',
      };
    });
    return {
      schema_version: 1,
      exported_at: new Date().toISOString(),
      episode_id: metadata.episodeId || '',
      episode_title: metadata.title || '',
      episode_url: metadata.url || '',
      track_label: record.label || '',
      source_language: (mt ? record.mtSource : record.lang) || '',
      target_language: mt ? (record.lang || '') : '',
      timeline: 'video_seconds',
      playback_offset_seconds: metadata.offset || 0,
      counts: {
        total: rows.length,
        translated: rows.filter(r => r.status === 'translated').length,
        pending: rows.filter(r => r.status === 'pending').length,
        unknown: rows.filter(r => r.status === 'unknown').length,
        missing_source: rows.filter(r => r.source_text === null).length,
      },
      rows,
    };
  }

  function csvCell(value) {
    let text = String(value ?? '');
    // Quoting alone does not prevent spreadsheet formula execution.
    if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }
  function csv(data) {
    const header = ['index', 'start', 'end', 'source_language', 'target_language',
      'status', 'source_text', 'translated_text', 'displayed_text', 'correction', 'notes'];
    const lines = data.rows.map(r => [
      r.index, timestamp(r.start), timestamp(r.end), data.source_language, data.target_language,
      r.status, r.source_text, r.translated_text, r.displayed_text, r.correction, r.notes,
    ]);
    return '\uFEFF' + [header, ...lines].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
  function srt(data, mode) {
    const entries = [];
    for (const row of data.rows) {
      let body;
      if (mode === 'source') body = row.source_text;
      else if (mode === 'target') body = row.translated_text;
      else {
        const target = row.translated_text;
        const source = row.source_text;
        body = target && source && target !== source ? `${target}\n${source}`
          : target || source || row.displayed_text;
      }
      if (!body) continue;
      entries.push(`${entries.length + 1}\n${timestamp(row.start)} --> ${timestamp(row.end)}\n` +
        body.replace(/\r\n?/g, '\n'));
    }
    return entries.length ? entries.join('\n\n') + '\n' : '';
  }
  function serialize(data, format) {
    if (format === 'csv') return { text: csv(data), suffix: 'proofreading.csv', type: 'text/csv;charset=utf-8' };
    if (format === 'json') return {
      text: JSON.stringify(data, null, 2) + '\n', suffix: 'proofreading.json', type: 'application/json;charset=utf-8',
    };
    if (!['source', 'target', 'bilingual'].includes(format)) throw new Error('Invalid export format');
    return { text: srt(data, format), suffix: `${format}.srt`, type: 'text/plain;charset=utf-8' };
  }
  function filename(data, suffix) {
    const clean = value => String(value).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 70);
    return `subtitles-${clean(data.episode_id)}-${clean(data.track_label) || 'track'}-${suffix}`;
  }
  NS.subtitleExport = { timestamp, snapshot, serialize, filename };
})();
