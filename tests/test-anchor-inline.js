/**
 * Leading block anchor → ⚓ in the LEFT MARGIN, aligned to its paragraph, with
 * the paragraph keeping its normal indent (read-only: renderSentencesToHTML on
 * a synthetic sentence; nothing persisted).
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

  const render = (sentences, sug) => page.evaluate(({ sentences, sug }) => {
    const R = window.WriteSysRenderer;
    const prev = window.WriteSysSuggestions.bySentenceId;
    const prevRender = window.WriteSysSuggestions.renderBySentenceId;
    window.WriteSysSuggestions.bySentenceId = sug;
    window.WriteSysSuggestions.renderBySentenceId = sug; // v3 render map
    const html = R.renderSentencesToHTML(sentences);
    window.WriteSysSuggestions.bySentenceId = prev;
    window.WriteSysSuggestions.renderBySentenceId = prevRender;
    return html;
  }, { sentences, sug });

  // Case 1: flush leading anchor (no preceding paragraph marker) is a
  // MID-PARAGRAPH start (2026-08-23): the ⚓ rides IN the prose, between
  // the spaces — no margin pull, no paragraph class.
  {
    const id = 'syn-flush';
    const html = await render([{ id, text: 'We probably recounted tales.' }],
      { [id]: '&anchor{The salvia night} We probably recounted tales.' });
    check('flush: ⚓ rides inline in the prose', /cmd-anchor-inline/.test(html));
    check('flush: no margin glyph for a marker-less anchor', !/cmd-anchor-margin/.test(html));
    check('flush: paragraph has no has-anchor-margin class', !/<p class="[^"]*has-anchor-margin/.test(html));
  }

  // Case 2: paragraph after a placeholder (\n\t marker) → indented AND margin.
  {
    const id = 'syn-indent';
    const html = await render([{ id, text: 'We probably recounted tales.' }],
      { [id]: '\n\t&anchor{The salvia night} We probably recounted tales.' });
    check('indented: ⚓ in margin', /cmd-anchor-margin/.test(html));
    check('indented: paragraph is BOTH indented and has-anchor-margin',
      /<p class="[^"]*indented[^"]*has-anchor-margin|<p class="[^"]*has-anchor-margin[^"]*indented/.test(html),
      html.match(/<p class="[^"]*"/)?.[0]);
  }

  // Case 3: standalone anchor, no following prose → own quiet line (not margin).
  {
    const id = 'syn-standalone';
    const html = await render([{ id, text: 'placeholder' }],
      { [id]: '&anchor{Waypoint}' });
    check('standalone: renders a .cmd-anchor line', /<div class="cmd-anchor[ "]/.test(html));
    check('standalone: NOT a margin glyph', !/cmd-anchor-margin/.test(html));
  }

  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
