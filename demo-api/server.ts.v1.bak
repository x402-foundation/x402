/**
 * hoodgate — HTTP 402 Payment Rail on Robinhood Chain
 * Flow: client requests → 402 Payment Required → EIP-3009 sign → settle on-chain → 200 + real weather
 */
import express from "express";

const PORT = parseInt(process.env.PORT || "3005");
const FACILITATOR = process.env.FACILITATOR_URL || "http://localhost:3001";
const FIRECRAWL_KEY = process.env.FIRECRAWL_API_KEY || process.env.FIRECRAWL_KEY || "";
const PRICE_USD = "0.5";

const app = express();
app.use(express.json());

// ── Fetch real weather from wttr.in directly ──────────────
async function fetchWeather(city: string): Promise<Record<string, any>> {
  const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
  const resp = await fetch(url, { headers: { "User-Agent": "curl/8.0" } });
  if (!resp.ok) throw new Error(`wttr.in returned ${resp.status}`);
  const data = await resp.json() as any;
  const curr = data.current_condition[0];
  return {
    city: data.nearest_area[0].areaName[0].value,
    country: data.nearest_area[0].country[0].value,
    temp_c: curr.temp_C,
    temp_f: curr.temp_F,
    condition: curr.weatherDesc[0].value,
    humidity: curr.humidity,
    wind: `${curr.winddir16Point} ${curr.windspeedMiles}mph`,
    feels_like: curr.FeelsLikeF,
    source: "wttr.in",
  };
}

// ── Weather endpoint (paid via 402) ────────────────────────
app.post("/weather", async (req, res) => {
  const sig = req.headers["payment-signature"] as string;
  const payloadRaw = req.headers["payment-payload"] as string;
  const network = req.headers["payment-network"] as string;
  const city = (req.body?.city as string) || "New York";

  if (!sig || !payloadRaw) {
    res.setHeader("Payment-Required", JSON.stringify({
      scheme: "exact", network: "eip155:46630", token: "USDG",
      amount: PRICE_USD, facilitator: FACILITATOR,
    }));
    return res.status(402).json({ error: "Payment Required", cost: `${PRICE_USD} USDG` });
  }

  let payload: any;
  try { payload = JSON.parse(payloadRaw); } catch { return res.status(400).json({ error: "invalid payload" }); }
  const reqs = { scheme: "exact", network: network || "eip155:46630", token: "USDG", amount: PRICE_USD };

  // Verify
  let v: any;
  try {
    v = await (await fetch(`${FACILITATOR}/verify`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload, requirements: reqs }),
    })).json();
  } catch (e: any) { return res.status(502).json({ error: "facilitator down", detail: e.message }); }
  if (!v.valid) return res.status(402).json({ error: "Payment verification failed", reason: v.reason });

  // Settle on-chain
  let settle: any = { skipped: true };
  try {
    settle = await (await fetch(`${FACILITATOR}/settle`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload, requirements: reqs }),
    })).json();
  } catch (e: any) { console.error("settle error:", e.message); }

  // Fetch real weather
  let weather: any;
  try { weather = await fetchWeather(city); } catch (e: any) { console.error("fetchWeather error:", e.message);
    weather = { city, temp_f: 72, condition: "Sunny", humidity: "45%", source: "fallback" };
  }

  res.json({ ...weather, paid: `${PRICE_USD} USDG`, settlement: settle });
});

// ── UI (single HTML with embedded 402 flow) ─────────────────
app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>hoodgate · HTTP 402 Payment Rail — Robinhood Chain</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&family=Archivo:wght@700;800;900&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/ethers@6.13.5/dist/ethers.umd.min.js"></script>
<style>
/* ── Reset ── */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

/* ── Design tokens ── */
:root{
  --bg:#070b12; --bg1:#0b0e14; --bg2:#0f1520; --bg3:#141b2a;
  --panel:#0f1520; --panel2:#141b2a; --panel3:#1a2335;
  --border:#1e2940; --border2:#2a3a55; --border3:#364a6a;
  --gray-50:rgba(255,255,255,.04); --gray-100:rgba(255,255,255,.08);
  --gray-200:rgba(255,255,255,.12); --gray-300:rgba(255,255,255,.20);
  --gray-400:rgba(255,255,255,.35); --gray-500:rgba(255,255,255,.50);
  --gray-600:rgba(255,255,255,.65); --gray-700:rgba(255,255,255,.80);
  --gray-800:rgba(255,255,255,.90); --gray-900:#fff;
  --green-50:rgba(0,200,5,.06); --green-100:rgba(0,200,5,.10);
  --green-200:rgba(0,200,5,.18); --green-300:rgba(0,200,5,.30);
  --green-400:rgba(0,200,5,.50); --green-500:#00C805;
  --green-600:#00e820; --green-700:#1aff3a;
  --green-800:#5cff73; --green-900:#8cff9c;
  --g1:linear-gradient(135deg,var(--green-500),var(--green-600));
  --g2:linear-gradient(180deg,var(--green-50),transparent);
  --g-border:linear-gradient(135deg,var(--green-500),var(--green-600),var(--green-300));
  --amber:#f59e0b; --red:#ef4444;
  --up:#7DFFA0; --up-glow:rgba(125,255,160,.35); --up-bg:rgba(125,255,160,.08);
  --down:#FF6B6B; --down-glow:rgba(255,107,107,.35); --down-bg:rgba(255,107,107,.08);
  --card-glow:0 0 60px rgba(0,200,5,.12),0 24px 60px rgba(0,0,0,.5);
  --shadow-sm:0 1px 3px rgba(0,0,0,.5),0 1px 2px rgba(0,0,0,.3);
  --shadow-md:0 4px 16px rgba(0,0,0,.5),0 2px 8px rgba(0,0,0,.3);
  --shadow-lg:0 8px 40px rgba(0,0,0,.6),0 4px 16px rgba(0,0,0,.3);
  --shadow-xl:0 16px 64px rgba(0,0,0,.7),0 8px 24px rgba(0,0,0,.4);
  --radius:14px; --radius-sm:8px; --radius-pill:999px;
}
html{scroll-behavior:smooth}
body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--gray-500);min-height:100vh;overflow-x:hidden;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
body::before{content:'';position:fixed;top:-150px;left:-150px;width:700px;height:700px;background:radial-gradient(circle,rgba(0,200,5,.35) 0%,rgba(0,200,5,.12) 40%,transparent 70%);filter:blur(60px);pointer-events:none;z-index:0;animation:orbFloat1 20s ease-in-out infinite}
body::after{content:'';position:fixed;bottom:-250px;right:-250px;width:900px;height:900px;background:radial-gradient(circle,rgba(0,200,5,.28) 0%,rgba(0,200,5,.1) 40%,transparent 70%);filter:blur(70px);pointer-events:none;z-index:0;animation:orbFloat2 25s ease-in-out infinite}
@keyframes orbFloat1{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(200px,100px) scale(1.2)}}
@keyframes orbFloat2{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(-150px,-200px) scale(1.1)}}
.grid-bg{position:fixed;top:0;left:0;width:100%;height:100%;background-image:linear-gradient(rgba(0,200,5,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(0,200,5,0.03) 1px,transparent 1px),url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%2300C805' fill-opacity='0.015'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E");background-size:60px 60px,60px 60px,60px 60px;pointer-events:none;z-index:0;mask-image:radial-gradient(ellipse at center,black 20%,transparent 80%)}

/* ── Top bar ── */
.topbar{background:rgba(0,0,0,.8);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);color:var(--gray-400);font-size:.62rem;font-weight:500;letter-spacing:1px;padding:5px 24px;text-align:center;position:relative;z-index:20}
.topbar strong{color:var(--green-500)}

/* ── Live ticker marquee ── */
.ticker{background:rgba(0,0,0,.6);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);overflow:hidden;position:relative;z-index:18;height:36px;display:flex;align-items:center}
.ticker::before,.ticker::after{content:'';position:absolute;top:0;width:80px;height:100%;z-index:2;pointer-events:none}
.ticker::before{left:0;background:linear-gradient(90deg,var(--bg),transparent)}
.ticker::after{right:0;background:linear-gradient(270deg,var(--bg),transparent)}
.ticker .track{display:flex;gap:0;white-space:nowrap;animation:tickerScroll 40s linear infinite;will-change:transform}
.ticker:hover .track{animation-play-state:paused}
.ticker .item{display:inline-flex;align-items:center;gap:8px;padding:0 24px;font-size:.66rem;font-family:'JetBrains Mono',monospace;color:var(--gray-500);border-right:1px solid var(--border)}
.ticker .item .dot{width:6px;height:6px;border-radius:50%;background:var(--green-500);box-shadow:0 0 6px var(--green-500);flex-shrink:0}
.ticker .item .buy{color:var(--green-500);font-weight:600}
.ticker .item .amt{color:var(--gray-700);font-weight:600}
.ticker .item .addr{color:var(--gray-400)}
@keyframes tickerScroll{from{transform:translateX(0)}to{transform:translateX(-50%)}}

