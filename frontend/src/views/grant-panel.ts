import "./grant-panel.css";
/**
 * The Trade screen's grant card for Nido accounts: one approval ("Allow
 * TurboLong to manage positions"), then a status line (spending left, end)
 * with revoke. What the approval installs (two rules, the session key, the
 * limits) sits behind a details toggle. Classic wallets get no card and keep
 * the main-wallet flow.
 */
import { el, on, Badge, Button, Card } from "../ui";
import { type PoolDef, getActiveNetwork, xlmContractId } from "../blend";
import { stroopsToXlm, xlmToStroops, type CapPeriod, type GrantCap } from "../grant";
import {
  DEFAULT_DURATION,
  type GrantStatus,
  defaultCap,
  forgetSessionKey,
  grantStatus,
  prepareSessionKey,
  requestGrant,
  revokeUrl,
} from "../grant-session";
import type { SessionKey } from "../grant-key";
import { isContractAccount } from "../nido";
import { getState } from "../app/state";
import { toast } from "../app/chrome";

const PERIOD_LABEL: Record<CapPeriod, string> = { day: "day", week: "week", "30d": "30 days" };

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
  /** Whether opens, add-funds and closes in the current pool should be signed under the grant. */
  active(): boolean;
  /** Show the account's (or TurboLong's) refusal of the last grant-signed call. */
  noteRefusal(text: string): void;
  /** A later grant-signed call went through: the refusal no longer holds. */
  clearRefusal(): void;
}

