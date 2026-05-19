/**
 * Alert delivery via email and webhook channels.
 */

interface EmailEnv {
  RESEND_API_KEY: string;
  RESEND_FROM: string;
}

interface SendResult {
  ok: boolean;
  error?: string;
}

export type AlertChannel = "email" | "slack" | "discord";

export interface NotificationTarget {
  channel: AlertChannel;
  destination: string;
}

interface ApyAlertOptions {
  poolName: string;
  assetSymbol: string;
  leverage: number;
  netApy: number;
  supplyApr: number;
  borrowCost: number;
  unsubscribeUrl: string;
  appUrl: string;
}

export type Notification =
  | { kind: "verification"; verifyUrl?: string }
  | { kind: "apy-alert"; opts: ApyAlertOptions };

async function sendEmail(env: EmailEnv, to: string, subject: string, html: string): Promise<SendResult> {
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

async function postWebhook(url: string, payload: object): Promise<SendResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: `Webhook ${res.status}: ${text}` };
  }
  return { ok: true };
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

async function sendVerificationEmail(env: EmailEnv, to: string, verifyUrl: string): Promise<SendResult> {
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

function verificationWebhookPayload(channel: Exclude<AlertChannel, "email">): object {
  const text = "Turbolong alert channel verified. This test confirms webhook delivery is working.";

  if (channel === "slack") {
    return {
      text,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "*Turbolong alert channel verified*" } },
        { type: "section", text: { type: "mrkdwn", text: "Webhook delivery is working for this subscription." } },
      ],
    };
  }

  return {
    content: text,
    embeds: [
      {
        title: "Turbolong alert channel verified",
        description: "Webhook delivery is working for this subscription.",
        color: 3008675,
      },
    ],
  };
}

function apyWebhookPayload(channel: Exclude<AlertChannel, "email">, opts: ApyAlertOptions): object {
  const { poolName, assetSymbol, leverage, netApy, supplyApr, borrowCost, unsubscribeUrl, appUrl } = opts;
  const title = "Negative APY Alert";
  const summary = `${assetSymbol} at ${leverage}x on ${poolName} is now ${formatPercent(netApy)}.`;

  if (channel === "slack") {
    return {
      text: `${title}: ${summary}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*${title}*\n${summary}` } },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Net supply APR*\n${formatPercent(supplyApr)}` },
            { type: "mrkdwn", text: `*Net borrow cost*\n${formatPercent(borrowCost)}` },
            { type: "mrkdwn", text: `*Net APY*\n${formatPercent(netApy)}` },
            { type: "mrkdwn", text: `*Leverage*\n${leverage}x` },
          ],
        },
        { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open Turbolong" }, url: appUrl }] },
        { type: "context", elements: [{ type: "mrkdwn", text: `<${unsubscribeUrl}|Unsubscribe from this alert>` }] },
      ],
    };
  }

  return {
    content: `${title}: ${summary}`,
    embeds: [
      {
        title,
        description: summary,
        color: 16731498,
        fields: [
          { name: "Net supply APR", value: formatPercent(supplyApr), inline: true },
          { name: "Net borrow cost", value: formatPercent(borrowCost), inline: true },
          { name: "Net APY", value: formatPercent(netApy), inline: true },
          { name: "Leverage", value: `${leverage}x`, inline: true },
        ],
        url: appUrl,
      },
    ],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 5, label: "Open Turbolong", url: appUrl },
          { type: 2, style: 5, label: "Unsubscribe", url: unsubscribeUrl },
        ],
      },
    ],
  };
}

async function sendApyEmail(env: EmailEnv, to: string, opts: ApyAlertOptions): Promise<SendResult> {
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

export async function notify(env: EmailEnv, target: NotificationTarget, notification: Notification): Promise<SendResult> {
  if (target.channel === "email") {
    if (notification.kind === "verification") {
      if (!notification.verifyUrl) return { ok: false, error: "Missing verification URL" };
      return sendVerificationEmail(env, target.destination, notification.verifyUrl);
    }
    return sendApyEmail(env, target.destination, notification.opts);
  }

  if (notification.kind === "verification") {
    return postWebhook(target.destination, verificationWebhookPayload(target.channel));
  }

  return postWebhook(target.destination, apyWebhookPayload(target.channel, notification.opts));
}
