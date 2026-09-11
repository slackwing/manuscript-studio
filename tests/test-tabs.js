// Stateful tabs e2e: home.html is the SHELL — every pin is a live iframe
// panel that stays mounted across tab flips (sentinels prove no reload).
// Manuscript cards open in place; pads pin from the modal into a panel;
// framed pages hide their own chrome (html.embedded); × destroys panels
// (after a pad save flush); the bar itself is permanent with an
// uncloseable Home. Plus the ghost-card restyle checks.
const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser } = require('./test-utils');
const HOME_URL = new URL('home.html', TEST_URL).href;

(async () => {
  console.log('=== stateful tabs e2e ===\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  let failed = 0;
  const check = (n, ok, extra) => {
    console.log(`${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`);
    if (!ok) failed++;
  };

  await loginAsTestUser(page);
  await page.goto(HOME_URL);
  await page.evaluate(() => localStorage.removeItem('ms_pinned_tabs'));
  await page.reload();
  await page.waitForSelector('.card-ghost[data-ghost="scratchpad"]');

  // ---- permanent bar: Home alone, active, uncloseable ----
  await page.waitForSelector('#ms-tabs .ms-tab-home', { timeout: 8000 });
  check('no pins → bar shows Home alone, active, no ×', await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('#ms-tabs .ms-tab')];
    return tabs.length === 1 && tabs[0].classList.contains('ms-tab-home')
      && tabs[0].classList.contains('active') && !tabs[0].querySelector('.ms-tab-x');
  }));
  check('layout claim is permanent (has-ms-tabs)', await page.evaluate(() =>
    document.documentElement.classList.contains('has-ms-tabs')));

  // ---- ghost cards: translucent at rest, card face on hover ----
  const ghost = page.locator('.card-ghost[data-ghost="manuscript"]');
  const rest = await ghost.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, border: cs.borderTopStyle, label: el.textContent.trim() };
  });
  check('ghost at rest: translucent, dashed, + only',
    /rgba\(.*0\.7\)/.test(rest.bg) && rest.border === 'dashed' && rest.label === '+',
    JSON.stringify(rest));
  await ghost.hover();
  await page.waitForTimeout(250); // the + color transitions 120ms
  const hov = await ghost.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, topW: cs.borderTopWidth, topC: cs.borderTopColor,
      plus: getComputedStyle(el.querySelector('.ghost-plus')).color };
  });
  check('manuscript ghost hover: white face, brown lining, brown +',
    hov.bg === 'rgb(255, 255, 255)' && hov.topW === '4px'
    && hov.topC === 'rgb(87, 80, 63)' && hov.plus === 'rgb(87, 80, 63)', JSON.stringify(hov));

  // ---- manuscript card → LIVE PANEL in place (no navigation) ----
  await page.click('a.card-manuscript');
  await page.waitForSelector('#ms-tab-panels .ms-panel.active', { timeout: 15000 });
  check('manuscript card opens a panel; URL stays on the shell',
    page.url().includes('home.html') && /#tab=m\d+/.test(page.url()), page.url());
  check('manuscript tab active beside Home', await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('#ms-tabs .ms-tab')];
    return tabs.length === 2 && tabs[1].classList.contains('ms-tab-manuscript')
      && tabs[1].classList.contains('active');
  }));
  const mFrame = page.frames().find((f) => f.url().includes('manuscript_id'));
  check('panel iframe exists', !!mFrame);
  await mFrame.waitForSelector('.pagedjs_page', { timeout: 60000 });
  const emb = await mFrame.evaluate(() => ({
    embedded: document.documentElement.classList.contains('embedded'),
    controlsHidden: getComputedStyle(document.getElementById('controls')).display === 'none',
    pagesTop: Math.round(document.querySelector('.pagedjs_pages').getBoundingClientRect().top),
  }));
  check('framed book page hides its own chrome and sits flush',
    emb.embedded && emb.controlsHidden && emb.pagesTop >= 0 && emb.pagesTop < 20,
    JSON.stringify(emb));
  await mFrame.evaluate(() => { window.__sentinel = 'alive'; });

  // ---- flip Home ↔ manuscript: NOTHING reloads ----
  await page.click('#ms-tabs .ms-tab-home');
  await page.waitForFunction(() => document.getElementById('ms-tab-panels').hidden === true);
  check('Home tab hides the panel layer (landing intact beneath)',
    await page.locator('.card-ghost[data-ghost="scratchpad"]').count() === 1);
  await page.click('#ms-tabs .ms-tab-manuscript');
  await page.waitForSelector('#ms-tab-panels .ms-panel.active', { timeout: 8000 });
  check('manuscript kept its state across the flip (no reload)',
    (await mFrame.evaluate(() => window.__sentinel).catch(() => 'GONE')) === 'alive');

  // ---- Home's refresh (2026-09-11): like any active tab, Home carries a
  // hover-revealed ↻ — it reloads the landing's data (points grid) in place.
  check('a panel is active → the Home tab carries no refresh', await page.evaluate(() =>
    !document.querySelector('#ms-tabs .ms-tab-home .ms-tab-refresh')
    && !!document.querySelector('#ms-tabs .ms-tab-manuscript.active .ms-tab-refresh')));
  await page.click('#ms-tabs .ms-tab-home');
  await page.waitForFunction(() => document.getElementById('ms-tab-panels').hidden === true);
  await page.evaluate(() => {
    const H = window.WriteSysHome;
    window.__homeReloads = 0;
    window.__homeShell = 'alive';
    const orig = H.reload.bind(H);
    window.__homeReloadDone = 0;
    H.reload = async () => { window.__homeReloads += 1; await orig(); window.__homeReloadDone += 1; };
  });
  await page.hover('#ms-tabs .ms-tab-home');
  const homeRf = await page.evaluate(() => {
    const r = document.querySelector('#ms-tabs .ms-tab-home.active .ms-tab-refresh');
    return r ? { visible: getComputedStyle(r).visibility === 'visible', box: [r.getBoundingClientRect().width, r.getBoundingClientRect().height] } : null;
  });
  check('Home active → hover reveals its refresh, boxed like the others',
    !!homeRf && homeRf.visible && Math.round(homeRf.box[0]) === 17 && Math.round(homeRf.box[1]) === 19, JSON.stringify(homeRf));
  await page.click('#ms-tabs .ms-tab-home .ms-tab-refresh');
  await page.waitForFunction(() => window.__homeReloadDone === 1, null, { timeout: 15000 }); // re-rendered
  await page.waitForSelector('a.home-seeall', { timeout: 8000 });
  check('Home refresh reloads the landing data in place (no navigation, still Home)',
    await page.evaluate(() => window.__homeReloads === 1 && window.__homeShell === 'alive'
      && document.getElementById('ms-tab-panels').hidden === true
      && document.querySelector('#ms-tabs .ms-tab-home').classList.contains('active')));
  await page.click('#ms-tabs .ms-tab-manuscript'); // back where the next section expects us
  await page.waitForSelector('#ms-tab-panels .ms-panel.active', { timeout: 8000 });

  // ---- the ACTIVE tab's refresh (2026-09-11): a second hover-revealed
  // button, boxed like the ×, that reloads the tab's iframe.
  await page.hover('#ms-tabs .ms-tab-manuscript');
  const rf = await page.evaluate(() => {
    const tab = document.querySelector('#ms-tabs .ms-tab-manuscript.active');
    const r = tab.querySelector('.ms-tab-refresh');
    const x = tab.querySelector('.ms-tab-x');
    const box = (el) => el.getBoundingClientRect();
    return {
      present: !!r,
      beforeX: !!r && r.nextElementSibling === x,
      visible: !!r && getComputedStyle(r).visibility === 'visible',
      sameSize: !!r && Math.abs(box(r).width - box(x).width) < 1 && Math.abs(box(r).height - box(x).height) < 1,
      sizes: r ? [box(r).width, box(r).height, box(x).width, box(x).height] : null,
    };
  });
  check('active tab carries a refresh beside its × (hover-revealed, same box)',
    rf.present && rf.beforeX && rf.visible && rf.sameSize, JSON.stringify(rf));
  await page.click('#ms-tabs .ms-tab-manuscript.active .ms-tab-refresh');
  await page.waitForFunction(() => {
    const f = document.querySelector('#ms-tab-panels .ms-panel.active');
    try {
      return !!f && f.contentWindow.__sentinel === undefined
        && f.contentDocument.readyState === 'complete'
        && !!f.contentDocument.querySelector('.pagedjs_page');
    } catch (e) { return false; }
  }, null, { timeout: 60000 });
  check('refresh reloads the iframe (sentinel gone, book re-rendered)', true);
  check('refresh keeps the shell URL and the active tab', page.url().includes('home.html')
    && await page.evaluate(() => document.querySelectorAll('#ms-tabs .ms-tab').length === 2
      && document.querySelector('#ms-tabs .ms-tab-manuscript').classList.contains('active')));
  await mFrame.evaluate(() => { window.__sentinel = 'alive'; });

  // ---- pad: card → windowed modal; PIN → live panel ----
  await page.click('#ms-tabs .ms-tab-home');
  await page.click('.card-ghost[data-ghost="scratchpad"]');
  await page.waitForSelector('.spm-overlay .ProseMirror', { timeout: 15000 });
  check('unpinned pad is a windowed modal (no panel)', await page.evaluate(() =>
    !document.querySelector('#ms-tab-panels iframe[src*="pad.html"]')));
  await page.fill('#spm-title', 'Live pad');
  await page.locator('.spm-editor .ProseMirror').click();
  await page.keyboard.type('remember me');
  // A sketch too — the panel page must load the FULL widget machinery
  // (pane-widget etc.), not just prose.
  await page.locator('#spm-toolbar button', { hasText: 'Sketch' }).dispatchEvent('mousedown');
  await page.waitForSelector('.sn-insertpop:not([hidden]) .sn-ins-new', { timeout: 8000 });
  await page.click('.sn-insertpop:not([hidden]) .sn-ins-new');
  await page.waitForSelector('.spm-editor .sn-widget[data-variation-id]', { timeout: 15000 });
  await page.click('#spm-pin');
  await page.waitForSelector('#ms-tab-panels iframe[src*="pad.html"].active', { timeout: 15000 });
  check('pin turns the modal into a live panel (modal gone)',
    await page.locator('.spm-overlay').count() === 0);
  check('refresh rides only the ACTIVE tab (pad active → manuscript tab has none)',
    await page.evaluate(() => !!document.querySelector('#ms-tabs .ms-tab-scratchpad.active .ms-tab-refresh')
      && !document.querySelector('#ms-tabs .ms-tab-manuscript .ms-tab-refresh')));
  const padFrame = page.frames().find((f) => f.url().includes('pad.html'));
  await padFrame.waitForSelector('.spm-editor .ProseMirror', { timeout: 20000 });
  check('panel carries the pad content (typed text survived the pin flush)',
    (await padFrame.evaluate(() => document.querySelector('.spm-editor .ProseMirror').textContent)).includes('remember me'));
  await padFrame.waitForSelector('.sn-widget .sn-render', { timeout: 20000 });
  check('sketch widget RENDERS inside the panel (preview mounted, no dead deps)',
    await padFrame.evaluate(() => document.querySelectorAll('.sn-widget .sn-render').length >= 1));
  check('pad tab label from the title', await page.evaluate(() => {
    const t = document.querySelector('#ms-tabs .ms-tab-scratchpad .ms-tab-label');
    return !!t && t.textContent === 'Live pad';
  }));
  await padFrame.evaluate(() => { window.__padSentinel = 42; });

  // ---- flip between the two panels: both stay alive ----
  await page.click('#ms-tabs .ms-tab-manuscript');
  await page.waitForFunction(() =>
    !!document.querySelector('#ms-tab-panels .ms-panel.active[src*="manuscript_id"]'));
  check('manuscript still alive after pad detour',
    (await mFrame.evaluate(() => window.__sentinel).catch(() => 'GONE')) === 'alive');
  await page.click('#ms-tabs .ms-tab-scratchpad');
  await page.waitForFunction(() =>
    !!document.querySelector('#ms-tab-panels .ms-panel.active[src*="pad.html"]'));
  check('pad still alive after manuscript detour',
    (await padFrame.evaluate(() => window.__padSentinel).catch(() => 'GONE')) === 42);

  // ---- reload restores the ACTIVE tab (fresh panel, right place) ----
  await page.reload();
  await page.waitForSelector('#ms-tab-panels iframe[src*="pad.html"].active', { timeout: 15000 });
  check('reload restores the active pad tab from #tab=', true);
  check('tabs survived reload', await page.evaluate(() =>
    document.querySelectorAll('#ms-tabs .ms-tab').length === 3));

  // ---- clicking the PINNED pad's landing card FOCUSES its tab (no modal) ----
  await page.click('#ms-tabs .ms-tab-home');
  await page.waitForFunction(() => document.getElementById('ms-tab-panels').hidden === true);
  const pinnedPadId = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('ms_pinned_tabs')).find((p) => p.type === 'scratchpad').id);
  await page.click(`.card-scratchpad[data-scratchpad-id="${pinnedPadId}"]`);
  await page.waitForSelector('#ms-tab-panels iframe[src*="pad.html"].active', { timeout: 10000 });
  check('pinned pad card → its tab focuses; NO modal', await page.evaluate(() =>
    !document.querySelector('.spm-overlay')
    && document.querySelector('#ms-tabs .ms-tab.active').classList.contains('ms-tab-scratchpad')));

  // ---- × destroys the panel; active falls back to Home ----
  await page.hover('#ms-tabs .ms-tab-scratchpad');
  await page.click('#ms-tabs .ms-tab-scratchpad .ms-tab-x');
  await page.waitForFunction(() => !document.querySelector('#ms-tab-panels iframe[src*="pad.html"]'));
  check('× destroys the pad panel and its tab; Home takes over', await page.evaluate(() => {
    const active = document.querySelector('#ms-tabs .ms-tab.active');
    return document.querySelectorAll('#ms-tabs .ms-tab').length === 2
      && active && active.classList.contains('ms-tab-home')
      && document.getElementById('ms-tab-panels').hidden;
  }));
  await page.hover('#ms-tabs .ms-tab-manuscript');
  await page.click('#ms-tabs .ms-tab-manuscript .ms-tab-x');
  check('closing the last pin leaves the permanent bar with Home', await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('#ms-tabs .ms-tab')];
    return tabs.length === 1 && tabs[0].classList.contains('ms-tab-home')
      && !document.getElementById('ms-tabs').hidden
      && !document.querySelector('#ms-tab-panels iframe');
  }));

  // ---- settings opens as a NORMAL tab from the header gear ----
  await page.click('#settings-link');
  await page.waitForSelector('#ms-tab-panels iframe[src*="settings.html"].active', { timeout: 10000 });
  check('gear opens Settings as a live panel tab (gear icon on the tab)', await page.evaluate(() =>
    document.querySelectorAll('#ms-tabs .ms-tab-settings').length === 1
    && !!document.querySelector('#ms-tabs .ms-tab-settings .ms-tab-label svg')));
  await page.click('#ms-tabs .ms-tab-home');
  await page.waitForFunction(() => document.getElementById('ms-tab-panels').hidden === true);
  await page.click('#settings-link');
  await page.waitForSelector('#ms-tab-panels iframe[src*="settings.html"].active', { timeout: 8000 });
  check('second gear click focuses the existing tab — never two instances', await page.evaluate(() =>
    document.querySelectorAll('#ms-tabs .ms-tab-settings').length === 1
    && document.querySelectorAll('#ms-tab-panels iframe[src*="settings.html"]').length === 1));
  // A home.html link INSIDE the panel iframe must open the HOME TAB —
  // never navigate the panel itself (the 2026-09-09 hijack: a second home
  // page living inside the settings tab).
  await page.evaluate(() => {
    const frame = document.querySelector('#ms-tab-panels iframe[src*="settings.html"]');
    const doc = frame.contentDocument;
    const a = doc.createElement('a');
    a.href = 'home.html?view=notes';
    a.id = 'embed-home-link';
    a.textContent = 'x';
    doc.body.appendChild(a);
    doc.getElementById('embed-home-link').click();
  });
  await page.waitForFunction(() => document.getElementById('ms-tab-panels').hidden === true, null, { timeout: 5000 });
  check('embedded home link activates the HOME tab (panel hidden)', true);
  check('the settings panel did NOT navigate (still settings.html)', await page.evaluate(() =>
    !!document.querySelector('#ms-tab-panels iframe[src*="settings.html"]')
    && document.querySelector('#ms-tab-panels iframe[src*="settings.html"]')
      .contentWindow.location.pathname.endsWith('settings.html')));
  check('shell URL carries the view (All notes)',
    await page.evaluate(() => new URLSearchParams(location.search).get('view')) === 'notes');
  await page.hover('#ms-tabs .ms-tab-settings');
  await page.click('#ms-tabs .ms-tab-settings .ms-tab-x');
  await page.waitForFunction(() => !document.querySelector('#ms-tab-panels iframe[src*="settings.html"]'));
  check('settings tab closes like any tab', await page.evaluate(() =>
    document.querySelectorAll('#ms-tabs .ms-tab').length === 1));

  // ---- LINK ROUTER (2026-09-11): every same-origin link is a tab move ----
  // The shell is on ?view=notes with Home alone. A reload would wipe the
  // sentinel; every step below must keep it.
  await page.evaluate(() => { window.__shellSentinel = 'alive'; });
  await page.waitForSelector('a.home-back', { timeout: 5000 });
  await page.click('a.home-back');
  await page.waitForSelector('a.home-seeall', { timeout: 5000 });
  check('← Home from an All view re-renders the landing in place (no reload)',
    await page.evaluate(() => window.__shellSentinel === 'alive'
      && !new URLSearchParams(location.search).get('view')
      && document.getElementById('ms-tab-panels').hidden === true));
  // Whichever section offers "See all" (the fixture may hold no pads now).
  const seeAllView = await page.evaluate(() => document.querySelector('a.home-seeall').dataset.view);
  await page.click('a.home-seeall');
  await page.waitForSelector('a.home-back', { timeout: 5000 });
  check('See all → All view in place', await page.evaluate((v) =>
    window.__shellSentinel === 'alive' && new URLSearchParams(location.search).get('view') === v, seeAllView),
  seeAllView);
  await page.goBack();
  await page.waitForSelector('a.home-seeall', { timeout: 5000 });
  check('browser Back returns to the landing (popstate re-render, no reload)',
    await page.evaluate(() => window.__shellSentinel === 'alive' && !new URLSearchParams(location.search).get('view')));
  await page.click('a.home-seeall');
  await page.waitForSelector('a.home-back', { timeout: 5000 });
  await page.click('#brand');
  await page.waitForSelector('a.home-seeall', { timeout: 5000 });
  check('brand link → landing in place', await page.evaluate(() =>
    window.__shellSentinel === 'alive' && !new URLSearchParams(location.search).get('view')));
  // A manuscript link with a note deep link → its tab; the hash lands in the panel.
  const mid = await page.evaluate(() =>
    new URL(document.querySelector('a.card-manuscript').href).searchParams.get('manuscript_id'));
  await page.evaluate((mid) => {
    const a = document.createElement('a');
    a.href = './?manuscript_id=' + mid + '#note-sentence=deep-1';
    a.id = 'deep-link';
    a.textContent = 'deep';
    document.body.appendChild(a);
  }, mid);
  await page.click('#deep-link');
  await page.waitForFunction(() => {
    const f = document.querySelector('#ms-tab-panels iframe[src*="manuscript_id"].active');
    try { return !!f && f.contentWindow.location.hash === '#note-sentence=deep-1'; } catch (e) { return false; }
  }, null, { timeout: 15000 });
  check('manuscript link → its tab (no navigation), hash forwarded into the panel',
    page.url().includes('home.html') && await page.evaluate(() => window.__shellSentinel === 'alive'
      && document.querySelector('#ms-tabs .ms-tab-manuscript.active') !== null));
  // The same deep link again: the live panel gets a hashchange to follow anew.
  await page.evaluate(() => {
    const f = document.querySelector('#ms-tab-panels iframe[src*="manuscript_id"].active');
    f.contentWindow.__hc = 0;
    f.contentWindow.addEventListener('hashchange', () => { f.contentWindow.__hc += 1; });
  });
  await page.click('#ms-tabs .ms-tab-home');
  await page.click('#deep-link');
  await page.waitForFunction(() => {
    const f = document.querySelector('#ms-tab-panels iframe[src*="manuscript_id"].active');
    try { return !!f && f.contentWindow.__hc >= 1; } catch (e) { return false; }
  }, null, { timeout: 5000 });
  check('re-clicking the same deep link re-fires hashchange in the live panel', true);
  // A manuscript link INSIDE a panel routes to the shell's tab — the panel never navigates.
  await page.click('#settings-link');
  await page.waitForSelector('#ms-tab-panels iframe[src*="settings.html"].active', { timeout: 8000 });
  await page.waitForFunction(() => { // the recreated panel must have LOADED
    const f = document.querySelector('#ms-tab-panels iframe[src*="settings.html"]');
    try { return !!f && f.contentDocument.readyState === 'complete' && !!f.contentDocument.body; } catch (e) { return false; }
  }, null, { timeout: 15000 });
  await page.evaluate((mid) => {
    const doc = document.querySelector('#ms-tab-panels iframe[src*="settings.html"]').contentDocument;
    const a = doc.createElement('a');
    a.href = './?manuscript_id=' + mid;
    a.id = 'embed-ms-link';
    a.textContent = 'm';
    doc.body.appendChild(a);
    doc.getElementById('embed-ms-link').click();
  }, mid);
  await page.waitForSelector('#ms-tab-panels iframe[src*="manuscript_id"].active', { timeout: 8000 });
  check('embedded manuscript link → the manuscript TAB; settings panel untouched', await page.evaluate(() =>
    document.querySelector('#ms-tab-panels iframe[src*="settings.html"]').contentWindow.location.pathname.endsWith('settings.html')
    && window.__shellSentinel === 'alive'));
  const cls = await page.evaluate(() => {
    const c = window.WriteSysTabs._classify;
    return {
      ms: c('./?manuscript_id=5#x'), pad: c('pad.html?scratchpad_id=9'), set: c('settings.html'),
      home: (c('home.html?view=notes') || {}).kind, ext: c('https://example.com/'), other: c('login.html'),
    };
  });
  check('classify: manuscript / pad / settings / home / external / other',
    !!cls.ms && cls.ms.type === 'manuscript' && cls.ms.id === 5 && cls.ms.hash === '#x'
    && !!cls.pad && cls.pad.type === 'scratchpad' && cls.pad.id === 9
    && !!cls.set && cls.set.type === 'settings' && cls.home === 'home' && cls.ext === null && cls.other === null,
    JSON.stringify(cls));
  // Fragment links are never ours (inline refs and go-to arrows use href="#").
  await page.evaluate(() => {
    const a = document.createElement('a');
    a.href = '#frag-x';
    a.id = 'frag-link';
    a.textContent = 'f';
    document.body.appendChild(a);
  });
  await page.evaluate(() => document.getElementById('frag-link').click()); // under the panel layer
  check('fragment link left to the browser (hash set, no reload, tab untouched)',
    await page.evaluate(() => location.hash === '#frag-x' && window.__shellSentinel === 'alive'
      && document.querySelector('#ms-tabs .ms-tab-manuscript.active') !== null));
  await page.evaluate(() => history.replaceState(null, '', location.pathname + location.search));

  // ---- standalone book page (old link): pins, and its tabs route to the shell ----
  await page.goto(TEST_URL);
  await page.waitForSelector('#ms-tabs .ms-tab-manuscript', { timeout: 30000 });
  check('standalone book visit auto-pins (bar present, manuscript active)',
    await page.evaluate(() => {
      const active = document.querySelector('#ms-tabs .ms-tab.active');
      return !!active && active.classList.contains('ms-tab-manuscript');
    }));
  await page.click('#ms-tabs .ms-tab-home');
  await page.waitForURL(/home\.html/, { timeout: 15000 });
  check('Home tab from a standalone page navigates to the shell', true);
  await page.waitForSelector('#ms-tabs .ms-tab-manuscript', { timeout: 8000 });
  await page.click('#ms-tabs .ms-tab-manuscript');
  await page.waitForSelector('#ms-tab-panels .ms-panel.active', { timeout: 15000 });
  check('manuscript tab in the shell opens the live panel (URL stays home)',
    page.url().includes('home.html'));

  await page.evaluate(() => localStorage.removeItem('ms_pinned_tabs'));
  await browser.close();
  console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ Test passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
