/**
 * sidebar.js — Chorus Sidebar Logic v0.2
 * Adds mode toggle (round-robin vs simultaneous) and ceiling config.
 */

(() => {
  "use strict";

  const selKite  = document.getElementById("sel-kite");
  const selWren  = document.getElementById("sel-wren");
  const btnRefresh = document.getElementById("btn-refresh");
  const btnAssign  = document.getElementById("btn-assign");
  const inputMsg   = document.getElementById("input-msg");
  const inputRounds = document.getElementById("input-rounds");
  const inputCeiling = document.getElementById("input-ceiling");
  const selMode    = document.getElementById("sel-mode");
  const btnFire    = document.getElementById("btn-fire");
  const btnStop    = document.getElementById("btn-stop");
  const statusEl   = document.getElementById("status");
  const roundEl    = document.getElementById("round-display");

  let firing = false;

  // ── Refresh available Claude tabs ──
  async function refreshTabs() {
    const tabs = await browser.runtime.sendMessage({
      type: "chorus:list-claude-tabs",
    });

    for (const sel of [selKite, selWren]) {
      const currentVal = sel.value;
      sel.innerHTML = '<option value="">—</option>';
      for (const tab of tabs) {
        const opt = document.createElement("option");
        opt.value = tab.id;
        const title = (tab.title || "Claude").substring(0, 50);
        opt.textContent = `[${tab.id}] ${title}`;
        sel.appendChild(opt);
      }
      if (currentVal) sel.value = currentVal;
    }

    const saved = await browser.runtime.sendMessage({
      type: "chorus:get-tabs",
    });
    if (saved.kite) selKite.value = saved.kite;
    if (saved.wren) selWren.value = saved.wren;
  }

  // ── Assign tabs ──
  async function assignTabs() {
    const kiteId = parseInt(selKite.value, 10);
    const wrenId = parseInt(selWren.value, 10);

    if (!kiteId || !wrenId) {
      setStatus("error", "Select both tabs");
      return;
    }
    if (kiteId === wrenId) {
      setStatus("error", "Must be different tabs");
      return;
    }

    await browser.runtime.sendMessage({
      type: "chorus:register",
      agent: "kite",
      tabId: kiteId,
    });
    await browser.runtime.sendMessage({
      type: "chorus:register",
      agent: "wren",
      tabId: wrenId,
    });

    setStatus("complete", "Tabs assigned ✓");
  }

  // ── Fire ──
  async function fire() {
    const text = inputMsg.value.trim();
    if (!text) {
      setStatus("error", "Enter a message");
      return;
    }

    const rounds = parseInt(inputRounds.value, 10) || 3;
    const ceilingSec = parseInt(inputCeiling.value, 10) || 300;
    const ceilingMs = ceilingSec * 1000;
    const mode = selMode.value || "roundrobin";

    firing = true;
    btnFire.disabled = true;
    btnFire.textContent = "Running...";
    btnStop.style.display = "block";
    setStatus("firing", `Sending (${mode}, ${ceilingSec}s ceiling)...`);

    try {
      const result = await browser.runtime.sendMessage({
        type: "chorus:fire",
        text: text,
        rounds: rounds,
        mode: mode,
        ceilingMs: ceilingMs,
      });

      if (result.success) {
        setStatus("complete", "All rounds complete ✓");
      } else {
        setStatus("error", result.error || "Failed");
      }
    } catch (e) {
      setStatus("error", e.message);
    } finally {
      firing = false;
      btnFire.disabled = false;
      btnFire.textContent = "▶ Fire Both";
      btnStop.style.display = "none";
    }
  }

  // ── Status updates from background ──
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "chorus:status") {
      const { state, round, maxRounds } = msg;

      if (state === "firing") {
        const label = round === 0 ? "Initial prompt" : `Exchange ${round}`;
        setStatus("firing", `${label} — waiting...`);
        roundEl.textContent = `${round} / ${maxRounds}`;
      } else if (state === "firing-kite") {
        setStatus("firing", `Exchange ${round} — Kite responding...`);
        roundEl.textContent = `${round} / ${maxRounds}`;
      } else if (state === "firing-wren") {
        setStatus("firing", `Exchange ${round} — Wren responding...`);
        roundEl.textContent = `${round} / ${maxRounds}`;
      } else if (state === "complete") {
        const label = round === 0 ? "Initial" : `Exchange ${round}`;
        setStatus("complete", `${label} complete`);
      } else if (state === "done") {
        setStatus("complete", "All exchanges complete ✓");
        roundEl.textContent = "";
      } else if (state === "done-early") {
        setStatus("complete", "Both empty — stopped at exchange " + round + " ✓");
        roundEl.textContent = "";
      } else if (state === "stopped") {
        setStatus("complete", "Stopped by user at exchange " + round + " ✓");
        roundEl.textContent = "";
      }
    }
  });

  // ── Helpers ──
  function setStatus(cls, text) {
    statusEl.className = `status ${cls}`;
    statusEl.textContent = text;
  }

  // ── Events ──
  btnRefresh.addEventListener("click", refreshTabs);
  btnAssign.addEventListener("click", assignTabs);
  btnFire.addEventListener("click", fire);
  btnStop.addEventListener("click", function() {
    browser.runtime.sendMessage({ type: "chorus:stop" });
    setStatus("complete", "Stopped by user ✓");
    btnStop.style.display = "none";
  });

  inputMsg.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !firing) {
      e.preventDefault();
      fire();
    }
  });

  refreshTabs();
})();
