// Em-dash glue e2e (2026-10-11): sentences glued at an em dash — the one
// before ends on "—" or the next opens on "—" — meet with NO space, in the
// red/green preview (no .sent-sp between them) and in copy. The owner's
// flow: drop the period from "He said." and suggest the next sentence as
// "—he sounded composed all of a sudden—"; the sentence after follows the
// closing dash. Push + migration are covered by Go TestReconstructEmDashGlue.
const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser, waitForPagination } = require('./test-utils');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail !== '' ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};

(async () => {
  console.log('=== em-dash glue e2e ===\n');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  await loginAsTestUser(page);
  await page.goto(TEST_URL);
  await waitForPagination(page);

  const SENTENCES = [
    ['eg-0', '\n\tIt was late. '],
    ['eg-1', 'He said. '],
    ['eg-2', 'He sounded composed all of a sudden. '],
    ['eg-3', 'Then he left. '],
    ['eg-4', 'Nobody followed. '],
    // A COMMITTED glue too (rows already ending / opening on a dash).
    ['eg-5', '\n\tShe began—'],
    ['eg-6', 'and stopped. '],
    ['eg-7', 'Silence. '],
  ];
  await page.evaluate(async (SENTENCES) => {
    const R = window.WriteSysRenderer, S = window.WriteSysSuggestions;
    const sentences = SENTENCES.map(([id, text]) => ({ id, sentence_id: id, text }));
    R.currentSentences = sentences;
    R.sentenceMap = Object.fromEntries(sentences.map((s) => [s.id, s.text]));
    S.viewer = 'test';
    S.rows = [
      { sentence_id: 'eg-1', user_id: 'test', text: 'He said' },
      { sentence_id: 'eg-2', user_id: 'test', text: '—he sounded composed all of a sudden—' },
    ];
    S.rebuildMaps();
    const before = document.body.dataset.paginated;
    await R.renderManuscript();
    await new Promise((res) => { const t = () => (document.body.dataset.paginated !== before ? res() : setTimeout(t, 50)); t(); });
  }, SENTENCES);

  const seps = await page.evaluate(() => {
    // Is there a .sent-sp between sentence a and sentence b (same paragraph)?
    const between = (a, b) => {
      const A = [...document.querySelectorAll(`.pagedjs_pages .sentence[data-sentence-id="${a}"]`)].pop();
      const B = document.querySelector(`.pagedjs_pages .sentence[data-sentence-id="${b}"]`);
      let n = A.nextSibling; let sp = false;
      while (n && n !== B) { if (n.classList && n.classList.contains('sent-sp')) sp = true; n = n.nextSibling; }
      return n === B ? sp : 'not-adjacent';
    };
    // What the reader sees of the suggested text (struck text dropped).
    const para = document.querySelector('.pagedjs_pages .sentence[data-sentence-id="eg-1"]').closest('p');
    const c = para.cloneNode(true);
    c.querySelectorAll('del').forEach((d) => d.remove());
    return {
      e01: between('eg-0', 'eg-1'), e12: between('eg-1', 'eg-2'), e23: between('eg-2', 'eg-3'), e34: between('eg-3', 'eg-4'),
      e56: between('eg-5', 'eg-6'), e67: between('eg-6', 'eg-7'),
      reads: c.textContent.replace(/\s+/g, ' ').trim(),
    };
  });
  check('preview: no space where the suggestion opens on "—"', seps.e12 === false, String(seps.e12));
  check('preview: no space after the suggestion\'s closing "—"', seps.e23 === false, String(seps.e23));
  check('preview: ordinary joins keep their space', seps.e01 === true && seps.e34 === true, `${seps.e01} ${seps.e34}`);
  check('preview reads glued', seps.reads === 'It was late. He said—he sounded composed all of a sudden—Then he left. Nobody followed.',
    JSON.stringify(seps.reads));
  check('committed glue: "began—" meets "and stopped." with no space; the next join keeps one',
    seps.e56 === false && seps.e67 === true, `${seps.e56} ${seps.e67}`);

  // Copy applies the same rule.
  await page.evaluate(() => { window.WriteSysRenderer.currentSelectedSentenceId = null; });
  await page.locator('.pagedjs_pages .sentence[data-sentence-id="eg-1"]').first().click();
  await page.locator('.pagedjs_pages .sentence[data-sentence-id="eg-4"]').first().click({ modifiers: ['Shift'] });
  await page.waitForSelector('.range-copy');
  await page.click('.range-copy');
  await page.waitForFunction(() => document.querySelector('.range-copy.copied'));
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  check('copy glues the same way', copied === 'He said—he sounded composed all of a sudden—Then he left. Nobody followed.',
    JSON.stringify(copied));

  await browser.close();
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
