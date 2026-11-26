export type PreviewAction =
  | "toggle-panel"
  | "refresh"
  | "back"
  | "forward"
  | "focus-url"
  | "zoom-in"
  | "zoom-out"
  | "reset-zoom"
  | "find";

const EVENT_NAME = "t3code:preview-action";

/** Returns whether a listener answered the action. */
export function dispatchPreviewAction(action: PreviewAction): boolean {
  if (typeof window === "undefined") return false;
  return !window.dispatchEvent(
    new CustomEvent<PreviewAction>(EVENT_NAME, { detail: action, cancelable: true }),
  );
}

/** A listener returns true when it answered the action. */
export function subscribePreviewAction(
  listener: (action: PreviewAction) => boolean | void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<PreviewAction>).detail;
    if (typeof detail === "string" && listener(detail) === true) event.preventDefault();
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
