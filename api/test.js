import dns from "dns";

const { Resolver } = dns.promises;

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

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

function isPrivateIPv4(ip) {
  const [a,b] = ip.split(".").map(Number);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

// تایم‌اوت برای هر دامنه (ms) تا تست گیر نکنه
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

const GROUPS = [
  {
    key: "xbox",
    title: "سرورهای Xbox",
    domains: [
      "xbox.com",
      "xboxlive.com",
      "login.live.com",
      "account.microsoft.com",
      "storeedgefd.dsx.mp.microsoft.com",
      "xsts.auth.xboxlive.com"
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
      "ea.com","help.ea.com","easports.com","origin.com",
      "apexlegends.com","battlefield.com",
      "callofduty.com","activision.com","battle.net",
      "epicgames.com","fortnite.com",
      "riotgames.com","playvalorant.com","leagueoflegends.com",
      "steampowered.com","steamcommunity.com",
      "ubisoft.com","rainbow6.com",
    ],
  },
  {
    key: "international",
    title: "سرورهای بین‌المللی",
    domains: ["google.com","cloudflare.com","github.com","microsoft.com","amazon.com"],
  },
  {
    key: "internal",
    title: "سرورهای داخلی",
    domains: ["aparat.com","digikala.com","divar.ir","rubika.ir"],
  },
];

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");
    const primary = normalizeDigits(u.searchParams.get("primary") || "");
    const secondary = normalizeDigits(u.searchParams.get("secondary") || "");

    if (!primary || !isValidIPv4(primary)) return json(res, 400, { ok:false, error:"invalid_primary" });
    if (isPrivateIPv4(primary)) return json(res, 400, { ok:false, error:"private_primary" });

    if (secondary) {
      if (!isValidIPv4(secondary)) return json(res, 400, { ok:false, error:"invalid_secondary" });
      if (isPrivateIPv4(secondary)) return json(res, 400, { ok:false, error:"private_secondary" });
      if (secondary === primary) return json(res, 400, { ok:false, error:"same_dns" });
    }

    async function runForDns(serverIp) {
      const resolver = new Resolver();
      resolver.setServers([serverIp]);

      const groups = [];
      for (const g of GROUPS) {
        const items = [];
        for (const d of g.domains) {
          items.push(await resolveOnce(resolver, d));
        }

        const okCount = items.filter(x=>x.ok).length;
        const total = items.length;
        const avg = avgMs(items);
        const status = groupStatus(items);

        groups.push({
          key: g.key,
          title: g.title,
          total,
          okCount,
          avgMs: avg,
          status,
          items
        });
      }

      return { groups, dnsOk: !allFailed(groups) };
    }

    const primaryResult = await runForDns(primary);
    const out = { ok:true, results: { primary: primaryResult } };

    if (secondary) {
      const secondaryResult = await runForDns(secondary);
      out.results.secondary = secondaryResult;
    }

    return json(res, 200, out);

  } catch (e) {
    return json(res, 500, { ok:false, error:"server_error" });
  }
}
