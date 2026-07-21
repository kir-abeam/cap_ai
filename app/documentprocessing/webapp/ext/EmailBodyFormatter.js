sap.ui.define([], function () {
  "use strict";

  /**
   * Decode a base64 string into UTF-8 HTML. atob yields a binary string
   * (one byte per char), so we rebuild the byte array and run it through
   * TextDecoder to correctly restore multi-byte UTF-8 characters. Returns
   * the input unchanged if it is not valid base64.
   */
  function decodeBase64(sBase64) {
    try {
      var sBinary = window.atob(sBase64);
      var aBytes = new Uint8Array(sBinary.length);
      for (var i = 0; i < sBinary.length; i++) {
        aBytes[i] = sBinary.charCodeAt(i);
      }
      return new TextDecoder("utf-8").decode(aBytes);
    } catch (e) {
      // Not valid base64 — fall back to treating it as plain HTML.
      return sBase64;
    }
  }

  /**
   * Escape a string so it is safe inside a double-quoted HTML attribute
   * (the iframe's srcdoc). Only & and " can break out of the attribute; the
   * rest is HTML that the iframe document parses on its own.
   */
  function escapeAttr(sValue) {
    return sValue.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  }

  return {
    /**
     * Render an Outlook-style HTML email as a sandboxed iframe.
     *
     * Why an iframe: Outlook emails are full HTML documents whose layout
     * depends on their own <style> blocks. sap.ui.core.HTML injects into the
     * app's own DOM, so those styles would either be stripped (unreadable) or
     * leak into and break the Fiori shell. An iframe is a separate document
     * with an isolated DOM/CSS scope, so the email renders faithfully and its
     * CSS cannot escape.
     *
     * Why sandbox="" (empty): the most restrictive setting — the frame is
     * treated as a unique origin and script execution, forms, popups and
     * same-origin access are all blocked. That neutralises untrusted email
     * HTML (stored-XSS) without having to strip its markup, so we no longer
     * need sanitizeHTML. srcdoc carries the decoded document inline.
     *
     * The iframe is a single root element, which sap.ui.core.HTML requires.
     * Height is fixed (iframes do not auto-size to content) with internal
     * scrolling.
     */
    sanitize: function (sBase64Html) {
      var sHtml = sBase64Html ? decodeBase64(sBase64Html) : "";
      return "<iframe class=\"invoiceEmailBody\" sandbox=\"\" " +
        "style=\"width:100%;height:600px;border:none;\" " +
        "srcdoc=\"" + escapeAttr(sHtml) + "\"></iframe>";
    }
  };
});
