import { parseJSON, parseArray, encodeJSON } from "./model.mjs";
import {
  editableDocument,
  prepareDocument,
  documentChanges,
} from "./documents.mjs";
import { buildDocumentPatch } from "./fields.mjs";
import {
  t,
  message as msg,
  LocalizedError,
  setText,
  setAttr,
} from "./i18n.mjs";

export function createDocumentState() {
  return {
    snapshot: null,
    baseline: "",
    creating: false,
    fieldErrors: new Map(),
  };
}

export function createDocumentController(dependencies) {
  const {
    documentState,
    state,
    $,
    documentEditor,
    scope,
    partitionPaths,
    showDocument,
    knownFields,
    rememberKey,
    metrics,
    setDocumentView,
    status,
    confirmAction,
    pauseDiscovery,
    invoke,
    afterMutation,
    dirty,
    resetEditor,
  } = dependencies;
  function point() {
    const id = $("document-id").value;
    if (!id) throw new LocalizedError(msg("ui.enterADocumentId"));
    parseArray($("document-pk").value, msg("partition.key"));
    return { ...scope(), id, partitionKeyText: $("document-pk").value };
  }
  function opened(result, identity) {
    const doc = parseJSON(result.json),
      etag = result.etag || doc._etag;
    showDocument();
    knownFields().learn(doc);
    documentState.snapshot = { ...identity, etag };
    documentState.creating = false;
    documentState.baseline = encodeJSON(editableDocument(doc), null, 2);
    documentState.fieldErrors.clear();
    documentEditor.value = documentState.baseline;
    $("document-id").value = identity.id;
    $("document-pk").value = identity.partitionKeyText;
    rememberKey(identity.partitionKeyText);
    setText($("document-state"), () => t("document.full"));
    setText($("etag"), () =>
      etag ? `ETag: ${etag}` : t("ui.theServiceProvidedNoEtagUpdateAnd"),
    );
    metrics(result, msg("ui.documentRead"));
    $("field-filter").value = "";
    $("document-location").open = false;
    setText($("document-identity"), () => identity.id);
    setAttr($("document-identity"), "title", () => identity.id);
    setAttr($("etag"), "title", () => $("etag").textContent);
    setDocumentView(state.preferredDocumentView);
  }
  async function saveDocument(forceReplace = false) {
    if (documentState.fieldErrors.size)
      throw new LocalizedError(msg("ui.fixInvalidFieldValuesFirst2"));
    const text = documentEditor.value;
    const prepared = prepareDocument(
      text,
      $("document-pk").value,
      partitionPaths(),
      documentState.creating ? null : documentState.snapshot,
    );
    const doc = prepared.doc;
    const creating = documentState.creating,
      identity = creating
        ? {
            ...scope(),
            id: doc.id,
            partitionKeyText: prepared.partitionKeyText,
          }
        : documentState.snapshot;
    parseArray(identity.partitionKeyText, msg("partition.key"));
    if (
      !creating &&
      (doc.id !== identity.id || $("document-id").value !== identity.id)
    )
      throw new LocalizedError(msg("ui.idAndPartitionKeyCannotChangeDuring"));
    const changes = documentChanges(
      creating ? {} : parseJSON(documentState.baseline),
      doc,
    );
    if (!changes.length) {
      status(msg("ui.noFieldChangesToSave"));
      return;
    }
    const patch = !creating && !forceReplace;
    const operations = patch
      ? buildDocumentPatch(
          parseJSON(documentState.baseline),
          doc,
          partitionPaths(),
        )
      : null;
    if (
      !(await confirmAction(
        creating
          ? msg("ui.createDocument")
          : patch
            ? msg("ui.patchDocument")
            : msg("ui.replaceFullDocument"),
        msg("ui.idPartitionKey", () => [
          identity.database,
          identity.container,
          identity.id,
          identity.partitionKeyText,
          patch
            ? msg("ui.submitOnlyFieldOperations", () => [operations.length])
            : "",
        ]),
        changes,
      ))
    )
      return;
    await pauseDiscovery();
    const result = await invoke(
      creating ? "cosmos/create" : patch ? "cosmos/patch" : "cosmos/replace",
      {
        ...identity,
        ...(patch
          ? { operationsText: encodeJSON(operations) }
          : { documentText: prepared.text }),
      },
    );
    opened(result, identity);
    await afterMutation(result, identity, msg("document.save"));
  }
  async function deleteDocument() {
    if (dirty())
      throw new LocalizedError(msg("ui.unsavedChangesExistSaveOrReadThe"));
    const identity = documentState.snapshot;
    if (!identity) throw new LocalizedError(msg("ui.readTheFullDocumentFirst"));
    if (
      !(await confirmAction(
        msg("ui.permanentlyDeleteDocument"),
        msg("ui.idPartitionKeyThisCannotBeUndone", () => [
          identity.database,
          identity.container,
          identity.id,
          identity.partitionKeyText,
        ]),
        documentChanges(parseJSON(documentState.baseline), {}),
      ))
    )
      return;
    await pauseDiscovery();
    const result = await invoke("cosmos/delete", identity);
    resetEditor();
    await afterMutation(result, identity, msg("document.delete"));
  }
  return { point, opened, saveDocument, deleteDocument };
}
