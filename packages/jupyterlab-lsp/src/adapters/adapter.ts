import { JupyterFrontEnd } from '@jupyterlab/application';
import { CodeEditor } from '@jupyterlab/codeeditor';
import { DocumentRegistry, IDocumentWidget } from '@jupyterlab/docregistry';
import { IVirtualEditor } from '../virtual/editor';
import { IForeignContext, VirtualDocument } from '../virtual/document';
import { Signal } from '@lumino/signaling';
import { IRootPosition, IVirtualPosition } from '../positioning';
import { LSPConnection } from '../connection';
import { ICommandContext } from '../command_manager';
import { JSONObject } from '@lumino/coreutils';
import {
  DocumentConnectionManager,
  IDocumentConnectionData,
  ISocketConnectionOptions
} from '../connection_manager';
import { ILSPExtension } from '../index';
import { IFeatureEditorIntegration, IFeature } from '../feature';
import { EditorAdapter } from '../editor_integration/editor_adapter';
import IEditor = CodeEditor.IEditor;
import { LanguageIdentifier } from '../lsp';

export class StatusMessage {
  /**
   * The text message to be shown on the statusbar
   */
  message: string;
  changed: Signal<StatusMessage, void>;
  private timer: number;

  constructor() {
    this.message = '';
    this.changed = new Signal(this);
    this.timer = null;
  }

  /**
   * Set the text message and (optionally) the timeout to remove it.
   * @param message
   * @param timeout - number of ms to until the message is cleaned;
   *        -1 if the message should stay up indefinitely;
   *        defaults to 3000ms (3 seconds)
   */
  set(message: string, timeout: number = 1000 * 3) {
    this.expire_timer();
    this.message = message;
    this.changed.emit();
    if (timeout !== -1) {
      this.timer = window.setTimeout(this.clear.bind(this), timeout);
    }
  }

  clear() {
    this.message = '';
    this.changed.emit();
  }

  private expire_timer() {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = 0;
    }
  }
}

/**
 * The values should follow the https://microsoft.github.io/language-server-protocol/specification guidelines
 */
const mime_type_language_map: JSONObject = {
  'text/x-rsrc': 'r',
  'text/x-r-source': 'r',
  // currently there are no LSP servers for IPython we are aware of
  'text/x-ipython': 'python'
};

export interface IEditorChangedData {
  editor: CodeEditor.IEditor;
}

/**
 * Foreign code: low level adapter is not aware of the presence of foreign languages;
 * it operates on the virtual document and must not attempt to infer the language dependencies
 * as this would make the logic of inspections caching impossible to maintain, thus the WidgetAdapter
 * has to handle that, keeping multiple connections and multiple virtual documents.
 */
export abstract class WidgetAdapter<T extends IDocumentWidget> {
  protected adapters: Map<
    VirtualDocument.id_path,
    EditorAdapter<IVirtualEditor<IEditor>>
  >;
  public adapterConnected: Signal<WidgetAdapter<T>, IDocumentConnectionData>;
  public isConnected: boolean;
  public connection_manager: DocumentConnectionManager;
  public status_message: StatusMessage;
  protected isDisposed = false;

  protected app: JupyterFrontEnd;

  public activeEditorChanged: Signal<WidgetAdapter<T>, IEditorChangedData>;
  public update_finished: Promise<void>;

  /**
   * (re)create virtual document using current path and language
   */
  abstract create_virtual_document(): VirtualDocument;

  abstract get_editor_index_at(position: IVirtualPosition): number;

  abstract get_editor_index(ce_editor: CodeEditor.IEditor): number;

  abstract get_editor_wrapper(ce_editor: CodeEditor.IEditor): HTMLElement;

  // note: it could be using namespace/IOptions pattern,
  // but I do not know how to make it work with the generic type T
  // (other than using 'any' in the IOptions interface)
  protected constructor(protected extension: ILSPExtension, public widget: T) {
    this.app = extension.app;
    this.connection_manager = extension.connection_manager;
    this.adapterConnected = new Signal(this);
    this.activeEditorChanged = new Signal(this);
    this.adapters = new Map();
    this.status_message = new StatusMessage();
    this.isConnected = false;

    // set up signal connections
    this.widget.context.saveState.connect(this.on_save_state, this);
    this.connection_manager.closed.connect(this.on_connection_closed, this);
    this.widget.disposed.connect(this.dispose, this);
  }

