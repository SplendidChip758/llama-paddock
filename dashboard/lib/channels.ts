// Notification channel types, shared by the server (validation) and the channel editor.
import type { ChannelType } from "./types";

export const CHANNEL_TYPES: Record<ChannelType, { label: string; help: string }> = {
  webhook: {
    label: "Webhook",
    help: "Posts a JSON message to any URL, such as an n8n, Node-RED or Home Assistant webhook. An optional token is sent as Authorization: Bearer.",
  },
  discord: {
    label: "Discord",
    help: "A channel webhook: in Discord, Edit channel → Integrations → Webhooks → New webhook → Copy webhook URL.",
  },
  slack: {
    label: "Slack",
    help: "An incoming webhook URL (https://hooks.slack.com/services/…). Mattermost and Rocket.Chat incoming webhooks take the same messages.",
  },
  email: {
    label: "Email",
    help: "Sent through your mail provider's SMTP server. For Gmail or Microsoft 365, use an app password.",
  },
};

export const isChannelType = (t: unknown): t is ChannelType => typeof t === "string" && Object.hasOwn(CHANNEL_TYPES, t);

/** The usual port for each kind of SMTP connection. */
export const SMTP_PORTS = { tls: 465, starttls: 587, none: 25 } as const;
