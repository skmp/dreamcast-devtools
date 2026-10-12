import type { CSSProperties } from "react";
import type { BoxFocus, WriteEditor } from "./useWriteEditor";

interface WriteEditorInputProps {
  editor: WriteEditor;
  /** the name of the box: what is written, and where */
  label: string;
  /** who is told where the keyboard focus is: the value the editor was opened from, which gets it back (`useFocusReturn`) */
  focus?: BoxFocus;
  className?: string;
  style?: CSSProperties;
}

/**
 * The box of an open editor (`useWriteEditor`), in place of the value it writes: Enter sends
 * what is typed, Escape and leaving the box put the editor away. It is a plain input that
 * takes the font of where it stands; the panel that shows it gives it its look by `className`.
 * It takes the keyboard focus when it is shown, so it is shown only when the user opens it.
 *
 * While its request is out the box cannot be typed into and says that it is busy; when the
 * request was refused it is marked invalid and its title says why.
 */
export const WriteEditorInput = ({ editor, label, focus, className, style }: WriteEditorInputProps) => (
  <input
    type="text"
    className={className}
    style={style}
    aria-label={label}
    aria-invalid={editor.refusal !== undefined || undefined}
    aria-busy={editor.sending || undefined}
    title={editor.refusal}
    value={editor.text ?? ""}
    readOnly={editor.sending}
    autoFocus
    autoComplete="off"
    autoCapitalize="off"
    spellCheck={false}
    // what is there is the value as it is: typing replaces it
    onFocus={(event) => {
      event.target.select();
      focus?.onFocus();
    }}
    onChange={(event) => editor.change(event.target.value)}
    onKeyDown={(event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        editor.submit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        editor.close();
      }
    }}
    onBlur={() => {
      focus?.onBlur();
      editor.close();
    }}
  />
);
