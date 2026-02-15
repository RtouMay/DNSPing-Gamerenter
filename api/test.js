import dns from "dns";

const { Resolver } = dns.promises;

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function normalizeDigits(input) {
  const map = {
    "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
    "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
    "٫": ".", "٬": "", "،": ".", " ": ""
  };
  return (input || "").toString().trim().split("").map((ch) => map[ch] ?? ch).join("");
}

function isValidIPv4(ip) {
  ip = normalizeDigits(ip);
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  return ip.split(".").every((n) => {
    const x = Number(n);
    return Number.isFinite(x) && x >= 0 && x <= 255;
  });
}

const nowMs = () => Date.now();

function withTimeout(promise, ms, signal) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error("TIMEOUT")), ms);
  });

  const abort = new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) return reject(new Error("ABORTED"));
    signal.addEventListener("abort", () => reject(new Error("ABORTED")), { once: true });
  });

  return Promise.race([promise, timeout, abort]).finally(() => clearTimeout(t));
}

async function resolveOnce(resolver, domain, perDomainTimeoutMs, signal) {
  const start = nowMs();
  const methods = [
    () => resolver.resolve4(domain),
    () => resolver.resolve6(domain),
    () => resolver.resolveAny(domain),
  ];

  let lastErr = null;
  for (const run of methods) {
    try {
      const out = await withTimeout(run(), perDomainTimeoutMs, signal);
      if (Array.isArray(out) && out.length) {
        return { domain, ok: true, ms: nowMs() - start, err: null };
      }
      lastErr = new Error("EMPTY_ANSWER");
    } catch (e) {
      if (e?.message === "ABORTED") return { domain, ok: false, ms: null, err: "ABORTED" };
      lastErr = e;
    }
  }

  const code = lastErr?.code || lastErr?.message || "FAIL";
  return { domain, ok: false, ms: null, err: code };
}

function avgMs(items) {
  const ok = items.filter((x) => x.ok && typeof x.ms === "number");
  if (!ok.length) return null;
  const sum = ok.reduce((a, b) => a + b.ms, 0);
  return Math.round(sum / ok.length);
}

function groupStatus(items) {
  return items.some((x) => x.ok) ? "ok" : "fail";
}

