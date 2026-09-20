#!/usr/bin/env node
import { parseReviewReport, parseRebuttalReport, parseReportArgs, readReportInput } from '../../dispatch/scripts/review-report.mjs';
import { isMainModule } from '../../dispatch/scripts/common.mjs';
export const DESIGN_TAGS = new Set(['architecture','boundaries','interfaces','data-flow','alternatives','security','operations','migration','rollback','risk','graph-correctness','parallel-safety','integration','compatibility','correctness','simplicity','verification','scope-creep','adjacent']);
export const DESIGN_LOCUS_PATTERN = /^§\s+\S.*$/;
export function parseReport(text) { return parseReviewReport(text, { kind: 'design', tags: DESIGN_TAGS, locusPattern: DESIGN_LOCUS_PATTERN, locusDescription: '"§ <Design heading>"' }); }
export function parseRebuttal(text, expectedKeys) { return parseRebuttalReport(text, { kind: 'design', expectedKeys }); }
if (isMainModule(import.meta.url)) { const args = parseReportArgs(process.argv.slice(2)); const input = readReportInput(args.file); const result = args.rebuttalPacket ? parseRebuttal(input, JSON.parse(readReportInput(args.rebuttalPacket)).findings.map(f => f.key)) : parseReport(input); process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); }
