// A small SMTP client for alert email, on node:net and node:tls, so email needs no dependency.
// It sends one plain-text message per connection: alerts are few, and a fresh connection keeps
// the failure modes simple.
import "server-only";
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import tls from "node:tls";

export type SmtpSecurity = "tls" | "starttls" | "none";

export interface SmtpConfig {
  host: string;
  port: number;
  /** tls: TLS from the start (usually port 465); starttls: upgrade a plain connection (587); none: no TLS, for a relay on the local network */
  security: SmtpSecurity;
  username: string | null;
  password: string | null;
  from: string;
  to: string[];
}

export interface Mail {
  subject: string;
  text: string;
}

export class SmtpError extends Error {}

interface Reply {
  code: number;
  text: string;
}

/** Reads replies off the connection: "250-…" lines continue a reply, "250 …" ends it. */
class Session {
  private buf = "";
  private lines: string[] = [];
  private replies: Reply[] = [];
  private waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;

  constructor(public socket: net.Socket) {
    this.attach(socket);
  }

  attach(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (d: Buffer) => this.onData(d));
    socket.on("error", (e) => this.fail(e));
    socket.on("close", () => this.fail(new SmtpError("the server closed the connection")));
  }

  private onData(d: Buffer) {
    this.buf += d.toString("utf8");
    if (this.buf.length > 65_536) return this.fail(new SmtpError("the server's reply is too long"));
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      this.lines.push(line);
      if (line[3] === "-") continue;
      const reply = { code: Number(line.slice(0, 3)), text: this.lines.map((l) => l.slice(4)).join("\n") };
      this.lines = [];
      if (this.waiting) {
        this.waiting.resolve(reply);
        this.waiting = null;
      } else this.replies.push(reply);
    }
  }

  fail(e: Error) {
    this.failure ??= e;
    this.waiting?.reject(this.failure);
    this.waiting = null;
  }

  private read(): Promise<Reply> {
    const r = this.replies.shift();
    if (r) return Promise.resolve(r);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => (this.waiting = { resolve, reject }));
  }

  async expect(codes: number[], what: string): Promise<Reply> {
    const r = await this.read();
    if (!codes.includes(r.code)) throw new SmtpError(`${what}: the server answered ${r.code} ${r.text.split("\n")[0]}`.trim());
    return r;
  }

  /** Send one command and check the reply. `what` names it in errors, so a password never ends up in one. */
  cmd(line: string, codes: number[], what: string): Promise<Reply> {
    this.socket.write(line + "\r\n");
    return this.expect(codes, what);
  }
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** RFC 2047, so alert names in any language survive in the subject. */
const encodeHeader = (s: string) => `=?UTF-8?B?${b64(s.replace(/[\r\n]+/g, " "))}?=`;

/** The name this machine introduces itself with: its hostname if that is a valid one. */
function heloName(): string {
  const h = os.hostname();
  return /^[A-Za-z0-9]([A-Za-z0-9.-]{0,252})$/.test(h) ? h : "localhost";
}

function message(cfg: SmtpConfig, mail: Mail): string {
  const body = b64(mail.text.replace(/\r?\n/g, "\r\n")).replace(/.{1,76}/g, "$&\r\n");
  return [
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `From: llama-paddock <${cfg.from}>`,
    `To: ${cfg.to.join(", ")}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    `Message-ID: <${crypto.randomUUID()}@llama-paddock>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
    "",
    body,
  ].join("\r\n");
}

function upgrade(socket: net.Socket, host: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    // from here on the TLS socket reads the connection
    socket.removeAllListeners("data");
    const s = tls.connect({ socket, host, servername: net.isIP(host) ? undefined : host });
    s.once("secureConnect", () => resolve(s));
    s.once("error", reject);
  });
}

/** Send one message. Resolves with the server's answer to it (often a queue id); rejects with an SmtpError or a socket error. */
export async function sendMail(cfg: SmtpConfig, mail: Mail, timeoutMs = 30_000): Promise<string> {
  if (cfg.username && cfg.security === "none") throw new SmtpError("won't send the password without TLS: use TLS or STARTTLS");
  const servername = net.isIP(cfg.host) ? undefined : cfg.host;
  const socket = cfg.security === "tls"
    ? tls.connect({ host: cfg.host, port: cfg.port, servername })
    : net.connect({ host: cfg.host, port: cfg.port });
  const s = new Session(socket);
  const timer = setTimeout(() => {
    s.fail(new SmtpError("timed out"));
    s.socket.destroy();
  }, timeoutMs);
  try {
    await s.expect([220], "connecting");
    let ehlo = await s.cmd(`EHLO ${heloName()}`, [250], "EHLO");
    if (cfg.security === "starttls") {
      if (!/^STARTTLS\b/im.test(ehlo.text)) throw new SmtpError("the server doesn't offer STARTTLS: try TLS, or another port");
      await s.cmd("STARTTLS", [220], "STARTTLS");
      s.attach(await upgrade(s.socket, cfg.host));
      ehlo = await s.cmd(`EHLO ${heloName()}`, [250], "EHLO");
    }
    if (cfg.username) {
      const mechs = (/^AUTH[ =](.*)$/im.exec(ehlo.text)?.[1] ?? "").toUpperCase().split(/\s+/);
      const user = cfg.username, pass = cfg.password ?? "";
      if (mechs.includes("PLAIN")) await s.cmd(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, [235], "login");
      else if (mechs.includes("LOGIN")) {
        await s.cmd("AUTH LOGIN", [334], "login");
        await s.cmd(b64(user), [334], "login");
        await s.cmd(b64(pass), [235], "login");
      } else throw new SmtpError("the server offers no login this client supports (PLAIN or LOGIN)");
    }
    await s.cmd(`MAIL FROM:<${cfg.from}>`, [250], "sender");
    for (const to of cfg.to) await s.cmd(`RCPT TO:<${to}>`, [250, 251], `recipient ${to}`);
    await s.cmd("DATA", [354], "DATA");
    // base64 lines never start with ".", so the message needs no dot-stuffing
    const sent = await s.cmd(`${message(cfg, mail)}.`, [250], "message");
    s.socket.end("QUIT\r\n");
    return sent.text;
  } finally {
    clearTimeout(timer);
    s.socket.destroy();
  }
}
