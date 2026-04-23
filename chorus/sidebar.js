/**
 * sidebar.js — Chorus Sidebar Logic v0.5.0
 * Three-instance support with fire-first ordering.
 */

(() => {
  "use strict";

  const selKite  = document.getElementById("sel-kite");
  const selWren  = document.getElementById("sel-wren");
  const selThird = document.getElementById("sel-third");
  const inputThirdName = document.getElementById("input-third-name");
  const btnRefresh = document.getElementById("btn-refresh");
  const btnAssign  = document.getElementById("btn-assign");
  const inputMsg   = document.getElementById("input-msg");
  const inputRounds = document.getElementById("input-rounds");
  const inputCeiling = document.getElementById("input-ceiling");
  const selMode    = document.getElementById("sel-mode");
  const selFireFirst = document.getElementById("sel-fire-first");
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

    for (const sel of [selKite, selWren, selThird]) {
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
    // Restore third agent by finding non-kite/wren key
    for (const key of Object.keys(saved)) {
      if (key !== "kite" && key !== "wren") {
        selThird.value = saved[key];
        inputThirdName.value = key;
        break;
      }
    }
  }

  // ── Assign tabs ──
  async function assignTabs() {
    const kiteId = parseInt(selKite.value, 10);
    const wrenId = parseInt(selWren.value, 10);
    const thirdId = parseInt(selThird.value, 10);
    const thirdName = (inputThirdName.value || "").trim().toLowerCase();

    if (!kiteId || !wrenId) {
      setStatus("error", "Select Kite and Wren tabs");
      return;
    }

    const ids = [kiteId, wrenId];
    if (thirdId) ids.push(thirdId);
    const unique = new Set(ids);
    if (unique.size !== ids.length) {
      setStatus("error", "All tabs must be different");
      return;
    }

    if (thirdId && !thirdName) {
      setStatus("error", "Enter a name for the third instance");
      return;
    }

    if (thirdName === "kite" || thirdName === "wren") {
      setStatus("error", "Third name can't be kite or wren");
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

    if (thirdId && thirdName) {
      await browser.runtime.sendMessage({
        type: "chorus:register",
        agent: thirdName,
        tabId: thirdId,
      });
      setStatus("complete", `Tabs assigned ✓ (${thirdName})`);
    } else {
      setStatus("complete", "Tabs assigned ✓ (2 agents)");
    }
  }

  // ── Fire ──
  async function fire() {
    const text = inputMsg.value.trim();
    if (!text) {
      setStatus("error", "Enter a message");
      return;
    }

    const _r = parseInt(inputRounds.value, 10);
    const rounds = Number.isFinite(_r) ? _r : 3;
    const _c = parseInt(inputCeiling.value, 10);
    const ceilingSec = Number.isFinite(_c) ? _c : 300;
    const ceilingMs = ceilingSec * 1000;
    const mode = selMode.value || "roundrobin";
    const fireFirst = selFireFirst.value || "";

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
        fireFirst: fireFirst,
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
      btnFire.textContent = "▶ Fire All";
      btnStop.style.display = "none";
    }
  }

  // ── Status updates from background ──
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "chorus:status") {
      const { state, round, maxRounds, agentLabel } = msg;

      if (state === "firing") {
        const label = round === 0 ? "Initial prompt" : `Exchange ${round}`;
        setStatus("firing", `${label} — waiting...`);
        roundEl.textContent = `${round} / ${maxRounds}`;
      } else if (state === "firing-agent") {
        const label = agentLabel || "agent";
        setStatus("firing", `Exchange ${round} — ${label} responding...`);
        roundEl.textContent = `${round} / ${maxRounds}`;
      } else if (state === "complete") {
        const label = round === 0 ? "Initial" : `Exchange ${round}`;
        setStatus("complete", `${label} complete`);
      } else if (state === "done") {
        setStatus("complete", "All exchanges complete ✓");
        roundEl.textContent = "";
      } else if (state === "done-early") {
        setStatus("complete", "All empty — stopped at exchange " + round + " ✓");
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
