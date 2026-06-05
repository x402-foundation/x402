/**
 * x402_agentpay — Optional status widget for Ouroboros UI
 * Shows live AgentWorld economy stats and a quick-query panel
 * Kind: inline (rendered in the skills sidebar)
 */

(function (api) {
  const BASE = "https://agentworld.me/api/agentworld";
  const STORE = "https://agentpaystore.com";

  const AGENTS = [
    { slug: "wally",    name: "WALLY 📈",    price: 0.10 },
    { slug: "cipher",   name: "CIPHER 🔐",   price: 0.10 },
    { slug: "scout",    name: "SCOUT 🔎",    price: 0.10 },
    { slug: "feeds",    name: "FEEDS 📰",    price: 0.05 },
    { slug: "gridiron", name: "GRIDIRON 🏈", price: 0.10 },
    { slug: "hardwood", name: "HARDWOOD 🏀", price: 0.10 },
    { slug: "duke",     name: "DUKE 🤖",     price: 0.10 },
  ];

  function render(container) {
    container.innerHTML = `
      <div style="font-family:monospace;font-size:12px;color:#ccc;padding:8px">
        <div style="font-weight:bold;color:#7b6fff;margin-bottom:8px">⚡ x402 AgentPay</div>
        <div id="x402-econ" style="color:#64748b;font-size:11px;margin-bottom:10px">Loading economy...</div>
        <select id="x402-slug" style="width:100%;background:#0d1225;border:1px solid #1e293b;color:#ccc;padding:4px;border-radius:4px;margin-bottom:6px">
          ${AGENTS.map(a => `<option value="${a.slug}">${a.name} — $${a.price.toFixed(2)}/query</option>`).join("")}
        </select>
        <textarea id="x402-query" placeholder="Ask the agent..." rows="2"
          style="width:100%;background:#0d1225;border:1px solid #1e293b;color:#ccc;padding:6px;border-radius:4px;resize:vertical;font-size:11px;box-sizing:border-box"></textarea>
        <button id="x402-run" style="margin-top:6px;width:100%;background:#7b6fff;color:#fff;border:none;padding:6px;border-radius:4px;cursor:pointer;font-weight:bold">
          Run Query (x402 USDC)
        </button>
        <div id="x402-result" style="margin-top:8px;font-size:10px;color:#94a3b8;min-height:40px;white-space:pre-wrap;word-break:break-word"></div>
        <div style="margin-top:8px;border-top:1px solid #1e293b;padding-top:6px;font-size:10px;color:#334155">
          <a href="https://agentpaystore.com" target="_blank" style="color:#7b6fff;text-decoration:none">agentpaystore.com</a>
          · <a href="https://agentworld.me/tokenomics" target="_blank" style="color:#4ade80;text-decoration:none">$AGWC tokenomics</a>
          · <a href="https://www.elonmuskoxnft.com" target="_blank" style="color:#4ade80;text-decoration:none">$MUSKOX</a>
        </div>
      </div>
    `;

    // Load economy
    fetch(BASE + "/economy")
      .then(r => r.json())
      .then(d => {
        document.getElementById("x402-econ").innerHTML =
          `🌍 <b style="color:#4ade80">${d.total_agents || "—"}</b> agents · ` +
          `💵 <b style="color:#f59e0b">$${parseFloat(d.treasury_usdc || 0).toFixed(2)}</b> treasury · ` +
          `🪙 <b style="color:#7b6fff">${Math.round(d.total_awc || 0).toLocaleString()}</b> AGWC in-world`;
      })
      .catch(() => {
        document.getElementById("x402-econ").textContent = "Economy data unavailable";
      });

    // Run button
    document.getElementById("x402-run").addEventListener("click", () => {
      const slug  = document.getElementById("x402-slug").value;
      const query = document.getElementById("x402-query").value.trim();
      const res   = document.getElementById("x402-result");
      if (!query) { res.textContent = "Enter a query first."; return; }

      res.textContent = "Routing via x402...";
      document.getElementById("x402-run").disabled = true;

      // Delegate to the plugin tool via Ouroboros API
      api.callTool("x402_query_agent", { slug, query })
        .then(data => {
          res.textContent = typeof data?.response?.response === "string"
            ? data.response.response
            : JSON.stringify(data, null, 2);
        })
        .catch(e => { res.textContent = "Error: " + e.message; })
        .finally(() => { document.getElementById("x402-run").disabled = false; });
    });
  }

  api.registerWidget({ id: "x402_agentpay", title: "x402 AgentPay", render });
})(ouroboros_plugin_api);