async function mapWithConcurrency(items, limit, mapper, signal) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      if (signal?.aborted) break;
      const idx = i++;
      if (idx >= items.length) break;
      results[idx] = await mapper(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

const GROUPS = [
  {
    key: "xbox",
    title: "سرورهای Xbox",
    domains: [
      "xboxlive.com", "xbox.com", "login.live.com", "account.microsoft.com", "xsts.auth.xboxlive.com", "storeedgefd.dsx.mp.microsoft.com"
    ],
  },
  {
    key: "playstation",
    title: "سرورهای PlayStation",
    domains: [
      "playstation.com", "store.playstation.com", "id.sonyentertainmentnetwork.com", "auth.api.sonyentertainmentnetwork.com", "image.api.playstation.com"
    ],
  },
  {
    key: "games",
    title: "سرور بازی‌های پرطرفدار",
    domains: [
      "steampowered.com", "steamcommunity.com", "riotgames.com", "playvalorant.com", "leagueoflegends.com",
      "epicgames.com", "fortnite.com", "battle.net", "activision.com", "callofduty.com", "ea.com", "help.ea.com",
      "easports.com", "origin.com", "ubisoft.com", "rainbow6.com", "apexlegends.com", "battlefield.com",
    ],
  },
  {
    key: "international",
    title: "سرورهای بین‌المللی",
    domains: ["cloudflare.com", "google.com", "github.com", "microsoft.com", "amazon.com"],
  },
  {
    key: "internal",
    title: "سرورهای داخلی",
    domains: ["aparat.com", "digikala.com", "divar.ir", "rubika.ir"],
  },
];

const CACHE_TTL_MS = 45_000;
const cache = new Map();

function cacheGet(key) {
  const x = cache.get(key);
  if (!x) return null;
  if (nowMs() - x.t > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return x.v;
}

function cacheSet(key, value) {
  cache.set(key, { t: nowMs(), v: value });
}

function summarizeErrors(items) {
  const out = {};
  for (const item of items) {
    if (item.ok || !item.err) continue;
    out[item.err] = (out[item.err] || 0) + 1;
  }
  return out;
}

function buildNetworkProfile(warmups) {
  const ok = warmups.filter((x) => x.ok && typeof x.ms === "number");
  const avg = avgMs(ok);
  if (avg == null) return { quality: "unknown", warmupAvgMs: null };
  if (avg <= 80) return { quality: "fast", warmupAvgMs: avg };
  if (avg <= 180) return { quality: "normal", warmupAvgMs: avg };
  return { quality: "slow", warmupAvgMs: avg };
}

function computeTimeout(profile, requested) {
  if (Number.isFinite(requested) && requested >= 700 && requested <= 10_000) return Math.floor(requested);
  if (profile.quality === "fast") return 1400;
  if (profile.quality === "normal") return 2400;
  if (profile.quality === "slow") return 3600;
  return 2800;
}

async function runForDns(serverIp, options) {
  const resolver = new Resolver();
  resolver.setServers([serverIp]);

  const signal = null;
  const warmupTargets = ["cloudflare.com", "google.com", "microsoft.com"];
  const warmups = [];
  for (const d of warmupTargets) {
    warmups.push(await resolveOnce(resolver, d, 1200, signal));
  }

  const networkProfile = buildNetworkProfile(warmups);
  const perDomainTimeoutMs = computeTimeout(networkProfile, options.requestedTimeoutMs);

  const groups = [];
  for (const group of GROUPS) {
    const items = await mapWithConcurrency(group.domains, options.concurrency, (d) => resolveOnce(resolver, d, perDomainTimeoutMs, signal), signal);
    const okCount = items.filter((x) => x.ok).length;
    groups.push({
      key: group.key,
      title: group.title,
      total: group.domains.length,
      tested: items.length,
      okCount,
      avgMs: avgMs(items),
      status: groupStatus(items),
      errorSummary: summarizeErrors(items),
      items,
    });
  }

  const totalOk = groups.reduce((acc, g) => acc + g.okCount, 0);
  return {
    groups,
    dnsOk: totalOk > 0,
    meta: {
      concurrency: options.concurrency,
      perDomainTimeoutMs,
      networkProfile,
      warmup: warmups,
      checkedDomainCount: groups.reduce((acc, g) => acc + g.total, 0),
    },
  };
}

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");
    const primary = normalizeDigits(u.searchParams.get("primary") || "");
    const secondary = normalizeDigits(u.searchParams.get("secondary") || "");

    const userConc = Number(normalizeDigits(u.searchParams.get("conc") || "16"));
    const concurrency = Number.isFinite(userConc) ? Math.max(1, Math.min(100, Math.floor(userConc))) : 16;
    const requestedTimeoutMs = Number(normalizeDigits(u.searchParams.get("timeout") || ""));

    if (!primary || !isValidIPv4(primary)) return json(res, 400, { ok: false, error: "invalid_primary" });
    if (secondary) {
      if (!isValidIPv4(secondary)) return json(res, 400, { ok: false, error: "invalid_secondary" });
      if (secondary === primary) return json(res, 400, { ok: false, error: "same_dns" });
    }

    const cacheKey = `${primary}|${secondary || ""}|c${concurrency}|t${Number.isFinite(requestedTimeoutMs) ? requestedTimeoutMs : "auto"}`;
    const cached = cacheGet(cacheKey);
    if (cached) return json(res, 200, { ok: true, cached: true, ...cached });

    const options = { concurrency, requestedTimeoutMs };
    const primaryResult = await runForDns(primary, options);
    const out = { ok: true, results: { primary: primaryResult } };

    if (secondary) {
      out.results.secondary = await runForDns(secondary, options);
    }

    cacheSet(cacheKey, out);
    return json(res, 200, out);
  } catch (e) {
    return json(res, 500, { ok: false, error: "server_error", message: e?.message || "unknown_error" });
  }
}
