import "./grant-panel.css";
/**
 * Grant mode panel for the Trade screen: shows TurboLong's grant on the
 * connected Nido account (scope, spending cap left, expiry), asks for it
 * through Nido once, and lets the owner revoke it. Only rendered for Nido
 * (contract) accounts; classic wallets keep the main-wallet flow untouched.
 */
import { el, on, Badge, Button, Card } from "../ui";
import { type PoolDef, xlmContractId } from "../blend";
import { stroopsToXlm, xlmToStroops, type CapPeriod, type GrantCap } from "../grant";
import {
  DEFAULT_CAP,
  DEFAULT_DURATION,
  type GrantStatus,
  forgetSessionKey,
  grantStatus,
  grantsSupported,
  prepareSessionKey,
  requestGrant,
  revokeUrl,
} from "../grant-session";
import type { SessionKey } from "../grant-key";
import { isContractAccount } from "../nido";
import { getState } from "../app/state";
import { switchNetwork } from "../app/wallet";
import { toast } from "../app/chrome";

const PERIOD_LABEL: Record<CapPeriod, string> = { day: "day", week: "week", "30d": "30 days" };
const USE_GRANT_KEY = "turbolong:grant-mode:";

const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

function untilText(ms: number | undefined): string {
  if (ms === undefined) return "never (until revoked)";
  const mins = Math.round((ms - Date.now()) / 60_000);
  if (mins <= 0) return "expired";
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  return hrs < 48 ? `in ${hrs}h ${mins % 60}m` : `in ${Math.round(hrs / 24)}d`;
}

function periodOf(ledgers: number): string {
  if (ledgers === 17_280) return "day";
  if (ledgers === 120_960) return "week";
  if (ledgers === 518_400) return "30 days";
  return `${ledgers.toLocaleString("en-US")} ledgers`;
}

export interface GrantPanel {
  el: HTMLElement;
  refresh(): Promise<void>;
  /** Whether opens and closes in the current pool should be signed under the grant. */
  active(): boolean;
  /** Show the account's (or TurboLong's) refusal of the last grant-signed call. */
  noteRefusal(text: string): void;
}

