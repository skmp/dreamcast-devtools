/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const read_reg: (a: number) => number;
export const write_reg: (a: number, b: number) => void;
export const step: (a: number) => void;
export const get_dsp_registers: () => [number, number];
export const step128_start: () => void;
export const step128_end: () => void;
export const __wbindgen_export_0: WebAssembly.Table;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_start: () => void;
