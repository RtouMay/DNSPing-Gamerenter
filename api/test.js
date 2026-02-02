import { Resolver } from "node:dns/promises";

function normalizeDigits(input) {
  // تبدیل ارقام فارسی/عربی به انگلیسی + نقطه فارسی
  const map = {
    "۰": "0","۱": "1","۲": "2","۳": "3","۴": "4","۵": "5","۶": "6","۷": "7","۸": "8","۹": "9",
    "٠": "0","١": "1","٢": "2","٣": "3","٤": "4","٥": "5","٦": "6","٧": "7","٨": "8","٩": "9",
    "٫": ".", "٬": "", "،": ".", " ": ""
  };
  return (input || "").toString().trim().split("").map(ch => map[ch] ?? ch).join("");
}

function parseIPv4(ipRaw) {
  const ip = normalizeDigits(ipRaw);
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
  const parts = ip.split(".").map(Number);
  if (parts.some(n => n < 0 || n > 255)) return null;
  return ip;
}

function isPublicIPv4(ip) {
  const parts = ip.split(".").map(Number);
  const [a, b] = parts;

  // block private & local ranges (SSRF safety)
  if (a === 10) return false;
  if (a === 127) return false;
  if (a === 0) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;

  return true;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

async function testDomain(resolver, domain) {
  const t0 = Date.now();
  try {
    await withTimeout(resolver.resolve4(domain), 2500);
    return { domain, ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { domain, ok: false, error: e?.message || "error" };
  }
}

function summarize(items) {
  const oks = items.filter(x => x.ok);
  const okCount = oks.length;
  const total = items.length;
  const threshold = Math.ceil(total / 2); // majority (برای 2 => 1 هم قبول)

  const avgMs = okCount
    ? Math.round(oks.reduce((a, b) => a + (b.ms || 0), 0) / okCount)
    : null;

  const status = okCount >= threshold ? "ok" : "fail";
  return { okCount, total, avgMs, status };
}

async function runForDns(dnsIp, groupsDef) {
  const resolver = new Resolver();
  resolver.setServers([dnsIp]);

  const groups = [];
  for (const g of groupsDef) {
    const items = [];
    for (const d of g.domains) {
      items.push(await testDomain(resolver, d));
    }
    const s = summarize(items);
    groups.push({
      key: g.key,
      title: g.title,
      icon: g.icon,
      status: s.status,
      okCount: s.okCount,
      total: s.total,
      avgMs: s.avgMs,
      items,
    });
  }

  return { ip: dnsIp, groups };
}

export default async function handler(req, res) {
  try {
    const primaryRaw = req.query.primary || req.query.dns || "";
    const secondaryRaw = req.query.secondary || "";

    const primary = parseIPv4(primaryRaw);
    const secondary = secondaryRaw ? parseIPv4(secondaryRaw) : null;

    if (!primary) {
      return res.status(400).json({ ok: false, error: "invalid_primary" });
    }
    if (!isPublicIPv4(primary)) {
      return res.status(400).json({ ok: false, error: "private_primary" });
    }
    if (secondary && !isPublicIPv4(secondary)) {
      return res.status(400).json({ ok: false, error: "private_secondary" });
    }
    if (secondary && secondary === primary) {
      return res.status(400).json({ ok: false, error: "same_dns" });
    }

    const groupsDef = [
      {
        key: "xbox",
        title: "سرورهای Xbox",
        icon: "🎮",
        domains: ["xboxlive.com", "xsts.auth.xboxlive.com", "title.mgt.xboxlive.com"],
      },
      {
        key: "playstation",
        title: "سرورهای PlayStation",
        icon: "🎮",
        domains: ["playstation.com", "playstation.net", "auth.api.sonyentertainmentnetwork.com"],
      },
      {
        key: "games",
        title: "سرور بازی‌های پرطرفدار",
        icon: "🔥",
        domains: [
          "ea.com",
          "accounts.ea.com",
          "easports.com",
          "callofduty.com",
          "demonware.net"
        ],
      },
      {
        key: "international",
        title: "سرورهای بین‌المللی",
        icon: "🌍",
        domains: ["google.com", "cloudflare.com", "github.com"],
      },
      {
        key: "internal",
        title: "سرورهای داخلی",
        icon: "🇮🇷",
        domains: ["aparat.com", "digikala.com"],
      },
    ];

    const out = { ok: true, results: {} };

    out.results.primary = await runForDns(primary, groupsDef);

    if (secondary) {
      out.results.secondary = await runForDns(secondary, groupsDef);
    }

    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ ok: false, error: "server_error", message: e?.message || "error" });
  }
}
