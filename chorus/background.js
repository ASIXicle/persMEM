/**
 * background.js — Chorus Background Script
 * Coordinates between sidebar and content scripts.
 * Manages the multi-turn AMQ exchange loop.
 */

(() => {
  "use strict";

  // ── State ──
  let tabMap = {};        // { "kite": tabId, "wren": tabId }
  let pendingTabs = {};   // tabs we're waiting on for response completion
  let loopState = null;   // { round, maxRounds, resolve }
  let lastResponses = {}; // { agent: "response snippet" } — for empty detection

  const AMQ_CHECK_PROMPT = 
    "[AMQ-CHECK] Check your AMQ inbox (amq_check). " +
    "Read and respond to any messages from the other instance via amq_send. " +
    "If no new messages, reply with: No new AMQ messages.";

  const NO_MSG_PATTERNS = [
    /no new amq messages/i,
    /no new messages/i,
    /inbox.*empty/i,
    /new_count.*0/i,
  ];

  // Wraps the user's prompt so both instances write to AMQ before
  // the check round fires. Without this, both check simultaneously,
  // find empty mailboxes, and the loop dies on round 1.
  function wrapInitialPrompt(text) {
    return "[CHORUS] " + text + "\n\n" +
      "After processing, write your key thoughts/analysis to AMQ " +
      "(amq_send from yourself to the other instance) so they can " +
      "read and respond. Then answer normally.";
  }

  function responseIsEmpty(text) {
    if (!text) return false;
    // Check last 500 chars of response for no-message indicators
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

  async function sendToTab(tabId, text) {
    try {
      const response = await browser.tabs.sendMessage(tabId, {
        type: "chorus:inject",
        text: text,
        tabId: tabId,
      });
      return response;
    } catch (e) {
      console.error(`[Chorus] Failed to send to tab ${tabId}:`, e);
      return { success: false, error: e.message };
    }
  }

  // ── Multi-Turn AMQ Loop ──

  async function fireToAllTabs(text) {
    await loadTabMap();
    const agents = Object.keys(tabMap);
    if (agents.length === 0) {
      return { error: "No tabs registered" };
    }

    // Track which tabs we're waiting on
    pendingTabs = {};
    lastResponses = {};
    for (const agent of agents) {
      pendingTabs[tabMap[agent]] = agent;
    }

    // Send to all tabs
    const results = {};
    for (const agent of agents) {
      const tabId = tabMap[agent];
      try {
        // Verify tab still exists
        await browser.tabs.get(tabId);
        const res = await sendToTab(tabId, text);
        results[agent] = res;
      } catch (e) {
        results[agent] = { success: false, error: "tab closed or unreachable" };
        delete pendingTabs[tabId];
      }
    }

    return results;
  }

  function allTabsComplete() {
    return Object.keys(pendingTabs).length === 0;
  }

  async function runLoop(text, maxRounds) {
    const status = [];

    // Round 0: Fire initial prompt (wrapped with AMQ write instruction)
    console.log(`[Chorus] Round 0: firing initial prompt`);
    broadcastStatus("firing", 0, maxRounds);
    const r0 = await fireToAllTabs(wrapInitialPrompt(text));
    status.push({ round: 0, type: "initial", results: r0 });

    // Wait for all responses
    await waitForAllResponses();
    broadcastStatus("complete", 0, maxRounds);

    // Rounds 1..N: AMQ check loop
    for (let round = 1; round <= maxRounds; round++) {
      console.log(`[Chorus] Round ${round}: AMQ check`);
      broadcastStatus("firing", round, maxRounds);

      const rN = await fireToAllTabs(AMQ_CHECK_PROMPT);
      status.push({ round, type: "amq_check", results: rN });

      await waitForAllResponses();
      broadcastStatus("complete", round, maxRounds);

      // Early termination: if both instances reported no messages, stop
      if (allResponsesEmpty()) {
        console.log(`[Chorus] Round ${round}: both instances report empty — terminating early`);
        broadcastStatus("done-early", round, maxRounds);
        return status;
      }
    }

    broadcastStatus("done", maxRounds, maxRounds);
    return status;
  }

  function waitForAllResponses() {
    return new Promise((resolve) => {
      if (allTabsComplete()) {
        resolve();
        return;
      }
      loopState = { resolve };
    });
  }

  function broadcastStatus(state, round, maxRounds) {
    browser.runtime.sendMessage({
      type: "chorus:status",
      state,
      round,
      maxRounds,
    }).catch(() => {}); // sidebar might not be open
  }

  // ── Message Handlers ──

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    // Content script reports response complete
    if (msg.type === "chorus:response-complete") {
      const tabId = msg.tabId || (sender.tab && sender.tab.id);
      if (tabId && pendingTabs[tabId]) {
        const agent = pendingTabs[tabId];
        console.log(`[Chorus] ${agent} (tab ${tabId}) response complete`);

        // Store response snippet for empty detection
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

    // Sidebar: register a tab
    if (msg.type === "chorus:register") {
      registerTab(msg.agent, msg.tabId).then(() => {
        sendResponse({ success: true });
      });
      return true;
    }

    // Sidebar: get registered tabs
    if (msg.type === "chorus:get-tabs") {
      getRegisteredTabs().then((tabs) => {
        sendResponse(tabs);
      });
      return true;
    }

    // Sidebar: fire prompt with AMQ loop
    if (msg.type === "chorus:fire") {
      const { text, rounds } = msg;
      runLoop(text, rounds || 3).then((status) => {
        sendResponse({ success: true, status });
      }).catch((e) => {
        sendResponse({ success: false, error: e.message });
      });
      return true;
    }

    // Sidebar: fire to single tab (for testing)
    if (msg.type === "chorus:fire-single") {
      sendToTab(msg.tabId, msg.text).then((res) => {
        sendResponse(res);
      });
      return true;
    }

    // Sidebar: list Claude tabs for registration
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

  console.log("[Chorus] Background script loaded");
})();