  protected get foreign_code_extractors() {
    return this.extension.foreign_code_extractors;
  }

  protected get code_overrides() {
    return this.extension.code_overrides;
  }

  on_connection_closed(
    manager: DocumentConnectionManager,
    { virtual_document }: IDocumentConnectionData
  ) {
    console.log(
      'LSP: connection closed, disconnecting adapter',
      virtual_document.id_path
    );
    if (virtual_document !== this.virtual_editor?.virtual_document) {
      return;
    }
    this.dispose();
  }

  dispose() {
    if (this.isDisposed) {
      return;
    }

    if (this.virtual_editor?.virtual_document) {
      this.disconnect_adapter(this.virtual_editor?.virtual_document);
    }

    this.widget.context.saveState.disconnect(this.on_save_state, this);
    this.connection_manager.closed.disconnect(this.on_connection_closed, this);
    this.widget.disposed.disconnect(this.dispose, this);
    this.widget.context.model.contentChanged.disconnect(
      this.onContentChanged,
      this
    );

    for (let adapter of this.adapters.values()) {
      adapter.dispose();
    }
    this.adapters.clear();

    this.connection_manager.disconnect_document_signals(
      this.virtual_editor.virtual_document
    );
    this.virtual_editor.dispose();

    // just to be sure
    this.virtual_editor = null;
    this.app = null;
    this.widget = null;
    this.connection_manager = null;
    this.widget = null;

    this.isDisposed = true;
  }

  virtual_editor: IVirtualEditor<IEditor>;

  abstract get document_path(): string;

  abstract get mime_type(): string;

  get widget_id(): string {
    return this.widget.id;
  }

  get language(): LanguageIdentifier {
    // the values should follow https://microsoft.github.io/language-server-protocol/specification guidelines,
    // see the table in https://microsoft.github.io/language-server-protocol/specification#textDocumentItem
    if (mime_type_language_map.hasOwnProperty(this.mime_type)) {
      return mime_type_language_map[this.mime_type] as string;
    } else {
      let without_parameters = this.mime_type.split(';')[0];
      let [type, subtype] = without_parameters.split('/');
      if (type === 'application' || type === 'text') {
        if (subtype.startsWith('x-')) {
          return subtype.substr(2);
        } else {
          return subtype;
        }
      } else {
        return this.mime_type;
      }
    }
  }

  abstract get language_file_extension(): string;

  // equivalent to triggering didClose and didOpen, as per syncing specification,
  // but also reloads the connection; used during file rename (or when it was moved)
  protected reload_connection() {
    // ignore premature calls (before the editor was initialized)
    if (this.virtual_editor == null) {
      return;
    }

    // disconnect all existing connections (and dispose adapters)
    this.connection_manager.unregister_document(
      this.virtual_editor.virtual_document
    );

    // recreate virtual document using current path and language
    let virtual_document = this.create_virtual_document();
    this.virtual_editor.virtual_document = virtual_document;
    // reconnect
    this.connect_document(virtual_document, true).catch(console.warn);
  }

  protected on_save_state(context: any, state: DocumentRegistry.SaveState) {
    // ignore premature calls (before the editor was initialized)
    if (this.virtual_editor == null) {
      return;
    }

    if (state === 'completed') {
      for (let connection of this.connection_manager.connections.values()) {
        connection.sendSaved(
          this.virtual_editor.virtual_document.document_info
        );
      }
    }
  }

  abstract activeEditor: CodeEditor.IEditor;

  abstract get editors(): CodeEditor.IEditor[];

  /**
   * public for use in tests (but otherwise could be private)
   */
  public update_documents() {
    if (this.isDisposed) {
      console.warn('Cannot update documents: adapter disposed');
      return;
    }
    return this.virtual_editor.virtual_document.update_manager.update_documents(
      this.editors.map(ce_editor => {
        return {
          ce_editor: ce_editor,
          value: this.virtual_editor.get_editor_value(ce_editor)
        };
      })
    );
  }

  get has_multiple_editors(): boolean {
    return this.editors.length > 1;
  }

  protected async on_connected(data: IDocumentConnectionData) {
    let { virtual_document } = data;

    this.connect_adapter(data.virtual_document, data.connection);
    this.adapterConnected.emit(data);
    this.isConnected = true;

    await this.update_documents().then(() => {
      // refresh the document on the LSP server
      this.document_changed(virtual_document, virtual_document, true);

      console.log(
        'LSP: virtual document(s) for',
        this.document_path,
        'have been initialized'
      );
    });
  }

