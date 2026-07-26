sap.ui.define([
  "sap/ui/core/mvc/ControllerExtension"
], function (ControllerExtension) {
  "use strict";

  // Client-side edit lock for the DIRECT-TO-S/4 path (`cds watch --profile s4`).
  //
  // On the mock/CAP path a Verified/Rejected invoice is locked declaratively via
  // @Capabilities.UpdateRestrictions.Updatable = IsEditable (a CAP calculated
  // boolean). The live S/4 service exposes no such boolean, and OData's
  // UpdateRestrictions.Updatable needs a real boolean property path — so the same
  // lock can't be expressed in annotations.xml. Instead we hide the standard Edit
  // button on the Invoice Object Page unless the invoice is Pending, reactively
  // bound to VerificationStatus so it also disappears right after Verify/Reject.
  //
  // Shared by both Object Pages (Email + Invoice use the same FE controller); it
  // is a no-op on the Email page so the Email draft-root Edit stays available.
  return ControllerExtension.extend("documentprocessing.ext.InvoiceEditLock", {

    // Bind the Invoice OP's standard Edit button visibility to the invoice being
    // Pending. Idempotent: safe to call from several lifecycle hooks.
    _applyEditLock: function () {
      try {
        // `this.base` is the host FE controller; getView() is reliable there
        // (ControllerExtension's own getView() may be undefined).
        var oCtrl = this.base || this;
        var oView = oCtrl.getView && oCtrl.getView();
        // Only the Invoice Object Page (id: <app>::InvoiceObjectPage). No-op on
        // the Email page so its draft-root Edit button is untouched.
        if (!oView || oView.getId().indexOf("InvoiceObjectPage") === -1) return;

        // Local id of the FE Edit button (view id is stripped by byId).
        var oEdit = oView.byId("fe::StandardAction::Edit");
        if (!oEdit) return;                                  // not created yet
        if (oEdit.data("editLockApplied")) return;           // bind exactly once
        oEdit.data("editLockApplied", true);

        // Replace FE's own `visible` binding with ours: shown only while Pending.
        oEdit.bindProperty("visible", {
          path: "VerificationStatus",
          targetType: "any",   // don't auto-coerce the raw "V"/"R"/"P" string to Boolean
          formatter: function (sStatus) { return sStatus === "P"; }
        });
      } catch (e) {
        // Never break page rendering because of the lock.
      }
    },

    override: {
      onPageReady: function () { this._applyEditLock(); },
      onAfterRendering: function () { this._applyEditLock(); }
    }
  });
});
