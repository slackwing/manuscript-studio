package sentence

import "strings"

// Outline is the document structure derived from block commands, for the
// left-margin navigator (TEX_COMMANDS_PLAN.md §5). Built from the migration's
// sentences in ordinal order.
type Outline struct {
	Title *OutlineTitle `json:"title,omitempty"`
	Parts []OutlinePart `json:"parts"`
	// Anchors and chapters that appear before any part (document-level).
	TopChapters []OutlineChapter `json:"top_chapters"`
	TopAnchors  []OutlineAnchor  `json:"top_anchors"`
}

type OutlineTitle struct {
	Name       string `json:"name"`
	Slug       string `json:"slug,omitempty"`
	SentenceID string `json:"sentence_id"`
}

type OutlinePart struct {
	Label       string           `json:"label"`
	Description string           `json:"description,omitempty"`
	Slug        string           `json:"slug,omitempty"`
	SentenceID  string           `json:"sentence_id"`
	Chapters    []OutlineChapter `json:"chapters"`
	Anchors     []OutlineAnchor  `json:"anchors"`
}

type OutlineChapter struct {
	Label       string          `json:"label"`
	Description string          `json:"description,omitempty"`
	Slug        string          `json:"slug,omitempty"`
	SentenceID  string          `json:"sentence_id"`
	Anchors     []OutlineAnchor `json:"anchors"`
}

type OutlineAnchor struct {
	Description string `json:"description,omitempty"`
	Slug        string `json:"slug,omitempty"`
	SentenceID  string `json:"sentence_id"`
}

// BuildOutline constructs the outline from sentences in document (ordinal)
// order. Each item is (sentenceID, text). A block-anchor attaches to the most
// recently opened chapter, else the most recent part, else document root.
// Non-command sentences are ignored. Inline anchors (not their own sentence)
// don't appear here — the outline is structural.
func BuildOutline(ids []string, textByID map[string]string) *Outline {
	o := &Outline{Parts: []OutlinePart{}, TopChapters: []OutlineChapter{}, TopAnchors: []OutlineAnchor{}}

	// Indexes of the "currently open" containers, or -1.
	curPart := -1
	curChapter := -1 // index within the current part's Chapters, or into TopChapters when curPart == -1

	for _, id := range ids {
		text, ok := textByID[id]
		if !ok {
			continue
		}
		cmd, ok := ParseCommand(strings.TrimSpace(text))
		if !ok || !blockCommandKinds[cmd.Kind] || cmd.Raw != strings.TrimSpace(text) {
			continue
		}

		label := ""
		if len(cmd.Args) > 0 {
			label = cmd.Args[0]
		}
		desc := ""
		if len(cmd.Args) > 1 {
			desc = cmd.Args[1]
		}

		switch cmd.Kind {
		case CmdTitle:
			o.Title = &OutlineTitle{Name: label, Slug: cmd.Slug, SentenceID: id}

		case CmdPart:
			o.Parts = append(o.Parts, OutlinePart{
				Label: label, Description: desc, Slug: cmd.Slug, SentenceID: id,
				Chapters: []OutlineChapter{}, Anchors: []OutlineAnchor{},
			})
			curPart = len(o.Parts) - 1
			curChapter = -1

		case CmdChapter:
			ch := OutlineChapter{Label: label, Description: desc, Slug: cmd.Slug, SentenceID: id, Anchors: []OutlineAnchor{}}
			if curPart >= 0 {
				o.Parts[curPart].Chapters = append(o.Parts[curPart].Chapters, ch)
				curChapter = len(o.Parts[curPart].Chapters) - 1
			} else {
				o.TopChapters = append(o.TopChapters, ch)
				curChapter = len(o.TopChapters) - 1
			}

		case CmdAnchor, CmdPlaceholder:
			// A block anchor's outline text is its {label} (first arg). A
			// placeholder lists exactly like an anchor — indistinguishable in
			// the outline — using its own {label} field; a mis-syntaxed
			// placeholder renders as prose and stays out of the outline.
			if cmd.Kind == CmdPlaceholder {
				spec := ParsePlaceholder(cmd)
				// Unlabeled placeholders are pure spacing — not outline-worthy.
				if !spec.Valid || strings.TrimSpace(spec.Label) == "" {
					continue
				}
				label = spec.Label
			}
			a := OutlineAnchor{Description: label, Slug: cmd.Slug, SentenceID: id}
			switch {
			case curPart >= 0 && curChapter >= 0:
				o.Parts[curPart].Chapters[curChapter].Anchors = append(o.Parts[curPart].Chapters[curChapter].Anchors, a)
			case curPart >= 0:
				o.Parts[curPart].Anchors = append(o.Parts[curPart].Anchors, a)
			case curChapter >= 0:
				o.TopChapters[curChapter].Anchors = append(o.TopChapters[curChapter].Anchors, a)
			default:
				o.TopAnchors = append(o.TopAnchors, a)
			}
		}
	}

	return o
}
