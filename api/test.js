import dns from "dns";

const { Resolver } = dns.promises;

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function normalizeDigits(input) {
  const map = {
    "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
    "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
    "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
    "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
    "٫": ".", "٬": "", "،": ".", " ": ""
  };
  return (input || "").toString().trim().split("").map(ch => map[ch] ?? ch).join("");
}

function isValidIPv4(ip) {
  ip = normalizeDigits(ip);
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  return ip.split(".").every(n => {
    const x = Number(n);
    return Number.isFinite(x) && x >= 0 && x <= 255;
  });
}

function isPrivateIPv4(ip) {
  const [a, b] = ip.split(".").map(Number);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  // (می‌تونیم رنج‌های بیشتر هم اضافه کنیم)
  return false;
}

const PER_DOMAIN_TIMEOUT_MS = 3500;

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error("TIMEOUT")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function resolveOnce(resolver, domain) {
  const start = Date.now();
  try {
    await withTimeout(resolver.resolve4(domain), PER_DOMAIN_TIMEOUT_MS);
    const ms = Date.now() - start;
    return { domain, ok: true, ms, err: null };
  } catch (e) {
    const code = (e && e.code) ? e.code : (e && e.message) ? e.message : "FAIL";
    return { domain, ok: false, ms: null, err: code };
  }
}

function avgMs(items) {
  const ok = items.filter(x => x.ok && typeof x.ms === "number");
  if (!ok.length) return null;
  const sum = ok.reduce((a, b) => a + b.ms, 0);
  return Math.round(sum / ok.length);
}

function groupStatus(items) {
  const okCount = items.filter(x => x.ok).length;
  return okCount === 0 ? "fail" : "ok";
}

function allFailed(groups) {
  const totalOk = groups.reduce((acc, g) => acc + (g.okCount || 0), 0);
  return totalOk === 0;
}

/**
 * اجرای همزمان با محدودیت کانکارنسی (بدون dependency)
 * ترتیب خروجی حفظ می‌شود.
 */
async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let i = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      results[idx] = await mapper(items[idx], idx);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * تصمیم‌گیری Sampling:
 * - گروه کوچک: همه
 * - گروه بزرگ: اول sample (۳تا)
 *    اگر خیلی خوب: stop
 *    اگر خیلی بد: stop
 *    اگر مرزی: تا سقف max (مثلاً ۸تا) ادامه
 */
function decideSampling(domains, firstBatchResults, config) {
  const { initialCount, maxCount, goodAvgMsThreshold } = config;

  const testedCount = firstBatchResults.length;
  const okCount = firstBatchResults.filter(x => x.ok).length;
  const avg = avgMs(firstBatchResults);

  // خیلی خوب: همه موفق + avg پایین
  const isVeryGood = okCount === testedCount && avg !== null && avg <= goodAvgMsThreshold;

  // خیلی بد: هیچکدوم موفق نشدن
  const isVeryBad = okCount === 0;

  if (domains.length <= maxCount) {
    // گروه نه خیلی بزرگ: به max می‌رسه یعنی می‌تونیم همه رو تست کنیم
    return { action: "continue", targetCount: domains.length, reason: "small_group" };
  }

  if (testedCount >= initialCount) {
    if (isVeryGood) {
      return { action: "stop", targetCount: testedCount, reason: "very_good_sample" };
    }
    if (isVeryBad) {
      return { action: "stop", targetCount: testedCount, reason: "very_bad_sample" };
    }
    // مرزی/نامطمئن
    return { action: "continue", targetCount: Math.min(maxCount, domains.length), reason: "uncertain_sample" };
  }

  // حالت پیشفرض
  return { action: "continue", targetCount: Math.min(maxCount, domains.length), reason: "default" };
}

