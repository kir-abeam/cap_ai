sap.ui.define([
  "sap/ui/core/mvc/ControllerExtension"
], function (ControllerExtension) {
  "use strict";

  return ControllerExtension.extend("documentprocessing.ext.InvoiceEditLock", {

    _applyEditLock: function () {
      try {
        var oCtrl = this.base || this;
        var oView = oCtrl.getView && oCtrl.getView();

        if (!oView) {
          return;
        }

        // ============================================================
        // Email Object Page
        // ============================================================
        if (oView.getId().indexOf("EmailsObjectPage") !== -1) {

          var oEdit = oView.byId("fe::StandardAction::Edit");
          if (!oEdit) {
            return;
          }

          if (oEdit.data("editLockApplied")) {
            return;
          }

          var fnApply = function () {
            var oContext = oView.getBindingContext();

            if (!oContext) {
              console.log("Waiting for Email binding context...");
              return;
            }

            console.log("Email Context:", oContext.getPath());

            oEdit.data("editLockApplied", true);

            var oListBinding = oContext.getModel().bindList(
              "_Invoice",
              oContext
            );

            oListBinding.requestContexts(0, 100).then(function (aContexts) {

              var bVisible = aContexts.some(function (oCtx) {
                return oCtx.getProperty("VerificationStatus") === "P";
              });

              console.log("Invoices:", aContexts.length);
              console.log("Edit Visible:", bVisible);

              oEdit.setVisible(false);
            });
          };

          // Try immediately
          fnApply();

          // Retry when context changes
          oView.attachModelContextChange(fnApply);

          return;
        }

        // ============================================================
        // Invoice Object Page
        // ============================================================
        if (oView.getId().indexOf("InvoiceObjectPage") === -1) {
          return;
        }

        var oInvoiceEdit = oView.byId("fe::StandardAction::Edit");
        if (!oInvoiceEdit) {
          return;
        }

        if (oInvoiceEdit.data("editLockApplied")) {
          return;
        }

        oInvoiceEdit.data("editLockApplied", true);

        oInvoiceEdit.bindProperty("visible", {
          path: "VerificationStatus",
          targetType: "any",
          formatter: function (sStatus) {
            return sStatus === "P";
          }
        });

      } catch (e) {
        console.error(e);
      }
    },

    override: {
      onPageReady: function () { this._applyEditLock(); },
      onAfterRendering: function () { this._applyEditLock(); }
    }
  });
});
