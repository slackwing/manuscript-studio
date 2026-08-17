/**
 * Scratchpad API layer (split out of editor-core.mjs — CODE_REVIEW_AUG_2026.md
 * §1): the CSRF getter, apiCall (the ONE variation/sketch transport — errors
 * carry .status), variationApi, the per-manuscript bookData cache, image
 * upload, and the currentScratchpadId home for newly-created variations
 * (getter/setter — module-boundary state sharing, see the split note in
 * schema.mjs).
 */

// THE CSRF getter is auth.js's getCSRFToken (classic script, loads before
// everything) — call-time lookup so module-eval order doesn't matter.
export const csrf = () => window.getCSRFToken() || '';

// ------------------------------------------------- manuscript data cache

// Per-target-manuscript effective data for Canon views; module-level so
// several sketches targeting one book share fetches within a page.
export const bookData = {
  cache: {},
  async load(manuscriptId, force = false) {
    if (!force && this.cache[manuscriptId]) return this.cache[manuscriptId];
    const p = (async () => {
      const mig = await fetchJSON(`api/migrations/latest?manuscript_id=${manuscriptId}`, {}, false);
      const data = await fetchJSON(`api/migrations/${mig.migration_id}/manuscript`, {}, false);
      let sugMap = {};
      // Suggestions are "tolerated-but-required": a region placed as a
      // suggestion exists ONLY here, so a silently-empty map turns into a
      // missing-anchor error downstream. Transient failures (rate limiting,
      // parallel-suite contention) were the cause of exactly that race —
      // retry with backoff before falling back to empty.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const sug = await fetchJSON(`api/migrations/${mig.migration_id}/suggestions`, {}, false);
          (sug.suggestions || []).forEach(s => { sugMap[s.sentence_id] = s.text; });
          break;
        } catch (e) {
          if (attempt === 2) break; // give up: enhancement degrades, callers may force-fresh retry
          await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        }
      }
      return { migration: mig, sentences: data.sentences || [], sugMap };
    })();
    this.cache[manuscriptId] = p;
    p.catch(() => { delete this.cache[manuscriptId]; });
    return p;
  },
};

// ------------------------------------------------------ variation API

export async function apiCall(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    const msg = (await r.text()).trim();
    const err = new Error(msg || String(r.status));
    err.status = r.status;
    throw err;
  }
  return r.status === 204 ? null : r.json();
}

// currentScratchpadId: the scratchpad a newly-created variation is homed in. The
// modal sets this when it opens a scratchpad (from #scratchpad=N).
let currentScratchpadId = 0;
export function setCurrentScratchpadId(id) { currentScratchpadId = id | 0; }
// Getter seam (module split): pad-notes.mjs homes new notes here.
export function getCurrentScratchpadId() { return currentScratchpadId; }

// ONE transport for the variation/sketch API — apiCall (above) — so every
// error carries `.status` (the 409-freeze pin and the 401 re-login affordance
// both switch on it). Don't mix the global fetchJSON back in here: its error
// message shape differs ("HTTP nnn: body" vs the trimmed body).
export const variationApi = {
  context: (id) => apiCall('GET', `api/variations/${id}`),
  list: (q) => apiCall('GET', `api/variations?q=${encodeURIComponent(q || '')}`),
  createNew: () => apiCall('POST', 'api/sketches', { mode: 'new', scratchpad_id: currentScratchpadId }),
  // Based on a source variation → a new sibling variation (next letter, text copied).
  // No source freezing; the source is left as-is.
  createFrom: (sourceId) => apiCall('POST', 'api/sketches',
    { mode: 'variation', source_variation_id: sourceId, scratchpad_id: currentScratchpadId }),
  // Next-letter variation seeded with raw text — "sketch from placed text".
  createFromText: (sketchId, text) => apiCall('POST', 'api/sketches',
    { mode: 'text', sketch_id: sketchId, text, scratchpad_id: currentScratchpadId }),
  // Suggestion PUT (the book's own primitive) — placement writes region
  // replacements through it, one reviewable suggestion per sentence.
  putSuggestion: (sentenceId, text) => apiCall('PUT', `api/sentences/${encodeURIComponent(sentenceId)}/suggestion`, { text }),
  saveText: (id, text) => apiCall('PUT', `api/variations/${id}`, { text }),
  // ONE lifecycle state (draft | frozen | superseded) — setting frozen or
  // superseded cancels the other (single column server-side).
  setState: (id, state) => apiCall('PUT', `api/variations/${id}/state`, { state }),
  freezeAll: (sketchId) => apiCall('POST', `api/sketches/${sketchId}/freeze-all`),
  link: (sketchId, manuscriptId) => apiCall('PUT', `api/sketches/${sketchId}/link`, { manuscript_id: manuscriptId }),
  canonize: (id, manuscriptId) => apiCall('POST', `api/variations/${id}/canonize`, { manuscript_id: manuscriptId }),
  softDelete: (id) => apiCall('DELETE', `api/variations/${id}`),
  restore: (id) => apiCall('POST', `api/variations/${id}/restore`),
  listDeleted: (q) => apiCall('GET', `api/variations/deleted?q=${encodeURIComponent(q || '')}`),
  home: (id) => apiCall('GET', `api/variations/${id}/home`),
};

// ------------------------------------------------------------ image upload

export async function uploadImage(file) {
  const fd = new FormData();
  fd.append('image', file, file.name || 'image');
  const r = await fetch('api/scratchpad-images', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrf() },
    body: fd,
  });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()).image_id;
}
