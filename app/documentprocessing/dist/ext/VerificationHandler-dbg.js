sap.ui.define([
  "sap/m/MessageToast"
], function (MessageToast) {
  "use strict";

  var DRAFT_ROOT = "/Email@com.sap.vocabularies.Common.v1.DraftRoot";

  // Custom Object Page header actions: set an invoice's VerificationStatus by
  // driving the S/4 (or CAP mock) draft flow directly — Edit the owning Email,
  // PATCH the invoice draft node, Activate. No dedicated backend action is
  // needed; the draft Edit/Activate action names are read from the service's
  // Common.DraftRoot annotation so the same code works on both backends.
  var VerificationHandler = {

    onVerify: function (oEvent) { return VerificationHandler._setStatus.call(this, oEvent, "V"); },
    onReject: function (oEvent) { return VerificationHandler._setStatus.call(this, oEvent, "R"); },

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
