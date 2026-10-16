import { expect, type Locator, type Page } from "@playwright/test";

/** The (single visible) Monaco editor inside `scope`. */
export const monacoEditor = (scope: Page | Locator): Locator => scope.locator(".monaco-editor").first();

/** Text of the lines Monaco currently renders (it only renders the visible ones). */
export const monacoVisibleText = async (editor: Locator): Promise<string> => {
  const lines = await editor.locator(".view-line").evaluateAll((elements) =>
    elements
      .map((element) => ({ top: (element as HTMLElement).offsetTop, text: element.textContent ?? "" }))
      .sort((a, b) => a.top - b.top)
      // Monaco renders spaces as non-breaking spaces
      .map((line) => line.text.replace(/\u00a0/g, " ")),
  );
  return lines.join("\n");
};

/**
 * The distinct token classes ("mtk5", "mtk9 mtkb", ...) of the rendered lines. Plain,
 * untokenised text uses a single class, so more than one means the tokenizer ran.
 */
export const monacoTokenClasses = (editor: Locator): Promise<string[]> =>
  editor
    .locator(".view-line span span")
    .evaluateAll((elements) => [...new Set(elements.map((element) => element.className).filter(Boolean))].sort());

/** Replaces the whole document through the keyboard, as a user would. */
export const monacoReplaceAll = async (page: Page, editor: Locator, text: string) => {
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  // insertText avoids Monaco's auto-indent and auto-closing brackets, which would change the text typed
  await page.keyboard.insertText(text);
};

/** Waits until Monaco has rendered and tokenised some text. */
export const expectMonacoReady = async (editor: Locator) => {
  await expect(editor).toBeVisible();
  await expect(editor.locator(".view-line").first()).toBeVisible();
};
