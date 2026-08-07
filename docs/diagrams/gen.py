#!/usr/bin/env python3
"""Generate the two TurboLong STRIDE data-flow diagrams as SVG.

View A - control / authority (who may call what).
View B - value flow (principal in/out, and the harvest round trip).

Palette matches the Mermaid default the original diagram used, so the
replacement images sit consistently in the same document.
"""

NODE_FILL, NODE_STROKE = "#ECECFF", "#9370DB"
STORE_FILL, STORE_STROKE = "#E8F4EA", "#5C9367"
TB_FILL, TB_STROKE = "#FFFFDE", "#AAAA33"
LBL_BG = "#EDEDED"
LINE = "#333333"
TXT = "#1A1A1A"

FONT = ("-apple-system, BlinkMacSystemFont, 'Helvetica Neue', "
        "'Trebuchet MS', Arial, sans-serif")

# Rough advance width per character, as a fraction of font size, for the
# stack above. Only used to size label backgrounds, so approximate is fine.
CW = 0.52


def tw(text, size):
    return len(text) * size * CW


class Svg:
    def __init__(self, w, h):
        self.w, self.h, self.parts = w, h, []

    def add(self, s):
        self.parts.append(s)

    # -- primitives ------------------------------------------------------
    def rect(self, x, y, w, h, fill, stroke, rx=4, dash=None, sw=1.5):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" '
                 f'fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>')

    def text(self, x, y, s, size=14, anchor="middle", weight="normal",
             fill=TXT, style="normal"):
        s = (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
        self.add(f'<text x="{x}" y="{y}" font-family="{FONT}" '
                 f'font-size="{size}" font-weight="{weight}" '
                 f'font-style="{style}" fill="{fill}" '
                 f'text-anchor="{anchor}">{s}</text>')

    def lines(self, cx, cy, rows, size=14, anchor="middle", weight="normal",
              fill=TXT, lh=None):
        """Vertically centred multi-line text block."""
        lh = lh or size * 1.32
        top = cy - (len(rows) - 1) * lh / 2
        for i, r in enumerate(rows):
            w = weight if (i == 0 and weight == "bold") else "normal"
            self.text(cx, top + i * lh + size * 0.35, r, size, anchor, w, fill)

    # -- composites ------------------------------------------------------
    def node(self, x, y, w, h, rows, size=15, fill=NODE_FILL,
             stroke=NODE_STROKE, italic_last=False):
        self.rect(x, y, w, h, fill, stroke)
        lh = size * 1.35
        top = y + h / 2 - (len(rows) - 1) * lh / 2
        for i, r in enumerate(rows):
            st = "italic" if (italic_last and i == len(rows) - 1) else "normal"
            wt = "bold" if i == 0 else "normal"
            sz = size if i == 0 else size - 2
            self.text(x + w / 2, top + i * lh + sz * 0.35, r, sz,
                      "middle", wt, TXT, st)

    def boundary(self, x, y, w, h, label, dash="8 5"):
        self.rect(x, y, w, h, TB_FILL, TB_STROKE, rx=6, dash=dash, sw=2)
        self.text(x + 12, y + 22, label, 15, "start", "bold", "#6b6b1f")

    def flow_label(self, cx, cy, rows, size=13, pad=7):
        """Grey label plate, as used for edge labels in the original."""
        wmax = max(tw(r, size) for r in rows)
        lh = size * 1.3
        h = len(rows) * lh + pad
        self.rect(cx - wmax / 2 - pad, cy - h / 2, wmax + 2 * pad, h,
                  LBL_BG, "none", rx=3, sw=0)
        self.lines(cx, cy, rows, size)

    def arrow(self, pts, dash=None, both=False, sw=1.6, color=LINE):
        d = "M " + " L ".join(f"{x} {y}" for x, y in pts)
        da = f' stroke-dasharray="{dash}"' if dash else ""
        start = ' marker-start="url(#back)"' if both else ""
        self.add(f'<path d="{d}" fill="none" stroke="{color}" '
                 f'stroke-width="{sw}"{da} marker-end="url(#head)"{start}/>')

    def render(self):
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" '
            f'height="{self.h}" viewBox="0 0 {self.w} {self.h}">'
            '<defs>'
            f'<marker id="head" viewBox="0 0 10 10" refX="9" refY="5" '
            f'markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
            f'<path d="M 0 0 L 10 5 L 0 10 z" fill="{LINE}"/></marker>'
            f'<marker id="back" viewBox="0 0 10 10" refX="9" refY="5" '
            f'markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
            f'<path d="M 0 0 L 10 5 L 0 10 z" fill="{LINE}"/></marker>'
            '</defs>'
            f'<rect width="{self.w}" height="{self.h}" fill="#FFFFFF"/>'
            + "".join(self.parts) + "</svg>")