export function grantPanel(ctx: { pool(): PoolDef }): GrantPanel {
  const root = el("div", { class: "grant-slot" });
  let status: GrantStatus | undefined;
  /** The account, network and pool `status` was read for. */
  let statusFor = "";
  /** This browser's session key for `keyFor`, shown in the details. */
  let key: SessionKey | undefined;
  let keyFor = "";
  let refusal: string | undefined;
  let readError: string | undefined;
  let busy = false;
  let generation = 0;
  let cap: GrantCap = defaultCap();
  let capNetwork = getActiveNetwork();

  const account = () => getState().userAddress ?? "";
  const scope = () => `${account()}:${getActiveNetwork()}:${ctx.pool().id}`;

  async function refresh(): Promise<void> {
    const addr = account();
    const mine = ++generation;
    if (capNetwork !== getActiveNetwork()) {
      capNetwork = getActiveNetwork();
      cap = defaultCap();
    }
    const owner = `${addr}:${capNetwork}`;
    if (keyFor !== owner) {
      keyFor = owner;
      key = undefined;
    }
    if (!addr || !isContractAccount(addr)) {
      status = undefined;
      readError = undefined;
      render();
      return;
    }
    try {
      const where = scope();
      const next = await grantStatus(addr, ctx.pool());
      const nextKey = next.state !== "unavailable" && !key ? await prepareSessionKey(addr) : key;
      if (mine !== generation) return;
      if (where !== statusFor) refusal = undefined;
      status = next;
      statusFor = where;
      key = nextKey;
      readError = undefined;
    } catch (e) {
      if (mine !== generation) return;
      status = undefined;
      readError = `Could not read TurboLong's access: ${(e as Error)?.message ?? e}`;
    }
    render();
  }

  async function approve(): Promise<void> {
    const addr = account();
    if (busy) return;
    try {
      xlmToStroops(cap.xlm);
    } catch (e) {
      toast((e as Error).message, "error");
      return;
    }
    busy = true;
    render();
    try {
      const answer = await requestGrant({
        account: addr,
        pool: ctx.pool(),
        cap: { xlm: cap.xlm.trim(), period: cap.period },
        duration: DEFAULT_DURATION,
      });
      if (answer.outcome === "cancelled") toast("Nothing was allowed.", "info");
      else if (answer.outcome === "error" && answer.code !== "closed")
        toast(`Nido could not save it: ${answer.code}`, "error");
      else toast("Checking your account…", "info");
      refusal = undefined;
    } catch (e) {
      toast(`Could not open Nido: ${(e as Error)?.message ?? e}`, "error");
    } finally {
      busy = false;
    }
    // The account's rules are the truth, whatever the popup said.
    await refresh();
    if (status?.state === "active") toast("TurboLong can now manage your positions here.", "success");
  }

  async function forget(): Promise<void> {
    await forgetSessionKey(account());
    key = undefined;
    toast("This browser can no longer sign for TurboLong. Revoke it in Nido to remove it from your account.", "info");
    await refresh();
  }

  /** What the approval installs, for the details toggle. */
  function details(pool: PoolDef, capText: HTMLElement): HTMLElement {
    const mainnet = getActiveNetwork() === "mainnet";
    return el("details", { class: "grant-details" }, [
      el("summary", {}, ["What you're allowing"]),
      el("ul", { class: "grant-scope" }, [
        el("li", {}, [
          el("code", {}, ["submit"]),
          " on the ",
          el("strong", {}, [pool.name]),
          " Blend pool ",
          el("span", { class: "grant-mono" }, [shortAddr(pool.id)]),
          ": open, add to and close positions. No limit of its own: the call moves no tokens itself.",
        ]),
        el("li", {}, [
          el("code", {}, ["transfer"]),
          " of XLM ",
          el("span", { class: "grant-mono" }, [shortAddr(xlmContractId())]),
          ", paying only that pool, ",
          capText,
          ".",
        ]),
      ]),
      key
        ? el("p", { class: "grant-key" }, [
            "Signed by TurboLong's key ",
            el("span", { class: "grant-mono" }, [`${key.publicKeyHex.slice(0, 10)}…${key.publicKeyHex.slice(-6)}`]),
            ", made in this browser and never readable from it. It signs without asking you; these rules are its only limit, and your account checks them on every call.",
          ])
        : null,
      el("p", { class: "grant-muted" }, [
        "The limit counts every XLM moved into the pool: Blend's plain submit takes each supplied amount, then pays any borrow back in the same transaction (10 XLM at 2× counts 20). Closing counts the debt it repays.",
      ]),
      el("p", { class: "grant-muted" }, [
        mainnet
          ? "Nido cannot yet pin who receives a submit's withdrawals, so whoever holds this key could move the position itself elsewhere; the limit protects the XLM in your wallet. Use small amounts."
          : "Nido cannot yet pin who receives a submit's withdrawals, so whoever holds this key could move the position itself elsewhere; the limit protects the XLM in your wallet. Testnet only.",
      ]),
      el("p", { class: "grant-muted" }, [
        mainnet
          ? "Nido writes these rules into your account's policy (apply_doc); its relayer pays for the calls."
          : "Nido's grant preview installs them as an app grant (apply_grant); a throwaway Friendbot key in this browser pays for the calls.",
      ]),
    ]);
  }

  function render(): void {
    const s = status;
    const addr = account();
    if (!addr || !isContractAccount(addr) || !s) {
      root.replaceChildren(...(readError && addr && isContractAccount(addr) ? [errorCard(readError)] : []));
      return;
    }
    if (s.state === "unavailable") {
      root.replaceChildren(
        ...(s.reason === "classic"
          ? []
          : [
              Card({
                title: "TurboLong access",
                action: Badge({ tone: "neutral", children: "Unavailable" }),
                children: [
                  el("p", {}, [
                    "This Nido account cannot hold app permissions, so every action here is signed with your Nido passkey.",
                  ]),
                ],
              }),
            ]),
      );
      return;
    }

    const pool = ctx.pool();
    const mainnet = getActiveNetwork() === "mainnet";
    const header = el("div", { class: "grant-net" }, [
      Badge({
        tone: mainnet ? "success" : "warning",
        dot: true,
        children: mainnet ? "Mainnet" : "Testnet · Perch dev preview",
      }),
    ]);

    if (s.state === "none") {
      const xlmInput = el("input", {
        class: "grant-input grant-mono",
        type: "text",
        inputmode: "decimal",
        value: cap.xlm,
        "aria-label": "Spending cap in XLM",
      }) as HTMLInputElement;
      // The details follow the form as it is edited; a re-render would replace the focused input.
      const requested = () => `up to ${cap.xlm.trim() || "…"} XLM per ${PERIOD_LABEL[cap.period]}`;
      const capText = el("strong", {}, [requested()]);
      on(xlmInput, "input", () => {
        cap = { ...cap, xlm: xlmInput.value };
        capText.textContent = requested();
      });
      const periodSel = el("select", { class: "grant-input", "aria-label": "Cap window" }, [
        ...(["day", "week", "30d"] as CapPeriod[]).map((p) => {
          const opt = el("option", { value: p }, [PERIOD_LABEL[p]]) as HTMLOptionElement;
          opt.selected = p === cap.period;
          return opt;
        }),
      ]) as HTMLSelectElement;
      on(periodSel, "change", () => {
        cap = { ...cap, period: periodSel.value as CapPeriod };
        capText.textContent = requested();
      });
      root.replaceChildren(
        Card({
          title: "TurboLong access",
          action: header,
          class: "grant-card",
          children: [
            el("p", {}, [
              "Approve once with your Nido passkey, and TurboLong opens, adds to and closes XLM positions in this pool without asking again, within a spending limit you set.",
            ]),
            el("div", { class: "grant-form" }, [
              el("label", { class: "grant-field" }, ["Up to ", xlmInput, " XLM per ", periodSel]),
              el("span", { class: "grant-muted" }, ["Ends after 24 hours. You can change both in Nido."]),
            ]),
            refusal ? el("p", { class: "grant-refusal", role: "alert" }, [refusal]) : null,
            el("div", { class: "grant-actions" }, [
              Button({
                variant: "primary",
                loading: busy,
                disabled: busy || !key,
                id: "grant-approve",
                children: busy ? "Waiting for Nido…" : "Allow TurboLong to manage positions",
                onClick: () => void approve(),
              }),
            ]),
            details(pool, capText),
          ],
        }),
      );
      return;
    }

    const capText = `up to ${stroopsToXlm(s.limit)} XLM per ${periodOf(s.periodLedgers)}`;
    const pctLeft = s.limit > 0n ? Number((s.left * 1000n) / s.limit) / 10 : 0;
    root.replaceChildren(
      Card({
        title: "TurboLong access",
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
              s.state === "active" ? `Ends ${untilText(s.expiresAt)}` : "Allow it again to keep going",
            ]),
          ]),
          el("div", { class: "grant-meter", role: "meter", "aria-valuenow": String(pctLeft) }, [
            el("span", { style: `width:${Math.max(0, Math.min(100, pctLeft))}%` }),
          ]),
          refusal ? el("p", { class: "grant-refusal", role: "alert", id: "grant-refusal" }, [refusal]) : null,
          el("div", { class: "grant-actions" }, [
            s.state === "expired"
              ? Button({ variant: "primary", size: "sm", children: "Allow again", onClick: () => void approve() })
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
          details(pool, el("strong", {}, [capText])),
        ],
      }),
    );
  }

  function errorCard(text: string): HTMLElement {
    return Card({
      title: "TurboLong access",
      children: [
        el("p", { class: "grant-refusal", role: "alert" }, [text]),
        Button({ variant: "secondary", size: "sm", children: "Retry", onClick: () => void refresh() }),
      ],
    });
  }

  return {
    el: root,
    refresh,
    active: () => status?.state === "active" && statusFor === scope() && isContractAccount(account()),
    noteRefusal(text: string) {
      refusal = text;
      render();
    },
    clearRefusal() {
      refusal = undefined;
      render();
    },
  };
}

/** Ask whether to retry an action with the main Nido wallet after the grant
 * path was refused. `details` (a raw error) stays collapsed under the reason.
 * Resolves true to fall back. */
export function confirmFallback(reason: string, action: string, details?: string): Promise<boolean> {
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
      el("div", { class: "trade-modal__head" }, [
        el("h2", { class: "trade-modal__title" }, ["Not allowed for TurboLong"]),
      ]),
      el("div", { class: "trade-modal__body" }, [
        el("p", { class: "grant-refusal" }, [reason]),
        details
          ? el("details", { class: "grant-details", id: "grant-fallback-details" }, [
              el("summary", {}, ["Details"]),
              el("pre", { class: "grant-raw" }, [details]),
            ])
          : null,
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
