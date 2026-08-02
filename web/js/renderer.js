const WriteSysRenderer = {
  apiBaseUrl: 'api',
  currentSentences: [],
  currentNotes: [],
  currentMigrationID: null,
  currentCommitHash: null,
  currentSegmenter: null,
  sentenceMap: {}, // sentence id → full text (sentences may be split across pages)
  currentSelectedSentenceId: null,

  async init() {
    // Other pages (home) load this file purely for renderSentencesToHTML —
    // only the book page (which has the manuscript container) boots the app.
    if (!document.getElementById('manuscript-content')) return;

    console.log('WriteSys Renderer initialized');

    // Bind once at init, not per-render — saves trigger re-renders.
    window.addEventListener('resize', () => this.applyResponsiveScaling());

    const urlParams = new URLSearchParams(window.location.search);
    const idStr = urlParams.get('manuscript_id');
    this.manuscriptId = idStr ? parseInt(idStr, 10) : null;

    if (window.WriteSysOutline) window.WriteSysOutline.init();

    // Delegated click for inline references: scroll to the target sentence.
    // Attached once; survives re-renders since it's on document.
    document.addEventListener('click', (e) => {
      const ref = e.target.closest && e.target.closest('.inline-ref[data-ref-target]');
      if (ref) {
        e.preventDefault();
        this.scrollToSentence(ref.dataset.refTarget);
      }
    });

    if (!this.manuscriptId) {
      // The book page without a manuscript is nothing — the landing page is
      // where you pick one (HOME_PLAN.md).
      window.location.replace('home.html');
      return;
    }

    await this.loadLatestMigration();
  },

  async loadLatestMigration() {
    try {
      this.showStatus('Loading latest migration...');

      const migration = await fetchJSON(`${this.apiBaseUrl}/migrations/latest?manuscript_id=${this.manuscriptId}`, {}, false);
      this.currentMigrationID = migration.migration_id;
      this.currentCommitHash = migration.commit_hash;
      this.currentSegmenter = migration.segmenter;

      const shortHash = migration.commit_hash.substring(0, 7);
      // The session bootstrap is async — retry until it lands so the strip
      // never shows an empty name.
      const setName = (tries) => {
        const list = (window.currentSession && window.currentSession.accessible_manuscripts) || [];
        const mine = list.find(m => m.manuscript_id === this.manuscriptId);
        const nameEl = document.getElementById('mc-name');
        if (mine && nameEl) { nameEl.textContent = mine.display_name || mine.name; return; }
        if (tries < 20) setTimeout(() => setName(tries + 1), 250);
      };
      setName(0);

      // Stamp per-user recency for the landing page (fire-and-forget).
      fetch(`${this.apiBaseUrl}/manuscripts/${this.manuscriptId}/opened`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': (localStorage.getItem('csrf_token') || sessionStorage.getItem('csrf_token')) || '' },
      }).catch(() => {});
      this.renderInfoLine(migration);

      console.log(`Loading migration ${migration.migration_id}: ${shortHash} with segmenter ${migration.segmenter}`);

      await this.loadManuscriptByMigration(migration.migration_id);
      this.startMigrationPoll();

    } catch (error) {
      console.error('Failed to load latest migration:', error);
      this.showStatus(`Error: ${error.message}`, 'error');
      this.renderInfoLine(null);
    }
  },

  // Chrome-strip info line: "Updated <ts> · <shorthash> · <n> words" —
  // formatted in the browser's timezone so the abbreviation (EDT/EST/etc.)
  // reflects where the reader is, not the VM.
  renderInfoLine(migration) {
    const el = document.getElementById('mc-info');
    if (!el) return;
    if (!migration) {
      el.textContent = '';
      return;
    }
    const processedAt = new Date(migration.processed_at);
    const monthDay = processedAt.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
    const time = processedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    const parts = processedAt.toLocaleTimeString(undefined, { timeZoneName: 'short' }).split(' ');
    const tz = parts[parts.length - 1] || '';
    const bits = [
      `Updated ${monthDay}, ${time}${tz ? ' ' + tz : ''}`,
      (migration.commit_hash || '').substring(0, 7),
      migration.word_count ? `${migration.word_count.toLocaleString('en-US')} words` : '',
    ].filter(Boolean);
    el.textContent = bits.join(' · ');
  },

  // Poll /migrations/latest so a webhook-driven migration that arrives while
  // the tab is open doesn't leave the reader silently editing an orphan
  // (see the server-side stale-migration guard on PUT /suggestion). We don't
  // auto-reload — an open suggestion modal would lose unsaved text. Instead
  // we surface a persistent banner and let the user click Reload.
  MIGRATION_POLL_MS: 15000,

  startMigrationPoll() {
    if (this._migrationPollTimer) return;
    this._migrationPollTimer = setInterval(() => this.checkForNewerMigration(), this.MIGRATION_POLL_MS);
  },

  async checkForNewerMigration() {
    if (!this.manuscriptId || !this.currentMigrationID) return;
    if (this._newerMigrationSeen) return; // banner already up
    try {
      const migration = await fetchJSON(`${this.apiBaseUrl}/migrations/latest?manuscript_id=${this.manuscriptId}`, {}, false);
      if (migration && migration.migration_id !== this.currentMigrationID) {
        this._newerMigrationSeen = true;
        this.showStaleBanner(migration);
        clearInterval(this._migrationPollTimer);
        this._migrationPollTimer = null;
      }
    } catch (e) {
      // Transient failures are fine — next tick tries again.
    }
  },

  showStaleBanner(migration) {
    if (document.getElementById('stale-migration-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'stale-migration-banner';
    banner.className = 'stale-migration-banner';
    const processedAt = new Date(migration.processed_at);
    const when = processedAt.toLocaleString(undefined, { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    const short = (migration.commit_hash || '').substring(0, 7);
    const textSpan = document.createElement('span');
    textSpan.className = 'stale-migration-text';
    textSpan.textContent = `Manuscript was updated (${when}, ${short}). New edits will be blocked until you reload.`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'stale-migration-reload';
    btn.textContent = 'Reload';
    btn.addEventListener('click', () => window.location.reload());
    banner.appendChild(textSpan);
    banner.appendChild(btn);
    document.body.appendChild(banner);
  },

  async loadManuscriptByMigration(migrationID) {
    try {
      this.showStatus('Loading manuscript...');

      // Parallel-fetch suggestions + outline so an outage there never blocks
      // the render.
      const url = `${this.apiBaseUrl}/migrations/${migrationID}/manuscript`;
      const [data] = await Promise.all([
        fetchJSON(url, {}, false),
        window.WriteSysSuggestions
          ? window.WriteSysSuggestions.loadForMigration(migrationID).catch(() => {})
          : Promise.resolve(),
        // Outline is built client-side from effective fragments during
        // renderManuscript (WriteSysOutline.refresh), so nothing to fetch here.
      ]);
      this.currentSentences = data.sentences;
      this.currentNotes = data.notes;
      // data.settings is the committed-only baseline; applyEffectiveSettings
      // overlays suggestions so a suggested &meta takes effect in preview.
      this.committedSettings = data.settings || {};

      this.sentenceMap = {};
      this.currentSentences.forEach(s => {
        this.sentenceMap[s.id] = s.text;
      });

      this.applyEffectiveSettings();

      console.log(`Loaded ${this.currentSentences.length} sentences from migration ${migrationID}`);

      await this.renderManuscript();

      this.showStatus(`Loaded ${this.currentSentences.length} sentences`);

      if (window.WriteSysPush) {
        window.WriteSysPush.init();
      }

    } catch (error) {
      console.error('Failed to load manuscript:', error);
      this.showStatus(`Error: ${error.message}`, 'error');
    }
  },

  // opts:
  //   anchorSentenceId: string — capture this sentence's viewport position
  //     before re-render and restore it after, so the page doesn't visibly
  //     scroll to the top during a re-paginate.
  //   selectSentenceId: string — after the new render, add the .selected
  //     class to that sentence's span(s) so it's easy to spot post-edit.
  async renderManuscript(opts = {}) {
    const container = document.getElementById('manuscript-content');
    const { anchorSentenceId, selectSentenceId } = opts;

    // Re-apply settings each render so a suggestion that adds/removes a &meta
    // (saved via the modal, which triggers a re-render) takes effect live.
    this.applyEffectiveSettings();
    // Rebuild the outline from effective fragments so suggested structure
    // (a suggested &part/&chapter) shows in the nav.
    if (window.WriteSysOutline) window.WriteSysOutline.refresh();

    // Capture the anchor's viewport offset BEFORE we touch the DOM. We'll
    // re-locate the same sentence after re-render and adjust scroll so the
    // viewport sits at the same offset — eliminates the scroll-to-top jolt.
    let anchorOffset = null;
    if (anchorSentenceId) {
      const old = document.querySelector(`.sentence[data-sentence-id="${CSS.escape(anchorSentenceId)}"]`);
      if (old) anchorOffset = old.getBoundingClientRect().top;
    }

    // Sentences carry structural markers (\n\t / \n\n) and inline markdown.
    // Build paragraphs by walking the list; each sentence becomes its own
    // <span class="sentence" data-sentence-id="...">. Smartquotes runs LAST
    // so straight apostrophes in suggestions don't diff against curly ones.
    const tempContainer = document.createElement('div');
    tempContainer.innerHTML = this.renderSentencesToHTML(this.currentSentences);

    // Sentence backgrounds are now driven by note focus (not note
    // presence): a sentence stays unfilled by default, picks up its
    // selected-grey on click, and tints to a note's color only while
    // that note's textarea has the typing caret. Side-bars (rainbow)
    // still convey the note set at a glance — see addRainbowBars().

    // Suggestions are now rendered inline by renderSentencesToHTML (the
    // fragment model — SUGGESTION_RENDER_PLAN.md), so the old applyToSpans
    // overlay is no longer needed here.

    if (typeof smartquotes !== 'undefined') {
      smartquotes.element(tempContainer);
    }

    const wrappedHtml = tempContainer.innerHTML;

    if (typeof Paged !== 'undefined') {

      const paged = new Paged.Previewer();
      const appContainer = document.getElementById('app-container');
      const oldPages = Array.from(appContainer.querySelectorAll('.pagedjs_pages'));

      // Render the new pages BEFORE removing the old ones — keeps document
      // height (and therefore scroll offset) stable. Without this, the
      // moment between "removed" and "rendered" collapses the document and
      // browser snaps scrollTop to 0; the user sees a flash + jump.
      const bookCssUrl = new URL('css/book.css', document.baseURI).href;
      await paged.preview(wrappedHtml, [bookCssUrl], appContainer);

      oldPages.forEach(el => el.remove());

      // Re-run the inter-sentence space insertion now that the OLD pages
      // are gone. pagedjs-config.js's afterRendered already ran it, but
      // during in-place re-renders both old and new .pagedjs_pages
      // coexist briefly; that hook hits document.querySelector(
      // '.pagedjs_pages') which finds the OLD one and patches it instead
      // of the new one. Re-running here guarantees the new pages get it.
      const newPages = document.querySelector('.pagedjs_pages');
      if (newPages) this.insertSpacesBetweenSentences(newPages);

      // Placeholder hatch geometry (row-bridge padding + phase nudge) is
      // DOM-position-derived, so it re-runs on the fresh pages — same
      // reasoning as the insertSpacesBetweenSentences re-run above. The
      // scratchpad-import affordances are position-derived too.
      if (window.WriteSysPlaceholder) window.WriteSysPlaceholder.layoutPass();
      if (window.WriteSysImportScratchpad) window.WriteSysImportScratchpad.refresh();
      this.layoutMarginGlyphs();

      const originalContent = document.getElementById('manuscript-content');
      if (originalContent) {
        originalContent.style.display = 'none';
      }

      // setupSentenceHover() runs in pagedjs-config.js after Paged.js finishes.
      this.applyResponsiveScaling();
    } else {
      container.innerHTML = wrappedHtml;
      this.setupSentenceHover();
    }

    // Restore the anchor's viewport position. If the sentence's new layout
    // offset differs from the old one (it can — our edit may have changed
    // its width/wrap), shift scroll so it lands at the original viewport
    // y. The user perceives the diff appear in place.
    if (anchorSentenceId && anchorOffset !== null) {
      const fresh = document.querySelector(`.sentence[data-sentence-id="${CSS.escape(anchorSentenceId)}"]`);
      if (fresh) {
        const newOffset = fresh.getBoundingClientRect().top;
        const delta = newOffset - anchorOffset;
        if (Math.abs(delta) > 0.5) window.scrollBy({ top: delta, behavior: 'auto' });
      }
    }

    if (selectSentenceId) {
      // Mark the just-edited sentence as selected so the user sees what
      // changed even before the diff catches their eye.
      document.querySelectorAll(`.sentence[data-sentence-id="${CSS.escape(selectSentenceId)}"]`).forEach(el => {
        el.classList.add('selected');
      });
      this.currentSelectedSentenceId = selectSentenceId;
    }

    // Pagination is now COMPLETE (paged.preview resolved above), so page
    // numbers/counts and the caret are accurate for ALL pages — not a subset
    // that happened to exist when a fixed timer fired. Recompute now.
    if (window.WriteSysOutline) window.WriteSysOutline.updatePageInfo();
  },

  applyResponsiveScaling() {
    const pagesContainer = document.querySelector(".pagedjs_pages");
    if (!pagesContainer) return;

    if (window.innerWidth <= 768) {
      const pageWidth = 576; // the fixed sheet width (see .pagedjs_page)
      // Fill the widest available width, leaving only a slight gutter each side
      // (not the old 70% that wasted ~30% of the screen). transform-origin is
      // top-LEFT so the scaled sheet hugs the left gutter rather than centering
      // and drifting; the CSS zeroes .pagedjs_pages padding on mobile.
      const GUTTER = 12; // px each side
      const scale = Math.min(1, (window.innerWidth - GUTTER * 2) / pageWidth);
      // Fit the fixed publishable page to the viewport via transform: scale —
      // words-per-page must stay identical across viewports (it's a print form),
      // so we scale the whole sheet rather than reflow. transform doesn't shrink
      // the layout box, so it leaves phantom empty space below; compensate with
      // a negative margin-bottom equal to the height the scale removed. Measured
      // AFTER clearing any prior transform so the natural height is read.
      pagesContainer.style.transform = "";
      pagesContainer.style.marginBottom = "";
      const naturalH = pagesContainer.getBoundingClientRect().height;
      pagesContainer.style.transform = `scale(${scale})`;
      pagesContainer.style.transformOrigin = "top left";
      pagesContainer.style.marginLeft = GUTTER + "px";
      pagesContainer.style.marginBottom = -(naturalH * (1 - scale)) + "px";
      // Keep the grey book backdrop so each scaled sheet still reads as a page
      // (transparent here erased that look). The container is scaled, so paint
      // the grey on the BODY — it fills the whole viewport regardless of scale.
      pagesContainer.style.background = "transparent";
      document.body.style.background = "#f5f5f5";
    } else {
      pagesContainer.style.transform = "";
      pagesContainer.style.transformOrigin = "";
      pagesContainer.style.marginLeft = "";
      pagesContainer.style.marginBottom = "";
      pagesContainer.style.padding = "2em";
      // No inline background here: the stylesheet paints the grey veil over
      // the library-wall photo (.pagedjs_pages in book.css) — an inline flat
      // grey would sit on top and hide it entirely.
      pagesContainer.style.background = "";
      document.body.style.background = "";
    }
  },

  // Build paginated HTML directly from the sentence list. Each sentence
  // becomes a <span class="sentence" data-sentence-id="...">, grouped into
  // <p> / <p class="indented"> / <h*> elements based on the sentence's
  // leading marker (\n\t = new indented paragraph, \n\n = new section,
  // # = heading).
  //
  // Replaces parseManuscript + wrapSentences. The DB is now the structural
  // source of truth — no need to re-parse the raw .manuscript file.
  renderSentencesToHTML(sentences) {
    if (!sentences || sentences.length === 0) return '';

    const out = [];
    let openP = null; // { cls, spans } — current open paragraph
    // Anchor-family glyphs (⚓ for &anchor/&snippet) NEVER interrupt prose
    // flow: they defer to the NEXT paragraph's LEFT MARGIN (across sentence
    // boundaries — post-push an anchor is its own sentence row). The anchor's
    // own structural marker carries over so \n\n before an anchor still
    // sections the following prose, \n\t still indents it.
    let pendingMarginGlyphs = [];
    let pendingCarriedCls = '';
    const strongestCls = (a, b) => {
      if (a === 'section-break' || b === 'section-break') return 'section-break';
      if (a === 'indented' || b === 'indented') return 'indented';
      return a || b || '';
    };

    const flush = () => {
      if (openP !== null) {
        out.push(openP.cls
          ? `<p class="${openP.cls}">${openP.spans.join(' ')}</p>`
          : `<p>${openP.spans.join(' ')}</p>`);
        openP = null;
      }
    };
    const pushProse = (cls, span) => {
      if (cls) flush();
      if (openP === null) openP = { cls: cls || '', spans: [span] };
      else openP.spans.push(span);
    };

    const cmdLib = window.WriteSysCommand;
    const sugMap = (window.WriteSysSuggestions && window.WriteSysSuggestions.bySentenceId) || {};

    for (const s of sentences) {
      const id = s.id;
      const committed = s.text;
      const suggestion = sugMap[id]; // undefined if none
      const rawEffective = (suggestion !== undefined) ? suggestion : committed;
      // Canonicalize per sentence BEFORE segmenting so the preview is truthful:
      // a leading anchor blocks out (⚓ + outline entry), an inline-typed
      // command gains its block form, whitespace tidies. Same canonicalize the
      // server runs at push time, so what you see is what you push.
      const canon = (window.WriteSysCanonicalize && window.WriteSysCanonicalize.canonicalize)
        ? window.WriteSysCanonicalize.canonicalize
        : (t) => t;
      const effective = canon(rawEffective);

      // Segment the effective text into fragments, all sharing this
      // sentence's real ID (SUGGESTION_RENDER_PLAN.md). Each renders by kind.
      const frags = cmdLib ? cmdLib.segmentFragments(effective) : [{ kind: 'prose', text: effective, marker: '' }];
      // The original prose (committed, marker-stripped) to diff a single-prose
      // suggestion against. Canonicalize the committed baseline too so a
      // word-diff reflects real content edits, not whitespace canonicalization.
      const canonCommitted = canon(committed);
      const origProse = this.stripLeadingMarker(canonCommitted);
      const loneProse = frags.length === 1 && frags[0].kind === 'prose';

      // A block anchor that leads a paragraph (canonicalize's "&anchor{x}\n
      // prose" form → [command:anchor, prose] with no marker on the prose) is
      // NOT a standalone line. Its ⚓ marker is pulled into the LEFT MARGIN,
      // aligned with the top of the following paragraph, so the prose starts
      // flush (no indent look). We hold the glyph here and attach it to the
      // paragraph the next prose fragment opens. If there's no following prose,
      // the anchor falls back to its own quiet ⚓ line.
      for (let fi = 0; fi < frags.length; fi++) {
        const f = frags[fi];
        // A structural fragment (command/header) that came from a suggestion
        // is a change we DON'T word-diff — mark it blue ("cmd-suggested") so
        // the author knows to click it to see the change.
        const changed = suggestion !== undefined;
        if (f.kind === 'command') {
          // Anchor family (&anchor / &snippet): ALWAYS a margin glyph on the
          // next paragraph — never a flow-breaking block line. The marker it
          // carried transfers to that paragraph's break class.
          if (f.cmd.kind === 'anchor' || f.cmd.kind === 'snippet') {
            pendingMarginGlyphs.push({ cmd: f.cmd, id, changed });
            pendingCarriedCls = strongestCls(pendingCarriedCls,
              f.marker === '\n\n' ? 'section-break' : (f.marker === '\n\t' ? 'indented' : ''));
            continue;
          }
          // &end: never shown in the preview (the raw text keeps it) — but its
          // marker still carries (a region often ends right before a break).
          if (f.cmd.kind === 'end') {
            pendingCarriedCls = strongestCls(pendingCarriedCls,
              f.marker === '\n\n' ? 'section-break' : (f.marker === '\n\t' ? 'indented' : ''));
            continue;
          }
          // Otherwise a block command fragment → render its result, no diff.
          // &meta renders nothing. All share this sentence's id.
          flush();
          const html = this.renderBlockCommandFrag(f.cmd, id, changed, f.marker);
          if (html) out.push(html);
          continue;
        }
        // Prose fragment.
        let cls = f.marker === '\n\n' ? 'section-break' : (f.marker === '\n\t' ? 'indented' : '');
        const body = this.stripLeadingMarker(f.text);
        let inner;
        if (suggestion !== undefined && loneProse) {
          // A pure prose edit → word-level diff vs. the committed prose, then
          // render any inline &reference/&anchor tokens that survived the diff
          // as links/markers (they're escaped as &amp;… in the diff HTML).
          inner = this.renderInlineCommandsInHtml(renderDiffHTML(origProse, body, this._dmp()));
          // Glyph diff: if this lone prose's leading structural break was
          // added or removed by the suggestion, show a §/¶ glyph (green added,
          // struck removed) so the break change is reviewable.
          const glyph = this.markerGlyphDiff(this.leadingMarker(canonCommitted), f.marker);
          if (glyph) inner = glyph + inner;
        } else {
          inner = this.applyInlineFormatting(body);
        }
        const sugClass = (suggestion !== undefined) ? ' has-suggestion' : '';
        let span = `<span class="sentence${sugClass}" data-sentence-id="${this.escapeHtml(id)}">${inner}</span>`;
        // Pending margin glyphs attach to THIS paragraph, absolutely placed
        // in the left margin aligned to its top; the carried break class wins
        // over the prose's own weaker one.
        cls = strongestCls(cls, pendingCarriedCls);
        pendingCarriedCls = '';
        if (pendingMarginGlyphs.length) {
          span = pendingMarginGlyphs.map((g) => this.anchorGlyphHTML(g.cmd, g.id, g.changed, /*margin*/ true)).join('') + span;
          cls = (cls ? cls + ' ' : '') + 'has-anchor-margin';
          pendingMarginGlyphs = [];
        }
        pushProse(cls, span);
      }
    }
    // Anchors with no following prose anywhere: attach to the last open
    // paragraph, else fall back to a quiet standalone line.
    if (pendingMarginGlyphs.length) {
      if (openP) {
        openP.spans.unshift(pendingMarginGlyphs.map((g) => this.anchorGlyphHTML(g.cmd, g.id, g.changed, true)).join(''));
        openP.cls = (openP.cls ? openP.cls + ' ' : '') + 'has-anchor-margin';
      } else {
        // No prose anywhere to host them: quiet standalone line, NON-margin.
        out.push(`<div class="cmd-anchor">${pendingMarginGlyphs.map((g) => this.anchorGlyphHTML(g.cmd, g.id, g.changed, false)).join('')}</div>`);
      }
      pendingMarginGlyphs = [];
    }

    flush();
    return out.join('\n');
  },

  // layoutMarginGlyphs stacks same-line margin anchors leftward so several on
  // one line never overlap (they may overlap the outline column — fine, rare).
  layoutMarginGlyphs() {
    document.querySelectorAll('.pagedjs_page_content').forEach((page) => {
      const byLine = new Map();
      page.querySelectorAll('.cmd-anchor-margin').forEach((el) => {
        el.style.left = ''; // reset before measuring
        const key = Math.round(el.getBoundingClientRect().top / 8);
        const n = byLine.get(key) || 0;
        if (n > 0) el.style.left = `-${(1.6 + n * 1.2).toFixed(1)}em`;
        byLine.set(key, n + 1);
      });
    });
  },

  // stripLeadingMarker removes a single leading \n\n or \n\t (structural) so
  // it doesn't appear in visible text — the marker only chooses the block.
  stripLeadingMarker(text) {
    const t = String(text == null ? '' : text);
    if (t.startsWith('\n\n') || t.startsWith('\n\t')) return t.slice(2);
    return t;
  },

  // leadingMarker returns the leading structural marker of a text ('\n\n',
  // '\n\t', or '').
  leadingMarker(text) {
    const t = String(text == null ? '' : text);
    if (t.startsWith('\n\n')) return '\n\n';
    if (t.startsWith('\n\t')) return '\n\t';
    return '';
  },

  // markerGlyphDiff returns a glyph indicator when a suggestion changed a
  // sentence's leading structural break: green §/¶ if a break was added,
  // struck-through §/¶ if removed. Returns '' when unchanged. § = section
  // (\n\n), ¶ = paragraph (\n\t).
  markerGlyphDiff(committedMarker, effectiveMarker) {
    if (committedMarker === effectiveMarker) return '';
    const glyph = (m) => (m === '\n\n' ? '§' : (m === '\n\t' ? '¶' : ''));
    if (!committedMarker && effectiveMarker) {
      // Break added.
      return `<span class="marker-added">${glyph(effectiveMarker)}</span>`;
    }
    if (committedMarker && !effectiveMarker) {
      // Break removed.
      return `<span class="marker-removed">${glyph(committedMarker)}</span>`;
    }
    // Break type changed (\n\n <-> \n\t): show old struck + new green.
    return `<span class="marker-removed">${glyph(committedMarker)}</span><span class="marker-added">${glyph(effectiveMarker)}</span>`;
  },

  _dmp() {
    if (this.__dmp === undefined) {
      this.__dmp = (typeof diff_match_patch !== 'undefined') ? new diff_match_patch() : null;
    }
    return this.__dmp;
  },

  // renderBlockCommandFrag renders a parsed block command as its structural
  // element (heading / part page / anchor marker), or nothing for &meta. The
  // .sentence span carries the given id so the fragment is hoverable/
  // annotatable and shares identity with the rest of the sentence.
  renderBlockCommandFrag(cmd, id, changed, marker) {
    // Structural break class from the fragment's leading marker — block
    // placeholders honor \n\t (indent) and \n\n (section) like prose does.
    const markerCls = marker === '\n\t' ? 'indented' : (marker === '\n\n' ? 'section-break' : '');
    if (cmd.kind === 'placeholder') {
      const lib = window.WriteSysPlaceholder;
      const spec = window.WriteSysCommand.placeholderSpec(cmd.args);
      const sugClass = changed ? ' has-suggestion' : '';
      if (!lib || !spec.valid) {
        // Mis-syntaxed placeholder prints as literal prose (PLACEHOLDER_PLAN.md).
        return `<p><span class="sentence${sugClass}" data-sentence-id="${this.escapeHtml(id)}">${this.escapeHtml(cmd.raw)}</span></p>`;
      }
      if (spec.unit === 'paragraphs') {
        return lib.blockHTML(spec, cmd.slug, id, changed, this.escapeHtml.bind(this), markerCls);
      }
      // A sentences-unit placeholder alone on its line: a one-run paragraph.
      const chCls = changed ? ' cmd-suggested' : '';
      return `<p class="ph-line${markerCls ? ' ' + markerCls : ''}${chCls}"><span class="sentence${sugClass}" data-sentence-id="${this.escapeHtml(id)}">${lib.inlineHTML(spec, cmd.slug)}</span></p>`;
    }
    if (cmd.kind === 'meta') {
      // A changed &meta renders as a small blue marker (it's otherwise
      // invisible) so the author can find and click it; unchanged is hidden.
      if (changed) {
        return `<div class="cmd-meta cmd-suggested"><span class="sentence" data-sentence-id="${this.escapeHtml(id)}" title="changed setting — click to view">⚙</span></div>`;
      }
      return `<div class="cmd-meta" hidden><span class="sentence" data-sentence-id="${this.escapeHtml(id)}"></span></div>`;
    }
    if (cmd.kind === 'end') {
      // Region terminator: NEVER rendered in the preview — it exists in the
      // raw text (suggest-edit shows it) and that's the only place it should.
      const slugAttr = cmd.slug ? ` data-slug="${this.escapeHtml(cmd.slug)}"` : '';
      return `<div class="cmd-end"${slugAttr} hidden><span class="sentence" data-sentence-id="${this.escapeHtml(id)}"></span></div>`;
    }
    const form = window.WriteSysCommand && window.WriteSysCommand.structuralForm(cmd.raw);
    if (!form) return null;
    const slugAttr = cmd.slug ? ` data-slug="${this.escapeHtml(cmd.slug)}"` : '';
    const chCls = changed ? ' cmd-suggested' : '';
    // A block anchor renders as a ⚓ glyph marker (grey; hover reveals its
    // label). The label itself is outline metadata, never shown as book text.
    // (Normally the ⚓ rides inline at the start of the following paragraph —
    // see the render loop; this block form is the fallback when an anchor has
    // no following prose in its sentence.)
    if (form.glyph) {
      return `<${form.tag} class="${form.cls}${chCls}"${slugAttr}>${this.anchorGlyphHTML(cmd, id, changed)}</${form.tag}>`;
    }
    // Heading shows the LABEL only. The description is outline metadata and is
    // never rendered in the book (it appears in the left-margin outline nav).
    const inner = `<span class="sentence" data-sentence-id="${this.escapeHtml(id)}">${this.applyInlineFormatting(form.visible)}</span>`;
    return `<${form.tag} class="${form.cls}${chCls}"${slugAttr}>${inner}</${form.tag}>`;
  },

  // anchorGlyphHTML renders the ⚓ marker span for a block anchor: grey, hover
  // reveals the label (outline metadata, never book text). Shared by the
  // leading-anchor path (margin=true → pulled into the left margin, aligned to
  // the following paragraph's top) and the standalone fallback (margin=false →
  // its own quiet ⚓ line). The span carries the sentence id so the anchor is
  // hoverable/annotatable like any fragment.
  anchorGlyphHTML(cmd, id, changed, margin) {
    const label = (cmd.args && cmd.args[0]) || '';
    const titleAttr = label ? ` title="${this.escapeHtml(label)}"` : '';
    const chCls = changed ? ' cmd-suggested' : '';
    const marginCls = margin ? ' cmd-anchor-margin' : '';
    const slugAttr = cmd.slug ? ` data-slug="${this.escapeHtml(cmd.slug)}"` : '';
    return `<span class="sentence cmd-anchor-glyph${marginCls}${chCls}" data-sentence-id="${this.escapeHtml(id)}"${slugAttr}${titleAttr} aria-label="anchor">⚓</span>`;
  },

  // Escape first, then substitute *x* → <em> — otherwise the escape pass
  // would re-escape our own <em> tags.
  escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  applyInlineFormatting(text) {
    // Inline &-commands (&reference / &anchor) are rendered specially; the
    // rest of the text gets escape + *italics*. We find command ranges on the
    // RAW text (correct offsets), then process each non-command span normally.
    const cmds = (window.WriteSysCommand && window.WriteSysCommand.findInline)
      ? window.WriteSysCommand.findInline(text)
      : [];
    if (cmds.length === 0) {
      return this.escapeHtml(text).replace(/\*([^*]+)\*/g, '<em>$1</em>');
    }
    const chars = Array.from(text);
    let out = '';
    let pos = 0;
    for (const c of cmds) {
      const before = chars.slice(pos, c.start).join('');
      out += this.escapeHtml(before).replace(/\*([^*]+)\*/g, '<em>$1</em>');
      out += this.renderInlineCommand(c);
      pos = c.end;
    }
    out += this.escapeHtml(chars.slice(pos).join('')).replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return out;
  },

  // renderInlineCommand renders a single inline &reference/&anchor. A
  // reference resolves against the slug map (from the outline); a resolvable
  // one is a link that scrolls to its target, a dangling one shows a broken
  // marker. An inline anchor is an invisible target span.
  renderInlineCommand(c) {
    if (c.kind === 'end') {
      // Invisible region terminator, same treatment as an inline anchor.
      const slug = c.slug ? ` data-slug="${this.escapeHtml(c.slug)}"` : '';
      return `<span class="inline-end"${slug} aria-hidden="true"></span>`;
    }
    if (c.kind === 'placeholder') {
      const lib = window.WriteSysPlaceholder;
      const spec = window.WriteSysCommand && window.WriteSysCommand.placeholderSpec(c.args || []);
      if (!lib || !spec || !spec.valid || spec.unit !== 'sentences') {
        // Mis-syntax — including a paragraphs-form riding mid-line, which
        // must be alone on its line — prints as literal prose.
        return this.escapeHtml(c.raw || '');
      }
      return lib.inlineHTML(spec, c.slug);
    }
    if (c.kind === 'anchor' || c.kind === 'snippet') {
      const slug = c.slug ? ` data-slug="${this.escapeHtml(c.slug)}"` : '';
      const label = (c.args && c.args[0]) || c.slug || '';
      const titleAttr = label ? ` title="${this.escapeHtml(label)}"` : '';
      // The zero-width target stays inline (scroll anchor); the VISIBLE ⚓
      // rides in the left margin at this line's height (absolute, no top →
      // static-position y), so the flow is never touched.
      return `<span class="inline-anchor"${slug} aria-hidden="true"></span>`
        + `<span class="cmd-anchor-glyph cmd-anchor-margin cmd-anchor-margin-inline"${slug}${titleAttr} aria-label="anchor">⚓</span>`;
    }
    // reference
    const slugMap = (window.WriteSysOutline && window.WriteSysOutline.slugMap) || {};
    const targetId = c.slug ? slugMap[c.slug] : undefined;
    const notes = c.notes ? this.escapeHtml(c.notes) : ('↪ ' + this.escapeHtml(c.slug || ''));
    if (targetId) {
      return `<a class="inline-ref" data-ref-target="${this.escapeHtml(targetId)}" title="${this.escapeHtml(c.slug)}">${notes}</a>`;
    }
    return `<span class="inline-ref broken" title="unresolved reference: ${this.escapeHtml(c.slug || '')}">${notes}</span>`;
  },

  // renderInlineCommandsInHtml post-processes diff HTML (already escaped, so
  // '&' is '&amp;') to turn any surviving inline &reference/&anchor tokens
  // into links/markers. Used on a suggested prose fragment's diff output so a
  // reference in edited prose still renders as a link. Tokens that straddle a
  // <del>/<strong> boundary are left as-is (rare; they read as diff text).
  renderInlineCommandsInHtml(html) {
    // Match an escaped command token: &amp;(keyword)(#slug)?{...}{...}...
    // (1-4 brace groups: reference/anchor take 1-2, placeholder up to 4).
    // Args are plain (no nested braces in the escaped stream we care about).
    const re = /&amp;(reference|anchor|placeholder|snippet)(#[a-z0-9-]+)?((?:\{[^{}]*\}){1,4})|&amp;(end)(#[a-z0-9-]+)/g;
    const unescape = (s) => String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    return html.replace(re, (m, kw, hashSlug, groups, endKw, endSlug) => {
      if (endKw) {
        return this.renderInlineCommand({ kind: 'end', slug: endSlug.slice(1), notes: '', args: [], raw: m.replace('&amp;', '&') });
      }
      const slug = hashSlug ? hashSlug.slice(1) : '';
      // args here are already HTML-escaped (we're in escaped output);
      // unescape just for the parse, renderInlineCommand re-escapes.
      const args = [];
      groups.replace(/\{([^{}]*)\}/g, (_, g) => { args.push(unescape(g)); return ''; });
      const raw = '&' + kw + (hashSlug || '') + args.map(a => '{' + a + '}').join('');
      return this.renderInlineCommand({ kind: kw, slug, notes: args[0] || '', args, raw });
    });
  },

  // applyEffectiveSettings computes book-wide settings from the EFFECTIVE text
  // of each sentence — the suggestion if one exists, else committed — so a
  // suggested &meta applies live and a suggested removal drops it. Falls back
  // to the committed-only baseline from the server if the command layer isn't
  // present. Call after loading and whenever suggestions change.
  applyEffectiveSettings() {
    let settings = this.committedSettings || {};
    if (window.WriteSysCommand && this.currentSentences) {
      const sug = (window.WriteSysSuggestions && window.WriteSysSuggestions.bySentenceId) || {};
      const canon = (window.WriteSysCanonicalize && window.WriteSysCanonicalize.canonicalize)
        ? window.WriteSysCanonicalize.canonicalize
        : (t) => t;
      const ids = [];
      const effective = {};
      this.currentSentences.forEach(s => {
        ids.push(s.id);
        const raw = (sug[s.id] !== undefined) ? sug[s.id] : s.text;
        effective[s.id] = canon(raw);
      });
      settings = window.WriteSysCommand.extractSettings(ids, effective);
    }
    this.applySettings(settings);
  },

  // applySettings maps &meta settings onto the document: per-element settings
  // become data-* attributes on <body> that book.css keys on; whole-page
  // settings (font) become CSS custom properties. The property vocabulary is
  // fixed server-side (ExtractSettings), so anything here is already valid.
  applySettings(settings) {
    const body = document.body;
    const setAttr = (attr, val) => {
      if (val) body.setAttribute(attr, val);
      else body.removeAttribute(attr);
    };
    setAttr('data-chapter-align', settings['chapter-align'] || '');
    setAttr('data-part-align', settings['part-align'] || '');
    setAttr('data-title-align', settings['title-align'] || '');
    setAttr('data-divider-folios', settings['divider-folios'] || '');
    if (settings['font']) {
      document.documentElement.style.setProperty('--book-font', settings['font']);
    } else {
      document.documentElement.style.removeProperty('--book-font');
    }
  },

  // A sentence may be split across page fragments; hover/click events propagate
  // to every fragment with the same data-sentence-id.
  setupSentenceHover() {
    document.querySelectorAll('.sentence').forEach(span => {
      span.addEventListener('mouseenter', () => {
        const sentenceId = span.dataset.sentenceId;
        document.querySelectorAll(`.sentence[data-sentence-id="${sentenceId}"]`).forEach(fragment => {
          fragment.classList.add('hover');
        });
      });

      span.addEventListener('mouseleave', () => {
        const sentenceId = span.dataset.sentenceId;
        document.querySelectorAll(`.sentence[data-sentence-id="${sentenceId}"]`).forEach(fragment => {
          fragment.classList.remove('hover');
        });
      });

      span.addEventListener('click', () => {
        const sentenceId = span.dataset.sentenceId;

        // Re-click on the selected sentence opens the suggested-edit modal.
        if (sentenceId === this.currentSelectedSentenceId && window.WriteSysSuggestions) {
          window.WriteSysSuggestions.openModal(sentenceId);
          return;
        }

        if (this.currentSelectedSentenceId) {
          document.querySelectorAll(`.sentence[data-sentence-id="${this.currentSelectedSentenceId}"]`).forEach(fragment => {
            fragment.classList.remove('selected');
          });
        }

        document.querySelectorAll(`.sentence[data-sentence-id="${sentenceId}"]`).forEach(fragment => {
          fragment.classList.add('selected');
        });

        this.currentSelectedSentenceId = sentenceId;

        if (window.WriteSysNotes) {
          // sentenceMap has the full text; the clicked span may be a fragment.
          const fullText = this.sentenceMap[sentenceId] || span.textContent;
          window.WriteSysNotes.showNotesForSentence(sentenceId, fullText);

          // Pulse the first note (which owns the sentence's color).
          setTimeout(() => {
            const firstNote = document.querySelector('.sticky-note');
            if (firstNote) {
              firstNote.scrollIntoView({ behavior: 'smooth', block: 'center' });
              firstNote.classList.add('flash-highlight');
              setTimeout(() => {
                firstNote.classList.remove('flash-highlight');
              }, 600);
            }
          }, 300);
        }
      });
    });
  },

  // Re-insert single spaces between adjacent sentence spans (Paged.js
  // strips the whitespace text nodes).
  insertSpacesBetweenSentences(container) {
    const paragraphs = container.querySelectorAll('p');

    paragraphs.forEach(p => {
      const children = Array.from(p.childNodes);

      for (let i = children.length - 1; i > 0; i--) {
        const current = children[i];
        const prev = children[i - 1];

        if (current.nodeType === 1 && current.classList?.contains('sentence') &&
            prev.nodeType === 1 && prev.classList?.contains('sentence')) {
          p.insertBefore(document.createTextNode(' '), current);
        }
      }
    });
  },

  showStatus(message, type = 'info') {
    // Header no longer renders a visible status field. Errors still log to
    // console; the info-icon tooltip carries the load context.
    if (type === 'error') console.warn('[status]', message);
  },

  getColorValue(colorName) {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(`--highlight-${colorName}`).trim();
  },

  getRainbowBarNotes(notes) {
    if (notes.length === 0) return [];

    const colors = notes.map(a => a.color);
    const barColors = rainbowSlice(colors, { skip: 0, maxSize: 5 });

    const barNotes = [];
    let searchStartIndex = 0;

    barColors.forEach(colorName => {
      for (let i = searchStartIndex; i < notes.length; i++) {
        if (notes[i].color === colorName) {
          barNotes.push(notes[i]);
          searchStartIndex = i + 1;
          break;
        }
      }
    });

    return barNotes;
  },

  calculateRainbowBarPosition(sentenceRect, pageRect) {
    return {
      top: Math.round(sentenceRect.top - pageRect.top),
      height: Math.round(sentenceRect.height)
    };
  },

  createRainbowBar(note, index, sentenceId) {
    const bar = document.createElement('div');
    bar.className = 'rainbow-bar';
    bar.style.position = 'absolute';
    bar.style.top = '0';
    bar.style.left = `${index * 0.5}em`;
    bar.style.width = '0.5em';
    bar.style.height = '100%';
    bar.style.backgroundColor = this.getColorValue(note.color) || '#ccc';
    bar.style.pointerEvents = 'auto';
    bar.style.cursor = 'pointer';

    const noteId = note.note_id || note.id;
    bar.dataset.annotationId = noteId;
    bar.dataset.sentenceId = sentenceId;
    bar.dataset.color = note.color;

    bar.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handleRainbowBarClick(sentenceId, noteId, note.color);
    });

    // Mirror sentence-hover behaviour: hovering a bar previews which
    // sentence it belongs to. Light-grey only — the bar carries the
    // colour cue, the sentence just signals "this is the one".
    bar.addEventListener('mouseenter', () => {
      document.querySelectorAll(`.sentence[data-sentence-id="${sentenceId}"]`).forEach(fragment => {
        fragment.classList.add('hover');
      });
    });
    bar.addEventListener('mouseleave', () => {
      document.querySelectorAll(`.sentence[data-sentence-id="${sentenceId}"]`).forEach(fragment => {
        fragment.classList.remove('hover');
      });
    });

    return bar;
  },

  // Sidebar bars for sentences with multiple notes.
  addRainbowBars() {
    document.querySelectorAll('.rainbow-bar-container').forEach(el => el.remove());

    if (!this.currentNotes || this.currentNotes.length === 0) {
      return;
    }

    const notesBySentence = {};
    this.currentNotes.forEach(note => {
      if (!note.color) return;
      const sentenceId = note.sentence_id;
      if (!notesBySentence[sentenceId]) {
        notesBySentence[sentenceId] = [];
      }
      notesBySentence[sentenceId].push(note);
    });

    Object.keys(notesBySentence).forEach(sentenceId => {
      const notes = notesBySentence[sentenceId];
      const barNotes = this.getRainbowBarNotes(notes);

      if (barNotes.length === 0) return;

      const sentenceFragments = document.querySelectorAll(`.sentence[data-sentence-id="${sentenceId}"]`);

      sentenceFragments.forEach(sentence => {
        const page = sentence.closest('.pagedjs_page');
        if (!page) return;

        const pageArea = page.querySelector('.pagedjs_page_content');
        if (!pageArea) return;

        const sentenceRect = sentence.getBoundingClientRect();
        const pageRect = pageArea.getBoundingClientRect();
        const position = this.calculateRainbowBarPosition(sentenceRect, pageRect);

        const container = document.createElement('div');
        container.className = 'rainbow-bar-container';
        container.style.position = 'absolute';
        container.style.top = `${position.top}px`;
        container.style.left = 'calc(100% + 5px)';
        container.style.width = `${barNotes.length * 0.5}em`;
        container.style.height = `${position.height}px`;
        container.style.pointerEvents = 'none';
        container.style.zIndex = '10';

        barNotes.forEach((note, index) => {
          const bar = this.createRainbowBar(note, index, sentenceId);
          container.appendChild(bar);
        });

        pageArea.appendChild(container);
      });
    });

    const totalBars = document.querySelectorAll('.rainbow-bar-container').length;
    if (totalBars > 0) {
      console.log(`Added rainbow bars for ${totalBars} sentence fragments`);
    }
  },

  handleRainbowBarClick(sentenceId, noteId, color) {
    console.log(`Rainbow bar clicked: sentence=${sentenceId}, note=${noteId}, color=${color}`);

    if (this.currentSelectedSentenceId) {
      document.querySelectorAll(`.sentence[data-sentence-id="${this.currentSelectedSentenceId}"]`).forEach(fragment => {
        fragment.classList.remove('selected');
      });
    }

    document.querySelectorAll(`.sentence[data-sentence-id="${sentenceId}"]`).forEach(fragment => {
      fragment.classList.add('selected');
    });

    this.currentSelectedSentenceId = sentenceId;

    if (window.WriteSysNotes) {
      const fullText = this.sentenceMap[sentenceId] || '';
      window.WriteSysNotes.showNotesForSentence(sentenceId, fullText);

      // Wait for notes to render before we scroll/flash.
      setTimeout(() => {
        this.scrollToAndHighlightNote(noteId);
      }, 300);
    }
  },

  // Scroll a sentence into view (used by the outline navigator). Briefly
  // flashes it so the reader sees where they landed.
  scrollToSentence(sentenceId) {
    const target = document.querySelector(`.sentence[data-sentence-id="${sentenceId}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('flash-highlight');
    setTimeout(() => target.classList.remove('flash-highlight'), 1200);
  },

  scrollToAndHighlightNote(noteId) {
    const noteElement = document.querySelector(`.sticky-note[data-annotation-id="${noteId}"]`);
    if (!noteElement) {
      console.warn(`Note element not found for note ${noteId}`);
      return;
    }

    noteElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    noteElement.classList.add('flash-highlight');

    setTimeout(() => {
      noteElement.classList.remove('flash-highlight');
    }, 600); // matches CSS animation
  },

  // Re-render the per-sentence rainbow bars from the in-memory note
  // cache. Note mutations (create/delete/complete) keep
  // currentNotes in sync via the notes module's _cacheAdd /
  // _cacheRemove + in-place property edits — so we don't need a refetch
  // here. Refetching would also corrupt the shared-object invariant the
  // sentence-click cache read depends on.
  refreshRainbowBars() {
    if (!this.currentMigrationID) return;
    this.addRainbowBars();
  }
};

window.WriteSysRenderer = WriteSysRenderer;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => WriteSysRenderer.init());
} else {
  WriteSysRenderer.init();
}