export function grantPanel(ctx: { pool(): PoolDef }): GrantPanel {
  const root = el("div", { class: "grant-slot" });
  let status: GrantStatus | undefined;
  /** The account and pool `status` was read for. */
  let statusFor = "";
  let key: SessionKey | undefined;
  let refusal: string | undefined;
  let busy = false;
  let generation = 0;
  let capXlm = DEFAULT_CAP.xlm;
  let capPeriod: CapPeriod = DEFAULT_CAP.period;

  const account = () => getState().userAddress ?? "";
  const useGrantPref = () => {
    try {
      return localStorage.getItem(USE_GRANT_KEY + account()) !== "off";
    } catch {
      return true;
    }
  };
  const setUseGrant = (onOff: boolean) => {
    try {
      localStorage.setItem(USE_GRANT_KEY + account(), onOff ? "on" : "off");
    } catch {
      /* private mode: keep the default */
    }
  };

  async function refresh(): Promise<void> {
    const addr = account();
    const mine = ++generation;
    if (!addr || !isContractAccount(addr)) {
      status = undefined;
      render();
      return;
    }
    try {
      const pool = ctx.pool();
      const next = await grantStatus(addr, pool);
      if (mine !== generation) return;
      status = next;
      statusFor = `${addr}:${pool.id}`;
      if (next.state !== "unavailable" && !key) key = await prepareSessionKey(addr);
    } catch (e) {
      if (mine !== generation) return;
      status = undefined;
      refusal = `Could not read the grant: ${(e as Error)?.message ?? e}`;
    }
    render();
  }

  async function approve(): Promise<void> {
    const addr = account();
    if (!key || busy) return;
    let cap: GrantCap;
    try {
      xlmToStroops(capXlm);
      cap = { xlm: capXlm.trim(), period: capPeriod };
    } catch (e) {
      toast((e as Error).message, "error");
      return;
    }
    busy = true;
    render();
    try {
      const answer = await requestGrant({ account: addr, pool: ctx.pool(), key, cap, duration: DEFAULT_DURATION });
      if (answer.outcome === "cancelled") toast("The grant was not approved.", "info");
      else if (answer.outcome === "error" && answer.code !== "closed")
        toast(`Nido could not apply the grant: ${answer.code}`, "error");
      else toast("Checking the account for TurboLong's grant…", "info");
      refusal = undefined;
    } catch (e) {
      toast(`Could not open Nido: ${(e as Error)?.message ?? e}`, "error");
    } finally {
      busy = false;
    }
    // The account's rules are the truth, whatever the popup said.
    await refresh();
    if (status?.state === "active") toast("TurboLong's grant is active on your account.", "success");
  }

  async function forget(): Promise<void> {
    const addr = account();
    await forgetSessionKey(addr);
    key = undefined;
    toast("This browser's session key is gone. Revoke the grant in Nido to remove it from the account.", "info");
    await refresh();
  }

  const scopeRows = (pool: PoolDef, capText: string) =>
    el("ul", { class: "grant-scope" }, [
      el("li", {}, [
        el("code", {}, ["submit"]),
        " on the ",
        el("strong", {}, [pool.name]),
        " Blend pool ",
        el("span", { class: "grant-mono" }, [shortAddr(pool.id)]),
        ": open and close positions (no cap: the call moves no tokens itself)",
      ]),
      el("li", {}, [
        el("code", {}, ["transfer"]),
        " on XLM ",
        el("span", { class: "grant-mono" }, [shortAddr(xlmContractId())]),
        ", paying only that pool, ",
        el("strong", {}, [capText]),
      ]),
    ]);

  function render(): void {
    const s = status;
    const addr = account();
    if (!addr || !isContractAccount(addr) || !s) {
      root.replaceChildren(...(refusal && addr && isContractAccount(addr) ? [errorCard(refusal)] : []));
      return;
    }
    if (s.state === "unavailable") {
      if (s.reason === "classic") {
        root.replaceChildren();
        return;
      }
      const body =
        s.reason === "mainnet"
          ? [
              el("p", {}, [
                "Grant mode runs on testnet, where Nido previews Perch grants (apply_grant). Nido's mainnet accounts run an earlier Perch account without grants, so here every action is signed by your main Nido wallet.",
              ]),
              Button({
                variant: "secondary",
                size: "sm",
                children: "Switch to testnet",
                onClick: () => void switchNetwork("testnet"),
              }),
            ]
          : [
              el("p", {}, [
                "This Nido account has no grants (it predates Perch dev). Create an account on Nido's grant preview to try grant mode; this one keeps the main-wallet flow.",
              ]),
            ];
      root.replaceChildren(
        Card({ title: "Grant mode", action: Badge({ tone: "neutral", children: "Unavailable" }), children: body }),
      );
      return;
    }

    const pool = ctx.pool();
    const header = el("div", { class: "grant-net" }, [
      Badge({ tone: "warning", dot: true, children: "Testnet · Perch dev preview" }),
    ]);
    const keyLine = key
      ? el("p", { class: "grant-key" }, [
          "Signer: TurboLong's session key ",
          el("span", { class: "grant-mono" }, [`${key.publicKeyHex.slice(0, 10)}…${key.publicKeyHex.slice(-6)}`]),
          ", a P-256 key kept non-extractable in this browser. It signs without a prompt; the grant's rules are what limit it, and your account checks them on every call.",
        ])
      : null;

    if (s.state === "none") {
      const xlmInput = el("input", {
        class: "grant-input grant-mono",
        type: "text",
        inputmode: "decimal",
        value: capXlm,
        "aria-label": "Spending cap in XLM",
      }) as HTMLInputElement;
      on(xlmInput, "input", () => {
        capXlm = xlmInput.value;
      });
      const periodSel = el("select", { class: "grant-input", "aria-label": "Cap window" }, [
        ...(["day", "week", "30d"] as CapPeriod[]).map((p) => {
          const opt = el("option", { value: p }, [PERIOD_LABEL[p]]) as HTMLOptionElement;
          opt.selected = p === capPeriod;
          return opt;
        }),
      ]) as HTMLSelectElement;
      on(periodSel, "change", () => {
        capPeriod = periodSel.value as CapPeriod;
      });
      const approveBtn = Button({
        variant: "primary",
        loading: busy,
        disabled: busy || !key,
        id: "grant-approve",
        children: busy ? "Waiting for Nido…" : "Approve grant in Nido",
        onClick: () => void approve(),
      });
      root.replaceChildren(
        Card({
          title: "Grant mode",
          action: header,
          class: "grant-card",
          children: [
            el("p", {}, [
              "Approve once in Nido with your passkey. After that, TurboLong opens, adds to and closes XLM positions in this pool with its own session key: no passkey prompt, and your account refuses anything outside the grant.",
            ]),
            scopeRows(pool, `up to ${capXlm || "…"} XLM per ${PERIOD_LABEL[capPeriod]}`),
            el("div", { class: "grant-form" }, [
              el("label", { class: "grant-field" }, ["Cap ", xlmInput, " XLM per ", periodSel]),
              el("span", { class: "grant-muted" }, ["Expires after 24 hours. Nido lets you change both."]),
            ]),
            el("p", { class: "grant-muted" }, [
              "Settlement in grant mode is gross: Blend's plain submit pulls every supplied XLM through the capped transfer, then pays the borrowed XLM back in the same transaction. Opening 10 XLM at 2× counts 20 XLM against the cap and needs 20 XLM on hand. The pool rule cannot pin submit's recipient (Nido has no way to express that yet), so treat this as a testnet demo.",
            ]),
            keyLine,
            refusal ? el("p", { class: "grant-refusal", role: "alert" }, [refusal]) : null,
            el("div", { class: "grant-actions" }, [approveBtn]),
          ],
        }),
      );
      return;
    }

    const capText = `up to ${stroopsToXlm(s.limit)} XLM per ${periodOf(s.periodLedgers)}`;
    const useBox = el("input", { type: "checkbox", id: "grant-use" }) as HTMLInputElement;
    useBox.checked = useGrantPref();
    on(useBox, "change", () => setUseGrant(useBox.checked));
    const pctLeft = s.limit > 0n ? Number((s.left * 1000n) / s.limit) / 10 : 0;
    root.replaceChildren(
      Card({
        title: "Grant mode",
        action: header,
        class: "grant-card",
        children: [
          el("div", { class: "grant-status" }, [
            Badge({
              tone: s.state === "active" ? "success" : "danger",
              dot: true,
              id: "grant-state",
              children: s.state === "active" ? "Active" : "Expired",
            }),
            el("span", { class: "grant-mono", id: "grant-cap-left" }, [
              `${stroopsToXlm(s.left)} of ${stroopsToXlm(s.limit)} XLM left this ${periodOf(s.periodLedgers)}`,
            ]),
            el("span", { class: "grant-muted" }, [
              s.state === "active" ? `Expires ${untilText(s.expiresAt)}` : "Approve it again to keep using grant mode",
            ]),
          ]),
          el("div", { class: "grant-meter", role: "meter", "aria-valuenow": String(pctLeft) }, [
            el("span", { style: `width:${Math.max(0, Math.min(100, pctLeft))}%` }),
          ]),
          scopeRows(pool, capText),
          keyLine,
          refusal ? el("p", { class: "grant-refusal", role: "alert", id: "grant-refusal" }, [refusal]) : null,
          el("label", { class: "grant-toggle" }, [
            useBox,
            " Sign opens, add-funds and closes in this pool with the grant",
          ]),
          el("div", { class: "grant-actions" }, [
            s.state === "expired"
              ? Button({ variant: "primary", size: "sm", children: "Approve again", onClick: () => void approve() })
              : null,
            Button({ variant: "secondary", size: "sm", children: "Refresh", onClick: () => void refresh() }),
            el(
              "a",
              {
                class: "tl-btn tl-btn--ghost tl-btn--sm",
                href: revokeUrl(account()),
                target: "_blank",
                rel: "noopener",
              },
              ["Revoke in Nido"],
            ),
            Button({ variant: "ghost", size: "sm", children: "Forget key", onClick: () => void forget() }),
          ]),
          el("p", { class: "grant-muted" }, [
            "Revoke: Nido → Security → Remove app removes the grant from your account (remove_grant). Forget key stops this browser from signing right away.",
          ]),
        ],
      }),
    );
  }

  function errorCard(text: string): HTMLElement {
    return Card({
      title: "Grant mode",
      children: [
        el("p", { class: "grant-refusal", role: "alert" }, [text]),
        Button({ variant: "secondary", size: "sm", children: "Retry", onClick: () => void refresh() }),
      ],
    });
  }

  return {
    el: root,
    refresh,
    active: () =>
      grantsSupported() &&
      status?.state === "active" &&
      statusFor === `${account()}:${ctx.pool().id}` &&
      useGrantPref() &&
      isContractAccount(account()),
    noteRefusal(text: string) {
      refusal = text;
      render();
    },
  };
}

