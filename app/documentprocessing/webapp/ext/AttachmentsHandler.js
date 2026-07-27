sap.ui.define([
  "sap/ui/core/Fragment",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast"
], function (Fragment, JSONModel, MessageToast) {
  "use strict";

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

      // Base URL comes from the model (the manifest `mainService` uri), so the
      // same code hits the CAP mock or S/4 without a hardcoded constant. It
      // already ends with "/" — appending another one yields an empty first
      // path segment, which CAP rejects with
      // 404 Invalid resource path "InvoiceReviewService.".
      var sBase = oModel.getServiceUrl();

      var aContexts = await oListBinding.requestContexts(0, 100);
      var aItems = aContexts.map(function (oCtx) {
        var oData = oCtx.getObject();
        // Draft-enabled on both backends: the media key needs IsActiveEntity,
        // taken from the row so a draft attachment resolves too.
        var sKey = "AttachmentUUID=" + oData.AttachmentUUID +
          ",IsActiveEntity=" + (oData.IsActiveEntity === false ? "false" : "true");
        return {
          fileName: oData.FileName,
          mediaType: oData.MediaType,
          url: sBase + "Attachment(" + sKey + ")/Content"
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

    /**
     * Open the attachment in a new tab.
     *
     * The two backends answer `GET .../Content` differently and neither can be
     * handed straight to `window.open`:
     *  - S/4: `Content` is a plain `Edm.Binary` property (the EDMX has no
     *    `HasStream`/`Core.MediaType`), so OData returns a JSON object whose
     *    `value` is the payload in **base64url** — that JSON is what the browser
     *    would render.
     *  - CAP mock: `@Core.MediaType` makes it a real stream, so the bytes come
     *    back as `application/pdf`.
     * Both are normalised here into a Blob carrying the row's MediaType, so the
     * tab displays the PDF inline instead of downloading or printing base64.
     */
    onOpenAttachment: async function (oEvent) {
      var oData = oEvent.getSource().getBindingContext("att").getObject();

      // Opened synchronously: a window.open after the await below is not tied to
      // the click gesture any more and gets swallowed by the popup blocker.
      var oWindow = window.open("", "_blank");

      try {
        // No explicit `accept`: the mock's media stream answers 406 to
        // `application/json`, and S/4 defaults a property GET to JSON anyway —
        // so the response content-type below is what tells the two apart.
        var oResponse = await fetch(oData.url);
        if (!oResponse.ok) throw new Error(oResponse.status + " " + oResponse.statusText);

        var sContentType = oResponse.headers.get("content-type") || "";
        var oBlob;
        if (sContentType.indexOf("application/json") === 0) {
          var oJson = await oResponse.json();
          oBlob = AttachmentsHandler._toBlob(oJson.value, oData.mediaType);
        } else {
          oBlob = await oResponse.blob();
          oBlob = oBlob.slice(0, oBlob.size, oData.mediaType || oBlob.type);
        }

        var sObjectUrl = URL.createObjectURL(oBlob);
        if (oWindow) oWindow.location.href = sObjectUrl;
        else window.open(sObjectUrl, "_blank");
        // The tab keeps its own reference once loaded; free ours.
        setTimeout(function () { URL.revokeObjectURL(sObjectUrl); }, 60000);
      } catch (oError) {
        if (oWindow) oWindow.close();
        MessageToast.show("Could not open " + oData.fileName + ": " + oError.message);
      }
    },

    /**
     * base64 (S/4 emits the **URL-safe** alphabet, `-`/`_`, and drops padding)
     * to a typed Blob.
     */
    _toBlob: function (sBase64, sMediaType) {
      var sStandard = String(sBase64 || "").replace(/-/g, "+").replace(/_/g, "/");
      while (sStandard.length % 4) sStandard += "=";

      var sBinary = atob(sStandard);
      var aBytes = new Uint8Array(sBinary.length);
      for (var i = 0; i < sBinary.length; i++) aBytes[i] = sBinary.charCodeAt(i);

      return new Blob([aBytes], { type: sMediaType || "application/octet-stream" });
    },

    onCloseAttachments: function (oEvent) {
      oEvent.getSource().getParent().close();
    }
  };

  return AttachmentsHandler;
});
