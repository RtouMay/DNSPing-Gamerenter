import { Resolver } from "node:dns/promises";

function isPublicIPv4(ip) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const parts = ip.split(".").map(Number);
  if (parts.some(n => n < 0 || n > 255)) return false;

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
    // resolve4 is enough for reachability check in most cases
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
  const threshold = Math.ceil(total / 2); // majority (for 2 => 1)

  const avgMs = okCount
    ? Math.round(oks.reduce((a, b) => a + (b.ms || 0), 0) / okCount)
    : null;

  const status = okCount >= threshold ? "ok" : "fail";
  return { okCount, total, avgMs, status };
}

export default async function handler(req, res) {
  try {
    const dnsIp = (req.query.dns || "").toString().trim();
    if (!isPublicIPv4(dnsIp)) {
      return res.status(400).json({ ok: false, error: "invalid_dns_ip" });
    }

    const resolver = new Resolver();
    resolver.setServers([dnsIp]);

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

    return res.status(200).json({ ok: true, groups });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e?.message || "error" });
  }
}
