/**
 * sidebar.js — Chorus Sidebar Logic
 */

(() => {
  "use strict";

  const selKite  = document.getElementById("sel-kite");
  const selWren  = document.getElementById("sel-wren");
  const btnRefresh = document.getElementById("btn-refresh");
  const btnAssign  = document.getElementById("btn-assign");
  const inputMsg   = document.getElementById("input-msg");
  const inputRounds = document.getElementById("input-rounds");
  const btnFire    = document.getElementById("btn-fire");
  const statusEl   = document.getElementById("status");
  const roundEl    = document.getElementById("round-display");

  let firing = false;

  // ── Refresh available Claude tabs ──
  async function refreshTabs() {
    const tabs = await browser.runtime.sendMessage({
      type: "chorus:list-claude-tabs",
    });

    // Populate both selects
    for (const sel of [selKite, selWren]) {
      const currentVal = sel.value;
      sel.innerHTML = '<option value="">—</option>';
      for (const tab of tabs) {
        const opt = document.createElement("option");
        opt.value = tab.id;
        // Show conversation title, truncated
        const title = (tab.title || "Claude").substring(0, 50);
        opt.textContent = `[${tab.id}] ${title}`;
        sel.appendChild(opt);
      }
      // Restore previous selection if still valid
      if (currentVal) sel.value = currentVal;
    }

    // Try to restore from saved assignments
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

    firing = true;
    btnFire.disabled = true;
    btnFire.textContent = "Running...";
    setStatus("firing", "Sending to both tabs...");

    try {
      const result = await browser.runtime.sendMessage({
        type: "chorus:fire",
        text: text,
        rounds: rounds,
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
    }
  }

  // ── Status updates from background ──
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "chorus:status") {
      const { state, round, maxRounds } = msg;
      if (state === "firing") {
        const label = round === 0 ? "Initial prompt" : `AMQ Round ${round}`;
        setStatus("firing", `${label} — waiting for responses...`);
        roundEl.textContent = `${round} / ${maxRounds}`;
      } else if (state === "complete") {
        const label = round === 0 ? "Initial" : `Round ${round}`;
        setStatus("complete", `${label} complete`);
      } else if (state === "done") {
        setStatus("complete", "All rounds complete ✓");
        roundEl.textContent = "";
      } else if (state === "done-early") {
        setStatus("complete", "Both empty — stopped at round " + round + " ✓");
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

  // Ctrl+Enter to fire
  inputMsg.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !firing) {
      e.preventDefault();
      fire();
    }
  });

  // Initial load
  refreshTabs();
})();
