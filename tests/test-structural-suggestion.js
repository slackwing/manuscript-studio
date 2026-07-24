// Structural-suggestion preview: a suggestion that turns a sentence into a
// block &-command (or Markdown header) renders in the SUGGESTION's resulting
// structure — an <h2 class="cmd-part"> for &part — with the word-level diff of
// the visible text shown inside it, rather than raw "&part{...}" diff text.
//
// Also checks &title / &part get a page break before them.
const { chromium } = require('playwright');
const {
  TEST_URL, TEST_MANUSCRIPT_ID, SYSTEM_TOKEN,
  cleanupTestAnnotations, loginAsTestUser,
} = require('./test-utils');

const API = 'http://localhost:5001/api';

async function syncManuscript() {
  // Re-point manuscript_id=1 at content containing &-commands + a # header we
  // can suggest an edit on, then sync.
  const r = await fetch(`${API}/admin/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SYSTEM_TOKEN}` },
    body: JSON.stringify({ manuscript_name: 'test-manuscripts' }),
  });
  if (!r.ok) throw new Error(`sync failed: ${r.status}`);
}

(async () => {
  console.log('=== Structural suggestion preview ===\n');
  let failed = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
    if (!ok) failed++;
  };

  await cleanupTestAnnotations();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 1200 });
  page.on('dialog', async d => { try { await d.dismiss(); } catch (e) {} });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));

  try {
    await loginAsTestUser(page);
    await page.goto(TEST_URL);
    await page.waitForSelector('.sentence', { timeout: 30000 });
    await page.waitForTimeout(1500);

    // The canonical test manuscript begins with "# The Wildfire" / "## Chapter
    // 1" / "### I." headers. Suggest turning the "## Chapter 1" header into a
    // &part command and confirm the preview renders as a Part heading.
    const targetId = await page.evaluate(() => {
      const s = Array.from(document.querySelectorAll('.sentence'))
        .find(x => x.textContent.trim() === 'Chapter 1');
      return s ? s.dataset.sentenceId : null;
    });
    check('found a "## Chapter 1" header sentence', !!targetId, `id ${targetId}`);
    if (!targetId) throw new Error('no header sentence to test');

    const csrf = await page.evaluate(() => sessionStorage.getItem('csrf_token'));
    const putStatus = await page.evaluate(async ({ id, csrf }) => {
      const r = await fetch(`api/sentences/${id}/suggestion`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ text: '&part{Part 1}{A new part now}' }),
      });
      return r.status;
    }, { id: targetId, csrf });
    check('suggestion PUT accepted', putStatus === 200, `status ${putStatus}`);

    await page.reload();
    await page.waitForSelector('.sentence', { timeout: 30000 });
    await page.waitForTimeout(2000);

    const preview = await page.evaluate((id) => {
      const span = document.querySelector(`.sentence[data-sentence-id="${id}"]`);
      if (!span) return { found: false };
      const block = span.closest('h1,h2,h3,div,p');
      return {
        found: true,
        blockTag: block ? block.tagName : null,
        blockCls: block ? block.className : null,
        structuralClass: span.classList.contains('has-structural-suggestion'),
        hasDel: !!span.querySelector('del'),
        hasIns: !!span.querySelector('strong'),
        text: span.textContent,
      };
    }, targetId);

    check('preview renders in an <h2>', preview.blockTag === 'H2', `got ${preview.blockTag}`);
    check('preview has cmd-part class', /cmd-part/.test(preview.blockCls || ''), preview.blockCls);
    check('span marked structural-suggestion', preview.structuralClass === true);
    check('diff shows deletion (old label struck)', preview.hasDel === true);
    check('diff shows insertion (new label)', preview.hasIns === true);
    check('new label text present', /Part 1/.test(preview.text || ''), preview.text);

    // Page break: &title / &part should break before. (The canonical
    // manuscript has # headers, not commands, so check the CSS rule applies to
    // the suggested cmd-part we just created.)
    const brk = await page.evaluate(() => {
      const e = document.querySelector('.cmd-part');
      if (!e) return 'no-cmd-part';
      const s = getComputedStyle(e);
      return s.breakBefore !== 'auto' ? s.breakBefore : s.pageBreakBefore;
    });
    check('cmd-part breaks before (own page)', brk === 'page', `got ${brk}`);

    check('no page errors', errs.length === 0, errs.join('; '));
  } finally {
    // Remove the suggestion so the next test starts clean.
    try {
      const csrf = await page.evaluate(() => sessionStorage.getItem('csrf_token'));
      const id = await page.evaluate(() => {
        const s = Array.from(document.querySelectorAll('.sentence'))
          .find(x => /Part 1|Chapter 1/.test(x.textContent));
        return s ? s.dataset.sentenceId : null;
      });
      if (id) {
        await page.evaluate(async ({ id, csrf }) => {
          await fetch(`api/sentences/${id}/suggestion`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf } });
        }, { id, csrf });
      }
    } catch (e) { /* best effort */ }
    await cleanupTestAnnotations();
    await browser.close();
  }

  console.log(failed === 0 ? '\n✅ Test passed' : `\n❌ ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error('Test crashed:', err); process.exit(1); });
