// Entry point for embedding the editor in another page, e.g. a STACK question
// (built to out/embed.js). Unlike index.ts it has no playground features
// (shortcuts, teacher mode, exercise dropdown), so students cannot use them.

import tutorialContents from "./data/tutorial.md";
import { createAquarium } from "./app";
import { assetUrl } from "./lsp";

// The exports of this module are exposed as the global `Aquarium` (see esbuild.mjs).

export type EmbedOptions = {
    /** The exercise document to start from; defaults to the tutorial. */
    exercise?: string;
    /** Element to render into; defaults to the page body. */
    root?: HTMLElement;
};

/**
 * Set up the editor and proof checker in this page: load the stylesheets, build
 * the layout and start the editor on the exercise. May be called once per page.
 */
export async function embed(options: EmbedOptions = {}): Promise<void> {
    await loadStylesheets();
    const { editorElement, goalsElement } = createLayout(options.root ?? document.body);
    await createAquarium({
        editorElement,
        goalsElement,
        initialDocument: options.exercise ?? tutorialContents,
    });
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