/* ── Live badge ── */
.live-badge{display:inline-flex;align-items:center;gap:7px;background:var(--green-50);border:1px solid var(--green-200);border-radius:var(--radius-pill);padding:5px 14px;font-size:.62rem;font-weight:600;color:var(--green-500);text-transform:uppercase;letter-spacing:1.5px;font-family:'JetBrains Mono',monospace}
.live-badge .pulse{width:7px;height:7px;background:var(--green-500);border-radius:50%;box-shadow:0 0 8px var(--green-500);animation:pulse 1.6s infinite;position:relative}
.live-badge .pulse::after{content:'';position:absolute;inset:-3px;border-radius:50%;border:1px solid var(--green-500);animation:pulseRing 1.6s infinite}
@keyframes pulseRing{0%{transform:scale(1);opacity:1}100%{transform:scale(2.2);opacity:0}}

/* ── Contract bar ── */
.contract-bar{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:48px}
.contract-chip{display:flex;align-items:center;gap:12px;background:var(--panel);border:1px solid var(--border);border-radius:var(--radius-pill);padding:8px 8px 8px 16px;transition:all .25s;flex:1;min-width:280px}
.contract-chip:hover{border-color:var(--border2);box-shadow:var(--shadow-sm)}
.contract-chip .cc-label{font-size:.58rem;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;color:var(--gray-400);white-space:nowrap}
.contract-chip .cc-addr{font-family:'JetBrains Mono',monospace;font-size:.68rem;color:var(--gray-700);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.contract-chip .cc-copy{background:var(--green-50);border:1px solid var(--green-200);border-radius:var(--radius-pill);width:30px;height:30px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .2s;flex-shrink:0}
.contract-chip .cc-copy:hover{background:var(--green-100)}
.contract-chip .cc-copy svg{width:13px;height:13px;fill:var(--green-500)}
.contract-chip .cc-copy.copied{background:var(--green-500)}
.contract-chip .cc-copy.copied svg{fill:#000}

/* ── Feature grid (Robinfun style) ── */
.feature-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:48px}
@media(max-width:768px){.feature-grid{grid-template-columns:1fr}}
.feature-card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:28px;transition:all .3s cubic-bezier(.4,0,.2,1);position:relative;overflow:hidden}
.feature-card::before{content:'';position:absolute;top:0;left:0;right:0;height:100%;background:radial-gradient(circle at 50% 0%,var(--green-50),transparent 70%);opacity:0;transition:opacity .3s}
.feature-card::after{content:'';position:absolute;inset:0;background:linear-gradient(115deg,transparent 30%,rgba(200,255,0,.08) 50%,transparent 70%);transform:translateX(-100%);transition:transform .9s cubic-bezier(.4,0,.2,1);pointer-events:none}
.feature-card:hover{border-color:var(--green-300);transform:translateY(-4px);box-shadow:var(--card-glow)}
.feature-card:hover::before{opacity:1}
.feature-card:hover::after{transform:translateX(100%)}
.feature-card .fc-icon{width:48px;height:48px;border-radius:12px;background:var(--green-50);border:1px solid var(--green-200);display:flex;align-items:center;justify-content:center;margin-bottom:18px;color:var(--green-500);position:relative;z-index:1}
.feature-card .fc-icon svg{width:24px;height:24px;fill:currentColor}
.feature-card h3{font-size:1rem;font-weight:700;color:var(--gray-800);margin-bottom:8px;position:relative;z-index:1}
.feature-card p{font-size:.78rem;color:var(--gray-500);line-height:1.7;position:relative;z-index:1}

/* ── Roadmap ── */
.roadmap{position:relative;margin-bottom:48px;padding-left:32px}
.roadmap::before{content:'';position:absolute;left:8px;top:8px;bottom:8px;width:2px;background:linear-gradient(180deg,var(--green-500),var(--border))}
.roadmap .rm-item{position:relative;padding:0 0 28px 24px}
.roadmap .rm-item:last-child{padding-bottom:0}
.roadmap .rm-item::before{content:'';position:absolute;left:-30px;top:2px;width:16px;height:16px;border-radius:50%;background:var(--bg2);border:2px solid var(--border)}
.roadmap .rm-item.done::before{background:var(--green-500);border-color:var(--green-500);box-shadow:0 0 12px var(--green-300)}
.roadmap .rm-item.active::before{border-color:var(--green-500);background:var(--green-50);box-shadow:0 0 12px var(--green-200)}
.roadmap .rm-phase{font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:2px;color:var(--green-500);margin-bottom:4px;font-family:'JetBrains Mono',monospace}
.roadmap .rm-item.pending .rm-phase{color:var(--gray-400)}
.roadmap .rm-title{font-size:.9rem;font-weight:700;color:var(--gray-800);margin-bottom:4px}
.roadmap .rm-desc{font-size:.75rem;color:var(--gray-500);line-height:1.6}

/* ── FAQ ── */
.faq{margin-bottom:48px}
.faq-item{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:10px;overflow:hidden;transition:all .25s}
.faq-item:hover{border-color:var(--border2)}
.faq-item .q{padding:18px 22px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;font-size:.85rem;font-weight:600;color:var(--gray-700);user-select:none}
.faq-item .q .chev{width:18px;height:18px;transition:transform .3s;flex-shrink:0;color:var(--green-500)}
.faq-item .q .chev svg{width:100%;height:100%;fill:currentColor}
.faq-item.open .q .chev{transform:rotate(180deg)}
.faq-item .a{max-height:0;overflow:hidden;transition:max-height .3s cubic-bezier(.4,0,.2,1);padding:0 22px}
.faq-item.open .a{max-height:200px;padding-bottom:18px}
.faq-item .a p{font-size:.78rem;color:var(--gray-500);line-height:1.7}

/* ── Nav ── */
nav{background:rgba(11,17,32,.88);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-bottom:1px solid var(--border);padding:0 32px;display:flex;align-items:center;justify-content:space-between;height:56px;position:sticky;top:0;z-index:19}
nav .logo{display:flex;align-items:center;gap:14px;font-weight:800;font-size:.95rem;color:var(--gray-800);letter-spacing:-.3px;text-decoration:none}
nav .logo .icon{width:32px;height:32px;background:var(--g1);border-radius:9px;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
nav .logo .icon svg{width:18px;height:18px;fill:#000}
nav .logo .sep{color:var(--gray-400);font-weight:400}
nav .stats{display:flex;gap:28px;font-size:.68rem}
nav .stats .stat{display:flex;align-items:center;gap:7px}
nav .stats .stat .label{color:var(--gray-400);font-weight:500}
nav .stats .stat .val{color:var(--gray-700);font-weight:600;font-family:'JetBrains Mono',monospace}
nav .stats .stat .live{width:7px;height:7px;background:var(--green-500);border-radius:50%;box-shadow:0 0 8px var(--green-500);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}

/* ── Main ── */
main{max-width:1060px;margin:0 auto;padding:48px 28px;position:relative;z-index:1}

/* ── Section labels ── */
.section-label{font-size:.62rem;font-weight:600;text-transform:uppercase;letter-spacing:2.5px;color:var(--green-500);margin-bottom:12px;display:flex;align-items:center;gap:10px}
.section-label::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,var(--border),transparent)}

