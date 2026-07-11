  const PRIVATE_KEY = "0x053317dbc976dea9c15400a6ba23b7c73b752f5213ead2a95af6f43535ebbe20";
  const USDG = "0xdDC7e17D6c06F8c5126b65fc9164481D87e6edE4";
  const CHAIN = { chainId: 46630, name: "Robinhood Testnet", rpcUrl: "https://rpc.testnet.chain.robinhood.com" };
  function log(msg, cls) {
    const t = new Date().toTimeString().slice(0,8);
    const el = document.getElementById("term");
    const div = document.createElement("div");
    div.className = "log-line";
    div.innerHTML = '<span class="ts">['+t+']</span><span class="prompt">$</span> ' + (cls === 'err' ? '<span class="err">'+msg+'</span>' : msg);
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }
  function setStep(n, state) {
    const s = document.getElementById("s"+n);
    if (s) { s.className = "pipe-step"; if (state === "active") s.classList.add("active"); if (state === "done") s.classList.add("done"); }
  }
  function setGate(state, label) {
    const g = document.getElementById("gate");
    const badge = document.getElementById("gate-status");
    if (g) g.setAttribute("data-state", state);
    if (badge && label) badge.textContent = label;
  }
  async function doPay() {
    const btn = document.getElementById("fetch");
    const res = document.getElementById("result");
    const city = document.getElementById("city").value || "New York";
    btn.disabled = true; btn.textContent = "⟳ PROCESSING...";
    res.classList.remove("show");
    ["s1","s2","s3","s4"].forEach(id => { const el = document.getElementById(id); if (el) el.className = "pipe-step"; });
    document.getElementById("tx-card").style.display = "none";
    setGate("scanning", "AUTHORIZING PAYMENT");
    try {
      // Step 1: 402 challenge
      log("GET /weather → expecting 402 Payment Required", "");
      setStep(1, "active");
      const r1 = await fetch("/weather", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ city }) });
      if (r1.status !== 402) throw new Error("Expected 402, got " + r1.status);
      const reqs = JSON.parse(r1.headers.get("Payment-Required") || "{}");
      log("← 402 Payment Required: " + reqs.amount + " " + reqs.token + " @ " + reqs.network, "");
      setStep(1, "done");
      // Step 2: EIP-3009 sign
      setStep(2, "active");
      log("Signing EIP-3009 TransferWithAuthorization...", "");
      const provider = new ethers.JsonRpcProvider(CHAIN.rpcUrl);
      const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
      const amount = ethers.parseUnits(reqs.amount, 6);
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const now = Math.floor(Date.now() / 1000);
      const domain = { name: "USDG", version: "2", chainId: CHAIN.chainId, verifyingContract: USDG };
      const types = {
              TransferWithAuthorization: [
                { name: "from", type: "address" },
                { name: "to", type: "address" },
                { name: "value", type: "uint256" },
                { name: "validAfter", type: "uint256" },
                { name: "validBefore", type: "uint256" },
                { name: "nonce", type: "bytes32" },
              ],
            };
      const msg = { from: wallet.address, to: "0x5131c099eB615227aB2Bb8b542D4cBd622910a25", value: amount, validAfter: 0, validBefore: now + 3600, nonce };
      const sig = await wallet.signTypedData(domain, types, msg);
      const payload = JSON.stringify({ ...msg, value: ethers.toQuantity(msg.value), validAfter: "0x0", validBefore: ethers.toQuantity(msg.validBefore), nonce, signature: sig });
      log("✓ Signed: r=" + sig.slice(0,70) + "...", "");
      setStep(2, "done");
      // Step 3: verify + settle
      setStep(3, "active");
      log("POST /weather with payment headers → facilitator verify + settle...", "");
      btn.textContent = "⟳ SETTLING ON-CHAIN...";
      const r2 = await fetch("/weather", {
        method: "POST",
        headers: { "Content-Type": "application/json", "payment-signature": sig, "payment-payload": payload, "payment-network": "eip155:46630" },
        body: JSON.stringify({ city }),
      });
      const data = await r2.json();
      if (!r2.ok) throw new Error(data.error || "Failed");
      setStep(3, "done");
      // Step 4: data
      setStep(4, "active");
      log("✓ Payment verified. Fetching weather data...", "");
      // Render
      document.getElementById("r-loc").textContent = "📍 " + (data.city||city) + ", " + (data.country||"");
      document.getElementById("r-temp").innerHTML = (data.temp_f||"?") + "<sup>°F</sup>";
      document.getElementById("r-desc").textContent = data.condition || "";
      document.getElementById("r-hum").textContent = (data.humidity||"?") + "%";
      document.getElementById("r-wind").textContent = data.wind || "—";
      document.getElementById("r-feels").textContent = (data.feels_like||"?") + "°F";
      document.getElementById("r-src").textContent = data.source || "wttr.in";
      if (data.settlement?.txHash) {
        document.getElementById("tx-card").style.display = "";
        const txHash = data.settlement.txHash;
        document.getElementById("r-tx").textContent = txHash.slice(0,10) + "..." + txHash.slice(-8);
        const txLink = document.getElementById("r-tx-link");
        txLink.href = "https://explorer.testnet.chain.robinhood.com/tx/" + txHash;
        document.getElementById("r-from").textContent = wallet.address.slice(0,10) + "..." + wallet.address.slice(-6);
        document.getElementById("r-to").textContent = "0x5131...a25";
        document.getElementById("r-amt").textContent = data.paid || "0.5 USDG";
        document.getElementById("r-net").textContent = "RH Testnet (46630)";
        log("✓ On-chain settlement: " + data.settlement.txHash, "");
      }
      log("✓ 200 OK — " + (data.temp_f||"?") + "°F " + (data.condition||""), "");
      setStep(4, "done");
      setGate("open", "GATE OPEN · ACCESS GRANTED");
      res.classList.add("show");
    } catch (e) {
      log("✗ ERROR: " + e.message, "err");
      setGate("denied", "ACCESS DENIED");
      document.getElementById("r-loc").textContent = "ERROR";
      document.getElementById("r-temp").innerHTML = "<span style='font-size:4rem'>⚠</span>";
      document.getElementById("r-desc").textContent = e.message;
      res.classList.add("show");
    } finally {
      btn.disabled = false; btn.textContent = "▶ Execute Payment";
      setTimeout(() => {
        const g = document.getElementById("gate");
        if (g && g.getAttribute("data-state") === "denied") setGate("idle", "GATE LOCKED");
      }, 3500);
    }
  }

  document.getElementById("fetch")?.addEventListener("click", doPay);
