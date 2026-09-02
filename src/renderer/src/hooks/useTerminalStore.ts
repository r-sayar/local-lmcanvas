import { create } from "zustand";

export type TerminalState = {
  open: boolean;
  height: number;
  capturing: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setHeight: (h: number) => void;
  toggleCapture: () => void;
};

export const useTerminalStore = create<TerminalState>()((set) => ({
  open: false,
  height: 280,
  capturing: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
  setHeight: (height) => set({ height }),
  toggleCapture: () => set((s) => ({ capturing: !s.capturing })),
}));
