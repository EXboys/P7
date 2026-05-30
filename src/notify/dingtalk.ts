import { createHmac } from "crypto";

export async function sendDingTalkMarkdown(
  webhook: string,
  secret: string | undefined,
  title: string,
  text: string,
): Promise<void> {
  let url = webhook;
  if (secret) {
    const ts = Date.now();
    const sign = createHmac("sha256", secret).update(`${ts}\n${secret}`).digest("base64");
    const enc = encodeURIComponent(sign);
    url += `${webhook.includes("?") ? "&" : "?"}timestamp=${ts}&sign=${enc}`;
  }
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msgtype: "markdown",
      markdown: { title, text },
    }),
  });
}

export async function sendDingTalkActionCard(opts: {
  webhook: string;
  secret?: string;
  title: string;
  text: string;
  singleTitle: string;
  singleURL: string;
}): Promise<void> {
  let url = opts.webhook;
  if (opts.secret) {
    const ts = Date.now();
    const sign = createHmac("sha256", opts.secret).update(`${ts}\n${opts.secret}`).digest("base64");
    url += `${url.includes("?") ? "&" : "?"}timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
  }
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msgtype: "actionCard",
      actionCard: {
        title: opts.title,
        text: opts.text,
        btnOrientation: "0",
        singleTitle: opts.singleTitle,
        singleURL: opts.singleURL,
      },
    }),
  });
}
