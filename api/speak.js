// Just the Facts — the three host voices (ElevenLabs text-to-speech)
// Env: ELEVENLABS_API_KEY (without it the page falls back to the browser's built-in voices)
// Optional voice swaps in Vercel: VOICE_MAX, VOICE_DOT, VOICE_PROF, ELEVENLABS_MODEL
// Only the hosts' own lines are sent here. No visitor audio ever reaches this server.

const env = k => process.env[k];
const VOICES = {
  max: env("VOICE_MAX") || "34lPwSZ54D8fWbX1aHzk",   // Guy - upbeat TV/radio announcer
  dot: env("VOICE_DOT") || "r1KmysJdVYZjJCm4mL3b",   // Jessica - playful, bright, warm
  prof: env("VOICE_PROF") || "pqHfZKP75CvOlQylNhV4"  // Bill - wise, mature, calm
};
// Each host gets their own delivery: lower stability = more expressive.
const STYLE = {
  max: { stability: 0.28, style: 0.75, speed: 1.08 },
  dot: { stability: 0.32, style: 0.65, speed: 1.06 },
  prof: { stability: 0.6, style: 0.25, speed: 0.97 }
};
const cache = new Map();

module.exports = async (req, res) => {
  if (!(await require("./_lwgate")(req, res, "just-the-facts"))) return;
  if (!allowedRequest(req)) return blockRequest(res);
  const key = process.env.ELEVENLABS_API_KEY;
  if (req.method === "GET") {
    const out = { api_key_set: !!key, voices: VOICES };
    if (key) {
      try {
        const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICES.prof}?output_format=mp3_22050_32`, {
          method: "POST", headers: { "xi-api-key": key, "content-type": "application/json" },
          body: JSON.stringify({ text: "Hi.", model_id: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5" })
        });
        out.voice = r.ok ? "working" : `error ${r.status}: ${(await r.text()).slice(0, 200)}`;
      } catch (e) { out.voice = "error: " + e.message; }
    }
    return res.json(out);
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!key) return res.status(501).json({ error: "voice_off" });
  const b = req.body || {};
  const host = VOICES[b.host] ? b.host : "prof";
  const text = String(b.text || "").replace(/\s+/g, " ").trim().slice(0, 1200);
  if (!text) return res.status(400).json({ error: "empty" });
  const ck = host + "|" + text;
  if (cache.has(ck)) return res.json(cache.get(ck));
  const st = STYLE[host];
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICES[host]}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({
        text, model_id: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
        voice_settings: { stability: st.stability, similarity_boost: 0.8, style: st.style, speed: st.speed, use_speaker_boost: true }
      })
    });
    if (!r.ok) return res.status(502).json({ error: "voice_failed" });
    const out = { audio: Buffer.from(await r.arrayBuffer()).toString("base64") };
    if (cache.size > 150) cache.clear();
    cache.set(ck, out);
    return res.json(out);
  } catch (e) {
    return res.status(502).json({ error: "voice_failed" });
  }
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
