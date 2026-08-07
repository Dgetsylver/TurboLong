# Diagram sources — `docs/threat-model-stride.docx` §1.6

The threat model ships as a `.docx`, so its diagrams live in the document as
raster images. These are the sources that produce them. **Edit here, never the
PNG** — the previous version of this diagram existed only as a 4752×1359 PNG
embedded in the document, with no source anywhere, and correcting a single
function name meant redrawing it from scratch.

## Files

| File | What it is |
| --- | --- |
| `gen.py` | Emits both diagrams as SVG. Hand-laid-out — see *Why not Mermaid* below. |
| `render.sh` | Runs `gen.py`, then rasterises each SVG to a 2× PNG via headless Chrome. |
| `dfd_a.svg` / `dfd_b.svg` | Generated. Committed so a reviewer can diff the drawing without running anything. |
| `docx-patches/reembed.py` | Pushes the rendered PNGs back into the `.docx`, resizing to their true aspect. Idempotent — run it after every render. |
| `docx-patches/patch_*.py` | One-shot scripts that applied the v1.5 edits. Already run; kept as a record of exactly what changed. |

## Regenerating

```sh
./render.sh                    # -> dfd_a.png (3040×2020), dfd_b.png (2880×2120)
python3 docx-patches/reembed.py
```

`reembed.py` handles the sizing: it reads each PNG's real pixel dimensions and
sets the drawing extents from them, so the image can never end up stretched.
Widths are pinned at 9.4in and 8.7in on the 10in landscape text column, giving
about 6.3in of height and ~0.6in of slack under each caption. Widen them and
the caption orphans onto the next page.

Two things about this package that will bite if you embed an image by hand: it
declares content types **per part** rather than by extension, so a new image
needs an explicit `<Override>` in `[Content_Types].xml` as well as a
relationship in `word/_rels/document.xml.rels` — miss the Override and Word
refuses to open the file. `patch_docx.py` shows both.

## The two views

**A — control.** Who may invoke what. TB-1/TB-2/TB-3 gate the callers; TB-6 is
drawn as the boundary *between* strategy and share token, matching §1.6's
boundary table. Carries DF-1…DF-8, DF-20, DF-21.

**B — value.** Principal in and out, plus the harvest round trip through both
routes. TB-4 bounds the external protocols; TB-5 cuts between the on-chain swap
account and the off-chain Broker. Carries DF-9…DF-19 and DF-23.

`DF-22` is deliberately absent. It recorded the alerts worker consuming contract
events; `alerts/src/stellar.ts` simulates Blend pool view calls and reads none
of this contract's events, which is what Repudiate.1 says. Leave the gap — the
numbers are cited about forty times across §2 and §3, so renumbering costs more
than it buys.

**If you add a flow, add it to §2.** §2.2 claims the threat table was enumerated
by walking these flows. A flow no §2 row cites is either unexamined or not worth
a number; five such flows accumulated before v1.5.

## Why not Mermaid

The original was Mermaid, and its auto-layout is what made it unreadable: 20
nodes and 23 flows routed across the full width, with edge labels landing far
from the edges they annotated. These diagrams place every node and label
explicitly, which is more code but keeps labels on their edges and holds the
aspect ratio near 1.4:1 so the drawing uses the page's height instead of a
2.9in strip. `gen.py`'s helpers (`node`, `boundary`, `flow_label`, `arrow`) keep
that cheap to edit.