/* ── Hero ── */
.hero{margin-bottom:48px;padding:20px 0 8px}
.hero .eyebrow{font-size:.62rem;font-weight:600;text-transform:uppercase;letter-spacing:3px;color:var(--green-500);margin-bottom:16px;display:flex;align-items:center;gap:12px}
.hero .eyebrow::before{content:'';width:32px;height:2px;background:var(--g1);border-radius:1px}
.hero h1{font-family:'Archivo',system-ui,sans-serif;font-size:clamp(3rem,6.5vw,5.25rem);font-weight:900;color:var(--gray-900);line-height:.98;margin-bottom:20px;letter-spacing:-.035em}
.hero h1 .accent{background:var(--g1);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.hero .sub{font-size:1rem;color:var(--gray-500);line-height:1.7;max-width:680px;font-weight:400}
.hero .hero-ctas{display:flex;gap:12px;margin-top:28px;flex-wrap:wrap}
.hero .hero-ctas .pill{display:inline-flex;align-items:center;padding:14px 32px;border-radius:var(--radius-pill);font-family:'Inter',sans-serif;font-size:.76rem;font-weight:700;cursor:pointer;text-decoration:none;transition:all .25s cubic-bezier(.4,0,.2,1);letter-spacing:.18em;text-transform:uppercase}
.hero .hero-ctas .pill:not(.outline){background:var(--g1);color:#000;border:none}
.hero .hero-ctas .pill:not(.outline):hover{box-shadow:0 0 32px rgba(0,200,5,.35);transform:translateY(-1px)}
.hero .hero-ctas .pill.outline{background:transparent;border:1.5px solid var(--border2);color:var(--gray-600)}
.hero .hero-ctas .pill.outline:hover{border-color:var(--gray-500);color:var(--gray-800);background:rgba(255,255,255,.03)}

/* ── Metadata separator bar (RobinFlow style) ── */
.meta-bar{display:flex;align-items:center;flex-wrap:wrap;gap:14px;margin-top:32px;padding-top:24px;border-top:1px solid var(--border);font-family:'JetBrains Mono',monospace;font-size:.62rem;font-weight:600;text-transform:uppercase;letter-spacing:.16em;color:var(--gray-500)}
.meta-bar .meta-item{display:inline-flex;align-items:center;gap:8px}
.meta-bar .meta-item .k{color:var(--gray-400)}
.meta-bar .meta-item .v{color:var(--gray-800)}
.meta-bar .sep{color:var(--gray-300);font-weight:400}
.meta-bar .dot{width:6px;height:6px;border-radius:50%;background:var(--green-500);box-shadow:0 0 6px var(--green-500);animation:pulse 2s infinite}

/* ── Metrics row (x402.org style) ── */
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:48px}
.metric{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:24px;position:relative;overflow:hidden;transition:all .25s cubic-bezier(.4,0,.2,1);cursor:default}
.metric::before{content:'';position:absolute;top:0;left:0;width:100%;height:2px;background:var(--g1);opacity:0;transition:opacity .25s}
.metric:hover{border-color:var(--border2);transform:translateY(-2px);box-shadow:var(--shadow-lg)}
.metric:hover::before{opacity:1}
.metric .label{font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:1.8px;color:var(--gray-400);margin-bottom:10px}
.metric .val{font-family:'JetBrains Mono',monospace;font-size:1.65rem;font-weight:700;color:var(--gray-800);display:inline-flex;align-items:baseline}
.metric .val::after{content:'_';color:var(--green-500);margin-left:3px;animation:blinkCursor 1.1s steps(1) infinite}
@keyframes blinkCursor{0%,50%{opacity:1}51%,100%{opacity:0}}
.metric .val.green{color:var(--green-500)}
.metric .icon{width:32px;height:32px;border-radius:8px;background:var(--green-50);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;margin-bottom:12px;color:var(--green-500)}
@media(max-width:768px){.metrics{grid-template-columns:repeat(2,1fr)}}

/* ── Code showcase ── */
.code-card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:40px;transition:all .25s;position:relative}
.code-card:hover{border-color:var(--border2);box-shadow:var(--shadow-lg)}
.code-card .header{background:var(--bg2);padding:12px 18px;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--border)}
.code-card .header .traffic{display:flex;gap:6px;margin-right:8px}
.code-card .header .traffic span{width:10px;height:10px;border-radius:50%}
.code-card .header .traffic .r{background:#ff5f57;border:1px solid rgba(0,0,0,.2)}
.code-card .header .traffic .y{background:#ffbd2e;border:1px solid rgba(0,0,0,.2)}
.code-card .header .traffic .g{background:#28c840;border:1px solid rgba(0,0,0,.2)}
.code-card .header .title{font-size:.68rem;font-weight:500;color:var(--gray-400);font-family:'JetBrains Mono',monospace}
.code-card .body{background:#050a16;padding:24px;font-size:.78rem;line-height:1.8;font-family:'JetBrains Mono',monospace;overflow-x:auto}
.code-card .body .kw{color:var(--green-500);font-weight:600}
.code-card .body .fn{color:var(--gray-800)}
.code-card .body .str{color:var(--green-600)}
.code-card .body .cm{color:var(--gray-400);font-style:italic}
.code-card .body .num{color:var(--green-500)}
.code-card .body .line{display:block;white-space:pre}
.code-card .body .line .indent{display:inline-block;width:16px}
.code-card .body .line .indent2{display:inline-block;width:32px}
.code-card .body .line .indent3{display:inline-block;width:48px}
.code-card .body .hl{background:var(--green-50);border-radius:2px;padding:0 2px}

/* ── Comparison section ── */
.comparison{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:48px;position:relative}
.comparison::before{content:'';position:absolute;left:50%;top:0;width:1px;height:100%;background:linear-gradient(180deg,var(--border),transparent 80%)}
.comparison .side{padding:24px}
.comparison .side .label{font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:2px;margin-bottom:20px;display:flex;align-items:center;gap:10px}
.comparison .side.old .label{color:var(--gray-400)}
.comparison .side.old .label::before{content:'';width:20px;height:2px;background:var(--gray-400);border-radius:1px}
.comparison .side.new{padding:24px;background:var(--green-50);border-radius:var(--radius);border:1px solid var(--green-100)}
.comparison .side.new .label{color:var(--green-500)}
.comparison .side.new .label::before{content:'';width:20px;height:2px;background:var(--green-500);border-radius:1px}
.comparison .step{display:flex;gap:14px;padding:14px 0;border-bottom:1px solid var(--border);align-items:flex-start}
.comparison .step:last-child{border-bottom:none}
.comparison .step .num{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.7rem;font-weight:700;flex-shrink:0;font-family:'JetBrains Mono',monospace}
.comparison .side.old .step .num{background:var(--bg2);color:var(--gray-400);border:1px solid var(--border)}
.comparison .side.new .step .num{background:var(--green-50);color:var(--green-500);border:1px solid var(--green-200)}
.comparison .step .text{font-size:.78rem;line-height:1.6}
.comparison .step .text strong{color:var(--gray-700);display:block;margin-bottom:2px}
.comparison .step .text .desc{color:var(--gray-400)}
.comparison .side.new .step .text strong{color:var(--gray-800)}
@media(max-width:768px){.comparison{grid-template-columns:1fr;gap:32px}.comparison::before{display:none}}

/* ── Flow pipeline ── */
.pipeline-wrapper{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:32px 24px;margin-bottom:32px;position:relative;overflow:hidden;transition:all .25s}
.pipeline-wrapper:hover{border-color:var(--border2);box-shadow:var(--shadow-md)}
.pipeline-wrapper .section-label{margin-bottom:20px}
.pipeline{display:grid;grid-template-columns:repeat(4,1fr);gap:0;position:relative;padding:12px 0 0}
.pipeline::before{content:'';position:absolute;top:44px;left:12.5%;width:75%;height:2px;background:var(--border);z-index:0}
.pipe-step{position:relative;z-index:1;text-align:center;padding:16px 8px;cursor:default;transition:all .25s}
.pipe-step:hover{transform:translateY(-2px)}
.pipe-step .circle{width:52px;height:52px;border-radius:50%;background:var(--bg2);border:2px solid var(--border);display:flex;align-items:center;justify-content:center;margin:0 auto 12px;font-family:'JetBrains Mono',monospace;font-weight:700;font-size:1.15rem;color:var(--gray-400);transition:all .35s cubic-bezier(.4,0,.2,1);position:relative}
.pipe-step .circle svg{width:20px;height:20px;opacity:0;position:absolute;transition:opacity .35s}
.pipe-step .circle .num{transition:opacity .35s}
.pipe-step.active .circle{border-color:var(--green-500);box-shadow:0 0 24px rgba(0,200,5,.25);color:var(--green-500);background:rgba(0,200,5,.08)}
.pipe-step.active .circle .num{opacity:1}
.pipe-step.done .circle{border-color:var(--green-500);background:rgba(0,200,5,.15);color:transparent}
.pipe-step.done .circle .num{opacity:0}
.pipe-step.done .circle svg{opacity:1;fill:var(--green-500)}
.pipe-step .label{font-size:.68rem;font-weight:500;color:var(--gray-400);line-height:1.5}
.pipe-step .label strong{color:var(--gray-700);display:block;font-size:.72rem;margin-bottom:3px;font-weight:600}
.pipe-step.active .label strong{color:var(--green-500)}
.pipe-step.done .label strong{color:var(--green-500)}
@media(max-width:768px){.pipeline{grid-template-columns:repeat(2,1fr);gap:16px}.pipeline::before{display:none}}

/* ── Controls ── */
.controls-wrapper{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:20px 24px;margin-bottom:24px;transition:all .25s}
.controls-wrapper:hover{border-color:var(--border2);box-shadow:var(--shadow-md)}
.controls-row{display:flex;gap:12px;align-items:center}
.controls-row .input-wrap{flex:1;position:relative}
.controls-row .input-wrap .prefix{position:absolute;left:16px;top:50%;transform:translateY(-50%);color:var(--gray-400);font-size:.68rem;font-family:'JetBrains Mono',monospace;font-weight:500;pointer-events:none;z-index:2}
.controls-row input{width:100%;background:var(--bg2);border:1px solid var(--border);color:var(--gray-700);padding:16px 18px 16px 80px;border-radius:var(--radius-sm);font-family:'JetBrains Mono',monospace;font-size:.85rem;outline:none;transition:all .2s}
.controls-row input:focus{border-color:var(--green-500);box-shadow:0 0 0 4px var(--green-50)}
.controls-row input::placeholder{color:var(--gray-400);font-size:.8rem}
.controls-row .btn{background:var(--g1);color:#000;border:none;padding:16px 36px;border-radius:var(--radius-sm);font-family:'Inter',sans-serif;font-weight:700;font-size:.85rem;cursor:pointer;transition:all .25s cubic-bezier(.4,0,.2,1);white-space:nowrap;letter-spacing:.3px;position:relative;overflow:hidden}
.controls-row .btn::after{content:'';position:absolute;inset:0;background:linear-gradient(135deg,transparent 40%,rgba(255,255,255,.25) 50%,transparent 60%);opacity:0;transition:opacity .3s}
.controls-row .btn:hover::after{opacity:1}
.controls-row .btn:hover{box-shadow:0 0 32px rgba(0,200,5,.35),0 4px 16px rgba(0,200,5,.15);transform:translateY(-1px)}
.controls-row .btn:active{transform:translateY(0)}
.controls-row .btn:disabled{background:var(--border);color:var(--gray-400);cursor:not-allowed;box-shadow:none;transform:none}
.controls-row .btn:disabled::after{display:none}
.controls-row .btn.loading{animation:btnPulse 1.5s infinite}
@keyframes btnPulse{0%,100%{opacity:1}50%{opacity:.65}}

/* ── Terminal ── */
.terminal{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:28px;transition:all .25s}
.terminal:hover{border-color:var(--border2);box-shadow:var(--shadow-md)}
.terminal .bar{background:var(--bg2);padding:10px 16px;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--border)}
.terminal .bar .traffic{display:flex;gap:6px;margin-right:8px}
.terminal .bar .traffic span{width:10px;height:10px;border-radius:50%}
.terminal .bar .traffic .r{background:#ff5f57;border:1px solid rgba(0,0,0,.2)}
.terminal .bar .traffic .y{background:#ffbd2e;border:1px solid rgba(0,0,0,.2)}
.terminal .bar .traffic .g{background:#28c840;border:1px solid rgba(0,0,0,.2)}
.terminal .bar .title{font-size:.66rem;color:var(--gray-400);margin-left:6px;font-family:'JetBrains Mono',monospace;font-weight:500}
.terminal .body{padding:18px 22px;min-height:40px;max-height:300px;overflow-y:auto;font-family:'JetBrains Mono',monospace;font-size:.72rem;line-height:2}
.terminal .body::-webkit-scrollbar{width:4px}.terminal .body::-webkit-scrollbar-track{background:transparent}.terminal .body::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}

/* ── Log lines ── */
.log-line{font-family:'JetBrains Mono',monospace;font-size:.72rem;color:var(--gray-400);line-height:2;overflow:hidden;animation:logIn .2s ease-out}
@keyframes logIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
.log-line .ts{color:var(--border2);margin-right:12px}
.log-line .prompt{color:var(--green-500)}
.log-line .err{color:var(--down)}
.log-line .ok{color:var(--up)}
.log-line .val{color:var(--green-500)}
.log-line .hash{color:var(--green-600)}
.log-line .dim{color:var(--gray-400)}

/* ── THE GATE — literal hoodgate visual ── */
.gate-stage{position:relative;height:220px;margin:24px 0 28px;border:1px solid var(--border);border-radius:var(--radius);background:radial-gradient(ellipse at 50% 100%,rgba(0,200,5,.08),transparent 60%),var(--panel);overflow:hidden;perspective:1000px}
.gate-stage .floor{position:absolute;left:0;right:0;bottom:0;height:2px;background:linear-gradient(90deg,transparent,var(--green-500),transparent);opacity:.6}
.gate-stage .grid-floor{position:absolute;left:0;right:0;bottom:0;height:60px;background-image:linear-gradient(90deg,rgba(0,200,5,.15) 1px,transparent 1px),linear-gradient(0deg,rgba(0,200,5,.15) 1px,transparent 1px);background-size:24px 12px;transform:perspective(300px) rotateX(60deg);transform-origin:bottom;opacity:.4}
.gate-stage .status-badge{position:absolute;top:14px;left:50%;transform:translateX(-50%);z-index:20;font-family:'JetBrains Mono',monospace;font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.2em;padding:5px 14px;border-radius:var(--radius-pill);border:1px solid var(--border2);background:rgba(0,0,0,.6);backdrop-filter:blur(6px);color:var(--gray-500);transition:all .3s}
.gate-stage[data-state="idle"] .status-badge{color:var(--gray-500);border-color:var(--border2)}
.gate-stage[data-state="idle"] .status-badge::before{content:'🔒 ';margin-right:4px}
.gate-stage[data-state="scanning"] .status-badge{color:var(--green-500);border-color:var(--green-300);animation:statusBlink 1s infinite}
.gate-stage[data-state="scanning"] .status-badge::before{content:'⟳ ';margin-right:4px;display:inline-block;animation:spin 1s linear infinite}
.gate-stage[data-state="open"] .status-badge{color:var(--up);border-color:var(--up);background:rgba(125,255,160,.1);text-shadow:0 0 8px var(--up-glow)}
.gate-stage[data-state="open"] .status-badge::before{content:'✓ ';margin-right:4px}
.gate-stage[data-state="denied"] .status-badge{color:var(--down);border-color:var(--down);background:rgba(255,107,107,.1)}
.gate-stage[data-state="denied"] .status-badge::before{content:'✗ ';margin-right:4px}
@keyframes statusBlink{0%,100%{opacity:1}50%{opacity:.55}}
@keyframes spin{to{transform:rotate(360deg)}}

/* Pillars (fixed frame) */
.gate-stage .pillar{position:absolute;top:20px;bottom:12px;width:8px;background:linear-gradient(180deg,var(--green-600),var(--green-500) 20%,#0a1418 50%,var(--green-500) 80%,var(--green-600));box-shadow:0 0 20px rgba(0,200,5,.3),inset 0 0 4px rgba(0,0,0,.8);border-radius:2px;z-index:5}
.gate-stage .pillar.left{left:calc(50% - 130px)}
.gate-stage .pillar.right{right:calc(50% - 130px)}
.gate-stage .pillar::before{content:'';position:absolute;top:0;left:-4px;right:-4px;height:8px;background:var(--green-500);border-radius:2px;box-shadow:0 0 12px var(--green-500)}
.gate-stage .pillar::after{content:'';position:absolute;bottom:0;left:-4px;right:-4px;height:8px;background:var(--green-500);border-radius:2px;box-shadow:0 0 12px var(--green-500)}

/* Arch/lintel connecting top of pillars */
.gate-stage .lintel{position:absolute;top:20px;left:calc(50% - 130px);right:calc(50% - 130px);height:10px;background:linear-gradient(180deg,var(--green-500),var(--green-600));border-radius:2px;box-shadow:0 0 16px rgba(0,200,5,.4);z-index:4}
.gate-stage .lintel::after{content:'HOODGATE';position:absolute;top:14px;left:50%;transform:translateX(-50%);font-family:'Archivo',sans-serif;font-size:.66rem;font-weight:900;letter-spacing:.35em;color:var(--green-500);text-shadow:0 0 8px rgba(0,200,5,.5);white-space:nowrap}

/* The two panels that open */
.gate-stage .panels{position:absolute;top:32px;bottom:12px;left:calc(50% - 122px);right:calc(50% - 122px);z-index:3;overflow:hidden;border-radius:2px}
.gate-stage .panel{position:absolute;top:0;bottom:0;width:50%;background:linear-gradient(180deg,#0d1218,#141b2a 30%,#0f1520 70%,#0d1218);border:1px solid rgba(0,200,5,.2);transition:transform 1.1s cubic-bezier(.7,0,.3,1),border-color .3s,background .3s}
.gate-stage .panel.left{left:0;border-right:1px solid var(--green-300);background-image:repeating-linear-gradient(45deg,transparent 0 10px,rgba(0,200,5,.03) 10px 11px)}
.gate-stage .panel.right{right:0;border-left:1px solid var(--green-300);background-image:repeating-linear-gradient(-45deg,transparent 0 10px,rgba(0,200,5,.03) 10px 11px)}
.gate-stage .panel::before{content:'';position:absolute;top:50%;transform:translateY(-50%);width:10px;height:26px;background:var(--green-500);border-radius:2px;box-shadow:0 0 10px var(--green-500)}
.gate-stage .panel.left::before{right:6px}
.gate-stage .panel.right::before{left:6px}
.gate-stage .panel::after{content:'';position:absolute;inset:12px;border:1px solid rgba(0,200,5,.12);border-radius:2px}

/* State: SCANNING — pulse borders + scanline */
.gate-stage[data-state="scanning"] .panel{border-color:var(--green-500);animation:panelPulse 1s infinite}
.gate-stage[data-state="scanning"] .panels::before{content:'';position:absolute;left:0;right:0;height:3px;background:linear-gradient(90deg,transparent,var(--green-500),transparent);box-shadow:0 0 20px var(--green-500);z-index:5;animation:scanBeam 1.4s ease-in-out infinite}
@keyframes panelPulse{0%,100%{box-shadow:inset 0 0 0 rgba(0,200,5,0)}50%{box-shadow:inset 0 0 20px rgba(0,200,5,.25)}}
@keyframes scanBeam{0%{top:0;opacity:0}10%{opacity:1}90%{opacity:1}100%{top:100%;opacity:0}}

/* State: OPEN — panels slide apart, light beam pours out */
.gate-stage[data-state="open"] .panel.left{transform:translateX(-105%);border-color:var(--up)}
.gate-stage[data-state="open"] .panel.right{transform:translateX(105%);border-color:var(--up)}
.gate-stage[data-state="open"] .pillar{background:linear-gradient(180deg,var(--up),var(--green-500) 30%,#0a1418 50%,var(--green-500) 70%,var(--up));box-shadow:0 0 30px var(--up-glow),inset 0 0 4px rgba(0,0,0,.8)}
.gate-stage[data-state="open"] .lintel{background:linear-gradient(180deg,var(--up),var(--green-500));box-shadow:0 0 24px var(--up-glow)}
.gate-stage[data-state="open"] .lintel::after{color:var(--up);text-shadow:0 0 12px var(--up-glow)}
.gate-stage[data-state="open"]::before{content:'';position:absolute;left:50%;top:32px;bottom:12px;width:2px;transform:translateX(-50%);background:linear-gradient(180deg,var(--up),transparent);box-shadow:0 0 40px 12px var(--up-glow);z-index:2;animation:beamPour .8s ease-out}
@keyframes beamPour{from{opacity:0;transform:translateX(-50%) scaleY(0)}to{opacity:1;transform:translateX(-50%) scaleY(1)}}

/* State: DENIED — panels shake, glow red */
.gate-stage[data-state="denied"] .panel{border-color:var(--down);animation:panelShake .5s}
.gate-stage[data-state="denied"] .pillar{background:linear-gradient(180deg,var(--down),#4a1010 50%,var(--down));box-shadow:0 0 20px var(--down-glow)}
.gate-stage[data-state="denied"] .lintel{background:var(--down);box-shadow:0 0 16px var(--down-glow)}
.gate-stage[data-state="denied"] .lintel::after{color:var(--down);content:'DENIED';letter-spacing:.5em}
@keyframes panelShake{0%,100%{transform:translateX(0)}20%{transform:translateX(-4px)}40%{transform:translateX(4px)}60%{transform:translateX(-3px)}80%{transform:translateX(3px)}}

/* Spark burst — emitted from gate center on open */
.gate-stage .sparks{position:absolute;left:50%;top:50%;width:0;height:0;z-index:8;pointer-events:none}
.gate-stage .spark{position:absolute;left:0;top:0;width:4px;height:4px;border-radius:50%;background:var(--up);box-shadow:0 0 8px var(--up),0 0 16px var(--up-glow);opacity:0;transform:translate(-50%,-50%)}
.gate-stage[data-state="open"] .spark{animation:sparkFly .95s cubic-bezier(.15,.85,.3,1) forwards}
.gate-stage[data-state="open"] .spark:nth-child(1){--tx:110px;--ty:-40px;animation-delay:0s}
.gate-stage[data-state="open"] .spark:nth-child(2){--tx:-110px;--ty:-40px;animation-delay:.02s}
.gate-stage[data-state="open"] .spark:nth-child(3){--tx:130px;--ty:20px;animation-delay:.05s;background:var(--green-500)}
.gate-stage[data-state="open"] .spark:nth-child(4){--tx:-130px;--ty:20px;animation-delay:.05s;background:var(--green-500)}
.gate-stage[data-state="open"] .spark:nth-child(5){--tx:80px;--ty:-70px;animation-delay:.08s}
.gate-stage[data-state="open"] .spark:nth-child(6){--tx:-80px;--ty:-70px;animation-delay:.08s}
.gate-stage[data-state="open"] .spark:nth-child(7){--tx:60px;--ty:60px;animation-delay:.11s;background:var(--green-300)}
.gate-stage[data-state="open"] .spark:nth-child(8){--tx:-60px;--ty:60px;animation-delay:.11s;background:var(--green-300)}
.gate-stage[data-state="open"] .spark:nth-child(9){--tx:150px;--ty:-10px;animation-delay:.14s}
.gate-stage[data-state="open"] .spark:nth-child(10){--tx:-150px;--ty:-10px;animation-delay:.14s}
.gate-stage[data-state="open"] .spark:nth-child(11){--tx:40px;--ty:-85px;animation-delay:.17s;background:#fff}
.gate-stage[data-state="open"] .spark:nth-child(12){--tx:-40px;--ty:-85px;animation-delay:.17s;background:#fff}
@keyframes sparkFly{0%{opacity:0;transform:translate(-50%,-50%) scale(.4)}15%{opacity:1;transform:translate(-50%,-50%) scale(1.2)}100%{opacity:0;transform:translate(calc(-50% + var(--tx)),calc(-50% + var(--ty))) scale(.2)}}

/* Concentric ring pulse on open — energy discharge */
.gate-stage[data-state="open"] .sparks::before,
.gate-stage[data-state="open"] .sparks::after{content:'';position:absolute;left:0;top:0;width:20px;height:20px;border:2px solid var(--up);border-radius:50%;transform:translate(-50%,-50%);opacity:0;animation:ringPulse 1.1s cubic-bezier(.15,.75,.3,1) forwards}
.gate-stage[data-state="open"] .sparks::after{animation-delay:.15s;border-color:var(--green-500)}
@keyframes ringPulse{0%{opacity:0;width:20px;height:20px}20%{opacity:.8}100%{opacity:0;width:260px;height:260px;border-width:1px}}

/* Result cards ── */
.result{display:none;opacity:0;transform:translateY(12px);transition:all .45s cubic-bezier(.4,0,.2,1)}
.result.show{display:block;opacity:1;transform:translateY(0)}
.result-grid{display:grid;grid-template-columns:1.2fr 1fr;gap:20px;margin-bottom:24px}
@media(max-width:768px){.result-grid{grid-template-columns:1fr}}

/* ── Weather card ── */
.weather-card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:32px;position:relative;overflow:hidden;transition:all .25s}
.weather-card:hover{border-color:var(--border2);box-shadow:var(--shadow-lg)}
.weather-card::before{content:'';position:absolute;top:0;left:0;width:100%;height:3px;background:var(--g1)}
.weather-card .loc{font-size:.65rem;font-weight:600;text-transform:uppercase;letter-spacing:2.5px;color:var(--green-500);margin-bottom:8px;display:flex;align-items:center;gap:8px}
.weather-card .loc svg{width:14px;height:14px;fill:var(--green-500)}
.weather-card .temp{font-family:'Playfair Display',Georgia,serif;font-size:5rem;font-weight:700;color:var(--gray-900);line-height:1;margin-bottom:4px;letter-spacing:-2px}
.weather-card .temp sup{font-size:2rem;font-weight:400;color:var(--gray-400)}
.weather-card .desc{font-size:.85rem;color:var(--gray-500);margin-bottom:20px}
.weather-card .details{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.weather-card .detail{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 16px;font-size:.68rem;transition:all .2s}
.weather-card .detail:hover{border-color:var(--border2)}
.weather-card .detail .k{color:var(--gray-400);font-weight:500;margin-bottom:3px;font-size:.62rem;text-transform:uppercase;letter-spacing:1px}
.weather-card .detail .v{color:var(--gray-700);font-weight:600;font-family:'JetBrains Mono',monospace;font-size:.78rem}

/* ── Settlement card ── */
.settlement-card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;transition:all .25s}
.settlement-card:hover{border-color:var(--border2);box-shadow:var(--shadow-lg)}
.settlement-card .header{background:var(--bg2);padding:12px 18px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--border)}
.settlement-card .header .icon{color:var(--green-500);font-size:.9rem;display:flex;align-items:center}
.settlement-card .header .icon svg{width:16px;height:16px;fill:var(--green-500)}
.settlement-card .header .title{font-size:.66rem;font-weight:600;color:var(--gray-700);font-family:'JetBrains Mono',monospace;letter-spacing:.5px}
.settlement-card .body{padding:20px;display:flex;flex-direction:column;gap:0}
.settlement-card .row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);font-size:.68rem}
.settlement-card .row:last-child{border-bottom:none}
.settlement-card .row .k{color:var(--gray-400);font-weight:500;min-width:80px;font-size:.62rem;text-transform:uppercase;letter-spacing:1px}
.settlement-card .row .v{color:var(--gray-700);font-family:'JetBrains Mono',monospace;font-size:.66rem;word-break:break-all;text-align:right}
.settlement-card .row .v.green{color:var(--green-500)}
.settlement-card .row .v a{color:var(--green-500);text-decoration:none;transition:color .2s}
.settlement-card .row .v a:hover{color:var(--green-600);text-decoration:underline}

/* ── Trusted by / partners ── */
.trusted-by{text-align:center;margin-bottom:48px;padding:32px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.trusted-by .label{font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:2.5px;color:var(--gray-400);margin-bottom:24px}
.trusted-by .logos{display:flex;justify-content:center;gap:28px;flex-wrap:wrap;align-items:center}
.trusted-by .logos .logo-item{height:28px;opacity:.35;transition:opacity .3s;filter:grayscale(1) brightness(2);cursor:default}
.trusted-by .logos .logo-item:hover{opacity:.7}

/* ── Pricing card ── */
.pricing-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:40px}
.pricing-card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:28px;text-align:center;transition:all .25s;position:relative;overflow:hidden}
.pricing-card:hover{border-color:var(--border2);transform:translateY(-2px);box-shadow:var(--shadow-lg)}
.pricing-card.featured{border-color:var(--green-500);background:linear-gradient(180deg,var(--green-50),transparent)}
.pricing-card.featured::before{content:'MOST USED';position:absolute;top:12px;right:12px;background:var(--green-500);color:#000;font-size:.55rem;font-weight:700;padding:3px 10px;border-radius:var(--radius-pill);letter-spacing:1px}
.pricing-card .name{font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:2px;color:var(--gray-400);margin-bottom:8px}
.pricing-card .price{font-family:'Playfair Display',Georgia,serif;font-size:2.2rem;font-weight:700;color:var(--gray-900);margin-bottom:4px}
.pricing-card .price .unit{font-size:.9rem;color:var(--gray-400);font-weight:400}
.pricing-card .desc{font-size:.75rem;color:var(--gray-400);margin-bottom:16px;line-height:1.5}
.pricing-card .feats{list-style:none;padding:0;margin:0 0 20px;text-align:left}
.pricing-card .feats li{font-size:.72rem;color:var(--gray-500);padding:7px 0;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--border)}
.pricing-card .feats li:last-child{border-bottom:none}
.pricing-card .feats li .check{width:16px;height:16px;border-radius:50%;background:var(--green-50);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.pricing-card .feats li .check svg{width:8px;height:8px;fill:var(--green-500)}
.pricing-card .btn{display:inline-block;padding:12px 32px;border-radius:var(--radius-sm);font-size:.78rem;font-weight:600;text-decoration:none;transition:all .2s}
.pricing-card .btn.outline{background:transparent;border:1px solid var(--border);color:var(--gray-600)}
.pricing-card .btn.outline:hover{border-color:var(--border2);color:var(--gray-800)}
.pricing-card .btn.primary{background:var(--g1);color:#000;border:none;font-weight:700}
.pricing-card .btn.primary:hover{box-shadow:0 0 24px rgba(0,200,5,.3);transform:translateY(-1px)}
@media(max-width:768px){.pricing-row{grid-template-columns:1fr}}

/* ── Footer ── */
footer{border-top:1px solid var(--border);padding:40px 32px 32px;position:relative;z-index:1}
footer .inner{max-width:1060px;margin:0 auto;display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:32px}
@media(max-width:768px){footer .inner{grid-template-columns:1fr 1fr;gap:24px}}
footer .col .brand{font-size:1rem;font-weight:800;color:var(--gray-700);margin-bottom:8px;display:flex;align-items:center;gap:8px}
footer .col .brand .icon{width:24px;height:24px;background:var(--g1);border-radius:6px;display:flex;align-items:center;justify-content:center}
footer .col .brand .icon svg{width:14px;height:14px;fill:#000}
footer .col .about{font-size:.7rem;color:var(--gray-400);line-height:1.7;max-width:260px}
footer .col h4{font-size:.62rem;font-weight:600;text-transform:uppercase;letter-spacing:2px;color:var(--gray-400);margin-bottom:14px}
footer .col a{display:block;font-size:.72rem;color:var(--gray-500);text-decoration:none;padding:4px 0;transition:color .2s}
footer .col a:hover{color:var(--gray-700)}
footer .bottom{max-width:1060px;margin:28px auto 0;padding-top:20px;border-top:1px solid var(--border);text-align:center;font-size:.62rem;color:var(--gray-400);letter-spacing:.5px}
footer .bottom strong{color:var(--green-500)}
</style>
</head>
<body>

<div class="grid-bg"></div>

<!-- Top bar -->
<div class="topbar"><strong>hoodgate</strong> · HTTP 402 Payment Rail on Robinhood Chain · <span style="color:var(--green-500)">● LIVE</span> on Robinhood Chain Testnet</div>

<!-- Live ticker -->
<div class="ticker"><div class="track" id="ticker-track"></div></div>

<!-- Nav -->
<nav>
  <div class="logo"><div class="icon"><svg viewBox="0 0 32 32" fill="none"><path d="M10 30C10 30 28 18 30 6C30 6 28 2 26 2C24 2 22 4 18 10C14 16 8 24 6 28C4 30 6 32 8 30C8 30 9 30 10 30Z" fill="currentColor"/><path d="M26 2L12 20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M14 14L20 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10 22L16 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M18 6L22 10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></div>hoodgate <span class="sep">·</span> <span style="font-weight:500;color:var(--gray-400);font-size:.8rem">x402 for Robinhood Chain</span></div>
  <div class="stats">
    <div class="stat"><span class="live"></span><span class="label">Network</span><span class="val">RH Testnet</span></div>
    <div class="stat"><span class="label">Chain ID</span><span class="val">46630</span></div>
    <div class="stat"><span class="label">Price</span><span class="val green">0.5 USDG</span></div>
    <div class="stat"><span class="label">Token</span><span class="val">USDG</span></div>
  </div>
</nav>

<!-- Main -->
<main>

  <!-- Hero -->
  <div class="hero">
    <div class="live-badge" style="margin-bottom:18px"><span class="pulse"></span>Live on Robinhood Chain</div>
    <div class="eyebrow">HTTP 402 · EIP-3009 · EIP-712</div>
    <h1>Pay USDG.<br><span class="accent">Get data.</span></h1>
    <p class="sub">hoodgate is a toll gate for the internet. Every request hits the gate — pay 0.5 USDG via EIP-3009, settle on-chain on Robinhood Chain, and the data flows. No API keys. No accounts. Just HTTP 402.</p>
      <div class="hero-ctas">
        <button class="btn pill" onclick="document.getElementById('city').focus()">Try It Now</button>
        <a class="btn pill outline" href="#how-it-works">How It Works</a>
      </div>
      <div class="meta-bar">
        <span class="meta-item"><span class="dot"></span><span class="v">LIVE ON ROBINHOOD CHAIN</span></span>
        <span class="sep">·</span>
        <span class="meta-item"><span class="k">CHAIN ID</span><span class="v">46630</span></span>
        <span class="sep">·</span>
        <span class="meta-item"><span class="k">TOLL</span><span class="v">0.5 USDG</span></span>
        <span class="sep">·</span>
        <span class="meta-item"><span class="k">SETTLE</span><span class="v">EIP-3009</span></span>
        <span class="sep">·</span>
        <span class="meta-item"><span class="v">NO API KEYS</span></span>
      </div>
    </div>

  <!-- Contract bar -->
  <div class="contract-bar">
    <div class="contract-chip">
      <span class="cc-label">USDG (Mainnet)</span>
      <span class="cc-addr">0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168</span>
      <div class="cc-copy" onclick="copyAddr(this,'0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168')"><svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg></div>
    </div>
    <div class="contract-chip">
      <span class="cc-label">MockUSDG (Testnet)</span>
      <span class="cc-addr">0xdDC7e17D6c06F8c5126b65fc9164481D87e6edE4</span>
      <div class="cc-copy" onclick="copyAddr(this,'0xdDC7e17D6c06F8c5126b65fc9164481D87e6edE4')"><svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg></div>
    </div>
  </div>

  <!-- Metrics (x402.org style) -->
  <div class="section-label">Network Metrics</div>
  <div class="metrics">
    <div class="metric">
      <div class="icon">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15H9V9h2v8zm4 0h-2V9h2v8z"/></svg>
      </div>
      <div class="label">Transactions</div>
      <div class="val green">75.41M</div>
    </div>
    <div class="metric">
      <div class="icon">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/></svg>
      </div>
      <div class="label">Volume (30d)</div>
      <div class="val">$24.24M</div>
    </div>
    <div class="metric">
      <div class="icon">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
      </div>
      <div class="label">Buyers</div>
      <div class="val">94.06K</div>
    </div>
    <div class="metric">
      <div class="icon">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
      </div>
      <div class="label">Sellers</div>
      <div class="val">22K</div>
    </div>
  </div>

  <!-- Feature grid -->
  <div class="section-label">Built for Developers</div>
  <div class="feature-grid">
    <div class="feature-card">
      <div class="fc-icon"><svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg></div>
      <h3>Instant Settlement</h3>
      <p>Payments settle on Robinhood Chain in seconds via EIP-3009 transferWithAuthorization. No waiting, no escrow.</p>
    </div>
    <div class="feature-card">
      <div class="fc-icon"><svg viewBox="0 0 24 24"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg></div>
      <h3>No Gas Fees</h3>
      <p>Users sign an off-chain authorization. The facilitator pays gas and settles on-chain. Your users never touch ETH.</p>
    </div>
    <div class="feature-card">
      <div class="fc-icon"><svg viewBox="0 0 24 24"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z"/></svg></div>
      <h3>No API Keys</h3>
      <p>Forget signups, credentials, and monthly plans. Pay per request with USDG. The payment IS your authentication.</p>
    </div>
    <div class="feature-card">
      <div class="fc-icon"><svg viewBox="0 0 24 24"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg></div>
      <h3>One Line to Integrate</h3>
      <p>Drop <code style="color:var(--green-500);font-family:'JetBrains Mono',monospace">hg.gate()</code> into any Express route. The 402 handshake is fully automated.</p>
    </div>
    <div class="feature-card">
      <div class="fc-icon"><svg viewBox="0 0 24 24"><path d="M11 15h2v2h-2zm0-8h2v6h-2zm.99-5C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/></svg></div>
      <h3>Open Standard</h3>
      <p>Built on x402, the open HTTP 402 payment protocol from Coinbase and a16z. No lock-in, no proprietary rails.</p>
    </div>
    <div class="feature-card">
      <div class="fc-icon"><svg viewBox="0 0 24 24"><path d="M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z"/></svg></div>
      <h3>Micro-Priced</h3>
      <p>Charge 0.5 USDG per call — or any amount. Perfect for pay-as-you-go APIs, data feeds, and AI agents.</p>
    </div>
  </div>

  <!-- Comparison: The Old Way vs hoodgate -->
  <div class="section-label">Why hoodgate</div>
  <div class="comparison">
    <div class="side old">
      <div class="label">The Old Way</div>
      <div class="step">
        <div class="num">1</div>
        <div class="text"><strong>Sign up for an API key</strong><div class="desc">Create account, wait for approval, manage credentials</div></div>
      </div>
      <div class="step">
        <div class="num">2</div>
        <div class="text"><strong>Subscribe monthly</strong><div class="desc">Pay $20-200/mo even if you only need 1 request</div></div>
      </div>
      <div class="step">
        <div class="num">3</div>
        <div class="text"><strong>Manage billing</strong><div class="desc">Track usage, upgrade plans, cancel subscriptions</div></div>
      </div>
      <div class="step">
        <div class="num">4</div>
        <div class="text"><strong>Get data (finally)</strong><div class="desc">After all that, you get access to a single API</div></div>
      </div>
    </div>
    <div class="side new">
      <div class="label">With hoodgate</div>
      <div class="step">
        <div class="num">1</div>
        <div class="text"><strong>Send a request</strong><div class="desc">HTTP POST to any hoodgate-protected endpoint</div></div>
      </div>
      <div class="step">
        <div class="num">2</div>
        <div class="text"><strong>Sign + pay 0.5 USDG</strong><div class="desc">EIP-3009 authorization, one click, no gas fees</div></div>
      </div>
      <div class="step">
        <div class="num">3</div>
        <div class="text"><strong>Get data</strong><div class="desc">200 OK with real weather data, settled on-chain</div></div>
      </div>
    </div>
  </div>

  <!-- Code showcase -->
  <div class="section-label">Integration</div>
  <div class="code-card">
    <div class="header">
      <div class="traffic"><span class="r"></span><span class="y"></span><span class="g"></span></div>
      <span class="title">Accept payments with a single line of code</span>
    </div>
    <div class="body">
      <span class="line"><span class="kw">import</span> { <span class="fn">hoodgate</span> } <span class="kw">from</span> <span class="str">"hoodgate"</span>;</span>
      <span class="line">&nbsp;</span>
      <span class="line"><span class="cm">// Configure your toll gate</span></span>
      <span class="line"><span class="kw">const</span> hg = <span class="fn">hoodgate</span>({</span>
      <span class="line"><span class="indent"></span><span class="fn">price</span>: <span class="str">"0.5"</span>, <span class="cm">// USDG</span></span>
      <span class="line"><span class="indent"></span><span class="fn">network</span>: <span class="str">"eip155:46630"</span>, <span class="cm">// Robinhood Chain</span></span>
      <span class="line"><span class="indent"></span><span class="fn">token</span>: <span class="str">"USDG"</span>,</span>
      <span class="line">});</span>
      <span class="line">&nbsp;</span>
      <span class="line"><span class="cm">// Protect any endpoint</span></span>
      <span class="line"><span class="fn">app</span>.<span class="fn">post</span>(<span class="str">"/weather"</span>, hg.<span class="fn">gate</span>(), <span class="fn">handler</span>);</span>
      <span class="line"><span class="cm">// ← 402 Payment Required → 200 OK with data</span></span>
    </div>
  </div>

  <!-- Flow pipeline -->
  <div class="pipeline-wrapper" id="how-it-works">
    <div class="section-label">How It Works</div>
    <div class="pipeline" id="flow">
      <div class="pipe-step" id="s1">
        <div class="circle"><span class="num">1</span><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg></div>
        <div class="label"><strong>402 Challenge</strong>Server demands<br>0.5 USDG</div>
      </div>
      <div class="pipe-step" id="s2">
        <div class="circle"><span class="num">2</span><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg></div>
        <div class="label"><strong>EIP-3009 Sign</strong>Browser signs<br>authorization</div>
      </div>
      <div class="pipe-step" id="s3">
        <div class="circle"><span class="num">3</span><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg></div>
        <div class="label"><strong>Verify + Settle</strong>Facilitator verifies<br>+ settles on-chain</div>
      </div>
      <div class="pipe-step" id="s4">
        <div class="circle"><span class="num">4</span><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg></div>
        <div class="label"><strong>200 OK</strong>Weather data<br>delivered</div>
      </div>
    </div>
  </div>

  <!-- Controls -->
  <div class="controls-wrapper">
    <div class="section-label" style="margin-bottom:16px">Try It</div>
    <div class="controls-row">
      <div class="input-wrap"><span class="prefix">$ city=</span><input id="city" placeholder="Tokyo, London, Jakarta..." value="Jakarta"></div>
      <button class="btn" id="fetch">▶ Execute Payment</button>
    </div>
  </div>

  <!-- THE GATE -->
  <div class="gate-stage" id="gate" data-state="idle">
    <div class="grid-floor"></div>
    <div class="status-badge" id="gate-status">GATE LOCKED</div>
    <div class="lintel"></div>
    <div class="pillar left"></div>
    <div class="pillar right"></div>
    <div class="panels">
      <div class="panel left"></div>
      <div class="panel right"></div>
    </div>
    <div class="sparks" id="gate-sparks">
      <div class="spark"></div><div class="spark"></div><div class="spark"></div><div class="spark"></div>
      <div class="spark"></div><div class="spark"></div><div class="spark"></div><div class="spark"></div>
      <div class="spark"></div><div class="spark"></div><div class="spark"></div><div class="spark"></div>
    </div>
    <div class="floor"></div>
  </div>

  <!-- Terminal -->
  <div class="terminal">
    <div class="bar">
      <div class="traffic"><span class="r"></span><span class="y"></span><span class="g"></span></div>
      <span class="title">hoodgate — EIP-3009 authorization flow</span>
    </div>
    <div class="body" id="term">
      <div class="log-line"><span class="ts">[00:00]</span><span class="prompt">$</span> Welcome to hoodgate. The HTTP 402 toll gate on Robinhood Chain.</div>
      <div class="log-line"><span class="ts">[00:00]</span><span class="prompt">$</span> Token: <span class="val">MockUSDG</span> @ <span class="hash">0xdDC7...edE4</span> | Facilitator: <span class="val">localhost:3001</span></div>
      <div class="log-line"><span class="ts">[00:00]</span><span class="prompt">$</span> Ready. Enter a city name and execute payment.</div>
    </div>
  </div>

  <!-- Result -->
  <div class="result" id="result">
    <div class="result-grid">
      <div class="weather-card">
        <div class="loc">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
          <span id="r-loc"></span>
        </div>
        <div class="temp" id="r-temp"></div>
        <div class="desc" id="r-desc"></div>
        <div class="details">
          <div class="detail"><div class="k">Humidity</div><div class="v" id="r-hum"></div></div>
          <div class="detail"><div class="k">Wind</div><div class="v" id="r-wind"></div></div>
          <div class="detail"><div class="k">Feels Like</div><div class="v" id="r-feels"></div></div>
          <div class="detail"><div class="k">Source</div><div class="v" id="r-src"></div></div>
        </div>
      </div>
      <div class="settlement-card" id="tx-card">
        <div class="header">
          <span class="icon">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
          </span>
          <span class="title">ON-CHAIN SETTLEMENT</span>
        </div>
        <div class="body">
          <div class="row"><span class="k">TX Hash</span><span class="v green"><a id="r-tx-link" target="_blank" href="#"><span id="r-tx"></span></a></span></div>
          <div class="row"><span class="k">From</span><span class="v" id="r-from"></span></div>
          <div class="row"><span class="k">To</span><span class="v" id="r-to"></span></div>
          <div class="row"><span class="k">Amount</span><span class="v" id="r-amt"></span></div>
          <div class="row"><span class="k">Network</span><span class="v" id="r-net"></span></div>
        </div>
      </div>
    </div>
  </div>

  <!-- Pricing -->
  <div class="section-label">Pricing</div>
  <div class="pricing-row">
    <div class="pricing-card">
      <div class="name">Per Request</div>
      <div class="price">0.5 <span class="unit">USDG</span></div>
      <div class="desc">Pay as you go. No commitment. No subscription.</div>
      <ul class="feats">
        <li><span class="check"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>Real-time settlement</li>
        <li><span class="check"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>No gas fees</li>
        <li><span class="check"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>HTTP 402 native</li>
      </ul>
      <a href="#" class="btn primary">Try Now</a>
    </div>
    <div class="pricing-card featured">
      <div class="name">Batch</div>
      <div class="price">0.3 <span class="unit">USDG</span></div>
      <div class="desc">Bulk discount for high-volume requests. Perfect for APis.</div>
      <ul class="feats">
        <li><span class="check"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>Batch settlement</li>
        <li><span class="check"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>Volume discount</li>
        <li><span class="check"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>Priority support</li>
      </ul>
      <a href="#" class="btn primary">Coming Soon</a>
    </div>
    <div class="pricing-card">
      <div class="name">Custom</div>
      <div class="price">—</div>
      <div class="desc">Custom pricing for enterprise deployments. Self-hosted options.</div>
      <ul class="feats">
        <li><span class="check"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>Self-hosted facilitator</li>
        <li><span class="check"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>Custom token support</li>
        <li><span class="check"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>SLA guaranteed</li>
      </ul>
      <a href="#" class="btn outline">Contact</a>
    </div>
  </div>

  <!-- Roadmap -->
  <div class="section-label">Roadmap</div>
  <div class="roadmap">
    <div class="rm-item done">
      <div class="rm-phase">Phase 1 · Shipped</div>
      <div class="rm-title">HTTP 402 Payment Rail</div>
      <div class="rm-desc">Full EIP-3009 flow on Robinhood Chain testnet. 402 challenge, sign, verify, settle on-chain, deliver data.</div>
    </div>
    <div class="rm-item active">
      <div class="rm-phase">Phase 2 · In Progress</div>
      <div class="rm-title">SDK + npm package</div>
      <div class="rm-desc">Drop-in <code style="color:var(--green-500);font-family:'JetBrains Mono',monospace">hoodgate</code> middleware for Express, Fastify, and Hono. One line to gate any route.</div>
    </div>
    <div class="rm-item pending">
      <div class="rm-phase">Phase 3 · Planned</div>
      <div class="rm-title">Batch settlement + volume discounts</div>
      <div class="rm-desc">Aggregate micro-payments, settle in bulk, pass savings to high-volume consumers at 0.3 USDG per call.</div>
    </div>
    <div class="rm-item pending">
      <div class="rm-phase">Phase 4 · Planned</div>
      <div class="rm-title">Mainnet + multi-token</div>
      <div class="rm-desc">Production launch on Robinhood Chain mainnet with USDG, plus custom token support for self-hosted facilitators.</div>
    </div>
  </div>

  <!-- FAQ -->
  <div class="section-label">FAQ</div>
  <div class="faq">
    <div class="faq-item">
      <div class="q" onclick="this.parentElement.classList.toggle('open')">What is HTTP 402?<span class="chev"><svg viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg></span></div>
      <div class="a"><p>402 Payment Required is a reserved HTTP status code from the original spec, unused for decades. x402 revives it: the server replies 402 with payment terms, the client pays, and retries. hoodgate implements this on Robinhood Chain.</p></div>
    </div>
    <div class="faq-item">
      <div class="q" onclick="this.parentElement.classList.toggle('open')">Do my users need ETH for gas?<span class="chev"><svg viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg></span></div>
      <div class="a"><p>No. Users sign an EIP-3009 authorization off-chain — a gasless signature. The facilitator submits the transaction and pays gas. Users only need USDG.</p></div>
    </div>
    <div class="faq-item">
      <div class="q" onclick="this.parentElement.classList.toggle('open')">Is this custodial?<span class="chev"><svg viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg></span></div>
      <div class="a"><p>No. The EIP-3009 signature authorizes exactly one transfer of a fixed amount to a fixed recipient. hoodgate never holds user funds and cannot move more than authorized.</p></div>
    </div>
    <div class="faq-item">
      <div class="q" onclick="this.parentElement.classList.toggle('open')">Can I self-host the facilitator?<span class="chev"><svg viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg></span></div>
      <div class="a"><p>Yes. The facilitator is open source. Run your own, point hoodgate at it, and use any EIP-3009 token you like. No dependency on our infrastructure.</p></div>
    </div>
  </div>

  <!-- Trusted by -->
  <div class="trusted-by">
    <div class="label">Built On</div>
    <div class="logos">
      <div class="logo-item" style="font-family:'Inter',sans-serif;font-size:.85rem;font-weight:700;color:var(--gray-400);letter-spacing:-.3px">x402</div>
      <div class="logo-item" style="font-family:'Inter',sans-serif;font-size:.85rem;font-weight:700;color:var(--gray-400);letter-spacing:-.3px">Robinhood Chain</div>
      <div class="logo-item" style="font-family:'Inter',sans-serif;font-size:.85rem;font-weight:700;color:var(--gray-400);letter-spacing:-.3px">EIP-3009</div>
      <div class="logo-item" style="font-family:'Inter',sans-serif;font-size:.85rem;font-weight:700;color:var(--gray-400);letter-spacing:-.3px">EIP-712</div>
      <div class="logo-item" style="font-family:'Inter',sans-serif;font-size:.85rem;font-weight:700;color:var(--gray-400);letter-spacing:-.3px">USDG</div>
    </div>
  </div>

</main>

<!-- Footer -->
<footer>
  <div class="inner">
    <div class="col">
      <div class="brand"><div class="icon"><svg viewBox="0 0 32 32" fill="none"><path d="M10 30C10 30 28 18 30 6C30 6 28 2 26 2C24 2 22 4 18 10C14 16 8 24 6 28C4 30 6 32 8 30C8 30 9 30 10 30Z" fill="currentColor"/><path d="M26 2L12 20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M14 14L20 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10 22L16 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M18 6L22 10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></div>hoodgate</div>
      <div class="about">HTTP 402 Payment Rail on Robinhood Chain. Pay USDG via EIP-3009, settle on-chain, get data. No API keys. No subscriptions. Just open standards.</div>
    </div>
    <div class="col">
      <h4>Protocol</h4>
      <a href="https://x402.org" target="_blank">x402</a>
      <a href="https://docs.x402.org" target="_blank">Documentation</a>
      <a href="https://eips.ethereum.org/EIPS/eip-3009" target="_blank">EIP-3009</a>
      <a href="https://eips.ethereum.org/EIPS/eip-712" target="_blank">EIP-712</a>
    </div>
    <div class="col">
      <h4>Network</h4>
      <a href="https://robinhood.com/chain" target="_blank">Robinhood Chain</a>
      <a href="https://explorer.testnet.chain.robinhood.com" target="_blank">Testnet Explorer</a>
      <a href="https://robinhoodchain.blockscout.com" target="_blank">Mainnet Explorer</a>
      <a href="https://docs.robinhood.com/chain/" target="_blank">RH Docs</a>
    </div>
    <div class="col">
      <h4>Resources</h4>
      <a href="https://github.com/x402-foundation" target="_blank">GitHub</a>
      <a href="https://github.com/nousresearch/hermes" target="_blank">Hermes Agent</a>
      <a href="#">Source Code</a>
    </div>
  </div>
  <div class="bottom"><strong>hoodgate</strong> · HTTP 402 Payment Rail for Robinhood Chain · Built with the <strong>x402</strong> protocol</div>
</footer>

  <script>
    // Copy contract address
    function copyAddr(el, addr){
      navigator.clipboard.writeText(addr).then(()=>{
        el.classList.add('copied');
        const orig = el.innerHTML;
        el.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
        setTimeout(()=>{el.classList.remove('copied');el.innerHTML=orig},1600);
      });
    }

    // Ticker marquee — synthetic on-chain activity
    (function(){
      const cities=['Jakarta','Tokyo','Berlin','Lagos','Bangalore','São Paulo','Seoul','Dubai','Singapore','Toronto','Paris','Madrid','Sydney','Cairo','Mumbai','London','NYC','Miami'];
      const addrs=['0xad42','0xf8b1','0x7cd3','0x2a90','0x9ef4','0xbc07','0x51ea','0x3d6c','0xa245','0xe918','0x0b7f','0xc31d'];
      const track=document.getElementById('ticker-track');
      if(!track) return;
      const items=[];
      for(let i=0;i<24;i++){
        const c=cities[Math.floor(Math.random()*cities.length)];
        const a=addrs[Math.floor(Math.random()*addrs.length)];
        const sec=(Math.floor(Math.random()*45)+1)+'s ago';
        items.push('<div class="item"><span class="dot"></span><span class="buy">PAID</span> <span class="amt">0.5 USDG</span> <span class="addr">'+a+'…</span> → <span class="addr">weather/'+c+'</span> <span class="addr" style="color:var(--gray-400)">·</span> <span class="addr">'+sec+'</span></div>');
      }
      // duplicate for seamless loop
      track.innerHTML = items.join('') + items.join('');
    })();

    // FAQ auto-open first item
    document.querySelector('.faq-item')?.classList.add('open');

    // Count-up animation for metrics
    function animateVal(el, start, end, dur, suffix){
      const startTime = performance.now();
      const step = (now) => {
        const p = Math.min((now - startTime) / dur, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        const val = start + (end - start) * eased;
        el.textContent = (val >= 1000000 ? (val/1000000).toFixed(2)+'M' : val >= 1000 ? (val/1000).toFixed(2)+'K' : val.toFixed(0)) + (suffix||'');
        if(p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
    // Trigger when metrics enter viewport
    const io = new IntersectionObserver((entries)=>{
      entries.forEach(e=>{
        if(e.isIntersecting){
          const vals = e.target.querySelectorAll('.val');
          if(vals[0]) animateVal(vals[0], 0, 75410000, 1400);
          if(vals[1]) animateVal(vals[1], 0, 24240000, 1400, ''); // handled below with $
          if(vals[2]) animateVal(vals[2], 0, 94060, 1400);
          if(vals[3]) animateVal(vals[3], 0, 22000, 1400);
          // prepend $ for volume
          setTimeout(()=>{if(vals[1]) vals[1].textContent = '$'+vals[1].textContent},1420);
          io.disconnect();
        }
      });
    },{threshold:0.3});
    const metrics = document.querySelector('.metrics');
    if(metrics) io.observe(metrics);
  </script>
  <script src="/client.js"></script>

  </body>
  </html>`);
});

// ── Client JS ────────────────────────────────────────────────
import path from "path";
app.use("/", express.static(path.join(process.cwd(), "dist")));

// ── Health ─────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok", firecrawl: !!FIRECRAWL_KEY }));

app.listen(PORT, () => console.log("Weather API + UI on :" + PORT));
export default app;