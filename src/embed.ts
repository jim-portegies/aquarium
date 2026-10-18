// Entry point for embedding the editor in another page, e.g. a STACK question
// (built to out/embed.js). Unlike index.ts it has no playground features
// (shortcuts, teacher mode, exercise dropdown), so students cannot use them.

import tutorialContents from "./data/tutorial.md";
import { createAquarium, ProofStatus } from "./app";
import { assetUrl } from "./lsp";

// The exports of this module are exposed as the global `Aquarium` (see esbuild.mjs).

/** Where the student's answer is stored, e.g. a STACK input. Values are JSON `StoredAnswer`s. */
export type AnswerChannel = {
    /** The stored value at startup; empty if there is none yet. */
    initial: string;
    /** Store a new value. */
    write(value: string): void;
};

/**
 * The stored answer: the document, and the statuses computed for exactly that
 * document. `statuses` is null while they are not known (e.g. right after an edit).
 */
type StoredAnswer = {
    v: 1;
    doc: string;
    statuses: ProofStatus[] | null;
};

export type EmbedOptions = {
    /** The exercise document to start from; defaults to the tutorial. */
    exercise?: string;
    /** Where to load the answer from and save it to. Without it, nothing is saved. */
    channel?: AnswerChannel;
    /** Element to render into; defaults to the page body. */
    root?: HTMLElement;
};

/**
 * Set up the editor and proof checker in this page: load the stylesheets, build
 * the layout and start the editor on the stored answer, or else on the exercise.
 * May be called once per page.
 */
export async function embed(options: EmbedOptions = {}): Promise<void> {
    const root = options.root ?? document.body;
    const stored = options.channel ? parseAnswer(options.channel.initial) : undefined;
    if (stored === "unreadable") {
        // Don't start the editor: its first save would overwrite the stored answer.
        root.textContent = "The saved answer could not be read; it may have been saved by a newer "
            + "version of this editor. Please reload the page. Your saved answer has not been changed.";
        return;
    }
    const writer = options.channel ? createAnswerWriter(options.channel) : undefined;

    await loadStylesheets();
    const { editorElement, goalsElement } = createLayout(root);
    await createAquarium({
        editorElement,
        goalsElement,
        initialDocument: stored?.doc ?? options.exercise ?? tutorialContents,
        onDocumentChange: text => writer?.documentChanged(text),
        onStatuses: (statuses, text) => writer?.statusesComputed(statuses, text),
    });
}

/**
 * Parse a stored answer. Returns undefined if nothing is stored yet, and
 * "unreadable" if something is stored but not in a format this version knows
 * (e.g. a newer `v`, or corrupted); that value must not be overwritten.
 */
function parseAnswer(value: string): StoredAnswer | "unreadable" | undefined {
    if (!value) return undefined;
    try {
        const answer = JSON.parse(value);
        if (answer?.v === 1 && typeof answer.doc === "string") return answer;
    } catch {
        // fall through
    }
    console.error("Stored answer is in an unknown format:", value);
    return "unreadable";
}

/** After an edit, wait this long for typing to pause before saving. */
const WRITE_DELAY_MS = 500;

/**
 * Saves answers to the channel such that the stored statuses always belong to
 * the stored document. Until a delayed write happens, the previous (consistent)
 * answer stays stored.
 */
function createAnswerWriter(channel: AnswerChannel) {
    let pending: number | undefined;
    const write = (answer: StoredAnswer) => channel.write(JSON.stringify(answer));
    return {
        /** The document changed, so its statuses are unknown until the next check. */
        documentChanged(doc: string) {
            window.clearTimeout(pending);
            pending = window.setTimeout(() => write({ v: 1, doc, statuses: null }), WRITE_DELAY_MS);
        },
        /** Statuses were computed for exactly `doc`; this supersedes any pending write. */
        statusesComputed(statuses: ProofStatus[], doc: string) {
            window.clearTimeout(pending);
            write({ v: 1, doc, statuses });
        },
    };
}

/**
 * Load the stylesheets the editor needs: embed.css (the editor's own styles,
 * bundled by esbuild) and editor.css (the page layout, shared with the playground).
 * Both are resolved next to this script, so the host page needs no <link> tags.
 * Resolves once both have loaded (or failed), so layout is in place before the
 * editor measures its viewport.
 */
function loadStylesheets(): Promise<void> {
    const loads = ["embed.css", "editor.css"].map(file => new Promise<void>(resolve => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = assetUrl(file);
        link.onload = () => resolve();
        link.onerror = () => {
            console.error("Failed to load stylesheet", link.href);
            resolve();
        };
        document.head.appendChild(link);
    }));
    return Promise.all(loads).then(() => undefined);
}

/**
 * Build the editor and goals panel markup inside `root`, matching the structure
 * of the playground's index.html (minus the exercise dropdown), which editor.css
 * and GoalsPanel rely on.
 */
function createLayout(root: HTMLElement): { editorElement: HTMLElement, goalsElement: HTMLElement } {
    root.innerHTML = `
        <div id="container">
            <div id="editor"></div>
            <div id="goals-panel">
                <h2 id="title">Goals</h2>
                <div id="goals"></div>
                <div id="messages"></div>
                <div id="help"><h3>Help:</h3><button id="help-button">Help</button><div id="help-container"></div></div>
            </div>
        </div>
    `;
    return {
        editorElement: root.querySelector<HTMLElement>("#editor")!,
        goalsElement: root.querySelector<HTMLElement>("#goals-panel")!,
    };
}
