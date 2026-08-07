#!/usr/bin/env python3
"""Elevation of Privilege pass — the last block in the register.

Verified, all eight correct:
  E.1  upgrade at lib.rs:1274-1279, gated on a bare require_admin.
  E.2  administratable.rs:10-15 at pinned rev 46ed159 is verbatim the quoted
       conditional gate. (Line 7 of the same file is audit L-8's
       unwrap_unchecked, which §2.5 already maps as adjacent.)
  E.3  has_share_token is used at lib.rs:923 only — inside share_token(),
       never by the setter at :914. Exactly as claimed.
  E.4  the "deliberately NOT Upgradable" comment is verbatim; citation
       tightened from :288-300 to :295-297.
  E.6  revoke_swap_allowance does resolve get_swap_account(e) — the current
       account, not the granted one.
  E.5 / E.7 / E.8 confirmed against earlier verification.

Two artifacts repaired, both mine: patch_body.py's prefix strip left
Elevation.2 with a stray ": " where "Added in v1.3:" had been, and
Elevation.6 with a gap where "One qualification, added in v1.3:" had been —
which also dropped the connective that made the qualification read as one.
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
 "Elevation.1": [
  (B, "The maximum-impact path in the system, and the only one with no "
      "on-chain bound of any kind."), (P, " "), (C, "upgrade"), (P, " ("),
  (C, "lib.rs:1274-1279"), (P, ") replaces the strategy's entire code with an "
      "arbitrary WASM hash, gated on a single "), (C, "require_admin"),
  (P, " — no timelock, no multi-party approval, no event. The replacement "
      "inherits custody of the whole Blend position, the minter authority "
      "over the share token, and every storage key, and can move the position "
      "anywhere in the same transaction that installs it. The loss is total, "
      "immediate and irreversible: the entire TVL, with no withdrawal window "
      "for holders. "), (B, "Why no code fix exists:"), (P, " the upgrade "
      "path "), (I, "is"), (P, " the incident-response mechanism (DoS.7 — "
      "there is no pause), so gating it on-chain would remove the only lever "
      "for responding to a Blend incident or a bug in this contract. The "
      "control has to live in custody, which is why §1.7's multisig "
      "recommendation and not any §3 code change is the treatment. "),
  (B, "What compounds it:"), (P, " the absence of an event (Repudiate.1) "
      "makes an upgrade not merely unstoppable but unobserved — the "),
  (C, "version"), (P, " counter is the sole trace, and only if someone polls "
      "it. Every other admin-side row (Spoof.2, Elevation.3, Elevation.4) "
      "collapses into this one: the same key, not independent paths."),
 ],
 "Elevation.2": [
  (C, "admin-sep"), (P, "'s "), (C, "set_admin"), (P, " is a single-step, "
      "unverified transfer: it authorises the "), (I, "current"),
  (P, " admin and writes the new address, with no two-step accept and no way "
      "to confirm the incoming key exists. A mistyped or uncontrolled address "
      "permanently orphans the admin role — taking "), (C, "upgrade"),
  (P, " with it, which is the mechanism you would need to recover from any "
      "other incident. Unrecoverable by any on-chain means. "),
  (B, "Worse, the gate is conditional:"), (P, " "),
  (C, "if let Some(owner) = admin_from_storage(env) { owner.require_auth(); }"),
  (P, " ("), (C, "administratable.rs:10-15"), (P, "), so when the "),
  (C, "ADMIN"), (P, " instance entry is "),
  (B, "absent, set_admin is ungated and anyone may claim the role"),
  (P, ". Not live today — both constructors seed the admin atomically with "
      "deployment — but it makes any future "), (C, "upgrade"),
  (P, " that relocates or renames the SEP's canonical "), (C, "ADMIN"),
  (P, " key an instant, silent total compromise, with nothing in the upgrade "
      "path to flag it. Folded into §4.1's "), (I, "Contract upgrade"),
  (P, " trigger."),
 ],
 "Elevation.3": [
  (C, "set_share_token"), (P, " ("), (C, "lib.rs:914"), (P, ") has no "
      "one-time guard. The "), (C, "has_share_token"), (P, " helper exists "
      "and "), (I, "is"), (P, " used — but only by the "), (C, "share_token()"),
  (P, " view at "), (C, "lib.rs:923"), (P, ", never by the setter, which is "
      "the one place it would be a guard. "), (B, "= audit L-2"),
  (P, ", and see Spoof.2: it is subsumed by "), (C, "upgrade"),
  (P, " under the same key and adds no capability an admin does not already "
      "have, hence Low. Still worth the guard — a two-line fix, and defence "
      "in depth costs nothing here."),
 ],
 "Elevation.4": [
  (P, "The token's "), (C, "set_minter"), (P, " ("),
  (C, "vault_share/lib.rs:280-285"), (P, ") lets the token admin install an "
      "arbitrary minter, which can mint unlimited shares and redeem them "
      "against the strategy's position — draining it through the ordinary "),
  (C, "withdraw"), (P, " path, with no anomaly for monitoring to catch beyond "
      "the size of the redemption. "),
  (B, "The guarantee it defeats is one made explicitly to holders:"),
  (P, " "), (C, "vault_share/lib.rs:295-297"), (P, " states the token is "
      "“deliberately NOT "), (C, "Upgradable"), (P, ": the share "
      "ledger is immutable code, so holders can trust their balances can "
      "never be rewritten by an admin upgrade.” True, and not the "
      "property that matters — balances cannot be "), (I, "rewritten"),
  (P, ", but unlimited new ones can be "), (I, "created"), (P, ", which "
      "dilutes existing holders just as effectively. A holder reading that "
      "comment draws a materially stronger conclusion than the code supports, "
      "which is why Elevation.4.R.2 is a P1 despite being a comment change. "),
  (B, "Key separation is the whole mitigation:"), (P, " shared with the "
      "strategy admin this is not a second path but the same Critical behind "
      "one credential — see §1.7's "), (I, "Token admin"), (P, " row."),
 ],
 "Elevation.6": [
  (C, "harvest_claim"), (P, " grants the swap account a live "),
  (C, "transfer_from"), (P, " over the entire claimed BLND for "),
  (C, "HARVEST_APPROVAL_LEDGERS"), (P, " (60 ledgers, ~5 min). Within that "
      "window the swap account's key is equivalent to custody of the claimed "
      "emissions: the floor makes taking it "), (I, "without settling"),
  (P, " revert the settlement, but the BLND has already left. Well-bounded "
      "and recorded as the residual shape of the Broker design, "),
  (B, "with one qualification."), (P, " "), (C, "revoke_swap_allowance"),
  (P, " ("), (C, "lib.rs:961-971"), (P, ") resolves the "), (I, "current"),
  (P, " "), (C, "SwapAccount"), (P, " rather than the account the allowance "
      "was granted to, so if the admin calls "), (C, "set_swap_account"),
  (P, " while a "), (C, "PendingHarvest"), (P, " is live, both revoke sites "
      "target the new address and the old account keeps its pull until "
      "expiry — the one condition under which “revoked on settle, "
      "revoked before re-grant” does not hold. Admin-gated and "
      "expiry-bounded, so Info-grade on its own; recorded because "
      "Elevation.6.R.1 states the guarantee without the qualification."),
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
        print(f"  {tid:14s} {len(issue.group(0)):6,d} -> {len(new):6,d}")
        doc = (doc[:rs] + row[:issue.start()] + new + row[issue.end():]
               + doc[re_:])
    print(f"  net saved: {saved:,} XML chars")

    out = HERE / "_elev.docx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for it in zin.infolist():
            zo.writestr(it, doc.encode("utf-8")
                        if it.filename == "word/document.xml"
                        else zin.read(it.filename))
    zin.close()
    shutil.move(out, DOCX)
    print("Elevation pass applied (E.5/.7/.8 unchanged)")


if __name__ == "__main__":
    main()
