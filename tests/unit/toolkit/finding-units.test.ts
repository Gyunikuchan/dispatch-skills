import assert from 'node:assert/strict';
import {test} from 'node:test';
import {findingUnits} from '../../../skills/dispatch/scripts/toolkit/findings.ts';

test('finding units classify and measure sections across rounds', () => {
  const rounds = [
    {findings: [{id:'a', locus:'§ T1 — Old'}], text:'## Work\n### T1 — Old\na\n### T10 — Other\nb\n', startSeq:1},
    {findings: [{id:'b', locus:'unresolved-locus: T1 – New'}], text:'## Work\n### T1 — New\na longer\n### T10 — Other\nb\n', startSeq:3},
  ];
  const units = findingUnits({kind:'plan', round:2, rounds, planPath:'plan.md', ruling: (id, seq) => id === 'a' && seq >= 2 ? 'accepted' : undefined});
  assert.equal(units[0]!.unit, 'T1');
  assert.equal(units[0]!.hot, true);
  assert.equal(units[0]!.hotStreak, 1);
  assert.ok(units[0]!.delta! > 0);
});


test('finding units group locus variants and code findings', () => {
  const text = '## Success Criteria\ncriteria\n## Work\n### T1 — First title\none\n### T10 – Shared title\ntwo\n### AD-4 — Shared title\nthree\n';
  const loci = ['REQ-3', 'DEC-15', 'Spec: Purpose', 'SC2', 'unresolved-locus: T10 — wrong', '§ First title', 'Shared title', '(none)'];
  const rounds = [{findings:loci.map((locus, i) => ({id:String(i), locus})), text, startSeq:1}];
  const units = findingUnits({kind:'plan', round:1, rounds, planPath:'work.plan.md', ruling:()=>undefined});
  assert.deepEqual(units.map(u=>u.unit), ['spec:REQ-3','spec:DEC-15','spec:Purpose','§ Success Criteria','T10','T1','artifact']);
  assert.deepEqual(units.find(u=>u.unit === 'T10')!.findings,['4','6']);
  assert.equal(units[0]!.bytes, undefined);
  assert.equal(units.find(u=>u.unit === 'T1')!.bytes, Buffer.byteLength('### T1 — First title\none\n'));
  const code = findingUnits({kind:'code', round:1, rounds:[{findings:[{id:'a',locus:'src\\x.ts:L4'},{id:'b',locus:'unresolved-locus: x'},{id:'c',locus:'absolute:L2',defect:'missing-red: T1 SC1'}],startSeq:0}],planPath:'work.plan.md',ruling:()=>undefined});
  assert.deepEqual(code.map(u=>u.unit),['src/x.ts','unresolved','work.plan.md']);
  assert.deepEqual(findingUnits({kind:'plan',round:1,rounds:[{findings:[],text,startSeq:0}],planPath:'',ruling:()=>undefined}),[]);
});

test('finding units preserve round start rulings and count growth without findings', () => {
  const rounds = [
    {findings:[{id:'a',locus:'T1'},{id:'x',locus:'unknown'}],text:'### T1 — One\na\n',startSeq:1},
    {findings:[{id:'b',locus:'T1'}],text:'### T1 — One\naa\n',startSeq:3},
    {findings:[{id:'c',locus:'T1'},{id:'y',locus:'unknown'}],text:'### T1 — One\naaa\n',startSeq:5},
  ];
  const ruling = (id:string, seq:number) => id === 'a' && seq >= 4 ? 'accepted' : id === 'b' && seq >= 4 ? 'accepted' : 'rejected';
  const units = findingUnits({kind:'plan',round:3,rounds,planPath:'',ruling});
  const second = findingUnits({kind:'plan',round:2,rounds,planPath:'',ruling});
  assert.deepEqual([second[0]!.hot,second[0]!.hotStreak],[false,0]);
  assert.deepEqual([units[0]!.hot,units[0]!.hotStreak,units[0]!.growthStreak],[true,1,2]);
  assert.deepEqual([units[1]!.hot,units[1]!.growthStreak],[false,2]);
});

test('finding units resolve renamed IDs and new sections across inputs', () => {
  const rounds = [
    {findings:[{id:'a',locus:'§ AD-4 — Old'}],text:'## Design\n### AD-4 — Old\none\n',startSeq:1},
    {findings:[],text:'## Design\n### AD-4 — New\ntwo\n',startSeq:3},
    {findings:[{id:'b',locus:'unresolved-locus: A — AD-4 — New'}, {id:'c',locus:'T10'}, {id:'d',locus:'New title'}],text:'## Design\n### AD-4 — New\nthree\n### T1 — First\nx\n### T10 — New title\ny\n',startSeq:5},
  ];
  const units = findingUnits({kind:'design',round:3,rounds,planPath:'',ruling:()=> 'accepted'});
  assert.deepEqual(units.map(u=>u.unit),['AD-4','T10']);
  assert.deepEqual(units.find(u=>u.unit === 'AD-4')!.findings,['b']);
  assert.deepEqual(units.find(u=>u.unit === 'T10')!.findings,['c','d']);
  assert.equal(units[0]!.hot,false);
  assert.equal(units[1]!.delta,units[1]!.bytes);
  assert.equal(units[1]!.growthStreak,1);
});

test('finding units require the whole heading title', () => {
  const text = '## New\n### T10 — New title\n';
  const findings = [{id:'a',locus:'New title extra'}, {id:'b',locus:'new TITLE'}, {id:'c',locus:'New'}];
  const units = findingUnits({kind:'plan',round:1,rounds:[{findings,text,startSeq:0}],planPath:'',ruling:()=>undefined});
  assert.deepEqual(units.map(u=>[u.unit,u.findings]),[['artifact',['a']],['T10',['b']],['§ New',['c']]]);
});

test('finding units accept heading markers on exact loci', () => {
  const text = '## Key Interfaces & Data\n### Automated Tests\n';
  const findings = [
    {id:'a',locus:'unresolved-locus: ## Key Interfaces & Data'},
    {id:'b',locus:'unresolved-locus: ### Automated Tests'},
    {id:'c',locus:'§ ## Key Interfaces & Data'},
    {id:'d',locus:'§ ### Automated Tests'},
    {id:'e',locus:'unresolved-locus: ## Key Interfaces & Data extra'},
  ];
  const units = findingUnits({kind:'plan',round:1,rounds:[{findings,text,startSeq:0}],planPath:'',ruling:()=>undefined});
  assert.deepEqual(units.map(u=>[u.unit,u.findings]),[['§ Key Interfaces & Data',['a','c']],['§ Automated Tests',['b','d']],['artifact',['e']]]);
});
