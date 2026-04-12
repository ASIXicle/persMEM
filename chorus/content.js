/**
 * content.js — Chorus Content Script
 * Injected into claude.ai tabs. Handles:
 *   - Text injection into ProseMirror input
 *   - Submit button click
 *   - Response completion detection
 *   - Response text extraction (for loop termination)
 *   - Communication with background script
 */

(() => {
  "use strict";

  // Prevent double-injection
  if (window.__chorus_loaded) return;
  window.__chorus_loaded = true;

  // ── State ──
  let responseObserver = null;
  let completionTimer = null;
  let ceilingTimer = null;
  const DEBOUNCE_FAST_MS = 5000;    // 5s silence = probably done
  const DEBOUNCE_CEILING_MS = 90000; // 90s max — hard safety limit

  // ── Text Injection ──
  function injectText(text) {
    const input = chorusQuery("input");
    if (!input) {
      console.error("[Chorus] Could not find input element");
      return false;
    }

    input.focus();

    // Select only the input's content (not the whole page).
    const range = document.createRange();
    range.selectNodeContents(input);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("delete", false, null);

    // Insert new text
    document.execCommand("insertText", false, text);

    // Belt-and-suspenders: dispatch InputEvent
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: text,
    }));

    return true;
  }

  // ── Submit ──
  function clickSubmit() {
    const btn = chorusQuery("submit");
    if (btn && !btn.disabled) {
      btn.click();
      return true;
    }

    // Fallback: try Enter key on the input
    const input = chorusQuery("input");
    if (input) {
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }));
      return true;
    }

    console.error("[Chorus] Could not find submit button");
    return false;
  }

  // ── Response Completion Detection ──
  // Dual-timer approach:
  //   FAST PATH: 5s of DOM mutation silence = response probably done
  //   CEILING:   90s max timeout = declare complete no matter what
  function watchForCompletion(callback) {
    stopWatching();

    const container = chorusQuery("responseContainer");
    if (!container) {
      console.warn("[Chorus] No response container found, using body");
    } else {
      console.log("[Chorus] Response container:", container.tagName, container.className.substring(0, 60));
    }

    const target = container || document.body;

    function declareComplete(source) {
      const streaming = chorusQuery("streamingIndicator");
      if (streaming) {
        if (source === "fast") {
          resetFastTimer();
          return;
        }
        console.warn("[Chorus] Ceiling override — streaming indicator still present");
      }

      const input = chorusQuery("input");
      const inputReady = input && (input.getAttribute("contenteditable") === "true");

      if (!inputReady && source === "fast") {
        resetFastTimer();
        return;
      }

      console.log(`[Chorus] Response complete (${source} path)`);
      stopWatching();
      callback();
    }

    function resetFastTimer() {
      clearTimeout(completionTimer);
      completionTimer = setTimeout(function() { declareComplete("fast"); }, DEBOUNCE_FAST_MS);
    }

    // Hard ceiling — declare complete after 90s no matter what
    ceilingTimer = setTimeout(function() {
      console.log("[Chorus] Ceiling timeout reached");
      declareComplete("ceiling");
    }, DEBOUNCE_CEILING_MS);

    responseObserver = new MutationObserver(function(mutations) {
      if (mutations.length > 0) {
        resetFastTimer();
      }
    });

    responseObserver.observe(target, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Start the initial fast timer
    resetFastTimer();
  }

  function stopWatching() {
    if (responseObserver) {
      responseObserver.disconnect();
      responseObserver = null;
    }
    clearTimeout(completionTimer);
    clearTimeout(ceilingTimer);
  }

  // ── Count response messages ──
  function countResponses() {
    return chorusQueryAll("responseMessage").length;
  }

  // ── Extract last response text (for empty-inbox detection) ──
  function getLastResponseSnippet() {
    var msgs = chorusQueryAll("responseMessage");
    if (msgs.length === 0) return "";
    var last = msgs[msgs.length - 1];
    var text = (last.textContent || last.innerText || "").trim();
    // Return last 500 chars — enough for background.js to detect
    // "No new AMQ messages" without transferring entire response
    return text.slice(-500);
  }

  // ── Message Handler ──
  browser.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    if (msg.type === "chorus:inject") {
      var text = msg.text;
      var beforeCount = countResponses();

      console.log('[Chorus] Injecting: "' + text.substring(0, 60) + '..."');

      var injected = injectText(text);
      if (!injected) {
        sendResponse({ success: false, error: "input not found" });
        return;
      }

      // Small delay to let ProseMirror process, then submit
      setTimeout(function() {
        var submitted = clickSubmit();
        if (!submitted) {
          sendResponse({ success: false, error: "submit failed" });
          return;
        }

        // Clear input after submit so next round injects cleanly.
        setTimeout(function() {
          var input = chorusQuery("input");
          if (input) {
            input.innerHTML = "";
            input.dispatchEvent(new InputEvent("input", {
              bubbles: true,
              inputType: "deleteContent",
            }));
          }
        }, 500);

        // Watch for response completion
        watchForCompletion(function() {
          var snippet = getLastResponseSnippet();
          console.log("[Chorus] Response complete, snippet: " +
            snippet.substring(0, 80) + "...");
          browser.runtime.sendMessage({
            type: "chorus:response-complete",
            tabId: msg.tabId,
            responseSnippet: snippet,
          });
        });

        sendResponse({ success: true });
      }, 200);

      return true; // async sendResponse
    }

    if (msg.type === "chorus:ping") {
      sendResponse({ alive: true, url: window.location.href });
      return;
    }
  });

  console.log("[Chorus] Content script loaded on", window.location.href);
})();
