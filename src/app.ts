import { WaterproofEditor, WaterproofEditorConfig, DocChange, ThemeStyle, WrappingDocChange, InputAreaStatus} from "@impermeable/waterproof-editor";
import { markdown } from "@impermeable/waterproof-editor";
import { continuousChecking, LspClient, serverConfig } from "./lsp";
import { TextDocument } from "./TextDocument";
import { determineProofStatus, getInputAreas } from "./inputAreas";
import symbols from "./data/symbols.json";
import tactics from "./data/tactics.json";
import { Position, Range } from "./positionsRanges";
import { GoalsPanel } from "./GoalsPanel";
import { executeCommandFullOutput } from "./lib/commandExecutor";

import "@impermeable/waterproof-editor/styles.css";
import "@impermeable/waterproof-editor/waterproof-defaults.css";
import { highlight_dark, highlight_light, waterproof } from "@impermeable/codemirror-lang-waterproof";
import { handleDiagnostics, handleFileProgress, handleLogTrace } from "./handlers";
import { CrashDetector } from "./crashDetector";

let viewPortRange: Range | null = null;
let currentPos: Position | null = null;

let teacherMode = false;

// App-lifetime state: one language server / worker for the whole session.
// Loading a new file swaps the document on the existing server (didClose/didOpen)
// and replaces the editor, instead of booting a fresh worker per file.
let lspClient: LspClient;
let goalsPanel: GoalsPanel;
let currentEditor: WaterproofEditor;
let currentTextDocument: TextDocument;

// The element the editor renders into and the embedder's options, set once by `createAquarium`.
let editorElem: HTMLElement;
let aquariumOptions: AquariumOptions;
let aquariumCreated = false;

// Detects a crashed/wedged checker worker (e.g. a WASM trap in zarith/GMP that
// leaves the server Busy forever) and offers a restart via the goals panel.
let restartingChecker = false;
const crashDetector = new CrashDetector(
    (message) => {
        // Ignore signals from the worker we are currently tearing down, and
        // anything that fires before the goals panel exists (during startup).
        if (restartingChecker || !goalsPanel) return;
        goalsPanel.showCrashNotice(message, restartChecker);
    },
    () => goalsPanel?.hideCrashNotice()
);

/**
 * Create an LSP client (starting a fresh worker) and register all notification
 * handlers on it. Used both at startup and when restarting a crashed checker.
 */
function createLspClient(): LspClient {
    const client = new LspClient(serverConfig, (message) => crashDetector.onWorkerError(message));
    registerNotificationHandlers(client);
    return client;
}

/**
 * Replace the crashed/wedged worker with a fresh one, re-open the current
 * document on it (edits are kept, since `currentTextDocument` is the source of
 * truth) and trigger a recheck of the visible region.
 */
async function restartChecker(): Promise<void> {
    if (restartingChecker) return;
    restartingChecker = true;
    try {
        crashDetector.reset();
        lspClient.dispose();
        lspClient = createLspClient();
        await lspClient.initializeServer();
        await lspClient.openDocument(currentTextDocument);
        // Recheck the visible region, like on a fresh load. If the crashing
        // sentence is still in view this may re-trigger the crash notice,
        // pointing the user at the sentence that needs editing.
        currentEditor.handleScroll(window.innerHeight);
    } finally {
        restartingChecker = false;
        goalsPanel.hideCrashNotice();
    }
}

/**
 * Proof status of one input area, as reported to embedders (e.g. stored in a
 * STACK answer). Deliberately independent of the editor's `InputAreaStatus`
 * values, which have changed between editor versions.
 */
export type ProofStatus = "proven" | "incomplete" | "invalid" | "unchecked";

function toProofStatus(status: InputAreaStatus): ProofStatus {
    switch (status) {
        case InputAreaStatus.Correct: return "proven";
        case InputAreaStatus.Incorrect: return "incomplete";
        case InputAreaStatus.Invalid: return "invalid";
        case InputAreaStatus.OutOfView: return "unchecked";
    }
}

export type AquariumOptions = {
    /** Element the editor renders into; its scroll events drive viewport checking. */
    editorElement: HTMLElement;
    /** Element holding the goals panel markup (`#goals`, `#messages`, `#help-button`, `#help-container`). */
    goalsElement: HTMLElement;
    /** Document loaded on startup. */
    initialDocument: string;
    /** Called after every edit with the full document text. Not called by `loadDocument`. */
    onDocumentChange?: (text: string) => void;
};

/** Handle returned by `createAquarium`. */
export type Aquarium = {
    loadDocument: typeof loadDocument;
    serializeDocument: typeof serializeDocument;
    isTeacherMode: typeof isTeacherMode;
    setTeacherMode: typeof setTeacherMode;
};

/**
 * One-time editor/checker setup: starts the language server worker, creates the
 * goals panel, registers notification handlers and loads the first document.
 * Switching files goes through `loadDocument` on the returned handle instead.
 *
 * All state in this module is page-global, so this may be called only once per
 * page. (In STACK each question runs in its own iframe, i.e. its own page.)
 */
