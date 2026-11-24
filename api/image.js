// Just the Facts — one photo for a fact, a report or an answer.
// The page tries Wikipedia's own photo first. When that has nothing, it asks here:
//   1) Wikimedia Commons (public domain / CC0 only), then
//   2) the best photo from a Google Images search (Serper, needs SERPER_API_KEY in Vercel), credited with
//      its website and a link back. Each web photo gets a quick AI look first: family-safe, really shows
//      the subject, not a watermarked stock image or a page of text.
// GET /api/image?q=search words
const UA = "JustTheFacts/1.0 (educational site; nusparklearnwow.com)";
const BAD = /\b(nude|naked|nsfw|sex|erotic|corpse|dead body|gore|blood|weapon|gun|execution|war crime|torture|skull|drug)\b/i;
// A report asking for a photo should not get a map, logo or chart, unless it asked for one.
const NOT_A_PHOTO = /\b(map|topo|topography|topographic|relief|satellite|landsat|locator|location|diagram|logo|chart|graph|flag|coat of arms|icon|floor plan|blueprint|seal|emblem|signature|stamp)\b/i;
const wasShown = (seen, src) => !!(seen && src && seen.has(String(src).slice(-80)));
// Wikimedia's own wording for an unnamed author is tidied into a plain name
const tidyCredit = s => String(s || "").replace(/no machine-readable author provided\.?/i, "").replace(/\s*assumed \(based on copyright claims\)\.?/i, "").replace(/\s+/g, " ").trim();
const strip = s => String(s || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 90);
const get = (url, headers) => fetch(url, { headers: { "User-Agent": UA, ...(headers || {}) }, signal: AbortSignal.timeout(8000) });

// the meaningful words of the search, used to check a result is really about the subject
const STOP = new Set(["the", "and", "for", "with", "from", "photo", "photograph", "picture", "image", "old", "early", "modern", "vintage", "historic", "historical", "famous",
  "portrait", "painting", "sculpture", "statue", "drawing", "engraving", "artwork", "print", "illustration", "original", "museum"]);
const keywords = q => q.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !STOP.has(w));
function about(q, text) {
  const words = keywords(q); if (!words.length) return true;
  const hay = String(text || "").toLowerCase();
  return words.some(w => hay.includes(w) || hay.includes(w.replace(/s$/, "")));
}
const wrongKind = (q, title) => NOT_A_PHOTO.test(title) && !NOT_A_PHOTO.test(q);
const strip2 = s => String(s || "").replace(/<[^>]*>/g, " ").slice(0, 600);
// Stricter check for the biggest source: the first search word (the main subject) must be in the photo's
// title or description, and so must most of the other words. Keeps out photos that only mention the subject in passing.
function onSubject(q, title, desc) {
  const words = keywords(q); if (!words.length) return true;
  const hay = (title + " " + desc).toLowerCase();
  const has = w => hay.includes(w) || hay.includes(w.replace(/s$/, ""));
  if (!has(words[0])) return false;
  const found = words.filter(has).length;
  return found === words.length || (words.length >= 4 && found >= words.length - 1);
}

