import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  type UIEvent,
} from "react";

type ViewValues = Map<string, unknown>;

const useBrowserLayoutEffect =
  typeof document === "undefined" ? useEffect : useLayoutEffect;

/** Lightweight view state only. File bytes and parsed documents never enter this store. */
export class PreviewViewStore {
  private views = new Map<string, ViewValues>();
  forFile(scope: string, path: string): ViewValues {
    const key = JSON.stringify([scope, path]);
    let values = this.views.get(key);
    if (!values) {
      values = new Map();
      this.views.set(key, values);
    }
    return values;
  }
  closeFile(scope: string, path: string) {
    this.views.delete(JSON.stringify([scope, path]));
  }
}

const PreviewContext = createContext<ViewValues | null>(null);

export function PreviewViewProvider({
  store,
  scope,
  path,
  children,
}: {
  store: PreviewViewStore;
  scope: string;
  path: string;
  children: ReactNode;
}) {
  const values = useMemo(
    () => store.forFile(scope, path),
    [store, scope, path],
  );
  return (
    <PreviewContext.Provider key={JSON.stringify([scope, path])} value={values}>
      {children}
    </PreviewContext.Provider>
  );
}

export function usePreviewCache() {
  const provided = useContext(PreviewContext);
  const [local] = useState<ViewValues>(() => new Map());
  return provided ?? local;
}

export function usePreviewValue<T>(
  key: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const values = usePreviewCache();
  const [value, setValue] = useState<T>(() =>
    values.has(key) ? (values.get(key) as T) : initial,
  );
  const update = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      setValue((previous) => {
        const next =
          typeof action === "function"
            ? (action as (value: T) => T)(previous)
            : action;
        values.set(key, next);
        return next;
      });
    },
    [values, key],
  );
  return [value, update];
}

export function usePreviewScroll<T extends HTMLElement>(
  key: string,
  ready = true,
) {
  const values = usePreviewCache();
  const ref = useRef<T>(null);
  useBrowserLayoutEffect(() => {
    const element = ref.current;
    const position = values.get(`scroll:${key}`) as
      { top: number; left: number } | undefined;
    if (ready && element) {
      element.scrollTop = position?.top ?? 0;
      element.scrollLeft = position?.left ?? 0;
    }
  }, [values, key, ready]);
  const onScroll = (event: UIEvent<T>) => {
    if (ready)
      values.set(`scroll:${key}`, {
        top: event.currentTarget.scrollTop,
        left: event.currentTarget.scrollLeft,
      });
  };
  return { ref, onScroll };
}
