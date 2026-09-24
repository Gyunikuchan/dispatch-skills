import fs from 'node:fs';
import path from 'node:path';

import { scanResolutionLog } from './resolution-log.mjs';
import { sessionTempDir } from '../lib/session-temp.mjs';

const VERDICTS = new Set(['reject', 'downgrade', 'disputed']);

function exactFields(value, fields) {
  return Object.keys(value).sort().join('\0') === [...fields].sort().join('\0');
}

function validateContext(value, unsettledKeys) {
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      !exactFields(value, ['findings']) || !Array.isArray(value.findings)) {
    throw new Error('Context must be an object containing only a findings array.');
  }
  const contexts = new Map();
  for (const finding of value.findings) {
    if (!finding || Array.isArray(finding) || typeof finding !== 'object' ||
        !exactFields(finding, [
          'key', 'orchestratorVerdict', 'counterEvidence', 'changedExcerpts',
        ])) {
      throw new Error('Each context finding must contain key, orchestratorVerdict, counterEvidence, and changedExcerpts.');
    }
    if (typeof finding.key !== 'string' || !unsettledKeys.has(finding.key)) {
      throw new Error(`Context contains unknown finding key: ${finding.key}`);
    }
    if (contexts.has(finding.key)) throw new Error(`Context contains duplicate finding key: ${finding.key}`);
    if (!VERDICTS.has(finding.orchestratorVerdict)) {
      throw new Error(`Context finding ${finding.key} has an invalid orchestratorVerdict.`);
    }
    if (typeof finding.counterEvidence !== 'string' || !finding.counterEvidence.trim()) {
      throw new Error(`Context finding ${finding.key} requires counterEvidence.`);
    }
    if (!Array.isArray(finding.changedExcerpts) ||
        finding.changedExcerpts.some((excerpt) => typeof excerpt !== 'string' || !excerpt.trim())) {
      throw new Error(`Context finding ${finding.key} changedExcerpts must be an array of non-empty strings.`);
    }
    contexts.set(finding.key, {
      orchestratorVerdict: finding.orchestratorVerdict,
      counterEvidence: finding.counterEvidence.trim(),
      changedExcerpts: finding.changedExcerpts.map((excerpt) => excerpt.trim()),
    });
  }
  for (const key of unsettledKeys) {
    if (!contexts.has(key)) throw new Error(`Context is missing finding key: ${key}`);
  }
  return contexts;
}

export function buildRebuttalPackets(markdown, context) {
  const scan = scanResolutionLog(markdown, { strict: true });
  const unsettledKeys = new Set(scan.unsettledItems.map((finding) => finding.key));
  const contexts = validateContext(context, unsettledKeys);
  const sourceMaps = new Map();
  for (const round of scan.rounds) {
    for (const [sourceKey, source] of Object.entries(round.sourceMap ?? {})) {
      sourceMaps.set(sourceKey, source);
    }
  }
  const groups = new Map();
  for (const finding of scan.unsettledItems) {
    for (const sourceKey of finding.sourceKeys) {
      const findings = groups.get(sourceKey) ?? [];
      findings.push({
        key: finding.key,
        id: finding.id,
        severity: finding.severity,
        sourceKeys: finding.sourceKeys,
        originalLine: finding.originalLine,
        ...contexts.get(finding.key),
      });
      groups.set(sourceKey, findings);
    }
  }
  return [...groups.entries()].map(([sourceKey, findings]) => ({
    sourceKey,
    source: sourceMaps.get(sourceKey) ?? null,
    packet: {
      schemaVersion: 1,
      sourceKey,
      canonicalLogHash: scan.canonicalLogHash,
      findings,
    },
  }));
}

export function writeRebuttalPackets({ artifact, context }) {
  const markdown = fs.readFileSync(artifact, 'utf8');
  const contextValue = JSON.parse(fs.readFileSync(context === '-' ? 0 : context, 'utf8'));
  const packets = buildRebuttalPackets(markdown, contextValue);
  const dir = sessionTempDir('dispatch-rebuttal-packets-');
  const written = packets.map((group, index) => {
    const safeSource = group.sourceKey.replace(/[^A-Za-z0-9._-]+/g, '-');
    const packetPath = path.join(dir, `${String(index + 1).padStart(2, '0')}-${safeSource}.json`);
    fs.writeFileSync(packetPath, `${JSON.stringify(group.packet, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    return {
      sourceKey: group.sourceKey,
      source: group.source,
      packetPath,
      keys: group.packet.findings.map((finding) => finding.key),
    };
  });
  return { packets: written, cleanupPaths: [dir] };
}
