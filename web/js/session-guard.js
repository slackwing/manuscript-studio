// Global session guard (app-wide, view-agnostic).
//
// When the session expires ANYWHERE in Manuscript Studio, this dims the page
// and offers an in-place re-login modal — no reload, so unsaved work
// (scratchpad autosaves, variation edits, note bodies) survives and their retry
// ladders succeed on the next tick after login.
//
// Installed at the DOCUMENT level: it patches window.fetch once, so every
// current and future view gets 401 detection for free by including this
// script — nothing view-specific required. Views can also integrate manually:
//   window.WriteSysSessionGuard.requireLogin()  → open the modal (idempotent);
//                                                 resolves true after login,
//                                                 false if dismissed.
//   window.WriteSysSessionGuard.isAuthError(e)  → true for a 401-shaped error.
//   document 'ms:session-restored' event        → fired after a successful
//                                                 re-login (retry saves now).
(function () {
  'use strict';

  const Z = 30000; // above the scratchpad modal (20000) and note float (21000+)

  let overlay = null;
  let resolvers = [];

  function injectStyles() {
    if (document.getElementById('msg-style')) return;
    const st = document.createElement('style');
    st.id = 'msg-style';
    st.textContent = `
      .msg-overlay { position: fixed; inset: 0; z-index: ${Z};
        background: rgba(20, 16, 10, 0.55); backdrop-filter: blur(2px);
        display: flex; align-items: center; justify-content: center; }
      .msg-card { background: #fffdf7; border: 1px solid #d8d2c4; border-radius: 10px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.35); padding: 26px 30px; width: 320px;
        font-family: Helvetica, Arial, sans-serif; }
      .msg-card h2 { margin: 0 0 6px; font-size: 17px; color: #3b3428; }
      .msg-card p { margin: 0 0 16px; font-size: 12.5px; color: #8a8378; line-height: 1.5; }
      .msg-card label { display: block; font-size: 11px; color: #8a8378; margin: 10px 0 3px; }
      .msg-card input { width: 100%; box-sizing: border-box; padding: 7px 9px;
        border: 1px solid #cfc8b8; border-radius: 6px; font-size: 14px; background: #fff; }
      .msg-card input:focus { outline: none; border-color: #a89f8c; }
      .msg-error { color: #a33; font-size: 12px; min-height: 16px; margin-top: 10px; }
      .msg-actions { display: flex; gap: 10px; align-items: center; margin-top: 14px; }
      .msg-login { flex: 1; padding: 8px 0; border: none; border-radius: 6px;
        background: #4a4336; color: #fffdf7; font-size: 14px; cursor: pointer; }
      .msg-login:hover { background: #5a5244; }
      .msg-login:disabled { opacity: 0.6; cursor: default; }
      .msg-dismiss { background: none; border: none; color: #8a8378; font-size: 12px;
        cursor: pointer; text-decoration: underline; }
    `;
    document.head.appendChild(st);
  }

  function close(loggedIn) {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    const rs = resolvers;
    resolvers = [];
    rs.forEach((r) => r(loggedIn));
  }

  function build() {
    injectStyles();
    overlay = document.createElement('div');
    overlay.className = 'msg-overlay';
    overlay.innerHTML = `
      <form class="msg-card">
        <h2>Session expired</h2>
        <p>Log in again to keep working — nothing on this page is lost, and pending saves resume automatically.</p>
        <label for="msg-user">Username</label>
        <input id="msg-user" name="username" autocomplete="username">
        <label for="msg-pass">Password</label>
        <input id="msg-pass" name="password" type="password" autocomplete="current-password">
        <div class="msg-error"></div>
        <div class="msg-actions">
          <button type="submit" class="msg-login">Log In</button>
          <button type="button" class="msg-dismiss">not now</button>
        </div>
      </form>`;
    const form = overlay.querySelector('form');
    const user = overlay.querySelector('#msg-user');
    const pass = overlay.querySelector('#msg-pass');
    const errEl = overlay.querySelector('.msg-error');
    const btn = overlay.querySelector('.msg-login');

    user.value = localStorage.getItem('ms_last_username') || '';

    overlay.querySelector('.msg-dismiss').addEventListener('click', () => close(false));
    // Swallow Escape while the guard is up — it must not bubble into view-level
    // Escape handlers (e.g. the scratchpad modal's close-on-Escape).
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(false); }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!user.value || !pass.value) { errEl.textContent = 'Please fill in both fields.'; return; }
      btn.disabled = true;
      btn.textContent = 'Logging in…';
      try {
        const resp = await fetch('api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ username: user.value, password: pass.value }),
        });
        if (!resp.ok) throw new Error((await resp.text()) || 'Login failed');
        const data = await resp.json();
        if (data.csrf_token) localStorage.setItem('csrf_token', data.csrf_token); // localStorage: SHARED across tabs (sessionStorage skew caused save-403 data loss)
        localStorage.setItem('ms_last_username', user.value);
        close(true);
        document.dispatchEvent(new CustomEvent('ms:session-restored'));
      } catch (err) {
        errEl.textContent = String(err.message || err).slice(0, 120);
        btn.disabled = false;
        btn.textContent = 'Log In';
      }
    });

    document.body.appendChild(overlay);
    (user.value ? pass : user).focus();
  }

  window.WriteSysSessionGuard = {
    requireLogin() {
      return new Promise((resolve) => {
        resolvers.push(resolve);
        if (!overlay) build();
      });
    },
    isAuthError(err) {
      return !!(err && err.status === 401);
    },
  };

  // CSRF SELF-HEAL: a 403 "Invalid CSRF token" means our stored token no
  // longer matches the session — the classic cause being a re-login in
  // ANOTHER tab rotating the session cookie (this exact skew once 403'd four
  // minutes of variation autosaves and lost the writing). The fix is silent:
  // GET /api/session returns the session's current csrf_token; resync it and
  // the caller's own retry ladder succeeds on its next attempt. If the
  // session itself is dead, /api/session 401s and the login modal takes over.
  let healing = null;
  function healCSRF() {
    if (!healing) {
      healing = origFetch('api/session', { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d && d.csrf_token) localStorage.setItem('csrf_token', d.csrf_token);
        })
        .catch(() => {})
        .finally(() => { setTimeout(() => { healing = null; }, 2000); });
    }
    return healing;
  }

  // The document-level hook: ANY same-origin API call answered with 401 trips
  // the guard; a CSRF 403 triggers the silent token resync above. Statuses
  // still propagate to the caller, so existing error handling (save-retry
  // ladders, error banners) is untouched — it simply starts succeeding once
  // the token is healed / the user logs back in.
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    return origFetch.call(this, input, init).then((resp) => {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const isApi = /(^|\/)api\//.test(url) && !/api\/login\b/.test(url);
        if (resp.status === 401 && isApi) window.WriteSysSessionGuard.requireLogin();
        if (resp.status === 403 && isApi) healCSRF();
      } catch (_) { /* never break the caller over guard bookkeeping */ }
      return resp;
    });
  };
})();
