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

  // Auto-size bounds for the email panel: short emails collapse to MIN_HEIGHT
  // (px); long ones grow up to MAX_VIEWPORT_FRACTION of the window height and
  // then scroll inside the iframe, so a long email fills the screen.
  var MIN_HEIGHT = 80;
  var MAX_VIEWPORT_FRACTION = 0.68;

  /** Measure the iframe's document and set its height, clamped to [MIN, ~vh]. */
  function resizeToContent(iframe) {
    try {
      var doc = iframe.contentDocument;
      if (!doc || !doc.body) { return; }
      var content = Math.max(
        doc.body.scrollHeight, doc.documentElement.scrollHeight
      );
      var maxH = Math.round((window.innerHeight || 900) * MAX_VIEWPORT_FRACTION);
      var h = Math.min(Math.max(content + 4, MIN_HEIGHT), maxH);
      iframe.style.height = h + "px";
    } catch (e) {
      // contentDocument unreachable — leave the initial height as-is.
    }
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
     * Why sandbox="allow-same-origin" (but NOT allow-scripts): the email's own
     * scripts still cannot run (stored-XSS stays mitigated without needing
     * sanitizeHTML), but same-origin lets the parent read the framed document's
     * scrollHeight so the panel can auto-size to the email (see
     * onAfterRendering). srcdoc carries the decoded document inline.
     *
     * The iframe is a single root element (required by sap.ui.core.HTML). It
     * starts at MIN_HEIGHT; onAfterRendering grows it to fit the content up to
     * MAX_HEIGHT, after which the iframe scrolls internally.
     */
    sanitize: function (sBase64Html) {
      var sHtml = sBase64Html ? decodeBase64(sBase64Html) : "";
      return "<iframe class=\"invoiceEmailBody\" sandbox=\"allow-same-origin\" " +
        "style=\"width:100%;height:" + MIN_HEIGHT + "px;border:none;" +
        "display:block;overflow:auto;\" " +
        "srcdoc=\"" + escapeAttr(sHtml) + "\"></iframe>";
    },

    /**
     * afterRendering handler for the sap.ui.core.HTML control: locate the
     * iframe and size it to its content once the email document has loaded.
     */
    onAfterRendering: function (oEvent) {
      var oDom = oEvent.getSource() && oEvent.getSource().getDomRef();
      if (!oDom) { return; }
      var iframe = oDom.tagName === "IFRAME"
        ? oDom
        : oDom.querySelector("iframe.invoiceEmailBody");
      if (!iframe) { return; }
      var doResize = function () { resizeToContent(iframe); };
      // srcdoc may not have parsed yet at render time, so resize on load too,
      // and re-measure on window resize so the viewport cap stays accurate.
      iframe.addEventListener("load", doResize);
      if (!iframe._emailResizeBound) {
        window.addEventListener("resize", doResize);
        iframe._emailResizeBound = true;
      }
      doResize();
    }
  };
});
