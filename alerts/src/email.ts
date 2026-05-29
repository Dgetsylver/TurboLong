/**
 * Email delivery via Resend API.
 */

interface Env {
  RESEND_API_KEY: string;
  RESEND_FROM: string;
}

interface SendResult {
  ok: boolean;
  error?: string;
}

async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<SendResult> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to: [to],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: `Resend ${res.status}: ${text}` };
  }
  return { ok: true };
}

export async function sendVerificationEmail(env: Env, to: string, verifyUrl: string): Promise<SendResult> {
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 16px; color: #1a1a2e;">
  <h2 style="margin: 0 0 16px;">Verify your Turbolong alert</h2>
  <p style="line-height: 1.6; color: #555;">Click the button below to verify your email and activate APY alerts.</p>
  <a href="${verifyUrl}" style="display: inline-block; margin: 20px 0; padding: 12px 28px; background: #2DE8A3; color: #0B0E14; text-decoration: none; border-radius: 8px; font-weight: 600;">Verify Subscription</a>
  <p style="font-size: 13px; color: #888; margin-top: 24px;">If you didn't subscribe, ignore this email.</p>
</body>
</html>`.trim();

  return sendEmail(env, to, "Verify your Turbolong alert subscription", html);
}

export async function sendApyAlert(
  env: Env,
  to: string,
  opts: {
    poolName: string;
    assetSymbol: string;
    leverage: number;
    netApy: number;
    supplyApr: number;
    borrowCost: number;
    unsubscribeUrl: string;
    appUrl: string;
  },
): Promise<SendResult> {
  const { poolName, assetSymbol, leverage, netApy, supplyApr, borrowCost, unsubscribeUrl, appUrl } = opts;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 16px; color: #1a1a2e;">
  <h2 style="margin: 0 0 8px; color: #FF4D6A;">Negative APY Alert</h2>
  <p style="font-size: 14px; color: #555; margin: 0 0 20px;">${assetSymbol} at ${leverage}x on ${poolName}</p>

  <div style="background: #f8f8fc; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
    <p style="margin: 0 0 8px; font-size: 13px; color: #888;">Current rates</p>
    <table style="width: 100%; font-size: 14px; border-collapse: collapse;">
      <tr><td style="padding: 4px 0; color: #555;">Net supply APR</td><td style="padding: 4px 0; text-align: right; font-weight: 600;">${supplyApr.toFixed(2)}%</td></tr>
      <tr><td style="padding: 4px 0; color: #555;">Net borrow cost</td><td style="padding: 4px 0; text-align: right; font-weight: 600;">${borrowCost.toFixed(2)}%</td></tr>
      <tr style="border-top: 1px solid #e0e0e8;"><td style="padding: 8px 0 4px; color: #FF4D6A; font-weight: 600;">Net APY at ${leverage}x</td><td style="padding: 8px 0 4px; text-align: right; font-weight: 700; color: #FF4D6A;">${netApy.toFixed(2)}%</td></tr>
    </table>
  </div>

  <p style="line-height: 1.6; color: #555;">Your position is losing money to interest costs. Consider closing or reducing leverage.</p>

  <a href="${appUrl}" style="display: inline-block; margin: 16px 0; padding: 12px 28px; background: #2DE8A3; color: #0B0E14; text-decoration: none; border-radius: 8px; font-weight: 600;">Open Turbolong</a>

  <p style="font-size: 12px; color: #aaa; margin-top: 32px;">
    <a href="${unsubscribeUrl}" style="color: #aaa;">Unsubscribe</a> from this alert.
  </p>
</body>
</html>`.trim();

  return sendEmail(
    env,
    to,
    `\u26A0 Negative APY: ${assetSymbol} at ${leverage}x on ${poolName}`,
    html,
  );
}

export interface DigestPosition {
  poolName: string;
  assetSymbol: string;
  leverage: number;
  hf: number | null;       // null = data unavailable; Infinity = no debt
  yield24h: number | null; // netApy / 365, null = data unavailable
  netApy: number | null;
}