export async function createAquarium(options: AquariumOptions): Promise<Aquarium> {
    if (aquariumCreated) {
        throw new Error("createAquarium can only be called once per page.");
    }
    aquariumCreated = true;
    aquariumOptions = options;
    editorElem = options.editorElement;

    // Display loading indicator (we are setting up the language server)
    editorElem.innerHTML = `
        <div id="loading-spinner-container" style="display: flex; justify-content: center; align-items: center; height: 100%;">
            <div class="lsp-spinner"></div>
        </div>
    `;

    // Create the LSP client object, this will also start the language server
    // in a web worker. The worker lives for the whole session unless it
    // crashes, in which case `restartChecker` replaces it.
    lspClient = createLspClient();
    // Initialize the server
    await lspClient.initializeServer();

    // Create the goals panel
    goalsPanel = new GoalsPanel(options.goalsElement, executeHelp);

    let timeoutHandle: number | undefined;
	editorElem.addEventListener("scroll", (_event) => {
		if (timeoutHandle === undefined) {
			timeoutHandle = window.setTimeout(() => {
				currentEditor.handleScroll(window.innerHeight);
				timeoutHandle = undefined;
			}, 100);
		}
	});

    // Load the initial document into the editor
    loadDocument(options.initialDocument);
    return { loadDocument, serializeDocument, isTeacherMode, setTeacherMode };
}

/** The current document as text, or undefined if it cannot be serialized. */
function serializeDocument() {
    return currentEditor.serializeDocument();
}

function isTeacherMode(): boolean {
    return teacherMode;
}

/** Lock or unlock the non-input-area parts of the document. Persists across document loads. */
function setTeacherMode(on: boolean): void {
    teacherMode = on;
    currentEditor.updateLockingState(on);
}

/**
 * Register all notification handlers on a client's connection. Called for every
 * client we create (initial one and post-crash replacements). The handlers
 * dereference `currentEditor`/`currentTextDocument` at call time so they always
 * target the active document, and ignore notifications addressed to a
 * previously closed document by comparing URIs.
 */
function registerNotificationHandlers(client: LspClient) {
    client.onNotification("$/logTrace", handleLogTrace());
    client.onNotification("textDocument/publishDiagnostics", (params) => {
        if (params.uri !== currentTextDocument.uri) return;
        handleDiagnostics(currentEditor, currentTextDocument)(params);
    });
    client.onNotification("$/coq/fileProgress", (params) => {
        if (params.textDocument?.uri !== currentTextDocument.uri) return;
        crashDetector.onFileProgress(params.processing?.[0]?.range?.start?.line);
        handleFileProgress(currentEditor, currentTextDocument)(params);
    });
    client.onNotification("$/coq/serverStatus", async params => {
        // On Idle, we recompute input area statuses
        const {status} = params;
        crashDetector.onServerStatus(status);
        if (status === "Idle") {
            await computeInputAreaStatus(lspClient, currentTextDocument, currentEditor);
        }

        if (status === "Busy") {
            currentEditor.startSpinner();
        } else {
            currentEditor.stopSpinner();
        }
    });

    // Handle window/logMessage notifications
    client.onNotification("window/logMessage", (params) => {
        console.log("LSP Log:", params.message);
    });

    // Handle performance data notifications
    client.onNotification("$/coq/filePerfData", (params: any) => {
        console.log("Performance data:", params);
    });
}

/**
 * Load a document into the editor, reusing the running language server.
 * Closes the previous document on the server, opens the new one under a fresh
 * URI and replaces the editor instance.
 */
