/**
 * selectors.js — Chorus DOM Selectors
 * 
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  EDIT THIS FILE when Anthropic updates the Claude UI.       ║
 * ║  All DOM interaction goes through these selectors.          ║
 * ║  Each selector has multiple fallbacks — try them in order.  ║
 * ╚══════════════════════════════════════════════════════════════╝
 * 
 * Last verified: April 15, 2026 (Stop response = lowercase r)
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
    'button[aria-label="Send message"]',
    'button[aria-label="Send Message"]',
    'button[aria-label="Send"]',
    'button[data-testid="send-button"]',
    'form button[type="submit"]',
  ],

  // The container where Claude's response streams in
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
    'button[aria-label="Stop response"]',   // CURRENT — lowercase r (verified Apr 2026)
    'button[aria-label="Stop Response"]',   // legacy fallback
    '[data-testid="stop-button"]',          // testid fallback
    'button[aria-label="Stop"]',            // broad fallback
    'div[class*="streaming"]',
    'div[class*="loading"]',
  ],

  // Conversation title
  conversationTitle: [
    'h1',
    '[data-testid="conversation-title"]',
    'title',
  ],
};

function chorusQuery(selectorKey) {
  const selectors = CHORUS_SELECTORS[selectorKey];
  if (!selectors) return null;
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function chorusQueryAll(selectorKey) {
  const selectors = CHORUS_SELECTORS[selectorKey];
  if (!selectors) return [];
  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    if (els.length > 0) return Array.from(els);
  }
  return [];
}
