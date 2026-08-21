/**
 * Frontend gate for permissions v3 (PERMISSIONS_PLAN.md): the session
 * payload carries each accessible manuscript's effective action list
 * (computed server-side from roles.json — the same data the backend
 * enforces with, so the two can't drift). Affordances hide behind
 * WriteSysActions.has(...); the server remains the real gate.
 */
const WriteSysActions = {
  _option(manuscriptId) {
    const list = (window.currentSession && window.currentSession.accessible_manuscripts) || [];
    return list.find(m => m.manuscript_id === manuscriptId) || null;
  },

  // has(manuscriptId, action) — false until the session bootstrap lands.
  has(manuscriptId, action) {
    const m = this._option(manuscriptId);
    return !!(m && (m.actions || []).includes(action));
  },

  // hasAnywhere(action) — e.g. award-points gates user-scoped surfaces
  // (landing points grid) when the user is a pointer on ANY manuscript.
  hasAnywhere(action) {
    const list = (window.currentSession && window.currentSession.accessible_manuscripts) || [];
    return list.some(m => (m.actions || []).includes(action));
  },

  // currentManuscriptId from the book page URL (0 elsewhere).
  currentManuscriptId() {
    const id = new URLSearchParams(window.location.search).get('manuscript_id');
    return id ? parseInt(id, 10) : 0;
  },

  // applyBookPageGates hides book-page chrome the session's actions don't
  // cover: pane tabs (outline/statistics/people), the settings gear, the
  // push container. Re-runs safely; waits for the session bootstrap.
  applyBookPageGates(tries) {
    const id = this.currentManuscriptId();
    if (!id) return;
    if (!window.currentSession) {
      if ((tries || 0) < 40) setTimeout(() => this.applyBookPageGates((tries || 0) + 1), 250);
      return;
    }
    const gate = (el, action) => {
      if (el) el.style.display = this.has(id, action) ? '' : 'none';
    };
    gate(document.querySelector('#pane-tabs .pane-tab[data-pane="outline"]'), 'see-outline');
    gate(document.querySelector('#pane-tabs .pane-tab[data-pane="stats"]'), 'see-statistics');
    gate(document.querySelector('#pane-tabs .pane-tab[data-pane="people"]'), 'see-others-edits');
    gate(document.getElementById('mc-settings'), 'manage-manuscript');
    const pc = document.getElementById('push-button-container');
    if (pc) {
      pc.style.display = (this.has(id, 'commit-and-push-suggestions')
        || this.has(id, 'manage-suggestions')) ? '' : 'none';
    }
    // If the saved pane choice is now invisible, fall back to the first
    // visible tab (or none).
    const active = document.querySelector('#pane-tabs .pane-tab.active');
    if (active && active.style.display === 'none' && window.WriteSysStats) {
      const firstVisible = [...document.querySelectorAll('#pane-tabs .pane-tab')]
        .find(t => t.style.display !== 'none');
      if (firstVisible) window.WriteSysStats.setPane(firstVisible.dataset.pane);
    }
  },
};

if (typeof window !== 'undefined') {
  window.WriteSysActions = WriteSysActions;
  const run = () => WriteSysActions.applyBookPageGates(0);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
}
