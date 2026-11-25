type Report = {
  file: string;
  text: string;
  lines: Array<string>;
  start: number;
  end: number;
};

export function loadReport(file: string): Report;
export function parseFindings(report: Report): Array<{ id: string; title: string }>;
export function cmdInit(root: string, file: string): void;
export function cmdList(root: string, file: string, argv: Array<string>): void;
export function cmdTriage(root: string, file: string, argv: Array<string>): void;
export function cmdBatch(root: string, file: string, argv: Array<string>): void;
export function cmdProgress(root: string, file: string, argv: Array<string>): void;
export function cmdSet(root: string, file: string, argv: Array<string>): void;