  /**
   * Opens a connection for the document. The connection may or may
   * not be initialized, yet, and depending on when this is called, the client
   * may not be fully connected.
   *
   * @param virtual_document a VirtualDocument
   * @param send_open whether to open the document immediately
   */
  protected async connect_document(
    virtual_document: VirtualDocument,
    send_open = false
  ): Promise<void> {
    virtual_document.changed.connect(this.document_changed, this);

    virtual_document.foreign_document_opened.connect(
      this.on_foreign_document_opened,
      this
    );

    const connection_context = await this.connect(virtual_document).catch(
      console.warn
    );

    if (!send_open) {
      return;
    }

    if (connection_context && connection_context.connection) {
      connection_context.connection.sendOpenWhenReady(
        virtual_document.document_info
      );
    } else {
      console.warn(`Connection for ${virtual_document.path} was not opened`);
    }
  }

  private create_virtual_editor(
    options: IVirtualEditor.IOptions
  ): IVirtualEditor<IEditor> {
    let editorType = this.extension.editor_type_manager.findBestImplementation(
      this.editors
    );
    if (editorType == null) {
      return null;
    }
    let virtualEditorConstructor = editorType.implementation;
    return new virtualEditorConstructor(options);
  }

  protected init_virtual() {
    let virtual_editor = this.create_virtual_editor({
      adapter: this,
      virtual_document: this.create_virtual_document()
    });
    if (virtual_editor == null) {
      console.error('Could not initialize a VirtualEditor for adapter: ', this);
      return;
    }
    this.virtual_editor = virtual_editor;
  }

  /**
   * Handler for opening a document contained in a parent document. The assumption
   * is that the editor already exists for this, and as such the document
   * should be queued for immediate opening.
   *
   * @param host the VirtualDocument that contains the VirtualDocument in another language
   * @param context information about the foreign VirtualDocument
   */
  protected async on_foreign_document_opened(
    host: VirtualDocument,
    context: IForeignContext
  ) {
    const { foreign_document } = context;

    await this.connect_document(foreign_document, true);

    foreign_document.foreign_document_closed.connect(
      this.on_foreign_document_closed,
      this
    );
  }

  private on_foreign_document_closed(
    host: VirtualDocument,
    context: IForeignContext
  ) {
    const { foreign_document } = context;
    foreign_document.foreign_document_closed.disconnect(
      this.on_foreign_document_closed,
      this
    );
    foreign_document.foreign_document_opened.disconnect(
      this.on_foreign_document_opened,
      this
    );
    foreign_document.changed.disconnect(this.document_changed, this);
  }

  document_changed(
    virtual_document: VirtualDocument,
    document: VirtualDocument,
    is_init = false
  ) {
    if (this.isDisposed) {
      console.warn('Cannot swap document: adapter disposed');
      return;
    }

    // TODO only send the difference, using connection.sendSelectiveChange()
    let connection = this.connection_manager.connections.get(
      virtual_document.id_path
    );
    let adapter = this.adapters.get(virtual_document.id_path);

    if (!connection?.isReady) {
      console.log('LSP: Skipping document update signal: connection not ready');
      return;
    }
    if (adapter == null) {
      console.log('LSP: Skipping document update signal: adapter not ready');
      return;
    }

    // this.virtual_editor.console.log(
    //   'LSP: virtual document',
    //   virtual_document.id_path,
    //   'has changed sending update'
    // );
    connection.sendFullTextChange(
      virtual_document.value,
      virtual_document.document_info
    );
    // the first change (initial) is not propagated to features,
    // as it has no associated CodeMirrorChange object
    if (!is_init) {
      // guarantee that the virtual editor won't perform an update of the virtual documents while
      // the changes are recorded...
      // TODO this is not ideal - why it solves the problem of some errors,
      //  it introduces an unnecessary delay. A better way could be to invalidate some of the updates when a new one comes in.
      //  but maybe not every one (then the outdated state could be kept for too long fo a user who writes very quickly)
      //  also we would not want to invalidate the updates for the purpose of autocompletion (the trigger characters)
      this.virtual_editor.virtual_document.update_manager
        .with_update_lock(async () => {
          await adapter.updateAfterChange();
        })
        .then()
        .catch(console.warn);
    }
  }