export async function sendDailyDigest(
  env: Env,
  to: string,
  opts: {
    date: string;           // YYYY-MM-DD
    positions: DigestPosition[];
    unsubscribeUrl: string;
    appUrl: string;
  },
): Promise<SendResult> {
  const { date, positions, unsubscribeUrl, appUrl } = opts;

  // Build the positions table — wrapped in try/catch so a render error
  // still results in a sent email with a fallback message.
  let tableHtml: string;
  try {
    const rows = positions.map(p => {
      const hfDisplay = p.hf === null
        ? "N/A"
        : !isFinite(p.hf)
          ? "&#8734;"
          : p.hf.toFixed(3);
      const hfColor = p.hf !== null && isFinite(p.hf) && p.hf < 1.2
        ? "color:#FF4D6A;font-weight:700;"
        : "";

      const yieldDisplay = p.yield24h === null
        ? "N/A"
        : `${p.yield24h >= 0 ? "+" : ""}${p.yield24h.toFixed(2)}%`;
      const yieldColor = p.yield24h !== null && p.yield24h < 0
        ? "color:#FF4D6A;"
        : p.yield24h !== null && p.yield24h > 0
          ? "color:#2DE8A3;"
          : "";

      return `
        <tr style="border-bottom:1px solid #e8eaf0;">
          <td style="padding:8px 10px;font-size:13px;">${p.poolName}</td>
          <td style="padding:8px 10px;font-size:13px;font-weight:600;">${p.assetSymbol}</td>
          <td style="padding:8px 10px;font-size:13px;text-align:center;">${p.leverage}&times;</td>
          <td style="padding:8px 10px;font-size:13px;text-align:right;${hfColor}">${hfDisplay}</td>
          <td style="padding:8px 10px;font-size:13px;text-align:right;${yieldColor}">${yieldDisplay}</td>
        </tr>`;
    }).join("");

    tableHtml = `
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
        <thead>
          <tr style="background:#f0f2f8;">
            <th style="padding:8px 10px;font-size:11px;text-align:left;text-transform:uppercase;letter-spacing:.5px;color:#888;font-weight:600;">Pool</th>
            <th style="padding:8px 10px;font-size:11px;text-align:left;text-transform:uppercase;letter-spacing:.5px;color:#888;font-weight:600;">Asset</th>
            <th style="padding:8px 10px;font-size:11px;text-align:center;text-transform:uppercase;letter-spacing:.5px;color:#888;font-weight:600;">Leverage</th>
            <th style="padding:8px 10px;font-size:11px;text-align:right;text-transform:uppercase;letter-spacing:.5px;color:#888;font-weight:600;">Health Factor</th>
            <th style="padding:8px 10px;font-size:11px;text-align:right;text-transform:uppercase;letter-spacing:.5px;color:#888;font-weight:600;">24h Yield</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  } catch {
    tableHtml = `<p style="color:#888;font-size:13px;">Position data temporarily unavailable.</p>`;
  }

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#1a1a2e;">
  <div style="margin-bottom:24px;">
    <span style="font-size:18px;font-weight:800;letter-spacing:-.5px;">Turbo<span style="color:#2DE8A3;">long</span></span>
    <span style="font-size:13px;color:#888;margin-left:12px;">Morning Digest &mdash; ${date}</span>
  </div>

  <p style="font-size:14px;color:#555;margin:0 0 16px;">Here&rsquo;s a snapshot of your monitored positions as of today.</p>

  ${tableHtml}

  <p style="font-size:12px;color:#aaa;margin-top:8px;">
    HF below 1.2 is highlighted in red. Negative 24h yield means interest costs exceeded supply earnings today.
  </p>

  <a href="${appUrl}" style="display:inline-block;margin:20px 0 8px;padding:12px 28px;background:#2DE8A3;color:#0B0E14;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">Open Turbolong</a>

  <p style="font-size:12px;color:#aaa;margin-top:28px;">
    <a href="${unsubscribeUrl}" style="color:#aaa;">Unsubscribe</a> from daily digests.
  </p>
</body>
</html>`.trim();

  return sendEmail(env, to, `TurboLong Morning Digest \u2014 ${date}`, html);
}
