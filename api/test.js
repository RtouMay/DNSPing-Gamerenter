import dns from "dns";

const { Resolver } = dns.promises;

// ----------------- Response helper -----------------
function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

// ----------------- Input helpers -----------------
function normalizeDigits(input){
  const map = {
    "۰":"0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9",
    "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9",
    "٫":".","٬":"","،":"."," ":""
  };
  return (input||"").toString().trim().split("").map(ch => map[ch] ?? ch).join("");
}

function isValidIPv4(ip) {
  ip = normalizeDigits(ip);
  if(!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  return ip.split(".").every(n => {
    const x = Number(n);
    return Number.isFinite(x) && x >= 0 && x <= 255;
  });
}

// ----------------- Timing & timeout -----------------
function nowMs() {
  // Date.now برای سادگی و سازگاری
  return Date.now();
}

function withTimeout(promise, ms, signal) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error("TIMEOUT")), ms);
  });

  // اگر بیرون abort شد
  const abort = new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) return reject(new Error("ABORTED"));
    signal.addEventListener("abort", () => reject(new Error("ABORTED")), { once: true });
  });

  return Promise.race([promise, timeout, abort]).finally(() => clearTimeout(t));
}

async function resolveOnce(resolver, domain, perDomainTimeoutMs, signal) {
  const start = nowMs();

  // بعضی DNSها روی یک نوع رکورد بد جواب می‌دن؛ چند روش رو پشت‌سرهم امتحان می‌کنیم.
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
        const ms = nowMs() - start;
        return { domain, ok: true, ms, err: null };
      }
      lastErr = new Error("EMPTY_ANSWER");
    } catch (e) {
      if (e?.message === "ABORTED") {
        return { domain, ok: false, ms: null, err: "ABORTED" };
      }
      lastErr = e;
    }
  }

  const code = (lastErr && lastErr.code) ? lastErr.code : (lastErr && lastErr.message) ? lastErr.message : "FAIL";
  return { domain, ok: false, ms: null, err: code };
}

function avgMs(items) {
  const ok = items.filter(x => x.ok && typeof x.ms === "number");
  if (!ok.length) return null;
  const sum = ok.reduce((a,b)=>a+b.ms,0);
  return Math.round(sum / ok.length);
}

function groupStatus(items){
  const okCount = items.filter(x=>x.ok).length;
  return okCount === 0 ? "fail" : "ok";
}

function allFailed(groups){
  const totalOk = groups.reduce((acc,g)=>acc + (g.okCount || 0), 0);
  return totalOk === 0;
}

// ----------------- Concurrency limiter -----------------
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

// ----------------- Groups -----------------
const GROUPS = [
  {
    key: "xbox",
    title: "سرورهای Xbox",
    // مهم‌ها اول = بهتر برای نمونه‌گیری
    domains: [
      "xboxlive.com",
      "xbox.com",
      "login.live.com",
      "account.microsoft.com",
      "xsts.auth.xboxlive.com",
      "storeedgefd.dsx.mp.microsoft.com",
    ],
  },
  {
    key: "playstation",
    title: "سرورهای PlayStation",
    domains: [
      "playstation.com",
      "store.playstation.com",
      "id.sonyentertainmentnetwork.com",
      "auth.api.sonyentertainmentnetwork.com",
      "image.api.playstation.com"
    ],
  },
  {
    key: "games",
    title: "سرور بازی‌های پرطرفدار",
    domains: [
      "steampowered.com","steamcommunity.com",
      "riotgames.com","playvalorant.com","leagueoflegends.com",
      "epicgames.com","fortnite.com",
      "battle.net","activision.com","callofduty.com",
      "ea.com","help.ea.com","easports.com","origin.com",
      "ubisoft.com","rainbow6.com",
      "apexlegends.com","battlefield.com",
    ],
  },
  {
    key: "international",
    title: "سرورهای بین‌المللی",
    domains: ["cloudflare.com","google.com","github.com","microsoft.com","amazon.com"],
  },
  {
    key: "internal",
    title: "سرورهای داخلی",
    domains: ["aparat.com","digikala.com","divar.ir","rubika.ir"],
  },
];