# ══════════════════════════════════════════════════════════════════════
# View A - control / authority
# ══════════════════════════════════════════════════════════════════════
def view_a():
    s = Svg(1520, 1010)
    s.text(760, 38, "A · Control view — who may invoke what", 21, "middle",
           "bold")

    # Trust boundaries around the callers
    s.boundary(25, 60, 660, 165, "TB-1 · Untrusted callers")
    s.boundary(715, 60, 320, 165, "TB-2 · Keeper (hot key)")
    s.boundary(1065, 60, 320, 165, "TB-3 · Admin")

    s.node(45, 108, 285, 92, ["Depositor /", "share holder"])
    s.node(390, 108, 285, 92, ["Any address", "(permissionless)"])
    s.node(735, 108, 285, 92, ["Keeper bot", "src/bin/execute_loop.rs"])
    s.node(1085, 108, 285, 92, ["Admin key", "(custody unspecified)"])

    # Strategy process
    s.node(330, 505, 860, 118,
           ["BlendLeverageStrategy", "process · Config · Reserves · Keeper · "
            "PendingHarvest · SwapAccount · ShareToken"],
           size=18, italic_last=True)

    # Caller -> strategy
    s.arrow([(187, 200), (187, 470), (420, 505)])
    s.flow_label(187, 330, ["DF-1", "deposit · withdraw", "(require_auth)"])

    s.arrow([(532, 200), (532, 505)])
    s.flow_label(532, 330, ["DF-2  (no auth gate)", "rebalance · sync_reserves",
                            "migrate_position", "partial_unwind *"])

    s.arrow([(877, 200), (877, 505)])
    s.flow_label(877, 335, ["DF-3  keeper.require_auth()",
                            "harvest · harvest_claim", "harvest_reinvest",
                            "rebalance_keeper · releverage", "set_keeper"])

    s.arrow([(1227, 200), (1227, 470), (1100, 505)])
    s.flow_label(1227, 335, ["DF-4  require_admin()", "upgrade · set_admin",
                             "admin_set_keeper", "set_share_token",
                             "set_swap_account", "set_min_harvest_rate"])

    # TB-6 as a boundary *between* the two contracts, not a box around them
    s.add(f'<line x1="255" y1="690" x2="1290" y2="690" stroke="{TB_STROKE}" '
          f'stroke-width="2.5" stroke-dasharray="9 6"/>')
    s.text(262, 681, "TB-6 · strategy ↔ share token", 15, "start", "bold",
           "#6b6b1f")

    # Share token process
    s.node(430, 755, 660, 112,
           ["VaultShareToken (SEP-41)",
            "process · authoritative share ledger · not upgradeable",
            "Balance · Allowance · Minter · TotalSupply"],
           size=18, italic_last=True)

    s.arrow([(600, 623), (600, 755)])
    s.flow_label(600, 690, ["DF-7  mint · burn_by_minter",
                            "(minter authority)"])

    s.arrow([(950, 755), (950, 623)])
    s.flow_label(950, 690, ["DF-8  balance()",
                            "total_supply declared, never called"])

    # Depositor -> token (holder ops), routed clear of the strategy
    s.arrow([(75, 200), (75, 811), (430, 811)])
    s.flow_label(232, 811, ["DF-6  transfer · approve",
                            "burn · burn_from (holder ops)"])

    # Admin -> token
    s.arrow([(1450, 200), (1450, 811), (1090, 811)])
    s.flow_label(1290, 811, ["DF-5  set_minter", "set_admin"])

    # Ledger events
    s.node(500, 925, 520, 62,
           ["Ledger events · append-only · no consumer"],
           size=16, fill=STORE_FILL, stroke=STORE_STROKE)

    s.arrow([(370, 623), (370, 956), (500, 956)])
    s.flow_label(432, 900, ["DF-20 emit"])
    s.arrow([(760, 867), (760, 925)])
    s.flow_label(838, 896, ["DF-21 emit"])

    s.text(760, 1000,
           "* partial_unwind is permissionless only while HF < orange_hf; the "
           "keeper may call it at any time.   "
           "Nothing reads these events: the alerts worker polls Blend pool "
           "views by simulation (Repudiate.1).",
           14, "middle", "normal", "#555")
    return s.render()


