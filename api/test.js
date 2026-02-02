import dns from "node:dns";

function isPublicIPv4(ip) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const parts = ip.split(".").map(Number);
  if (parts.some(n => n < 0 || n > 255)) return false;

  const [a, b] = parts;
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

async function testOne(resolver, domain) {
  const t0 = Date.now();
  try {
    await withTimeout(resolver.resolve4(domain), 2500);
    return { domain, ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { domain, ok: false, error: e?.message || "error" };
  }
}

export default async function handler(req, res) {
  try {
    const dnsIp = (req.query.dns || "").toString().trim();
    if (!isPublicIPv4(dnsIp)) {
      return res.status(400).json({ ok: false, error: "invalid_dns_ip" });
    }

    const resolver = new dns.Resolver();
    resolver.setServers([dnsIp]);

    const domains = ["google.com", "aparat.com"];

    const results = [];
    for (const d of domains) {
      results.push(await testOne(resolver, d));
    }

    return res.status(200).json({ ok: true, results });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e?.message || "error" });
  }
}
