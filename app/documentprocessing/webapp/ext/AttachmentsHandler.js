sap.ui.define([
  "sap/ui/core/Fragment",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast"
], function (Fragment, JSONModel, MessageToast) {
  "use strict";

  var SERVICE = "/invoice-review";

  // Named singleton so it can be passed as the fragment's `controller`: the
  // `.onOpenAttachment` / `.onCloseAttachments` press handlers in
  // AttachmentsDialog.fragment.xml are resolved against that controller. (Note
  // `this` inside onShowAttachments is FE's ExtensionAPI, which lacks these
  // methods — passing `this` there is why the item press never fired.)
  var AttachmentsHandler = {
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

      // Navigate from the invoice context to read its attachments. Non-draft:
      // there is no IsActiveEntity, so the media stream key is just the ID.
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

      if (!AttachmentsHandler._pDialog) {
        AttachmentsHandler._pDialog = Fragment.load({
          name: "documentprocessing.ext.AttachmentsDialog",
          controller: AttachmentsHandler
        });
      }

      var oDialog = await AttachmentsHandler._pDialog;
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

  return AttachmentsHandler;
});
