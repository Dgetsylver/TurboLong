/**
 * Web Push delivery via @pushforge/builder (Web Crypto, Workers-compatible).
 */

import { buildPushHTTPRequest } from "@pushforge/builder";

export interface PushEnv {
  VAPID_PRIVATE_KEY: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_SUBJECT?: string;
}

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SendResult {
  ok: boolean;
  status?: number;
  error?: string;
  gone?: boolean;
}

function privateJWK(env: PushEnv): JsonWebKey {
  return JSON.parse(env.VAPID_PRIVATE_KEY) as JsonWebKey;
}

function adminContact(env: PushEnv): string {
  return env.VAPID_SUBJECT ?? "mailto:alerts@turbolong.com";
}

export async function sendWebPush(
  env: PushEnv,
  sub: PushSubscriptionRow,
  payload: { title: string; body: string; url?: string },
): Promise<SendResult> {
  if (!env.VAPID_PRIVATE_KEY) {
    return { ok: false, error: "VAPID keys not configured" };
  }

  try {
    const { endpoint, headers, body } = await buildPushHTTPRequest({
      privateJWK: privateJWK(env),
      subscription: {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      },
      message: {
        payload,
        adminContact: adminContact(env),
      },
    });

    const res = await fetch(endpoint, { method: "POST", headers, body });

    if (res.ok) return { ok: true, status: res.status };
    if (res.status === 404 || res.status === 410) {
      return { ok: false, status: res.status, gone: true, error: "Subscription expired" };
    }
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: `Push ${res.status}: ${text}` };
  } catch (e: any) {
    return { ok: false, error: e.message ?? String(e) };
  }
}

export async function sendApyPush(
  env: PushEnv,
  sub: PushSubscriptionRow,
  opts: {
    poolName: string;
    assetSymbol: string;
    leverage: number;
    netApy: number;
    appUrl: string;
  },
): Promise<SendResult> {
  const { poolName, assetSymbol, leverage, netApy, appUrl } = opts;
  return sendWebPush(env, sub, {
    title: `Negative APY: ${assetSymbol} at ${leverage}x`,
    body: `${assetSymbol} on ${poolName} is at ${netApy.toFixed(2)}% net APY. Tap to open Turbolong.`,
    url: appUrl,
  });
}
