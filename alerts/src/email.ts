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

export async function sendLiquidationAlert(
  env: Env,
  to: string,
  opts: {
    poolName: string;
    userAddress: string;
    hf: number;
    unsubscribeUrl: string;
    appUrl: string;
  },
): Promise<SendResult> {
  const { poolName, userAddress, hf, unsubscribeUrl, appUrl } = opts;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 16px; color: #1a1a2e;">
  <h2 style="margin: 0 0 8px; color: #FF3B30;">LIQUIDATION IMMINENT</h2>
  <p style="font-size: 14px; color: #555; margin: 0 0 20px;">Your position on <strong>${poolName}</strong> is dangerously close to liquidation.</p>

  <div style="background: #fff6f6; border-radius: 8px; padding: 16px; margin-bottom: 20px; border: 1px solid #ffe6e6;">
    <p style="margin: 0 0 8px; font-size: 13px; color: #888;">Health Factor</p>
    <p style="margin: 0; font-size: 20px; font-weight: 700; color: #FF3B30;">${hf.toFixed(3)}</p>
  </div>

  <p style="line-height: 1.6; color: #555;">Your account (${userAddress}) has a health factor below 1.05 and may be liquidated by a small adverse move. Act immediately to reduce leverage or add collateral.</p>

  <a href="${appUrl}" style="display: inline-block; margin: 16px 0; padding: 12px 28px; background: #FF3B30; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600;">Open Turbolong</a>

  <p style="font-size: 12px; color: #aaa; margin-top: 32px;">
    <a href="${unsubscribeUrl}" style="color: #aaa;">Unsubscribe</a> from these liquidation warnings.
  </p>
</body>
</html>`.trim();

  return sendEmail(
    env,
    to,
    `\u26A0 LIQUIDATION IMMINENT: ${poolName} (HF ${hf.toFixed(3)})`,
    html,
  );
}
