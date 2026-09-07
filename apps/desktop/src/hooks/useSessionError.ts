import { useCallback, useState } from "react";

// Keep late failures attached to the session that initiated the operation.
export function useSessionError(scope: string) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const setScopeError = useCallback((scope: string, message: string | null) => {
    setErrors((current) => {
      const next = { ...current };
      if (message === null) delete next[scope];
      else next[scope] = message;
      return next;
    });
  }, []);
  const setError = useCallback(
    (message: string | null) => setScopeError(scope, message),
    [scope, setScopeError]
  );
  return [errors[scope] ?? null, setError, setScopeError] as const;
}
