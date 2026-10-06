sap.ui.define([
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "sap/ui/model/odata/v4/ODataModel",
  "sap/ui/core/BusyIndicator"
], function (MessageToast, MessageBox, ODataModel, BusyIndicator) {
  "use strict";

  var DRAFT_ROOT = "/Email@com.sap.vocabularies.Common.v1.DraftRoot";
  var POSTING_SERVICE_PATH = "odata/v4/invoice-posting/";
  var oPostingModel;

  /**
   * InvoicePostingService lives on CAP; the main model may point at S/4 or at
   * the CAP mock. Derive CAP's root from the main service URL so it resolves
   * the same way everywhere: "…/sap/opu/odata4/…" (S/4, absolute locally or
   * app-relative in Work Zone) -> the part before "sap/opu/"; the mock
   * "/invoice-review/" -> "/".
   */
  function postingModel(oMainModel) {
    if (!oPostingModel) {
      var sMain = oMainModel.getServiceUrl();
      var i = sMain.indexOf("sap/opu/");
      oPostingModel = new ODataModel({ serviceUrl: (i >= 0 ? sMain.slice(0, i) : "/") + POSTING_SERVICE_PATH });
    }
    return oPostingModel;
  }

  function bullets(aTexts) {
    return aTexts.map(function (s) { return "\u2022 " + s; }).join("\n");
  }

  // Custom Object Page header actions.
  //  - Verify = post: InvoicePostingService.verifyInvoice posts the invoice to
  //    S/4 (FI vendor invoice, KR) and marks it Verified only if S/4 accepts it.
  //    On any error it stays Pending and editable, and S/4's messages are shown.
  //  - Reject drives the S/4 (or CAP mock) draft flow directly — Edit the owning
  //    Email, PATCH the invoice draft node, Activate; the draft action names are
  //    read from the Common.DraftRoot annotation so it works on both backends.
  var VerificationHandler = {

    onVerify: function (oEvent) {
      var oContext = VerificationHandler._context.call(this, oEvent);
      if (!oContext) return;

      var oData = oContext.getObject() || {};
      MessageBox.confirm(
        "Verify invoice " + (oData.DocumentNumber || "") + " (" + oData.TotalAmount + " " + oData.Currency +
          ") and post it to S/4?\n\nIf S/4 rejects the posting, the invoice stays Pending so you can correct it.",
        {
          title: "Verify and Post",
          onClose: function (sAction) {
            if (sAction === MessageBox.Action.OK) VerificationHandler._verifyAndPost(oContext);
          }
        });
    },

    onReject: function (oEvent) { return VerificationHandler._setStatus.call(this, oEvent, "R"); },

    /** `this` is the FE ExtensionAPI of the Invoice Object Page. */
    _context: function (oEvent) {
      var oContext = this.getBindingContext
        ? this.getBindingContext()
        : (oEvent && oEvent.getSource && oEvent.getSource().getBindingContext());
      if (!oContext) MessageToast.show("No invoice selected.");
      return oContext;
    },

    _verifyAndPost: async function (oContext) {
      BusyIndicator.show(0);
      try {
        var sInvoiceUUID = await oContext.requestProperty("InvoiceUUID");
        var oAction = postingModel(oContext.getModel()).bindContext("/verifyInvoice(...)");
        oAction.setParameter("invoiceUUID", sInvoiceUUID);
        await oAction.execute();
        var oResult = oAction.getBoundContext().getObject() || {};

        oContext.refresh();

        var sDoc = oResult.accountingDocument + "/" + oResult.fiscalYear;
        var sHead = oResult.target === "s4"
          ? "Verified \u2014 posted as accounting document " + sDoc + "."
          : "Verified \u2014 mock posting " + sDoc + " (nothing sent to S/4).";
        var aWarnings = (oResult.messages || [])
          .filter(function (m) { return m.severity === "warning"; })
          .map(function (m) { return m.text; });
        if (aWarnings.length) {
          MessageBox.warning(sHead + "\n\n" + bullets(aWarnings), { title: "Verified with warnings" });
        } else {
          MessageToast.show(sHead);
        }
      } catch (e) {
        // CAP joins multiple S/4 log messages with " | ".
        var sMsg = e && e.message ? e.message : String(e);
        var aParts = sMsg.replace(/^S\/4 rejected the posting:\s*/, "").split(" | ");
        MessageBox.error(
          (aParts.length > 1 || sMsg !== aParts[0] ? "S/4 rejected the posting:\n\n" + bullets(aParts) : sMsg) +
            "\n\nThe invoice is still Pending \u2014 correct the data and verify again.",
          { title: "Not verified" });
      } finally {
        BusyIndicator.hide();
      }
    },

    /**
     * `this` is the FE ExtensionAPI of the Invoice Object Page, so
     * this.getBindingContext() returns the (active) invoice context.
     */
    _setStatus: async function (oEvent, sCode) {
      var oContext = this.getBindingContext
        ? this.getBindingContext()
        : (oEvent && oEvent.getSource && oEvent.getSource().getBindingContext());

      if (!oContext) {
        MessageToast.show("No invoice selected.");
        return;
      }

      var oModel = oContext.getModel();

      try {
        // Only Pending invoices can be verified/rejected (safety net; the
        // manifest also disables the buttons via an expression binding).
        var sCurrent = await oContext.requestProperty("VerificationStatus");
        if (sCurrent !== "P") {
          MessageToast.show("Only pending invoices can be updated.");
          return;
        }

        var sEmailUUID   = await oContext.requestProperty("EmailUUID");
        var sInvoiceUUID = await oContext.requestProperty("InvoiceUUID");

        // Draft Edit/Activate action names differ per backend -> read them from
        // the DraftRoot annotation (CAP: ...draftEdit/draftActivate, S/4: Edit/Activate).
        var oDraftRoot = oModel.getMetaModel().getObject(DRAFT_ROOT) || {};
        var sEditAction     = oDraftRoot.EditAction;
        var sActivateAction = oDraftRoot.ActivationAction;
        if (!sEditAction || !sActivateAction) {
          MessageToast.show("Draft actions not found in service metadata.");
          return;
        }

        // 1. Edit the owning Email (active -> draft), creating the draft tree.
        var oEmailActive = oModel
          .bindContext("/Email(EmailUUID=" + sEmailUUID + ",IsActiveEntity=true)")
          .getBoundContext();
        var oEdit = oModel.bindContext(sEditAction + "(...)", oEmailActive);
        oEdit.setParameter("PreserveChanges", false);
        var oDraftEmail = await oEdit.execute();

        // 2. PATCH the invoice draft node's status (Promise resolves on PATCH completion).
        var oDraftInvoice = oModel
          .bindContext("/Invoice(InvoiceUUID=" + sInvoiceUUID + ",IsActiveEntity=false)")
          .getBoundContext();
        await oDraftInvoice.setProperty("VerificationStatus", sCode);

        // 3. Activate the Email draft (draft -> active).
        await oModel.bindContext(sActivateAction + "(...)", oDraftEmail).execute();

        // 4. Reflect the new active status in the page.
        oContext.refresh();
        MessageToast.show(sCode === "V" ? "Invoice verified." : "Invoice rejected.");
      } catch (e) {
        MessageToast.show("Could not update status: " + (e && e.message ? e.message : e));
      }
    }
  };

  return VerificationHandler;
});