const GROUPS = [
  {
    key: "xbox",
    title: "سرورهای Xbox",
    // دامنه‌های مهم‌تر اول (برای نمونه‌گیری بهتر)
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
    // مهم‌ها اول
    domains: [
      "steampowered.com", "steamcommunity.com",
      "riotgames.com", "playvalorant.com", "leagueoflegends.com",
      "epicgames.com", "fortnite.com",
      "battle.net", "activision.com", "callofduty.com",
      "ea.com", "help.ea.com", "easports.com", "origin.com",
      "ubisoft.com", "rainbow6.com",
      "apexlegends.com", "battlefield.com",
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

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");

    const primary = normalizeDigits(u.searchParams.get("primary") || "");
    const secondary = normalizeDigits(u.searchParams.get("secondary") || "");

    // کانکارنسی
    const userConc = Number(normalizeDigits(u.searchParams.get("conc") || "8"));
    const CONCURRENCY = Number.isFinite(userConc)
      ? Math.max(1, Math.min(12, Math.floor(userConc)))
      : 8;

    // پارامترهای sampling (قابل تیون)
    const initialCount = 3;             // اول چند دامنه نمونه؟
    const maxCountBigGroups = 8;        // سقف تست برای گروه‌های بزرگ
    const goodAvgMsThreshold = 120;     // اگر sample عالی بود و avg <= این، قطع کن

    if (!primary || !isValidIPv4(primary)) return json(res, 400, { ok: false, error: "invalid_primary" });
    if (isPrivateIPv4(primary)) return json(res, 400, { ok: false, error: "private_primary" });

    if (secondary) {
      if (!isValidIPv4(secondary)) return json(res, 400, { ok: false, error: "invalid_secondary" });
      if (isPrivateIPv4(secondary)) return json(res, 400, { ok: false, error: "private_secondary" });
      if (secondary === primary) return json(res, 400, { ok: false, error: "same_dns" });
    }

    async function runGroupAdaptive(resolver, group) {
      const domains = group.domains;

      // گروه‌های کوچیک: همه
      const isSmall = domains.length <= 5;

      const maxCount = isSmall ? domains.length : Math.min(maxCountBigGroups, domains.length);

      // batch 1: initial sample
      const firstBatch = domains.slice(0, Math.min(initialCount, maxCount));
      const firstResults = await mapWithConcurrency(
        firstBatch,
        CONCURRENCY,
        (d) => resolveOnce(resolver, d)
      );

      const decision = decideSampling(domains, firstResults, {
        initialCount: Math.min(initialCount, maxCount),
        maxCount,
        goodAvgMsThreshold,
      });

      let testedResults = firstResults;

      if (decision.action === "continue") {
        const targetCount = decision.targetCount;
        const remaining = domains.slice(firstResults.length, targetCount);

        if (remaining.length) {
          const moreResults = await mapWithConcurrency(
            remaining,
            CONCURRENCY,
            (d) => resolveOnce(resolver, d)
          );
          testedResults = testedResults.concat(moreResults);
        }
      }

      const okCount = testedResults.filter(x => x.ok).length;
      const totalTested = testedResults.length;

      return {
        key: group.key,
        title: group.title,

        // دامنه‌هایی که واقعاً تست شدند
        tested: totalTested,
        okCount,
        avgMs: avgMs(testedResults),
        status: groupStatus(testedResults),

        // برای UI/دیباگ: بگو sampling چی کار کرد
        sampling: {
          enabled: !isSmall,
          decision: decision.reason,
          initialCount: Math.min(initialCount, maxCount),
          maxCount,
          totalAvailable: domains.length,
          skipped: Math.max(0, domains.length - totalTested),
        },

        items: testedResults,
      };
    }

    async function runForDns(serverIp) {
      const resolver = new Resolver();
      resolver.setServers([serverIp]);

      const groups = [];
      for (const g of GROUPS) {
        const result = await runGroupAdaptive(resolver, g);
        groups.push(result);
      }

      return {
        groups,
        dnsOk: !allFailed(groups),
        concurrency: CONCURRENCY,
        sampling: {
          initialCount,
          maxCountBigGroups,
          goodAvgMsThreshold,
        }
      };
    }

    const primaryResult = await runForDns(primary);
    const out = { ok: true, results: { primary: primaryResult } };

    if (secondary) {
      const secondaryResult = await runForDns(secondary);
      out.results.secondary = secondaryResult;
    }

    return json(res, 200, out);
  } catch (e) {
    return json(res, 500, { ok: false, error: "server_error" });
  }
}
