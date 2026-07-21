sap.ui.define([
  "sap/base/security/sanitizeHTML"
], function (sanitizeHTML) {
  "use strict";

  return {
    /**
     * Sanitize untrusted email HTML before it is injected into the DOM by
     * sap.ui.core.HTML. sanitizeHTML strips <script>, on* handlers and
     * javascript: URIs (stored-XSS protection). Wrapped in a single root
     * <div> because sap.ui.core.HTML requires exactly one root element.
     */
    sanitize: function (sHtml) {
      var sSafe = sHtml ? sanitizeHTML(sHtml) : "";
      return "<div class=\"invoiceEmailBody\">" + sSafe + "</div>";
    }
  };
});
