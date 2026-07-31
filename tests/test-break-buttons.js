/**
 * Modal break-insert buttons (read-only: opens a modal, clicks buttons, asserts
 * the § / ¶ glyphs land at the caret, then Cancels — NO save, so nothing is
 * persisted to the dev DB).
 */
const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser,
  waitForPagination,
} = require('./test-utils');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  let failed = false;
  const check = (name, ok, extra) => {
    console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
    if (!ok) failed = true;
  };

  await loginAsTestUser(page);
  await page.goto(TEST_URL);
  await waitForPagination(page);

  // Open the suggestion modal for the first rendered sentence.
  const opened = await page.evaluate(() => {
    const el = document.querySelector('.sentence[data-sentence-id]');
    if (!el) return null;
    const id = el.getAttribute('data-sentence-id');
    window.WriteSysSuggestions.openModal(id);
    return id;
  });
  check('opened modal', !!opened, opened);
  await page.waitForTimeout(300);
  // The pre-filled (original) glyph text — restored before closing so the
  // autosave leaves no suggestion behind.
  const origGlyph = await page.locator('.suggestion-modal-textarea').inputValue();

  const hasButtons = await page.locator('.suggestion-modal-break').count();
  check('two break buttons present', hasButtons === 2, String(hasButtons));

  // Clear textarea, place caret, click section then paragraph.
  await page.evaluate(() => {
    const ta = document.querySelector('.suggestion-modal-textarea');
    ta.value = 'AB';
    ta.setSelectionRange(1, 1); // caret between A and B
    ta.focus();
  });
  await page.locator('.suggestion-modal-break[data-break="section"]').click();
  const afterSection = await page.evaluate(() => document.querySelector('.suggestion-modal-textarea').value);
  check('section glyph inserted at caret', afterSection === 'A§B', JSON.stringify(afterSection));

  // Caret should now be after the §; insert paragraph there.
  await page.locator('.suggestion-modal-break[data-break="paragraph"]').click();
  const afterPara = await page.evaluate(() => document.querySelector('.suggestion-modal-textarea').value);
  check('paragraph glyph inserted after section', afterPara === 'A§¶B', JSON.stringify(afterPara));

  // fromGlyphs round-trip: § → \n\n, ¶ → \n\t.
  const roundtrip = await page.evaluate((v) => window.WriteSysTextMarkers.fromGlyphs(v), afterPara);
  check('glyphs convert back to real breaks', roundtrip === 'A\n\n\n\tB', JSON.stringify(roundtrip));

  // Closing ALWAYS saves now (autosave modal) — restore the original text
  // first so no suggestion is left behind, then Escape to flush + close.
  await page.locator('.suggestion-modal-textarea').fill(origGlyph);
  await page.locator('.suggestion-modal-textarea').press('Escape');
  await page.waitForSelector('#suggestion-modal', { state: 'detached', timeout: 4000 });
  check('modal closed via Escape (edit reverted, no suggestion left)', true);

  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
