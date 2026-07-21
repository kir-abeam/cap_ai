sap.ui.define([
  "sap/ui/core/Fragment",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast"
], function (Fragment, JSONModel, MessageToast) {
  "use strict";

  var SERVICE = "/invoice-review";

  return {
    /**
     * Custom Object Page header action: load the attachments of the current
     * Invoice and show them in a dialog with download/open links.
     * `this` is the extension API of the Object Page controller.
     */
    onShowAttachments: async function (oEvent) {
      var oContext = this.getBindingContext
        ? this.getBindingContext()
        : (oEvent && oEvent.getSource && oEvent.getSource().getBindingContext());

      if (!oContext) {
        MessageToast.show("No invoice selected.");
        return;
      }

      var oModel = oContext.getModel();

      // Navigate from the invoice context so attachments are read in the same
      // draft/active state as the parent. The entity is draft-enabled, so the
      // media stream key must include IsActiveEntity (see URL below).
      var oListBinding = oModel.bindList("attachments", oContext);

      var aContexts = await oListBinding.requestContexts(0, 100);
      var aItems = aContexts.map(function (oCtx) {
        var oData = oCtx.getObject();
        var sKey = "ID=" + oData.ID + ",IsActiveEntity=" + oData.IsActiveEntity;
        return {
          fileName: oData.fileName,
          mediaType: oData.mediaType,
          url: SERVICE + "/Attachments(" + sKey + ")/content"
        };
      });

      if (!this._pAttachmentsDialog) {
        this._pAttachmentsDialog = Fragment.load({
          name: "abeam.invoicereview.ext.AttachmentsDialog",
          controller: this
        }).then(function (oDialog) {
          return oDialog;
        });
      }

      var oDialog = await this._pAttachmentsDialog;
      oDialog.setModel(new JSONModel({ items: aItems }), "att");
      oDialog.open();
    },

    onOpenAttachment: function (oEvent) {
      var oItem = oEvent.getSource();
      var oData = oItem.getBindingContext("att").getObject();
      window.open(oData.url, "_blank");
    },

    onCloseAttachments: function (oEvent) {
      oEvent.getSource().getParent().close();
    }
  };
});