/** Ask whether to retry an action with the main Nido wallet after the grant
 * path was refused. Resolves true to fall back. */
export function confirmFallback(reason: string, action: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const overlay = el("div", { class: "trade-modal" });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(ok);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") done(false);
    };
    document.addEventListener("keydown", onKey);
    const card = el("div", { class: "trade-modal__card", role: "dialog", "aria-modal": "true", id: "grant-fallback" }, [
      el("div", { class: "trade-modal__head" }, [el("h2", { class: "trade-modal__title" }, ["Not under the grant"])]),
      el("div", { class: "trade-modal__body" }, [
        el("p", { class: "grant-refusal" }, [reason]),
        el("p", {}, [
          `Nothing was sent. You can run “${action}” with your main Nido wallet instead: Nido asks for your passkey for each transaction.`,
        ]),
      ]),
      el("div", { class: "trade-modal__foot" }, [
        Button({ variant: "ghost", children: "Cancel", onClick: () => done(false) }),
        Button({
          variant: "primary",
          id: "grant-fallback-main",
          children: "Use main wallet",
          onClick: () => done(true),
        }),
      ]),
    ]);
    overlay.append(card);
    on(overlay, "click", (e) => {
      if (e.target === overlay) done(false);
    });
    document.body.append(overlay);
  });
}