# ══════════════════════════════════════════════════════════════════════
# View B - value flow
# ══════════════════════════════════════════════════════════════════════
def view_b():
    s = Svg(1440, 1060)
    s.text(720, 38, "B · Value view — principal, and the harvest round trip",
           21, "middle", "bold")

    s.boundary(25, 62, 300, 280, "TB-1")
    s.node(45, 112, 260, 78, ["Depositor /", "share holder"])
    s.node(45, 244, 260, 78, ["Any address", "(donor)"])

    s.boundary(1085, 62, 330, 530, "TB-4 · External protocols")
    s.node(1110, 105, 285, 195,
           ["Blend pool", "positions —", "authoritative"])
    s.node(1110, 448, 285, 90, ["Soroswap router", "output untrusted"])

    s.node(540, 110, 300, 240,
           ["BlendLeverageStrategy", "process"], size=18, italic_last=True)

    # ── Principal in / out ────────────────────────────────────────────
    s.arrow([(305, 146), (540, 170)], both=True)
    s.flow_label(424, 100, ["DF-14  underlying in / out",
                            "deposit pull · withdraw payout"])

    s.arrow([(305, 278), (540, 262)])
    s.flow_label(424, 306, ["DF-23  unsolicited underlying",
                            "transfer (donation)"])

    # ── Strategy ↔ Blend: four parallel, non-crossing edges ───────────
    s.arrow([(840, 145), (1110, 135)], both=True)
    s.flow_label(975, 122, ["DF-9  submit_with_allowance",
                            "supply · borrow · repay · withdraw"])

    s.arrow([(1110, 180), (840, 195)])
    s.flow_label(975, 185, ["DF-10  get_positions · get_reserve",
                            "b/d rates · c_factor · l_factor"])

    s.arrow([(840, 255), (1110, 228)])
    s.flow_label(975, 248, ["DF-11  claim(strategy, ids, strategy)"])

    s.arrow([(1110, 272), (840, 310)])
    s.flow_label(975, 312, ["DF-12  claimed BLND is credited",
                            "to the strategy's own balance"])

    # ── Atomic route ──────────────────────────────────────────────────
    s.arrow([(840, 340), (985, 405), (1110, 480)], both=True)
    s.flow_label(945, 428, ["DF-13  swap_exact_tokens_for_tokens",
                            "amount_out_min enforced"])

    # ── Split route ───────────────────────────────────────────────────
    s.node(430, 620, 300, 92, ["Swap account", "on-chain · semi-trusted"])
    s.node(430, 890, 300, 92, ["Stellar Broker", "off-chain venue"])

    s.arrow([(610, 350), (610, 620)])
    s.flow_label(610, 452, ["DF-15  approve BLND · ≈5 min",
                            "PendingHarvest records the floor",
                            "DF-16  swap account pulls it"])

    s.arrow([(720, 620), (720, 350)])
    s.flow_label(720, 560, ["DF-18  underlying returned",
                            "value verified, not the swap"])

    # DF-19: the strategy measuring its own balance (self-flow)
    s.arrow([(545, 350), (545, 400), (475, 400), (475, 350)])
    s.flow_label(332, 400, ["DF-19  underlying balance delta",
                            "measured against min_harvest_rate"])

    # TB-5 cuts *between* the on-chain swap account and the off-chain venue
    s.add(f'<line x1="330" y1="800" x2="1090" y2="800" stroke="{TB_STROKE}" '
          f'stroke-width="2.5" stroke-dasharray="9 6"/>')
    s.text(1098, 788, "TB-5", 15, "start", "bold", "#6b6b1f")
    s.text(1098, 810, "on-chain ↔ off-chain", 13, "start", "normal", "#6b6b1f")

    s.arrow([(580, 712), (580, 890)], both=True)
    s.flow_label(855, 800, ["DF-17  off-chain swap —",
                            "the only flow the chain cannot observe"])

    s.text(720, 1032,
           "The underlying and BLND token contracts are edge labels rather "
           "than nodes: every value edge above is a SEP-41 transfer, approve "
           "or transfer_from on one of them.",
           14, "middle", "normal", "#555")
    return s.render()


if __name__ == "__main__":
    import pathlib
    d = pathlib.Path(__file__).parent
    (d / "dfd_a.svg").write_text(view_a())
    (d / "dfd_b.svg").write_text(view_b())
    print("wrote dfd_a.svg dfd_b.svg")
