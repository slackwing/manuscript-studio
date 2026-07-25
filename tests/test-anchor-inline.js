/**
 * Leading-anchor inline glyph (read-only, no DB writes). Calls
 * renderSentencesToHTML directly in the browser with a synthetic sentence
 * whose suggestion is "&anchor{x} prose" — asserting the ⚓ rides INLINE at the
 * start of the prose paragraph, not as a standalone block line.
 */
const { chromium } = require('playwright');
const { TEST_URL, loginAsTestUser } = require('./test-utils');

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
  await page.waitForTimeout(3000);

  const result = await page.evaluate(() => {
    const R = window.WriteSysRenderer;
    // Synthetic sentence + a suggestion overlaying it (nothing persisted).
    const id = 'synthetic-anchor-1';
    const sentences = [{ id, text: 'We probably recounted tales of that night.' }];
    const prevSug = window.WriteSysSuggestions.bySentenceId;
    window.WriteSysSuggestions.bySentenceId = { [id]: '&anchor{The salvia night} We probably recounted tales of that night.' };
    const html = R.renderSentencesToHTML(sentences);
    window.WriteSysSuggestions.bySentenceId = prevSug; // restore
    return html;
  });

  // Parse the produced HTML string.
  const hasGlyph = /cmd-anchor-glyph/.test(result);
  check('⚓ glyph present', hasGlyph);
  // The glyph must be INSIDE a <p> (inline), not a standalone .cmd-anchor div.
  const inParagraph = /<p[^>]*>[^]*cmd-anchor-glyph[^]*We probably recounted/.test(result);
  check('glyph is inline at start of the paragraph', inParagraph, result.slice(0, 240).replace(/\n/g, ' '));
  // No standalone .cmd-anchor block for this case.
  const noStandalone = !/<div class="cmd-anchor[ "]/.test(result);
  check('no standalone anchor block line', noStandalone);
  // Glyph precedes the prose text, with a space.
  const glyphThenSpaceThenText = /⚓<\/span> We probably recounted/.test(result);
  check('⚓ then space then first word', glyphThenSpaceThenText, result.match(/⚓[^]{0,40}/)?.[0]);

  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
