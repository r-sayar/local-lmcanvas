import { useStore } from "zustand";
import type { StoreApi } from "zustand";
import { createStore } from "zustand";
import { useActivePaneStoreApi } from "./usePaneRegistry";

type CwdState = { cwd: string | undefined };

// Stand-in so the hook can call useStore unconditionally when no pane is active.
const FALLBACK_STORE: StoreApi<CwdState> = createStore<CwdState>(() => ({
  cwd: undefined,
}));

/**
 * Working directory of the pane the user is currently in.
 *
 * The terminal panel is rendered outside any pane, so without this it had no
 * way to learn the canvas folder and always opened `claude` in the home
 * directory instead.
 */
export function useActivePaneCwd(): string | undefined {
  const api = useActivePaneStoreApi();
  const target = (api as StoreApi<CwdState> | null) ?? FALLBACK_STORE;
  return useStore(target, (s) => s.cwd);
}
