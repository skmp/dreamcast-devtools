// Monaco, bundled. @monaco-editor/react would otherwise download the editor from the
// jsDelivr CDN at run time; the UI is served by the emulator and must work without any
// other origin. Importing this module (for its side effects) before rendering an <Editor>
// hands the locally bundled editor to the loader.
//
// Only the editor core and the features the three editors (DSP source, DSP assembly, SH4
// simulator) use are imported. Their languages are Monarch grammars registered by the
// editors themselves, so none of Monaco's built-in languages and none of its language
// workers (TypeScript, CSS, JSON, HTML) are part of the bundle.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

// The editor itself and its basic commands (cursor, typing, undo, selection)
import "monaco-editor/esm/vs/editor/browser/coreCommands.js";
import "monaco-editor/esm/vs/editor/browser/widget/codeEditor/codeEditorWidget.js";
// Editing features
import "monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/esm/vs/editor/contrib/caretOperations/browser/caretOperations.js";
import "monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/esm/vs/editor/contrib/comment/browser/comment.js";
import "monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/esm/vs/editor/contrib/cursorUndo/browser/cursorUndo.js";
import "monaco-editor/esm/vs/editor/contrib/dnd/browser/dnd.js";
import "monaco-editor/esm/vs/editor/contrib/find/browser/findController.js";
import "monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js";
import "monaco-editor/esm/vs/editor/contrib/indentation/browser/indentation.js";
import "monaco-editor/esm/vs/editor/contrib/lineSelection/browser/lineSelection.js";
import "monaco-editor/esm/vs/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor.js";
import "monaco-editor/esm/vs/editor/contrib/smartSelect/browser/smartSelect.js";
import "monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter.js";
import "monaco-editor/esm/vs/editor/contrib/wordOperations/browser/wordOperations.js";
// Word completion while typing (Monaco's default; the words come from the editor worker)
import "monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController.js";
// Macro hovers of the DSP editors and the message of an error marker
import "monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution.js";
// Error markers: F8 / Shift+F8
import "monaco-editor/esm/vs/editor/contrib/gotoError/browser/gotoError.js";
// "This editor is read-only" in the Compiled tab of the DSP playground
import "monaco-editor/esm/vs/editor/contrib/readOnlyMessage/browser/contribution.js";
// Labels of the built-in commands and the icon font
import "monaco-editor/esm/vs/editor/common/standaloneStrings.js";
import "monaco-editor/esm/vs/base/browser/ui/codicons/codiconStyles.js";

// One worker type is enough: without language services Monaco only asks for its generic
// editor worker (word completion, link and diff computation).
window.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

loader.config({ monaco });
