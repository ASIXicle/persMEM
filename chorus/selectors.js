/**
 * selectors.js — Chorus DOM Selectors
 * 
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  EDIT THIS FILE when Anthropic updates the Claude UI.       ║
 * ║  All DOM interaction goes through these selectors.          ║
 * ║  Each selector has multiple fallbacks — try them in order.  ║
 * ╚══════════════════════════════════════════════════════════════╝
 * 
 * Last verified: April 2026
 */

const CHORUS_SELECTORS = {

  // The text input area (ProseMirror contenteditable div)
  input: [
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"][data-testid]',
    'div[contenteditable="true"][class*="composer"]',
    'div[contenteditable="true"][placeholder]',
    'div[contenteditable="true"]',
  ],

  // The send/submit button
  submit: [
    'button[aria-label="Send Message"]',
    'button[aria-label="Send"]',
    'button[data-testid="send-button"]',
    'form button[type="submit"]',
    // Last resort: find the button nearest to the input area
  ],

  // The container where Claude's response streams in
  // Used by MutationObserver to detect response completion
  responseContainer: [
    '[data-testid="chat-message-list"]',
    'div[class*="thread"]',
    'div[class*="chat-messages"]',
    'div[class*="conversation-"]',
    'div[class*="messages-"]',
    '[role="log"]',
    '[role="presentation"]',
    'div[class*="react-scroll"]',
    'main div[style*="overflow"]',
    'main',
  ],

  // Individual response message blocks
  responseMessage: [
    '[data-testid="chat-message"]',
    'div[class*="message"]',
  ],

  // Streaming indicator (appears while Claude is typing)
  streamingIndicator: [
    '[data-testid="stop-button"]',
    'button[aria-label="Stop Response"]',
    'button[aria-label="Stop"]',
    'div[class*="streaming"]',
    'div[class*="loading"]',
  ],

  // Conversation title (for auto-detecting which tab is Kite/Wren)
  conversationTitle: [
    'h1',
    '[data-testid="conversation-title"]',
    'title',
  ],
};

/**
 * Find the first matching element from a list of selector fallbacks.
 * Returns null if none match.
 */
function chorusQuery(selectorKey) {
  const selectors = CHORUS_SELECTORS[selectorKey];
  if (!selectors) return null;
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/**
 * Find all matching elements from a list of selector fallbacks.
 * Returns results from the first selector that matches anything.
 */
function chorusQueryAll(selectorKey) {
  const selectors = CHORUS_SELECTORS[selectorKey];
  if (!selectors) return [];
  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    if (els.length > 0) return Array.from(els);
  }
  return [];
}
