#!/usr/bin/env python3
"""§3.2 Work items — fix ordering and close the coverage gaps.

§3.2 is not bloated: 2,584 chars of item text across 29 rows. Its defects are
structural.

1. It is not in priority order, though it claims to be "ordered by expected
   risk reduction per unit of effort". A P2 (one-time guard on
   set_share_token) sat above a P1, and a second P2 (pin the approved spender)
   sat in the middle of the P3 block. Anyone working the list top-down would
   have done both ahead of higher-priority work.

2. Six planned treatments had no work item. Two were citation omissions —
   Spoof.2.R.2 is substantively the P0 custody row and Elevation.1.R.2 is
   substantively the P1 events row; both now cited. The other four were
   genuinely absent, and all four are user-facing or operational:
   DoS.1.R.2 (pause-state UI), DoS.2.R.2 (pool-dependency disclosure and vault
   sizing), DoS.7.R.2 (incident runbook), Spoof.4.R.1 (PR checklist wording).
   The backlog tracked code work and dropped the comms/ops work.

DoS.7.R.2 is added at P1 rather than parked behind §3.3's pause decision: its
own text says to write the runbook "whatever is decided", and there is
currently no documented answer to "Blend is compromised, what do we do".
"""
import re
import shutil
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
DOCX = HERE.parent.parent / "threat-model-stride.docx"

RPR = {"plain": "",
       "code": '<w:rPr><w:rStyle w:val="VerbatimChar" /></w:rPr>',
       "bold": '<w:rPr><w:b /><w:bCs /></w:rPr>',
       "ital": '<w:rPr><w:i /><w:iCs /></w:rPr>'}
W = [1060, 10065, 2215, 1060]


def esc(t):
    return (t.replace("&", "&amp;").replace("<", "&lt;")
             .replace(">", "&gt;").replace("'", "&#39;"))


def runs(parts):
    if isinstance(parts, str):
        parts = [("plain", parts)]
    return "".join(f'<w:r>{RPR[k]}<w:t xml:space="preserve">{esc(t)}</w:t>'
                   '</w:r>' for k, t in parts)


def row(cells):
    out = []
    for w, c in zip(W, cells):
        out.append(f'<w:tc><w:tcPr><w:tcW w:type="dxa" w:w="{w}" /></w:tcPr>'
                   '<w:tcPr /><w:p><w:pPr><w:pStyle w:val="Compact" /></w:pPr>'
                   + runs(c) + '</w:p></w:tc>')
    return "<w:tr>" + "".join(out) + "</w:tr>"


C, P, B = "code", "plain", "bold"

