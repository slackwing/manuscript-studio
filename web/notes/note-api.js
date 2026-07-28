/**
 * note-api.js — a PURE CRUD wrapper over /api/notes/* (NOTES_PLAN.md Phase 1c).
 *
 * No cache, no rendering, no rainbow bars — just fetch. The manuscript margin
 * (js/notes.js) keeps its own cache-coupled API logic; this standalone client is
 * what the scratchpad float (Phase 2) and the landing grid (Phase 3) use, so
 * every context speaks the same /api/notes contract.
 *
 * Notes are user-owned with optional context: a note may set any of
 * manuscript_id / sentence_id / scratchpad_id (or none). Create takes whichever
 * context applies.
 */
(function () {
  const BASE = 'api/notes';
  const csrf = () => sessionStorage.getItem('csrf_token') || '';
  // Reuse the app's authenticated fetch if present (handles 401→login); else
  // fall back to plain fetch with the CSRF header.
  const authFetch = (url, opts) =>
    (typeof authenticatedFetch === 'function')
      ? authenticatedFetch(url, opts)
      : fetch(url, opts);

  async function jsonOrThrow(resp) {
    if (!resp.ok && resp.status !== 204) throw new Error(`HTTP ${resp.status}`);
    if (resp.status === 204) return null;
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
  }

  const WriteSysNoteAPI = {
    // Create a note. `ctx` carries any of {sentence_id, manuscript_id,
    // scratchpad_id}; color is required (a scratchpad note is born colored).
    async create({ color, body = null, priority = 'none', flagged = false, ctx = {} }) {
      const resp = await authFetch(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify({ color, body, priority, flagged, ...ctx }),
      });
      return jsonOrThrow(resp); // { note_id, version }
    },

    async update(noteId, fields) {
      const resp = await authFetch(`${BASE}/${noteId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify(fields), // any of {color, body, priority, flagged}
      });
      return jsonOrThrow(resp);
    },

    async remove(noteId) {
      const resp = await authFetch(`${BASE}/${noteId}`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': csrf() },
      });
      return jsonOrThrow(resp);
    },

    async complete(noteId) {
      const resp = await authFetch(`${BASE}/${noteId}/complete`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrf() },
      });
      return jsonOrThrow(resp);
    },

    async tags(noteId) {
      const resp = await authFetch(`${BASE}/${noteId}/tags`, { method: 'GET' });
      return jsonOrThrow(resp); // { tags: [...] }
    },

    async addTag(noteId, tagName) {
      const resp = await authFetch(`${BASE}/${noteId}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify({ tag_name: tagName }),
      });
      return jsonOrThrow(resp);
    },

    async removeTag(noteId, tagId) {
      const resp = await authFetch(`${BASE}/${noteId}/tags/${tagId}`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': csrf() },
      });
      return jsonOrThrow(resp);
    },
  };

  if (typeof window !== 'undefined') window.WriteSysNoteAPI = WriteSysNoteAPI;
})();