function loadDocument(documentText: string) {
    // Release the server-side state of the previous document
    if (currentTextDocument) {
        lspClient.closeDocument(currentTextDocument.uri);
    }

    // Note: we reuse the same URI for every document (didClose + didOpen).
    // The server's lazy checking (check_only_on_request) does not schedule
    // checks for URIs other than this one, see "file not in workspace" log.
    const textDocument = new TextDocument(documentText);
    lspClient.openDocument(textDocument);

    // Reset per-document state.
    // `currentTextDocument` must be set before `editor.init` below, since init
    // synchronously fires viewportHint, which reads it.
    currentTextDocument = textDocument;
    viewPortRange = null;
    currentPos = null;

    // Define a waterproof editor config object
    const config: WaterproofEditorConfig = {
        completions: tactics,
        symbols,
        api: {
            executeCommand: function (): void {
                // we don't support commands other than "Help." so this is a no-op.
            },
            executeHelp: function (): void {
                executeHelp();
            },
            editorReady: function (): void {
                console.log("Editor is ready.");
            },
            documentChange: function (change: DocChange | WrappingDocChange): void {
                textDocument.applyChange(change);
                const documentText = textDocument.text;

                const didChangeParams = {
                    textDocument: textDocument.versionedIdentifier,
                    contentChanges: [{
                        text: documentText
                    }]
                };
                lspClient.sendNotification("textDocument/didChange", didChangeParams);
                // Notify the embedder last, so a failing callback cannot keep the server out of date.
                aquariumOptions.onDocumentChange?.(documentText);
            },
            applyStepError: function (errorMessage: string): void {
                console.error("Received an error when applying a ProseMirror step: \n", errorMessage);
            },
            cursorChange: function (cursorPosition: number): void {
                currentPos = textDocument.positionAt(cursorPosition);
                lspClient.requestGoals(currentPos, textDocument).then((goals) => {
                    goalsPanel.render(goals);
                }).catch((error) => {
                    if (!wasCanceledByServer(error)) {
                        console.error("Error requesting goals:", error);
                    }
                });
            },
            viewportHint: handleViewportHint
        },
        documentConstructor: (doc: string) => markdown.parse(doc, {language: "coq"}),
        tagConfiguration: markdown.configuration("coq"),
        languageConfig: {
            highlightDark: highlight_dark,
            highlightLight: highlight_light,
            languageSupport: waterproof()
        }
    }
    editorElem.innerHTML = ""; // Clear loading messages
    const editor = new WaterproofEditor(editorElem, config, ThemeStyle.Light);
    currentEditor = editor;
    editor.init(documentText);

    // Enable the line numbers
    editor.setShowLineNumbers(true);

    editor.reportProgress(0, textDocument.lineCount, "File loaded");
    // TODO: There seems to be some race condition between handle scroll and the editor not being initialized yet (?)
    // We add this call to handleScroll that hopefully fires in a properly instantiated editor
    editor.handleScroll(window.innerHeight);

    // Preserve teacher mode across document loads
    if (teacherMode) {
        editor.updateLockingState(teacherMode);
    }
}

function executeHelp(): void {
    executeCommandFullOutput(lspClient, currentTextDocument, "Help.", currentPos!).then((output) => {
        const msgs  = output.feedback.filter(([level, _]) => level === 4).map(([_, msg]) => msg);
        goalsPanel.renderHelpMessages(msgs);
    }).catch((error) => {
        console.error("Error executing Help command:", error);
    });
}

function handleViewportHint(start: number, end: number): void {
    sendViewportHint(lspClient, currentTextDocument, start, end).then(range => {
        viewPortRange = range;
    }).catch((error) => {
        console.error("Error sending viewport hint:", error);
    });
}

let computeInputAreaStatusTimer: number;

async function computeInputAreaStatus(client: LspClient, document: TextDocument, editor: WaterproofEditor) {
    if (computeInputAreaStatusTimer) {
        clearTimeout(computeInputAreaStatusTimer);
    }

    // Computing where all the input areas are requires a fair bit of work,
    // so we add a debounce delay to this function to avoid recomputing on every keystroke.
    computeInputAreaStatusTimer = window.setTimeout(async () => {
        // console.log("[computeInputAreaStatus] Computing input area statuses...");
        // get input areas based on tags
        const inputAreas = getInputAreas(document);
        if (!inputAreas) {
            throw new Error("Cannot check proof status; illegal input areas.");
        }

        // for each input area, check the proof status
        try {
            const statuses = await Promise.all(inputAreas.map(a => {
                    if (!continuousChecking && viewPortRange && isAfterRange(a, viewPortRange)) {
                        // The server checks sequentially, so only areas starting after the viewport end are unchecked;
                        // areas before or inside the viewport have a known status.
                        return Promise.resolve(InputAreaStatus.OutOfView);
                    } else {
                        return determineProofStatus(client, document, a);
                    }
                }));
            if (window.parent !== window) {
                window.parent.postMessage(
                    {
                        type: "waterproof:input-area-status",
                        statuses: statuses,
                    },
                    "*"
                );
            }
            editor.setInputAreaStatus(statuses);
        } catch (reason) {
            if (wasCanceledByServer(reason)) return;  // we've likely already sent new requests
        }
    }, 250);
}


function isAfterRange(area: Range, range: Range): boolean {
    const s = area.start, e = range.end;
    return s.line > e.line || (s.line === e.line && s.character >= e.character);
}

function wasCanceledByServer(reason: unknown): boolean {
    return !!reason
        && typeof reason === "object"
        && "message" in reason
        && reason.message === "Request got old in server";  // or: code == -32802
}

async function sendViewportHint(client: LspClient, textDocument: TextDocument, start: number, end: number): Promise<Range> {
    const startPos = textDocument.positionAt(start);
    let endPos = textDocument.positionAt(end);
    // Compute end of document position, use that if we're close
    const endOfDocument = textDocument.positionAt(textDocument.getText().length);
    if (endOfDocument.line - endPos.line < 20) {
        endPos = endOfDocument;
    }

    const requestBody = {
        textDocument: textDocument.versionedIdentifier,
        range: {
            start: {
                line: startPos.line,
                character: startPos.character
            },
            end: {
                line: endPos.line,
                character: endPos.character
            }
        }
    };

    // Save the range for which the document has been checked
    await client.sendNotification("coq/viewRange", requestBody);
    return Promise.resolve(new Range(startPos, endPos));
}
