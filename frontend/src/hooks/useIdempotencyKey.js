import { useCallback, useRef } from "react";

export default function useIdempotencyKey() {
  const keys = useRef(new Map());
  return useCallback((scope, payload) => {
    const body = JSON.stringify(payload);
    const current = keys.current.get(scope);
    if (current?.body === body) return current.key;
    const key = crypto.randomUUID();
    keys.current.set(scope, { body, key });
    return key;
  }, []);
}