# (priority, item, treatments, effort) in corrected priority order.
ITEMS = [
 ("P0", "Multisig admin custody + record custody model",
  "Elevation.1.R.1, .4.R.3, Spoof.2.R.2", "Ops"),
 ("P0", [(P, "Runtime risk-parameter coherence check in "),
         (C, "check_deposit_safety"), (P, " — both "),
         (C, "c_factor <= pool_c_factor"), (P, " (Tamper.1) and "),
         (C, "design_hf > orange_hf"), (P, " (Tamper.11). One call site "
             "closes both, and Tamper.11 trips on a ~2pp "), (C, "l_factor"),
         (P, " move against Tamper.1's 5pp, so it is the binding one")],
  "Tamper.1.R.1, .R.2, Tamper.11.R.1", "Small"),
 ("P0", "Constructor assertion for the same coherence, so an incoherent set "
        "cannot deploy without the script", "Tamper.11.R.2", "Trivial"),
 ("P0", [(P, "Investigate: does Blend net transfers across a "), (C, "submit"),
         (P, "? Settles DoS.2's severity and fixes whichever contradictory "
             "comment is wrong. "), (C, "blend_pool.rs:46-47"),
         (P, " is already known to be the wrong one; the open part is "
             "sequential vs full netting")],
  "DoS.2 (§2.5)", "Small"),

 ("P1", "Correct the non-upgradeability claim to holders [L-2] — a false "
        "statement made to users", "Elevation.4.R.2", "Trivial"),
 ("P1", [(P, "Events on all privileged mutations + alerts [L-6] — including "),
         (C, "set_keeper"), (P, ", which unblocks Elevation.7.R.3, and "),
         (C, "upgrade"), (P, ", which is the only on-chain detection "
             "available against a malicious upgrade")],
  "Repudiate.1.R.1, .R.2, Elevation.1.R.2, .7.R.3", "Small"),
 ("P1", [(P, "Extend "), (C, "Keeper"), (P, " (and "), (C, "Reserves"),
         (P, ") persistent TTL on read — a dated, certain outage of all vault "
             "maintenance, fixed in two lines")],
  "DoS.9.R.1, .R.2", "Trivial"),
 ("P1", [(P, "Require "), (C, "min_harvest_rate"),
         (P, " for any swap (M-5 residual)")], "Elevation.5.R.1", "Small"),
 ("P1", [(P, "Two-step admin handover in "), (C, "admin-sep")],
  "Elevation.2.R.1", "Medium"),
 ("P1", [(P, "Regression test + decision on public "), (C, "burn"),
         (P, " [L-1]")], "Tamper.6.R.1", "Small"),
 ("P1", [(P, "Thresholds on risk factors, utilization and "), (C, "design_hf"),
         (P, " margin. "), (C, "alerts/"), (P, " already decodes "),
         (C, "cFactor"), (P, ", "), (C, "lFactor"), (P, " and util per asset "
             "every tick — only the comparisons and notifications are "
             "missing, so this is Small, not Medium, and it is the detection "
             "half of both P0 rows")],
  "Tamper.1.R.3, Tamper.11.R.3, DoS.1.R.3", "Small"),
 ("P1", "Incident runbook for “Blend pool compromised / bug found in "
        "our contract”, naming the lever. There is no documented answer "
        "today, and it is needed whatever §3.3 decides about a pause",
  "DoS.7.R.2", "Ops"),

 ("P2", [(P, "One-time guard on "), (C, "set_share_token"),
         (P, " [L-2] — cheap, but adds no capability bound")],
  "Spoof.2.R.1, Elevation.3.R.1", "Small"),
 ("P2", [(P, "Event-driven monitoring: "), (C, "reserves_sync"),
         (P, ", instance and persistent TTL, keeper changes. "), (C, "alerts/"),
         (P, " currently consumes none of this contract's events — this is "
             "the half that needs new plumbing, and it is gated on "
             "Repudiate.1.R.1")],
  "DoS.5.R.2, DoS.9.R.3, Elevation.7.R.3", "Medium"),
 ("P2", "Canonical contract IDs published + frontend verification",
  "Spoof.1.R.1, .R.2", "Medium"),
 ("P2", [(P, "Attribution on "), (C, "rebalance"), (P, " / "),
         (C, "sync_reserves"), (P, " / "), (C, "migrate_position")],
  "Repudiate.2.R.1, .3.R.1", "Small"),
 ("P2", [(P, "Pin the approved spender in "), (C, "PendingHarvest"),
         (P, " so the revoke survives a swap-account rotation")],
  "Elevation.6.R.3", "Trivial"),
 ("P2", "User-facing disclosure: surface the utilization pause as a known "
        "state with the live number, disclose the pool-liquidity dependency, "
        "and size the vault against pool depth",
  "DoS.1.R.2, DoS.2.R.2", "Medium"),

 ("P3", [(C, "MAX_RATE_SPREAD"), (P, ": implement or delete [L-4]")],
  "Tamper.8.R.1", "Small"),
 ("P3", "Overflow propagation in deposit projection [L-3]",
  "Tamper.2.R.1", "Small"),
 ("P3", "Cap full-close approve at outstanding debt [L-5]",
  "Tamper.7.R.1", "Trivial"),
 ("P3", [(C, "data"), (P, " length validation + cooldown error code [L-7]")],
  "DoS.8.R.1", "Trivial"),
 ("P3", [(P, "Trait "), (C, "harvest"), (P, " should sweep a lapsed "),
         (C, "PendingHarvest"), (P, " rather than refuse on it")],
  "DoS.4.R.2", "Trivial"),
 ("P3", "Correct “a donation cannot move the share price” to "
        "“a collateral donation”", "Tamper.9.R.2", "Trivial"),
 ("P3", [(C, "ADMIN"), (P, " storage-key preservation on the upgrade "
                            "checklist — "), (C, "set_admin"),
         (P, " is ungated when the entry is absent")],
  "Elevation.2.R.3", "Trivial"),
 ("P3", [(P, "Comment + checklist item on "), (C, "migrate_position"),
         (P, ", the only unauthenticated "), (C, "mint"),
         (P, "; retire it once migration completes")],
  "Elevation.8.R.2, .R.3", "Trivial"),
 ("P3", [(P, "PR checklist: keep the "), (C, "caller == keeper"),
         (P, " equality check adjacent to every keeper "),
         (C, "require_auth()"), (P, " that takes a caller parameter — phrased "
             "as a conditional, since "), (C, "set_keeper"),
         (P, " is the standing exception")],
  "Spoof.4.R.1", "Trivial"),
 ("P3", "Recovery drills (keeper compromise, admin rotation)",
  "Elevation.2.R.2, .7.R.2", "Ops"),
 ("P3", "Harvest floor tightening + rotation", "Info.1.R.2, .R.1", "Ops"),

 ("—", [(P, "Emergency pause on "), (C, "deposit"), (P, "?")],
  "DoS.7.R.1", "⚠ decision first"),
 ("—", "Upgrade timelock", "Elevation.1.R.3", "⚠ decision first"),
 ("—", [(P, "Cap keeper "), (C, "target_hf"),
        (P, "? (reopens accepted M-1 residual)")],
  "DoS.3.R.1", "⚠ decision first"),
]


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")

    a = doc.index("Work items, prioritised")
    b = doc.index("Decisions needed")
    m = re.search(r'<w:tbl>.*?</w:tbl>', doc[a:b], re.S)
    tbl = m.group(0)
    rows = list(re.finditer(r'<w:tr>.*?</w:tr>', tbl, re.S))
    assert len(rows) == 30, f"expected 30 rows, found {len(rows)}"
    header = rows[0].group(0)

    body = "".join(row(it) for it in ITEMS)
    new_tbl = tbl[:rows[0].start()] + header + body + tbl[rows[-1].end():]
    print(f"  rows: {len(rows) - 1} -> {len(ITEMS)}")
    print(f"  table XML: {len(tbl):,} -> {len(new_tbl):,}")
    doc = doc[:a + m.start()] + new_tbl + doc[a + m.end():]

    out = HERE / "_wi.docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for it in zin.infolist():
            zo.writestr(it, doc.encode("utf-8")
                        if it.filename == "word/document.xml"
                        else zin.read(it.filename))
    zin.close()
    shutil.move(out, DOCX)
    print("§3.2 reordered, gaps closed")


if __name__ == "__main__":
    main()
