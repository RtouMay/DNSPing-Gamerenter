function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function cleanUrl(url) {
  if (!url) return "";
  let v = String(url).trim();
  if (!v) return "";
  if (v.startsWith("//")) v = `https:${v}`;
  if (v.startsWith("/")) v = `https://gamerenter.ir${v}`;
  return v;
}

function collectSlidesFromHtml(html) {
  const directMatches = [];
  const patterns = [
    /(?:data-lazy-src|data-src|src)=["']([^"']+)["']/gi,
    /"image"\s*:\s*"([^"\\]+)"/gi,
    /"backgroundImage"\s*:\s*"([^"\\]+)"/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      directMatches.push(cleanUrl(match[1]));
    }
  }

  const filtered = directMatches.filter((url) => {
    if (!url) return false;
    if (!/^https?:\/\//i.test(url)) return false;
    const low = url.toLowerCase();
    const isImage = /\.(jpg|jpeg|png|webp|gif|avif)(\?|$)/.test(low);
    const likelySlider = /(slider|banner|hero|uploads|elementor)/.test(low);
    return isImage && likelySlider;
  });

  const uniq = [...new Set(filtered)].slice(0, 8);
  return uniq.map((image, idx) => ({
    image,
    title: `اسلایدر ${idx + 1} گیم‌رنتر`,
    subtitle: "دریافت‌شده از صفحه اصلی Gamerenter",
    link: "https://gamerenter.ir/",
  }));
}

export default async function handler(req, res) {
  try {
    const r = await fetch("https://gamerenter.ir/", {
      headers: {
        "User-Agent": "Mozilla/5.0 DNSPing Slider Fetcher",
        "Accept-Language": "fa-IR,fa;q=0.9,en;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(7000),
    });

    if (!r.ok) {
      return json(res, 502, { ok: false, error: "upstream_error", status: r.status });
    }

    const html = await r.text();
    const slides = collectSlidesFromHtml(html);

    if (!slides.length) {
      return json(res, 200, { ok: false, error: "slides_not_found", slides: [] });
    }

    return json(res, 200, { ok: true, slides });
  } catch (error) {
    return json(res, 200, {
      ok: false,
      error: "fetch_failed",
      message: error?.message || "unknown_error",
      slides: [],
    });
  }
}
