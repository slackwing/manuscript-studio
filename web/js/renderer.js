const WriteSysRenderer = {
  apiBaseUrl: 'api',
  currentSentences: [],
  currentAnnotations: [],
  currentMigrationID: null,
  currentCommitHash: null,
  currentSegmenter: null,
  sentenceMap: {}, // sentence id → full text (sentences may be split across pages)
  currentSelectedSentenceId: null,

  async init() {
    console.log('WriteSys Renderer initialized');

    // Bind once at init, not per-render — saves trigger re-renders.
    window.addEventListener('resize', () => this.applyResponsiveScaling());

    const urlParams = new URLSearchParams(window.location.search);
    const idStr = urlParams.get('manuscript_id');
    this.manuscriptId = idStr ? parseInt(idStr, 10) : null;

    // Picker is independent of the manuscript being loadable: always init it
    // so the user can switch even from an empty/no-access state.
    if (window.WriteSysPicker) await window.WriteSysPicker.init();
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
      console.log('No manuscript_id in URL; showing empty state.');
      return;
    }

    // Defense in depth: the picker only listed accessible manuscripts, but a
    // hand-typed URL could point at one the user can't open. Treat that the
    // same as "not loaded".
    const accessible = (window.WriteSysPicker && window.WriteSysPicker.accessible) || [];
    if (accessible.length > 0 && !accessible.find(m => m.manuscript_id === this.manuscriptId)) {
      console.log(`manuscript_id ${this.manuscriptId} not in accessible list; showing empty state.`);
      this.manuscriptId = null;
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
      const processedAt = new Date(migration.processed_at);
      const date = processedAt.toLocaleDateString();
      const session = window.currentSession || {};
      const picker = window.WriteSysPicker;
      const manuscriptName = (picker && picker.currentName) || '';
      if (window.WriteSysInfoTooltip) {
        window.WriteSysInfoTooltip.set([
          manuscriptName ? ['Manuscript', manuscriptName] : null,
          session.username ? ['User', session.username] : null,
          ['Commit', shortHash],
          ['Segmenter', migration.segmenter],
          ['Loaded', date],
          ['Sentences', String(migration.sentence_count)],
        ].filter(Boolean));
      }
      this.renderUpdatedLabel(processedAt);

      console.log(`Loading migration ${migration.migration_id}: ${shortHash} with segmenter ${migration.segmenter}`);

      await this.loadManuscriptByMigration(migration.migration_id);
      this.startMigrationPoll();

    } catch (error) {
      console.error('Failed to load latest migration:', error);
      this.showStatus(`Error: ${error.message}`, 'error');
      if (window.WriteSysInfoTooltip) {
        window.WriteSysInfoTooltip.set([['Error', error.message]]);
      }
      this.renderUpdatedLabel(null);
    }
  },

  // Top-bar "Manuscript Updated: …" — formatted in the browser's timezone so
  // the abbreviation (EDT/EST/etc.) reflects where the reader is, not the VM.
  renderUpdatedLabel(processedAt) {
    const el = document.getElementById('manuscript-updated');
    if (!el) return;
    if (!processedAt) {
      el.textContent = '';
      return;
    }
    const monthDay = processedAt.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
    const time = processedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    const parts = processedAt.toLocaleTimeString(undefined, { timeZoneName: 'short' }).split(' ');
    const tz = parts[parts.length - 1] || '';
    el.textContent = `Manuscript Updated: ${monthDay}, ${time}${tz ? ' ' + tz : ''}`;
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
      this.currentAnnotations = data.annotations;
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

    // Sentence backgrounds are now driven by note focus (not annotation
    // presence): a sentence stays unfilled by default, picks up its
    // selected-grey on click, and tints to a note's color only while
    // that note's textarea has the typing caret. Side-bars (rainbow)
    // still convey the annotation set at a glance — see addRainbowBars().

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
  },

  applyResponsiveScaling() {
    const pagesContainer = document.querySelector(".pagedjs_pages");
    if (!pagesContainer) return;

    if (window.innerWidth <= 768) {
      const pageWidth = 600; // 6in @ 96dpi
      const viewportWidth = window.innerWidth;
      const scale = (viewportWidth * 0.7) / pageWidth; // 70% leaves border room
      pagesContainer.style.transform = `scale(${scale})`;
      pagesContainer.style.transformOrigin = "top center";
      pagesContainer.style.padding = "1em";
      pagesContainer.style.background = "transparent";
      document.body.style.background = "white";
    } else {
      pagesContainer.style.transform = "";
      pagesContainer.style.transformOrigin = "";
      pagesContainer.style.padding = "2em";
      pagesContainer.style.background = "#f5f5f5";
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
      const effective = (suggestion !== undefined) ? suggestion : committed;

      // Segment the effective text into fragments, all sharing this
      // sentence's real ID (SUGGESTION_RENDER_PLAN.md). Each renders by kind.
      const frags = cmdLib ? cmdLib.segmentFragments(effective) : [{ kind: 'prose', text: effective, marker: '' }];
      // The original prose (committed, marker-stripped) to diff a single-prose
      // suggestion against. Multi-fragment suggestions show the result of each
      // fragment; only a lone prose fragment gets a word-diff vs. the original.
      const origProse = this.stripLeadingMarker(committed);
      const loneProse = frags.length === 1 && frags[0].kind === 'prose';

      for (const f of frags) {
        if (f.kind === 'command') {
          // Block command fragment → render its result, no diff. &meta renders
          // nothing. All share this sentence's id.
          flush();
          const html = this.renderBlockCommandFrag(f.cmd, id);
          if (html) out.push(html);
          continue;
        }
        if (f.kind === 'header') {
          // Legacy Markdown header fragment → render as <h*>, result only (a
          // structural block, like a command). Transition support.
          flush();
          out.push(`<h${f.level}><span class="sentence" data-sentence-id="${this.escapeHtml(id)}">${this.applyInlineFormatting(f.text)}</span></h${f.level}>`);
          continue;
        }
        // Prose fragment.
        const cls = f.marker === '\n\n' ? 'section-break' : (f.marker === '\n\t' ? 'indented' : '');
        const body = this.stripLeadingMarker(f.text);
        let inner;
        if (suggestion !== undefined && loneProse) {
          // A pure prose edit → word-level diff vs. the committed prose, then
          // render any inline &reference/&anchor tokens that survived the diff
          // as links/markers (they're escaped as &amp;… in the diff HTML).
          inner = this.renderInlineCommandsInHtml(renderDiffHTML(origProse, body, this._dmp()));
        } else {
          inner = this.applyInlineFormatting(body);
        }
        const sugClass = (suggestion !== undefined) ? ' has-suggestion' : '';
        const span = `<span class="sentence${sugClass}" data-sentence-id="${this.escapeHtml(id)}">${inner}</span>`;
        pushProse(cls, span);
      }
    }

    flush();
    return out.join('\n');
  },

  // stripLeadingMarker removes a single leading \n\n or \n\t (structural) so
  // it doesn't appear in visible text — the marker only chooses the block.
  stripLeadingMarker(text) {
    const t = String(text == null ? '' : text);
    if (t.startsWith('\n\n') || t.startsWith('\n\t')) return t.slice(2);
    return t;
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
  renderBlockCommandFrag(cmd, id) {
    if (cmd.kind === 'meta') {
      return `<div class="cmd-meta" hidden><span class="sentence" data-sentence-id="${this.escapeHtml(id)}"></span></div>`;
    }
    const form = window.WriteSysCommand && window.WriteSysCommand.structuralForm(cmd.raw);
    if (!form) return null;
    const slugAttr = cmd.slug ? ` data-slug="${this.escapeHtml(cmd.slug)}"` : '';
    const inner = `<span class="sentence" data-sentence-id="${this.escapeHtml(id)}">${this.applyInlineFormatting(form.visible)}</span>`;
    let extra = '';
    if (cmd.kind === 'part' && form.description) {
      extra = `<span class="cmd-part-desc">${this.applyInlineFormatting(form.description)}</span>`;
    }
    return `<${form.tag} class="${form.cls}"${slugAttr}>${inner}${extra}</${form.tag}>`;
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
    if (c.kind === 'anchor') {
      const slug = c.slug ? ` data-slug="${this.escapeHtml(c.slug)}"` : '';
      // Invisible marker (zero-width) — the host sentence is the scroll target.
      return `<span class="inline-anchor"${slug} aria-hidden="true"></span>`;
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
    // Match an escaped command token: &amp;(keyword)(#slug)?{notes?}
    // Notes are plain (no nested braces in the escaped stream we care about).
    const re = /&amp;(reference|anchor)(#[a-z0-9-]+)?\{([^{}]*)\}/g;
    return html.replace(re, (m, kw, hashSlug, notes) => {
      const slug = hashSlug ? hashSlug.slice(1) : '';
      // notes here is already HTML-escaped (we're in escaped output); unescape
      // just for the parse, renderInlineCommand re-escapes.
      const rawNotes = String(notes)
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      return this.renderInlineCommand({ kind: kw, slug, notes: rawNotes });
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
      const ids = [];
      const effective = {};
      this.currentSentences.forEach(s => {
        ids.push(s.id);
        effective[s.id] = (sug[s.id] !== undefined) ? sug[s.id] : s.text;
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

  // renderBlockCommand renders a block &-command sentence as a heading
  // element, or returns null if `text` is not a block command. Uses
  // WriteSysCommand.structuralForm as the single source of truth for tag /
  // class / visible text (the heading shows the LABEL only — the description
  // is outline metadata, not rendered on the page). The .sentence span is
  // kept so the sentence stays hoverable/annotatable, and the slug is exposed
  // on data-slug for later phases.
  renderBlockCommand(text, id) {
    const cmd = window.WriteSysCommand;
    if (!cmd) return null;
    const parsed = cmd.parse(text.trim());
    if (!parsed || !cmd.BLOCK[parsed.kind] || parsed.raw !== text.trim()) return null;
    // &meta renders as nothing (it's a setting), but stays in the DOM as a
    // hidden, still-annotatable sentence span so it can be edited/suggested on.
    if (parsed.kind === 'meta') {
      return `<div class="cmd-meta" hidden><span class="sentence" data-sentence-id="${this.escapeHtml(id)}"></span></div>`;
    }
    const form = cmd.structuralForm(text);
    if (!form) return null;

    const slugAttr = parsed.slug ? ` data-slug="${this.escapeHtml(parsed.slug)}"` : '';
    const inner = `<span class="sentence" data-sentence-id="${this.escapeHtml(id)}">${this.applyInlineFormatting(form.visible)}</span>`;
    // Part dividers carry the description as a subtitle on their own page
    // (like a book's part-title page: "Part I" / "The Gathering"). The label
    // stays in the .sentence span (hoverable/annotatable); the subtitle is
    // presentational.
    let extra = '';
    if (parsed.kind === 'part' && form.description) {
      extra = `<span class="cmd-part-desc">${this.applyInlineFormatting(form.description)}</span>`;
    }
    return `<${form.tag} class="${form.cls}"${slugAttr}>${inner}${extra}</${form.tag}>`;
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

        if (window.WriteSysAnnotations) {
          // sentenceMap has the full text; the clicked span may be a fragment.
          const fullText = this.sentenceMap[sentenceId] || span.textContent;
          window.WriteSysAnnotations.showAnnotationsForSentence(sentenceId, fullText);

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

  getRainbowBarAnnotations(annotations) {
    if (annotations.length === 0) return [];

    const colors = annotations.map(a => a.color);
    const barColors = rainbowSlice(colors, { skip: 0, maxSize: 5 });

    const barAnnotations = [];
    let searchStartIndex = 0;

    barColors.forEach(colorName => {
      for (let i = searchStartIndex; i < annotations.length; i++) {
        if (annotations[i].color === colorName) {
          barAnnotations.push(annotations[i]);
          searchStartIndex = i + 1;
          break;
        }
      }
    });

    return barAnnotations;
  },

  calculateRainbowBarPosition(sentenceRect, pageRect) {
    return {
      top: Math.round(sentenceRect.top - pageRect.top),
      height: Math.round(sentenceRect.height)
    };
  },

  createRainbowBar(annotation, index, sentenceId) {
    const bar = document.createElement('div');
    bar.className = 'rainbow-bar';
    bar.style.position = 'absolute';
    bar.style.top = '0';
    bar.style.left = `${index * 0.5}em`;
    bar.style.width = '0.5em';
    bar.style.height = '100%';
    bar.style.backgroundColor = this.getColorValue(annotation.color) || '#ccc';
    bar.style.pointerEvents = 'auto';
    bar.style.cursor = 'pointer';

    const annId = annotation.annotation_id || annotation.id;
    bar.dataset.annotationId = annId;
    bar.dataset.sentenceId = sentenceId;
    bar.dataset.color = annotation.color;

    bar.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handleRainbowBarClick(sentenceId, annId, annotation.color);
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

  // Sidebar bars for sentences with multiple annotations.
  addRainbowBars() {
    document.querySelectorAll('.rainbow-bar-container').forEach(el => el.remove());

    if (!this.currentAnnotations || this.currentAnnotations.length === 0) {
      return;
    }

    const annotationsBySentence = {};
    this.currentAnnotations.forEach(annotation => {
      if (!annotation.color) return;
      const sentenceId = annotation.sentence_id;
      if (!annotationsBySentence[sentenceId]) {
        annotationsBySentence[sentenceId] = [];
      }
      annotationsBySentence[sentenceId].push(annotation);
    });

    Object.keys(annotationsBySentence).forEach(sentenceId => {
      const annotations = annotationsBySentence[sentenceId];
      const barAnnotations = this.getRainbowBarAnnotations(annotations);

      if (barAnnotations.length === 0) return;

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
        container.style.width = `${barAnnotations.length * 0.5}em`;
        container.style.height = `${position.height}px`;
        container.style.pointerEvents = 'none';
        container.style.zIndex = '10';

        barAnnotations.forEach((annotation, index) => {
          const bar = this.createRainbowBar(annotation, index, sentenceId);
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

  handleRainbowBarClick(sentenceId, annotationId, color) {
    console.log(`Rainbow bar clicked: sentence=${sentenceId}, annotation=${annotationId}, color=${color}`);

    if (this.currentSelectedSentenceId) {
      document.querySelectorAll(`.sentence[data-sentence-id="${this.currentSelectedSentenceId}"]`).forEach(fragment => {
        fragment.classList.remove('selected');
      });
    }

    document.querySelectorAll(`.sentence[data-sentence-id="${sentenceId}"]`).forEach(fragment => {
      fragment.classList.add('selected');
    });

    this.currentSelectedSentenceId = sentenceId;

    if (window.WriteSysAnnotations) {
      const fullText = this.sentenceMap[sentenceId] || '';
      window.WriteSysAnnotations.showAnnotationsForSentence(sentenceId, fullText);

      // Wait for notes to render before we scroll/flash.
      setTimeout(() => {
        this.scrollToAndHighlightAnnotation(annotationId);
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

  scrollToAndHighlightAnnotation(annotationId) {
    const noteElement = document.querySelector(`.sticky-note[data-annotation-id="${annotationId}"]`);
    if (!noteElement) {
      console.warn(`Note element not found for annotation ${annotationId}`);
      return;
    }

    noteElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    noteElement.classList.add('flash-highlight');

    setTimeout(() => {
      noteElement.classList.remove('flash-highlight');
    }, 600); // matches CSS animation
  },

  // Re-render the per-sentence rainbow bars from the in-memory annotation
  // cache. Annotation mutations (create/delete/complete) keep
  // currentAnnotations in sync via the annotations module's _cacheAdd /
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