// ----------------- In-memory cache (TTL) -----------------
const CACHE_TTL_MS = 60_000;
const cache = new Map();

function cacheGet(key) {
  const x = cache.get(key);
  if (!x) return null;
  if ((nowMs() - x.t) > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return x.v;
}

function cacheSet(key, value) {
  cache.set(key, { t: nowMs(), v: value });
}

// ----------------- Main handler -----------------
export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");

    const primary = normalizeDigits(u.searchParams.get("primary") || "");
    const secondary = normalizeDigits(u.searchParams.get("secondary") || "");

    // تنظیمات سرعت/دقت
    // conc: تعداد resolve همزمان
    const userConc = Number(normalizeDigits(u.searchParams.get("conc") || "8"));
    const CONCURRENCY = Number.isFinite(userConc) ? Math.max(1, Math.min(12, Math.floor(userConc))) : 8;

    // mode: برای سازگاری با کلاینت نگه داشته شده است
    const mode = (u.searchParams.get("mode") || "full").toLowerCase();

    // پر-دامنه تایم‌اوت (برای جلوگیری از آویزان شدن یک دامنه خاص)
    const PER_DOMAIN_TIMEOUT_MS = 2400;

    // Validate
    if (!primary || !isValidIPv4(primary)) return json(res, 400, { ok:false, error:"invalid_primary" });
    if (secondary) {
      if (!isValidIPv4(secondary)) return json(res, 400, { ok:false, error:"invalid_secondary" });
      if (secondary === primary) return json(res, 400, { ok:false, error:"same_dns" });
    }

    // Cache key
    const cacheKey = `${primary}|${secondary || ""}|${mode}|c${CONCURRENCY}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      return json(res, 200, { ok: true, cached: true, ...cached });
    }

    async function runGroupAdaptive(resolver, group, signal) {
      const domains = group.domains;
      const maxCount = domains.length;
      const initialCount = Math.min(3, maxCount);

      const testedResults = await mapWithConcurrency(
        domains,
        CONCURRENCY,
        (d) => resolveOnce(resolver, d, PER_DOMAIN_TIMEOUT_MS, signal),
        signal
      );

      const okCount = testedResults.filter(x=>x.ok).length;

      return {
        key: group.key,
        title: group.title,
        total: domains.length,
        tested: testedResults.length,
        okCount,
        avgMs: avgMs(testedResults),
        status: groupStatus(testedResults),
        sampling: {
          enabled: false,
          decision: "full_scan",
          initialCount,
          maxCount,
          skipped: Math.max(0, domains.length - testedResults.length),
        },
        items: testedResults
      };
    }

    async function runForDns(serverIp) {
      const resolver = new Resolver();
      resolver.setServers([serverIp]);

      const signal = null;

      // Warmup سبک
      await resolveOnce(resolver, "cloudflare.com", Math.min(900, PER_DOMAIN_TIMEOUT_MS), signal);

      const groups = [];
      for (const g of GROUPS) {
        groups.push(await runGroupAdaptive(resolver, g, signal));
      }

      return {
        groups,
        dnsOk: !allFailed(groups),
        meta: {
          mode,
          concurrency: CONCURRENCY,
          perDomainTimeoutMs: PER_DOMAIN_TIMEOUT_MS,
          budgetMs: null,
          budgetHit: false
        }
      };
    }

    const primaryResult = await runForDns(primary);
    const out = { ok:true, results: { primary: primaryResult } };

    if (secondary) {
      const secondaryResult = await runForDns(secondary);
      out.results.secondary = secondaryResult;
    }

    // cache response (بدون داده‌های غیرضروری)
    cacheSet(cacheKey, out);

    return json(res, 200, out);

  } catch (e) {
    return json(res, 500, { ok:false, error:"server_error" });
  }
}