  connect_adapter(
    virtual_document: VirtualDocument,
    connection: LSPConnection,
    features: IFeature[] = null
  ): EditorAdapter<any> {
    let adapter = this.create_adapter(virtual_document, connection, features);
    this.adapters.set(virtual_document.id_path, adapter);
    return adapter;
  }

  private disconnect_adapter(virtual_document: VirtualDocument) {
    let adapter = this.adapters.get(virtual_document.id_path);
    this.adapters.delete(virtual_document.id_path);
    if (adapter != null) {
      adapter.dispose();
    }
  }

  public get_features(virtual_document: VirtualDocument) {
    let adapter = this.adapters.get(virtual_document.id_path);
    return adapter?.features;
  }

  private async connect(virtual_document: VirtualDocument) {
    let language = virtual_document.language;

    console.log(`LSP: will connect using language: ${language}`);

    let options: ISocketConnectionOptions = {
      virtual_document,
      language,
      document_path: this.document_path
    };

    let connection = await this.connection_manager.connect(options);

    await this.on_connected({ virtual_document, connection });

    return {
      connection,
      virtual_document
    };
  }

  /**
   * Connect the change signal in order to update all virtual documents after a change.
   *
   * Update to the state of a notebook may be done without a notice on the CodeMirror level,
   * e.g. when a cell is deleted. Therefore a JupyterLab-specific signals are watched instead.
   *
   * While by not using the change event of CodeMirror editors we loose an easy way to send selective,
   * (range) updates this can be still implemented by comparison of before/after states of the
   * virtual documents, which is even more resilient and -obviously - editor-independent.
   */
  connect_contentChanged_signal() {
    this.widget.context.model.contentChanged.connect(
      this.onContentChanged,
      this
    );
  }

  private create_adapter(
    virtual_document: VirtualDocument,
    connection: LSPConnection,
    features: IFeature[] = null
  ): EditorAdapter<IVirtualEditor<IEditor>> {
    let adapter_features = new Array<
      IFeatureEditorIntegration<IVirtualEditor<IEditor>>
    >();

    if (features === null) {
      features = this.extension.feature_manager.features;
    }

    for (let feature of features) {
      let featureEditorIntegrationConstructor = feature.editorIntegrationFactory.get(
        this.virtual_editor.editor_name
      );
      let integration = new featureEditorIntegrationConstructor({
        feature: feature,
        virtual_editor: this.virtual_editor,
        virtual_document: virtual_document,
        connection: connection,
        status_message: this.status_message,
        settings: feature.settings,
        adapter: this
      });
      adapter_features.push(integration);
    }

    let adapter = new EditorAdapter(
      this.virtual_editor,
      virtual_document,
      adapter_features
    );
    console.log('LSP: Adapter for', this.document_path, 'is ready.');
    // the client is now fully ready: signal to the server that the document is "open"
    connection.sendOpenWhenReady(virtual_document.document_info);
    return adapter;
  }

  private async onContentChanged(_slot: any) {
    // update the virtual documents (sending the updates to LSP is out of scope here)
    this.update_finished = this.update_documents().catch(console.warn);
    await this.update_finished;
  }

  get_position_from_context_menu(): IRootPosition {
    // Note: could also try using this.app.contextMenu.menu.contentNode position.
    // Note: could add a guard on this.app.contextMenu.menu.isAttached

    // get the first node as it gives the most accurate approximation
    let leaf_node = this.app.contextMenuHitTest(() => true);

    let { left, top } = leaf_node.getBoundingClientRect();

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    let event = this.app._contextMenuEvent;

    // if possible, use more accurate position from the actual event
    // (but this relies on an undocumented and unstable feature)
    if (event !== undefined) {
      left = event.clientX;
      top = event.clientY;
      event.stopPropagation();
    }

    return this.virtual_editor.window_coords_to_root_position({
      left: left,
      top: top
    });
  }

  abstract context_from_active_document(): ICommandContext | null;

  get_context(root_position: IRootPosition): ICommandContext {
    let document = this.virtual_editor.document_at_root_position(root_position);
    let virtual_position = this.virtual_editor.root_position_to_virtual_position(
      root_position
    );
    return {
      document,
      connection: this.connection_manager.connections.get(document.id_path),
      virtual_position,
      root_position,
      features: this.get_features(document),
      editor: this.virtual_editor,
      app: this.app,
      adapter: this
    };
  }

  get_context_from_context_menu(): ICommandContext {
    let root_position = this.get_position_from_context_menu();
    return this.get_context(root_position);
  }

  abstract get wrapper_element(): HTMLElement;
}
