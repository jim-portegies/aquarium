
import tutorialContents from "./data/tutorial.md";
import { Aquarium, createAquarium } from "./app";

// Entry point of the web application, calls the main function.
window.onload = async () => {
    // Check if there's a file parameter in the URL.
    // If there is, fetch that file and load it into the editor
    const queryString = window.location.search;

    if (queryString !== "") {
        const urlParams = new URLSearchParams(queryString);
        // "?file=", "?sheet=" and "?exercise=" all work
        const fileParam = urlParams.get("file") || urlParams.get("sheet") || urlParams.get("exercise");

        if (fileParam) {
            console.log("Custom file parameter found in URL:", fileParam);

            const fileUrl = new URL(fileParam, window.location.origin).href;
            // For GitHub URLs, we allow users to input the regular GitHub URL, which we convert to
            // an URL that points to the raw text file.
            const rawUrl = fileUrl.includes("github.com") && !fileUrl.includes("raw.githubusercontent.com")
                ? fileUrl.replace("github.com", "raw.githubusercontent.com").replace("/blob/", '/')
                : fileUrl;
            try {
                const response = await fetch(rawUrl);
                if (!response.ok) {
                    throw new Error(`Failed to fetch ${rawUrl}`);
                }
                const content = await response.text();
                await initApp(content);
            } catch (error) {
                console.error("Error fetching file:", error);
                alert(`Failed to load file from URL parameter. Loading default file instead.`);
                await initApp();
            }
        } else {
            await initApp();
        }
    } else {
        // no file parameter, load custom tutorial
        await initApp();
    }
}

/**
 * Playground entry point: sets up the editor and proof checker, then adds the
 * playground-only features (shortcuts, exercise dropdown, leave confirmation).
 */
async function initApp(text?: string) {
    const editorElement = document.getElementById("editor");
    const goalsElement = document.getElementById("goals-panel");
    if (!editorElement || !goalsElement) return;

    const app = await createAquarium({
        editorElement,
        goalsElement,
        // Start with the adapted tutorial file if no other text is provided
        initialDocument: text ?? tutorialContents,
    });
    initPlayground(app);
}

/**
 * Playground-only UI: leave confirmation, keyboard shortcuts and the exercise
 * dropdown. Talks to the editor only through the `app` handle.
 */
function initPlayground(app: Aquarium) {
    // Add confirm leave notification
    window.addEventListener("beforeunload", (event) => {
        event.preventDefault();
    });

    window.addEventListener("keydown", (event) => {
        const {key, ctrlKey, metaKey, altKey} = event;
        const ctrlOrMeta = ctrlKey || metaKey;

        if (ctrlOrMeta) {
            if (key === 's') {
                event.preventDefault();
                const content = app.serializeDocument();
                if (content) {
                    const blob = new Blob([content], { type: "text/markdown" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = "Waterproof_aquarium_document.mv";
                    a.click();
                    URL.revokeObjectURL(url);
                }
            } else if (key === 'o') {
                event.preventDefault();
                const input = document.createElement("input");
                input.type = "file";
                input.accept = ".mv,.md,.txt";
                input.onchange = (e: Event) => {
                    const file = (e.target as HTMLInputElement).files?.[0];
                    if (file) {
                        const reader = new FileReader();
                        reader.onload = (e) => {
                            const content = e.target?.result as string;
                            if (content) {
                                app.loadDocument(content);
                            }
                        };
                        reader.readAsText(file);
                    }
                };
                input.click();
            } else if (altKey && key === 't') {
                event.preventDefault();
                app.setTeacherMode(!app.isTeacherMode());
                if (app.isTeacherMode()) {
                    document.getElementById("title")!.innerText = "Goals - Teacher Mode Enabled";
                } else {
                    document.getElementById("title")!.innerText = "Goals";
                }
            }
        }

    });

    // Logic to handle downloading and loading other documents using the dropdown
    const dropdown = document.getElementById("exercise-dropdown") as HTMLSelectElement;
    if (dropdown) {
        dropdown.addEventListener("change", async (event) => {
            const fileUrl = (event.target as HTMLSelectElement).value;
            if (fileUrl) {
                try {
                    const response = await fetch(fileUrl);
                    if (!response.ok) {
                        throw new Error(`Failed to fetch ${fileUrl}`);
                    }
                    const content = await response.text();
                    app.loadDocument(content);
                } catch (error) {
                    console.error("Error fetching exercise sheet:", error);
                    alert(`Failed to load exercise sheet.`);
                }
            }
        });
    }
}
