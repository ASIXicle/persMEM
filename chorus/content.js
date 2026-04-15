/**
 * content.js — Chorus Content Script v0.3
 * Stop-button lifecycle as primary completion detection.
 * DOM silence (15s) as fallback. Ceiling as safety net.
 */

(() => {
  "use strict";

  if (window.__chorus_loaded) return;
  window.__chorus_loaded = true;

  // ── State ──
  let responseObserver = null;
  let completionTimer = null;
  let ceilingTimer = null;
  let currentCeilingMs = 300000;     // default 300s, overridden per-inject
  let lastInjectedText = "";         // track what we injected to filter from snippets

  // ── Text Injection ──
  function injectText(text) {
    const input = chorusQuery("input");
    if (!input) {
      console.error("[Chorus] Could not find input element");
      return false;
    }

    input.focus();

    const range = document.createRange();
    range.selectNodeContents(input);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("delete", false, null);

    document.execCommand("insertText", false, text);

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

  // ── Response Completion Detection (v0.3 — stop button primary) ──
  const STOP_BTN_APPEAR_TIMEOUT = 15000;  // 15s to detect generation start
  const POST_STOP_DEBOUNCE = 3000;        // 3s settle after stop btn disappears
  const DOM_SILENCE_FALLBACK = 15000;     // 15s DOM silence = fallback
  let stopBtnPollTimer = null;

  function watchForCompletion(callback) {
    stopWatching();

    const container = chorusQuery("responseContainer") || document.body;

    function declareComplete(source) {
      console.log(`[Chorus] Response complete (${source}, ceiling=${currentCeilingMs}ms)`);
      stopWatching();
      callback();
    }

    // ── PRIMARY: Stop button lifecycle ──
    // Phase 1: Wait for stop button to APPEAR (generation started)
    let stopBtnSeen = false;
    let phase1Start = Date.now();

    stopBtnPollTimer = setInterval(function() {
      const stopBtn = chorusQuery("streamingIndicator");

      if (!stopBtnSeen) {
        // Phase 1: looking for stop button to appear
        if (stopBtn) {
          stopBtnSeen = true;
          console.log("[Chorus] Stop button appeared — generation started");
        } else if (Date.now() - phase1Start > STOP_BTN_APPEAR_TIMEOUT) {
          // Stop button never appeared — fall back to DOM silence
          console.warn("[Chorus] Stop button never appeared, falling back to DOM silence");
          clearInterval(stopBtnPollTimer);
          stopBtnPollTimer = null;
          startDomSilenceFallback(container, declareComplete);
          return;
        }
      } else {
        // Phase 2: stop button was seen, waiting for it to DISAPPEAR
        if (!stopBtn) {
          console.log("[Chorus] Stop button disappeared — generation finished, debouncing...");
          clearInterval(stopBtnPollTimer);
          stopBtnPollTimer = null;

          // Short debounce for final DOM mutations to settle
          completionTimer = setTimeout(function() {
            const input = chorusQuery("input");
            const inputReady = input && (input.getAttribute("contenteditable") === "true");
            if (inputReady) {
              declareComplete("stop-button");
            } else {
              // Input not ready yet — wait a bit more
              console.log("[Chorus] Input not ready after stop btn gone, extending...");
              completionTimer = setTimeout(function() {
                declareComplete("stop-button-extended");
              }, POST_STOP_DEBOUNCE);
            }
          }, POST_STOP_DEBOUNCE);
          return;
        }
      }
    }, 500);  // poll every 500ms

    // ── SAFETY NET: Ceiling timeout ──
    ceilingTimer = setTimeout(function() {
      console.log(`[Chorus] Ceiling timeout reached (${currentCeilingMs}ms)`);
      declareComplete("ceiling");
    }, currentCeilingMs);
  }

  // ── FALLBACK: DOM silence (only if stop button detection fails) ──
  function startDomSilenceFallback(target, declareComplete) {
    function resetFallbackTimer() {
      clearTimeout(completionTimer);
      completionTimer = setTimeout(function() {
        const input = chorusQuery("input");
        const inputReady = input && (input.getAttribute("contenteditable") === "true");
        if (inputReady) {
          declareComplete("dom-silence-fallback");
        } else {
          resetFallbackTimer();
        }
      }, DOM_SILENCE_FALLBACK);
    }

    responseObserver = new MutationObserver(function(mutations) {
      if (mutations.length > 0) {
        resetFallbackTimer();
      }
    });

    responseObserver.observe(target, {
      childList: true, subtree: true, characterData: true,
    });

    resetFallbackTimer();
  }

  function stopWatching() {
    if (responseObserver) {
      responseObserver.disconnect();
      responseObserver = null;
    }
    if (stopBtnPollTimer) {
      clearInterval(stopBtnPollTimer);
      stopBtnPollTimer = null;
    }
    clearTimeout(completionTimer);
    clearTimeout(ceilingTimer);
  }

  function countResponses() {
    return chorusQueryAll("responseMessage").length;
  }

  function getLastResponseSnippet() {
    var msgs = chorusQueryAll("responseMessage");
    if (msgs.length === 0) return "";

    // Walk backward to find the last message that ISN'T our injected prompt
    var injectedPrefix = lastInjectedText.substring(0, 40);
    for (var i = msgs.length - 1; i >= 0; i--) {
      var text = (msgs[i].textContent || msgs[i].innerText || "").trim();
      if (text.length === 0) continue;
      // Skip if this message starts with our injected text
      if (injectedPrefix && text.indexOf(injectedPrefix) === 0) continue;
      // Skip very short fragments (UI artifacts)
      if (text.length < 20) continue;
      return text.slice(-500);
    }
    // Fallback: return whatever the last message has
    var last = msgs[msgs.length - 1];
    return (last.textContent || last.innerText || "").trim().slice(-500);
  }

  // ── Message Handler ──
  browser.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    if (msg.type === "chorus:inject") {
      var text = msg.text;

      // Accept ceiling from background.js
      if (msg.ceilingMs && msg.ceilingMs > 0) {
        currentCeilingMs = msg.ceilingMs;
      }

      console.log('[Chorus] Injecting (ceiling=' + currentCeilingMs + 'ms): "' +
        text.substring(0, 60) + '..."');

      lastInjectedText = text;  // save for snippet filtering

      var injected = injectText(text);
      if (!injected) {
        sendResponse({ success: false, error: "input not found" });
        return;
      }

      setTimeout(function() {
        var submitted = clickSubmit();
        if (!submitted) {
          sendResponse({ success: false, error: "submit failed" });
          return;
        }

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

      return true;
    }

    if (msg.type === "chorus:ping") {
      sendResponse({ alive: true, url: window.location.href });
      return;
    }
  });

  console.log("[Chorus] Content script v0.3 loaded (stop-button completion detection)");
})();
