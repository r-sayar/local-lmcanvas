import { create } from "zustand";

export type TerminalState = {
  open: boolean;
  height: number;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setHeight: (h: number) => void;
};

export const useTerminalStore = create<TerminalState>()((set) => ({
  open: false,
  height: 280,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
  setHeight: (height) => set({ height }),
}));
