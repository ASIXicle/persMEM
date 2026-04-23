/**
 * background.js — Chorus Background Script v0.5.0
 * Three-instance round-robin with configurable fire-first ordering.
 * Stop-button completion detection, manual stop, follow-up prompts.
 */

(() => {
  "use strict";

  // ── State ──
  let tabMap = {};
  let pendingTabs = {};
  let loopState = null;
  let lastResponses = {};
  let stopRequested = false;

  // Agent order for round-robin. fireFirst moves selected agent to front.
  function getAgentOrder(fireFirst) {
    const order = [];
    if (tabMap["kite"]) order.push("kite");
    if (tabMap["wren"]) order.push("wren");
    // Any agent that isn't kite or wren is the third
    for (const agent of Object.keys(tabMap)) {
      if (agent !== "kite" && agent !== "wren") order.push(agent);
    }
    // Reorder if fireFirst is set
    if (fireFirst) {
      // __third__ resolves to the actual third agent name
      const resolved = fireFirst === "__third__"
        ? order.find(a => a !== "kite" && a !== "wren") || ""
        : fireFirst;
      const idx = order.indexOf(resolved);
      if (idx > 0) {
        order.splice(idx, 1);
        order.unshift(resolved);
      }
    }
    return order;
  }

  const AMQ_CHECK_PROMPT =
    "[AMQ-CHECK] Check your AMQ inbox (amq_check). " +
    "Read and respond to any messages from the other instances via amq_send. " +
    "If no new messages, reply with: No new AMQ messages.";

  const NO_MSG_PATTERNS = [
    /no new amq messages/i,
    /no new messages/i,
    /inbox.*empty/i,
    /new_count.*0/i,
  ];

  function wrapInitialPrompt(text) {
    return "[CHORUS] " + text + "\n\n" +
      "After processing, write your key thoughts/analysis to AMQ " +
      "(amq_send from yourself to the other instances) so they can " +
      "read and respond. Then answer normally.";
  }

  function wrapFollowUpPrompt(text, priorAgents) {
    const names = priorAgents.map(a => a.charAt(0).toUpperCase() + a.slice(1));
    const nameStr = names.join(" and ");
    return "[CHORUS] " + text + "\n\n" +
      "IMPORTANT: " + nameStr +
      " already processed this prompt and wrote analysis to AMQ. " +
      "Check your AMQ inbox FIRST (amq_check + amq_read), then build on " +
      "their analysis rather than duplicating work. Write your additional " +
      "thoughts/analysis to AMQ, then answer normally.";
  }

  function responseIsEmpty(text) {
    if (!text) return false;
    var tail = text.slice(-500).toLowerCase();
    for (var i = 0; i < NO_MSG_PATTERNS.length; i++) {
      if (NO_MSG_PATTERNS[i].test(tail)) return true;
    }
    return false;
  }

  function allResponsesEmpty() {
    var agents = Object.keys(lastResponses);
    if (agents.length === 0) return false;
    for (var i = 0; i < agents.length; i++) {
      if (!responseIsEmpty(lastResponses[agents[i]])) return false;
    }
    return true;
  }

  // ── Tab Management ──

  async function loadTabMap() {
    const data = await browser.storage.local.get("chorusTabMap");
    tabMap = data.chorusTabMap || {};
  }

  async function saveTabMap() {
    await browser.storage.local.set({ chorusTabMap: tabMap });
  }

  async function registerTab(agent, tabId) {
    await loadTabMap();
    tabMap[agent] = tabId;
    await saveTabMap();
    console.log(`[Chorus] Registered ${agent} → tab ${tabId}`);
  }

  async function getRegisteredTabs() {
    await loadTabMap();
    return { ...tabMap };
  }

  // ── Send to Tab ──

  async function sendToTab(tabId, text, ceilingMs) {
    try {
      // Focus the tab before injecting to avoid Firefox background throttling
      await browser.tabs.update(tabId, { active: true });
      const response = await browser.tabs.sendMessage(tabId, {
        type: "chorus:inject",
        text: text,
        tabId: tabId,
        ceilingMs: ceilingMs || 300000,
      });
      return response;
    } catch (e) {
      console.error(`[Chorus] Failed to send to tab ${tabId}:`, e);
      return { success: false, error: e.message };
    }
  }

  // ── Fire to all tabs (simultaneous mode) ──

  async function fireToAllTabs(text, ceilingMs) {
    await loadTabMap();
    const agents = Object.keys(tabMap);
    if (agents.length === 0) return { error: "No tabs registered" };

    pendingTabs = {};
    lastResponses = {};
    for (const agent of agents) {
      pendingTabs[tabMap[agent]] = agent;
    }

    const results = {};
    for (const agent of agents) {
      const tabId = tabMap[agent];
      try {
        await browser.tabs.get(tabId);
        const res = await sendToTab(tabId, text, ceilingMs);
        results[agent] = res;
      } catch (e) {
        results[agent] = { success: false, error: "tab closed or unreachable" };
        delete pendingTabs[tabId];
      }
    }
    return results;
  }

  // ── Fire to single tab and wait ──

  async function fireToOneTab(agent, text, ceilingMs) {
    await loadTabMap();
    const tabId = tabMap[agent];
    if (!tabId) {
      console.error(`[Chorus] No tab registered for ${agent}`);
      return { error: `No tab registered for ${agent}` };
    }

    pendingTabs = {};
    lastResponses = {};
    pendingTabs[tabId] = agent;

    try {
      await browser.tabs.get(tabId);
      const res = await sendToTab(tabId, text, ceilingMs);
      if (!res || !res.success) {
        console.error(`[Chorus] ${agent} tab ${tabId} injection failed:`, res);
        delete pendingTabs[tabId];
      } else {
        console.log(`[Chorus] ${agent} tab ${tabId} injection OK, waiting for completion`);
      }
      return res;
    } catch (e) {
      console.error(`[Chorus] ${agent} tab ${tabId} unreachable:`, e.message);
      delete pendingTabs[tabId];
      return { success: false, error: "tab closed or unreachable" };
    }
  }

  function allTabsComplete() {
    return Object.keys(pendingTabs).length === 0;
  }

  // ── Main Loop ──

  async function runLoop(text, maxRounds, mode, ceilingMs, fireFirst) {
    const status = [];
    const ceiling = ceilingMs || 300000;
    stopRequested = false;
    await loadTabMap();

    const deadTabTimeout = Math.round(ceiling * 1.5);
    const agents = getAgentOrder(fireFirst);
    const agentCount = agents.length;

    if (agentCount === 0) {
      broadcastStatus("error", 0, maxRounds);
      return [{ error: "No tabs registered" }];
    }

    // Round 0: Fire initial prompt — round-robin through all agents
    console.log(`[Chorus] Round 0: firing initial prompt (${mode} mode, ${ceiling}ms ceiling, ${agentCount} agents)`);

    if (mode === "roundrobin") {
      for (let i = 0; i < agentCount; i++) {
        const agent = agents[i];
        const label = agent.charAt(0).toUpperCase() + agent.slice(1);
        broadcastStatus("firing-agent", 0, maxRounds, label);

        let prompt;
        if (i === 0) {
          prompt = wrapInitialPrompt(text);
        } else {
          prompt = wrapFollowUpPrompt(text, agents.slice(0, i));
        }

        await fireToOneTab(agent, prompt, ceiling);
        await waitForAllResponses(deadTabTimeout);
        if (stopRequested) { broadcastStatus("stopped", 0, maxRounds); return status; }
      }
      status.push({ round: 0, type: "initial-roundrobin" });
    } else {
      broadcastStatus("firing", 0, maxRounds);
      const r0 = await fireToAllTabs(wrapInitialPrompt(text), ceiling);
      status.push({ round: 0, type: "initial", results: r0 });
      await waitForAllResponses(deadTabTimeout);
      if (stopRequested) { broadcastStatus("stopped", 0, maxRounds); return status; }
    }

    broadcastStatus("complete", 0, maxRounds);

    // Rounds 1..N
    for (let round = 1; round <= maxRounds; round++) {
      if (stopRequested) {
        console.log(`[Chorus] Stop requested — halting at round ${round}`);
        broadcastStatus("stopped", round, maxRounds);
        return status;
      }

      console.log(`[Chorus] Round ${round}: AMQ check (${mode})`);

      if (mode === "roundrobin") {
        let allEmpty = true;

        for (let i = 0; i < agentCount; i++) {
          const agent = agents[i];
          const label = agent.charAt(0).toUpperCase() + agent.slice(1);
          broadcastStatus("firing-agent", round, maxRounds, label);

          await fireToOneTab(agent, AMQ_CHECK_PROMPT, ceiling);
          await waitForAllResponses(deadTabTimeout);
          if (stopRequested) { broadcastStatus("stopped", round, maxRounds); return status; }

          const resp = lastResponses[agent];
          if (resp && resp !== "[TIMEOUT — no response]" && !responseIsEmpty(resp)) {
            allEmpty = false;
          }
        }

        status.push({ round, type: "roundrobin", allEmpty });
        broadcastStatus("complete", round, maxRounds);

        if (allEmpty) {
          console.log(`[Chorus] Round ${round}: all empty — terminating`);
          broadcastStatus("done-early", round, maxRounds);
          return status;
        }

      } else {
        // ── Simultaneous: original behavior ──
        broadcastStatus("firing", round, maxRounds);
        const rN = await fireToAllTabs(AMQ_CHECK_PROMPT, ceiling);
        status.push({ round, type: "amq_check", results: rN });

        await waitForAllResponses(deadTabTimeout);
        broadcastStatus("complete", round, maxRounds);

        if (allResponsesEmpty()) {
          console.log(`[Chorus] Round ${round}: all empty — terminating`);
          broadcastStatus("done-early", round, maxRounds);
          return status;
        }
      }
    }

    broadcastStatus("done", maxRounds, maxRounds);
    return status;
  }

  function waitForAllResponses(timeoutMs) {
    return new Promise((resolve) => {
      if (allTabsComplete()) {
        resolve();
        return;
      }
      loopState = { resolve };

      if (timeoutMs && timeoutMs > 0) {
        setTimeout(() => {
          if (!allTabsComplete()) {
            const deadAgents = Object.values(pendingTabs);
            console.warn(`[Chorus] Dead-tab timeout: ${deadAgents.join(", ")} did not respond within ${timeoutMs}ms`);
            for (const agent of deadAgents) {
              lastResponses[agent] = "[TIMEOUT — no response]";
            }
            pendingTabs = {};
            if (loopState) {
              loopState.resolve();
              loopState = null;
            }
          }
        }, timeoutMs);
      }
    });
  }

  function broadcastStatus(state, round, maxRounds, agentLabel) {
    browser.runtime.sendMessage({
      type: "chorus:status",
      state,
      round,
      maxRounds,
      agentLabel: agentLabel || null,
    }).catch(() => {});
  }

  // ── Message Handlers ──

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    if (msg.type === "chorus:response-complete") {
      const tabId = msg.tabId || (sender.tab && sender.tab.id);
      if (tabId && pendingTabs[tabId]) {
        const agent = pendingTabs[tabId];
        console.log(`[Chorus] ${agent} (tab ${tabId}) response complete`);

        if (msg.responseSnippet) {
          lastResponses[agent] = msg.responseSnippet;
          console.log(`[Chorus] ${agent} snippet: "${msg.responseSnippet.substring(0, 80)}..."`);
        }

        delete pendingTabs[tabId];

        if (allTabsComplete() && loopState) {
          loopState.resolve();
          loopState = null;
        }
      }
      return;
    }

    if (msg.type === "chorus:register") {
      registerTab(msg.agent, msg.tabId).then(() => {
        sendResponse({ success: true });
      });
      return true;
    }

    if (msg.type === "chorus:get-tabs") {
      getRegisteredTabs().then((tabs) => {
        sendResponse(tabs);
      });
      return true;
    }

    if (msg.type === "chorus:fire") {
      const { text, rounds, mode, ceilingMs, fireFirst } = msg;
      runLoop(text, rounds ?? 3, mode || "roundrobin", ceilingMs || 300000, fireFirst || "").then((status) => {
        sendResponse({ success: true, status });
      }).catch((e) => {
        sendResponse({ success: false, error: e.message });
      });
      return true;
    }

    if (msg.type === "chorus:stop") {
      console.log("[Chorus] Stop requested by user");
      stopRequested = true;
      sendResponse({ success: true });
      return;
    }

    if (msg.type === "chorus:fire-single") {
      sendToTab(msg.tabId, msg.text, msg.ceilingMs).then((res) => {
        sendResponse(res);
      });
      return true;
    }

    if (msg.type === "chorus:list-claude-tabs") {
      browser.tabs.query({ url: "*://claude.ai/*" }).then((tabs) => {
        sendResponse(tabs.map(t => ({
          id: t.id,
          title: t.title,
          url: t.url,
        })));
      });
      return true;
    }
  });

  console.log("[Chorus] Background script v0.5.0 loaded (3-instance round-robin, fire-first ordering)");
})();
