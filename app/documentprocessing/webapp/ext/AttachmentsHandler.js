sap.ui.define([
  "sap/ui/core/Fragment",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast"
], function (Fragment, JSONModel, MessageToast) {
  "use strict";

  var SERVICE = "/sap/opu/odata4/sap/zapi_doc_ex_header_o4/srvd_a2x/sap/zui_invoice_review_o4/0001";

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

      // Navigate to this invoice's attachments via the S/4 _Attachment nav.
      // S/4 is draft-enabled, so the media key needs IsActiveEntity=true.
      var oListBinding = oModel.bindList("_Attachment", oContext);

      var aContexts = await oListBinding.requestContexts(0, 100);
      var aItems = aContexts.map(function (oCtx) {
        var oData = oCtx.getObject();
        var sKey = "AttachmentUUID=" + oData.AttachmentUUID + ",IsActiveEntity=true";
        return {
          fileName: oData.FileName,
          mediaType: oData.MediaType,
          url: SERVICE + "/Attachment(" + sKey + ")/Content"
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
