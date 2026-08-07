#!/usr/bin/env python3
"""Denial of Service pass.

REGRESSION FIX (mine): patch_dedupe.py removed one run from DoS.7 to strip a
sentence narrating what §1.1 failed to ask. That run also carried the clause
"— a full code replacement, under the key whose compromise is the thing you
might be responding to", which is the actual point of the row. DoS.7 has been
ending mid-sentence at "the only lever is upgrade" ever since. Restored.

Verified correct: MAX_SAFE_UTILIZATION = 9_500_000 (constants.rs:9) and the
panic at leverage.rs:266-268; INSTANCE_BUMP_AMOUNT = 30 days and
PERSISTENT_BUMP_AMOUNT = 120 days (storage.rs:7, :10); the DoS.4 citations
(lib.rs:292-294, :1085-1088); DoS.8's copy_into_slice (lib.rs:311) and the
NotAuthorized/DeadlineExpired asymmetry (lib.rs:574 vs the comment at :676);
DoS.9's storage.rs contrast and lib.rs:617.

DoS.2 narrowed. §2.5 says the netting question is unresolved and "whichever
comment is wrong should be fixed". blend_pool.rs:46-47 is the wrong one as
written: it claims the pool "sums all supply amounts and does one
transfer_from for the total", but deposit approves total_supply (~4.1x the
deposit at target_loops 4, blend_pool.rs:96-101) while the contract holds only
`amount`, so a single summed pull would revert and deposits would never work.
That leaves sequential-per-request vs netting across supplies *and* borrows —
both consistent with a working deposit, and only the former makes DoS.2 High.
The vendored SDK is WASM-only, so finishing this needs upstream Blend source.
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
C, P, B, I = "code", "plain", "bold", "ital"


def esc(t):
    return (t.replace("&", "&amp;").replace("<", "&lt;")
             .replace(">", "&gt;").replace("'", "&#39;"))


def runs(parts):
    return "".join(f'<w:r>{RPR[k]}<w:t xml:space="preserve">{esc(t)}</w:t>'
                   '</w:r>' for k, t in parts)


ROWS = {
 "DoS.2": [
  (P, "Withdrawals require the pool to have free liquidity for the withdraw "
      "legs of the unwind. A fully utilized pool blocks "), (C, "withdraw"),
  (P, " entirely — funds are unreachable, not lost, until utilization falls. "),
  (B, "Severity is unproven and turns on whether Blend nets transfers across "
      "a submit"), (P, ", which the code's own comments contradict: "),
  (C, "blend_pool.rs:23-26"), (P, " says sequential per-request, "),
  (C, ":46-47"), (P, " says one summed "), (C, "transfer_from"), (P, ". "),
  (C, ":46-47"), (P, " is the wrong one as written: deposit approves "),
  (C, "total_supply"), (P, " (~4.1× the deposit at "), (C, "target_loops"),
  (P, " 4, "), (C, "blend_pool.rs:96-101"), (P, ") while the contract holds "
      "only "), (C, "amount"), (P, ", so a single summed pull would revert "
      "and no deposit would ever succeed. What remains open is "
      "sequential-per-request versus netting across supplies "), (I, "and"),
  (P, " borrows — both consistent with a working deposit, and only the former "
      "makes this High. The vendored SDK is WASM-only, so settling it needs "
      "the upstream Blend v2 source."),
 ],
 "DoS.3": [
  (P, "A compromised keeper can call "), (C, "partial_unwind"),
  (P, " with a large "), (C, "target_hf"), (P, ": the keeper's target is "
      "floored at "), (C, "orange_hf"), (P, " but "), (B, "never capped above"),
  (P, ", and "), (C, "compute_partial_unwind"), (P, " clamps the repay at "
      "outstanding debt — a full close. "), (C, "i128::MAX"),
  (P, " is not the exploit (it overflows "), (C, "target_hf × debt_value"),
  (P, " at "), (C, "leverage.rs:367"), (P, " and reverts), but any large "
      "finite target such as "), (C, "1e12"), (P, " passes cleanly. This is "
      "the explicitly accepted residual of audit M-1, which bounded the "),
  (I, "permissionless"), (P, " branch and deliberately left the keeper's "
      "unbounded because the keeper is a trusted role. Recorded because "
      "“can only make the position safer” and "
      "“unbounded” are different claims, and §1.2 declines to "
      "assume the keeper is uncompromised. Treating it is a decision, not a "
      "fix — see §3.3."),
 ],
 "DoS.4": [
  (P, "While a "), (C, "PendingHarvest"), (P, " record exists the trait "),
  (C, "harvest"), (P, " refuses with "), (C, "DeadlineExpired"), (P, " ("),
  (C, "lib.rs:292-294"), (P, "), checking "), (C, "is_some()"), (P, " with "),
  (B, "no expiry test"), (P, " — only "), (C, "harvest_claim"),
  (P, " consults "), (C, "expiration"), (P, " ("), (C, "lib.rs:1085-1088"),
  (P, "). The record clears only when "), (C, "harvest_reinvest"),
  (P, " settles it or "), (C, "harvest_claim"), (P, " sweeps a lapsed one, "
      "both keeper-gated. So an unsettled claim blocks the trait "),
  (C, "harvest"), (P, " "), (B, "indefinitely, not for ~5 minutes"),
  (P, ": the bound is keeper availability, and recovery needs exactly the "
      "actor whose loss is the triggering scenario. "),
  (C, "HARVEST_APPROVAL_LEDGERS"), (P, " bounds the allowance, a different "
      "asset (Elevation.6). Costs yield, never principal, and "),
  (C, "admin_set_keeper"), (P, " restores it."),
 ],
 "DoS.7": [
  (B, "= audit L-6 (second half)."), (P, " There is "),
  (B, "no emergency pause"), (P, ". If a Blend incident, an oracle failure or "
      "a discovered bug in this contract required stopping deposits, the only "
      "lever is "), (C, "upgrade"), (P, " — a full code replacement, under "
      "the key whose compromise is the thing you might be responding to."),
 ],
 "DoS.9": [
  (B, "The persistent half of DoS.5."), (P, " "), (C, "Keeper"), (P, " is a "),
  (B, "persistent"), (P, " entry with a 120-day TTL ("),
  (C, "PERSISTENT_BUMP_AMOUNT"), (P, ", "), (C, "storage.rs:10"),
  (P, "), and "), (C, "storage::get_keeper"), (P, " ("),
  (C, "storage.rs:151-156"), (P, ") does "), (B, "not"), (P, " extend it on "
      "read — unlike "), (C, "get_vault_shares"), (P, " ("), (C, ":127-138"),
  (P, "), which does. The only writers are "), (C, "set_keeper"),
  (P, " and "), (C, "admin_set_keeper"), (P, ", so a deployment that never "
      "rotates its keeper archives the entry on a pure calendar schedule, "
      "after which every keeper path "), (I, "and"), (P, " "),
  (C, "partial_unwind"), (P, " (which reads it at "), (C, "lib.rs:617"),
  (P, ") fails until someone submits a "), (C, "RestoreFootprint"),
  (P, ". Bounded and recoverable — restoration is permissionless, "),
  (C, "rebalance"), (P, " never touches the key so liquidation protection "
      "survives, and "), (C, "deposit"), (P, "/"), (C, "withdraw"),
  (P, " are unaffected — but it is a self-inflicted outage of all vault "
      "maintenance, arriving on a fixed date with no prior signal, and the "
      "one-line fix (extend on read) is already the pattern two functions "
      "away. "), (C, "Reserves"), (P, " shares the shape but every "
      "value-moving call writes it, so only a dormant vault lets it lapse."),
 ],
}


def main():
    zin = zipfile.ZipFile(DOCX)
    doc = zin.read("word/document.xml").decode("utf-8")
    saved = 0
    for tid, parts in ROWS.items():
        i = doc.index("2.3 Threat table")
        j = doc.index(f'>{tid}</w:t>', i)
        rs = doc.rindex("<w:tr>", i, j)
        re_ = doc.index("</w:tr>", j) + len("</w:tr>")
        row = doc[rs:re_]
        cells = list(re.finditer(r'<w:tc>.*?</w:tc>', row, re.S))
        issue = cells[3]
        w = re.search(r'w:w="(\d+)"', issue.group(0)).group(1)
        new = (f'<w:tc><w:tcPr><w:tcW w:type="dxa" w:w="{w}" /></w:tcPr>'
               '<w:tcPr /><w:p><w:pPr><w:pStyle w:val="Compact" /></w:pPr>'
               + runs(parts) + '</w:p></w:tc>')
        saved += len(issue.group(0)) - len(new)
        print(f"  {tid:8s} {len(issue.group(0)):6,d} -> {len(new):6,d}")
        doc = (doc[:rs] + row[:issue.start()] + new + row[issue.end():]
               + doc[re_:])
    print(f"  net: {saved:,} XML chars")

    out = HERE / "_dos.docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for it in zin.infolist():
            zo.writestr(it, doc.encode("utf-8")
                        if it.filename == "word/document.xml"
                        else zin.read(it.filename))
    zin.close()
    shutil.move(out, DOCX)
    print("DoS pass applied (DoS.1/.5/.6/.8 unchanged)")


if __name__ == "__main__":
    main()
