import { useCallback, useEffect, useRef, useState } from "react";

/** Track slow picker/clipboard work independently for each conversation draft. */
export function useAttachmentReads(scope: string | undefined) {
  const jobs = useRef(new Map<symbol, string | undefined>());
  const mounted = useRef(true);
  const [, refresh] = useState(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const hasPending = useCallback(() => [...jobs.current.values()].includes(scope), [scope]);
  const run = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    const job = Symbol();
    jobs.current.set(job, scope);
    refresh((value) => value + 1);
    try {
      return await operation();
    } finally {
      jobs.current.delete(job);
      if (mounted.current) refresh((value) => value + 1);
    }
  }, [scope]);
  return { pending: hasPending(), hasPending, run };
}
