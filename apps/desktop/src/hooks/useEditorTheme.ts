import { useMonaco, type BeforeMount } from "@monaco-editor/react";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { editorTheme } from "../editorTheme";
import { getAppearance, subscribeAppearance } from "../theme";

export function useEditorTheme(): BeforeMount {
  const { theme } = useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
  const monaco = useMonaco();
  const configure = useCallback<BeforeMount>(
    (instance) => {
      instance.editor.defineTheme("miniq", editorTheme(theme));
      instance.editor.setTheme("miniq");
    },
    [theme]
  );
  useEffect(() => {
    if (monaco) configure(monaco);
  }, [monaco, configure]);
  return configure;
}