async function fromCommons(q, quoted, seen) {
  const url = "https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search"
    + "&gsrnamespace=6&gsrlimit=15&gsrsearch=" + encodeURIComponent(q + " filetype:bitmap")
    + "&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=900";
  const r = await get(url);
  if (!r.ok) throw new Error("HTTP " + r.status);
  const pages = Object.values((await r.json()).query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  for (const p of pages) {
    const info = p.imageinfo?.[0]; const m = info?.extmetadata || {};
    const lic = (m.LicenseShortName?.value || "") + " " + (m.License?.value || "");
    if (!info || !/public domain|\bpd\b|cc0|pdm/i.test(lic)) continue;
    if ((info.width || 0) < 500) continue;   // too small to see well on a phone or for older eyes
    const file = p.title.replace(/^File:/, "");
    const title = file.replace(/\.[a-z]+$/i, "").replace(/_/g, " ");
    if (BAD.test(title) || BAD.test(m.ImageDescription?.value || "")) continue;
    if (!/\.(jpe?g|tiff?|webp)$/i.test(file) && !NOT_A_PHOTO.test(q)) continue;   // drawings and maps are mostly .png/.gif
    if (wrongKind(q, title)) continue;
    if (!onSubject(q, title, strip2(m.ImageDescription?.value) + " " + strip2(m.ObjectName?.value))) continue;
    if (wasShown(seen, info.thumburl || info.url)) continue;   // "Show another photo" skips the ones already shown
    return { src: info.thumburl || info.url, title: strip(title), credit: strip(tidyCredit(String(m.Artist?.value || "").replace(/<[^>]*>/g, " "))) || "Unknown",
      license: /cc0/i.test(lic) ? "CC0" : "Public domain", source: "Wikimedia Commons", link: info.descriptionurl };
  }
  return null;
}

// Google Images through Serper. Stock-photo sellers and social sites are skipped (watermarks, broken links).
const SKIP_SITES = /(fbsbx|facebook|instagram|tiktok|twitter|x\.com|threads\.net|pinterest|pinimg|shutterstock|alamy|gettyimages|istockphoto|dreamstime|depositphotos|123rf|stock\.adobe|agefotostock|bigstock|vectorstock|freepik|ebay|amazon|etsy|walmart|redbubble|teepublic)/i;
async function serper(q, safe) {
  const key = String(process.env.SERPER_API_KEY || "").trim();
  return fetch("https://google.serper.dev/images", { method: "POST", signal: AbortSignal.timeout(8000),
    headers: { "X-API-KEY": key, "content-type": "application/json" },
    body: JSON.stringify(safe ? { q, num: 20, gl: "us", hl: "en", safe: "active" } : { q, num: 20, gl: "us", hl: "en" }) });
}
// A quick AI look at one web photo before it is shown. The server downloads Google's small preview copy
// of the photo and sends it to the AI, which is more reliable than asking the AI to open other websites.
let lastWebNote = "";
async function looksRight(q, it) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) return "no anthropic key";
  try {
    const pic = await fetch(it.thumbnailUrl || it.imageUrl, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(6000) });
    if (!pic.ok) return "preview " + pic.status;
    let type = (pic.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    if (!/^image\/(jpeg|png|gif|webp)$/.test(type)) type = "image/jpeg";
    const raw = Buffer.from(await pic.arrayBuffer());
    if (raw.length > 4500000) return "too big";   // a very large archive file is let through unchecked
    const data = raw.toString("base64");
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: AbortSignal.timeout(12000),
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 1024, messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: type, data } },
        { type: "text", text: `This picture would appear on a family learning website; readers include children. The picture is meant to show: "${q}". Answer YES only if it is a clear photograph (or a still or promotional photo from a show or film, or the artwork, drawing or museum object itself when that is the subject) that really shows that subject, not just something with the same name or colors, is family-safe, and is not mostly text, a meme, a collage of many small pictures, or covered with a watermark. Otherwise answer NO. One word.` }
      ] }] }) });
    if (!r.ok) { const t = await r.text().catch(() => ""); return "ai " + r.status + " " + t.slice(0, 80); }
    const d = await r.json();
    const ans = (d.content || []).map(c => c.text || "").join("").trim();
    return /^\W*yes/i.test(ans) ? true : "ai said [" + ans.slice(0, 20) + "] stop " + d.stop_reason;
  } catch (e) { return "error " + String(e.message || e).slice(0, 60); }
}
async function fromWeb(q, quoted, seen) {
  lastWebNote = "";
  if (!String(process.env.SERPER_API_KEY || "").trim()) return null;
  const gq = quoted || q;
  let r = await serper(gq, true);
  // Serper's free plan refuses quotation marks; then the same words go without them
  if (r.status === 400 && quoted) r = await serper(quoted.replace(/"/g, ""), true);
  if (r.status === 400) r = await serper(quoted ? quoted.replace(/"/g, "") : q, false);
  // an exact-name search that finds nothing tries again without the quotes
  if (r.ok && quoted) { const j = await r.clone().json().catch(() => ({})); if (!(j.images || []).length) r = await serper(quoted.replace(/"/g, ""), true); }
  if (!r.ok) { const why = await r.text().catch(() => ""); throw new Error("HTTP " + r.status + " " + why.replace(/\s+/g, " ").slice(0, 60)); }
  const all = (await r.json()).images || [];
  const list = all.filter(it => it.imageUrl && /^https:\/\//i.test(it.imageUrl)
    && !/\.(svg|gif)(\?|$)/i.test(it.imageUrl) && !SKIP_SITES.test((it.domain || "") + " " + (it.link || "")) && !/(fbsbx|cdninstagram|pinimg|tiktokcdn|twimg)/i.test(it.imageUrl)
    && (it.imageWidth || 0) >= 450 && !BAD.test(it.title || "") && !wrongKind(q, it.title || "") && !wasShown(seen, it.imageUrl)).slice(0, 4);
  if (!list.length) { lastWebNote = all.length + " results, none passed the filters"; return null; }
  const ok = await Promise.all(list.map(it => looksRight(quoted || q, it)));
  lastWebNote = list.map((it, i) => (it.domain || "") + ": " + (ok[i] === true ? "yes" : ok[i])).join(" ; ");
  const it = list[ok.indexOf(true)]; if (!it) return null;
  const site = strip(it.source || it.domain || "").replace(/^www\./, "");
  return { src: it.imageUrl, thumb: it.thumbnailUrl || "", title: strip(it.title), credit: site || "the web", license: "From the web",
    source: site || "the web", link: it.link || "", web: true };
}

const cache = new Map();
module.exports = async (req, res) => {
  if (!(await require("./_lwgate")(req, res, "just-the-facts"))) return;
  if (!allowedRequest(req)) return blockRequest(res);
  const u = new URL(req.url, "http://x");
  const q = String(u.searchParams.get("q") || "").replace(/[^\w\s'-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  if (u.searchParams.get("check") === "1") return res.json({ serper_key_set: !!String(process.env.SERPER_API_KEY || "").trim(), anthropic_key_set: !!process.env.ANTHROPIC_API_KEY });
  if (!q || BAD.test(q)) return res.json({ image: null });
  if (cache.has(q)) return res.json({ image: cache.get(q) });
  const notes = [];
  let image = null;
  for (const [name, fn] of [["commons", fromCommons], ["web", fromWeb]]) {
    try { image = await fn(q, null, null); } catch (e) { notes.push(name + ": " + e.message); }
    if (name === "web" && lastWebNote) notes.push("web: " + lastWebNote);
    if (image) break;
  }
  if (cache.size > 300) cache.clear();
  cache.set(q, image);
  res.setHeader("Cache-Control", "public, max-age=86400");
  return res.json({ image, notes });
};

// ---------- website lock ----------
function allowedRequest(req) {
  if (String(process.env.LOCK_OFF || "") === "1") return true;
  const sites = ["nusparkpublishing.com", "nusparkmarketing.com", "nusparklearnwow.com"]
    .concat(String(process.env.ALLOWED_SITES || "").split(",").map(s => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean));
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").toLowerCase().split(":")[0];
  const ok = u => {
    try { const h = new URL(u).hostname.toLowerCase(); return h === host || h === "localhost" || h === "127.0.0.1" || sites.some(d => h === d || h.endsWith("." + d)); }
    catch (e) { return false; }
  };
  const origin = req.headers.origin, ref = req.headers.referer || req.headers.referrer;
  if (origin && origin !== "null") return ok(origin);
  if (ref) return ok(ref);
  return req.method === "GET";
}
function blockRequest(res) {
  res.statusCode = 403;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: "not_allowed", message: "This tool only works on NuSpark websites." }));
}
