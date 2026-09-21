/**
 * SOURCE-EXTRACT REPRODUCTION, NOT THE PROJECT'S TEST SUITE.
 * Baseline: Sunsetz2005/campus-badminton-tournament-system
 * commit: 84a159218b300de333e101da5af6ea8d51d3bacb
 * source: src/domain/rules/match-engine.ts
 *
 * The obligation add/remove and threshold branch below were transcribed from
 * the source read through the GitHub connector. TypeScript annotations were
 * removed. `applyThresholdBranch` is the interval/change-ends branch of
 * applyRally, not a substitute for the full engine. The harness supplies valid
 * nonterminal scores directly, and reproduces ACKNOWLEDGE_INTERVAL /
 * CONFIRM_CHANGE_ENDS with the same state operations.
 *
 * Does NOT run Next.js, Prisma, HTTP, authentication, the repository's test
 * suite, or the project's pinned Node runtime. Run original-project regression
 * tests separately before fixing or releasing. No external dependencies.
 */
import assert from 'node:assert/strict';

function clone(value) { return structuredClone(value); }
function addObligation(state, obligation) {
  if (!state.pendingObligations.some((item) => item.id === obligation.id)) state.pendingObligations.push(obligation);
}
function finishObligationPhase(state) {
  if (state.pendingObligations.length > 0) return;
  if (state.phase === 'OBLIGATIONS_PENDING') state.phase = 'IN_PROGRESS';
  if (state.phase === 'GAME_COMPLETE') state.phase = 'AWAITING_NEXT_GAME_SETUP';
}
function removeObligation(state, obligationId, type) {
  const pending = state.pendingObligations.find((item) => item.id === obligationId);
  if (!pending || pending.type !== type) throw new Error('obligation_not_found');
  state.pendingObligations = state.pendingObligations.filter((item) => item.id !== obligationId);
  finishObligationPhase(state);
}
function applyThresholdBranch(state) {
  const scoreA = state.score.A;
  const scoreB = state.score.B;
  const thresholdReached = scoreA === state.ruleConfig.intervalAt || scoreB === state.ruleConfig.intervalAt;
  if (thresholdReached) {
    addObligation(state, {
      id: `interval:game:${state.currentGame}:threshold`,
      type: 'INTERVAL',
      gameNumber: state.currentGame,
      triggerScore: clone(state.score),
    });
  }
  const decidingGame = state.ruleConfig.bestOf === 1 || state.currentGame === state.ruleConfig.bestOf;
  const changeEndsReached =
    scoreA === state.ruleConfig.decidingGameChangeEndsAt || scoreB === state.ruleConfig.decidingGameChangeEndsAt;
  if (decidingGame && changeEndsReached) {
    addObligation(state, {
      id: `change-ends:game:${state.currentGame}:threshold`,
      type: 'CHANGE_ENDS',
      gameNumber: state.currentGame,
      triggerScore: clone(state.score),
    });
  }
  if (state.pendingObligations.length > 0) state.phase = 'OBLIGATIONS_PENDING';
}
function acknowledgeAll(state) {
  for (const item of [...state.pendingObligations]) {
    removeObligation(state, item.id, item.type);
    if (item.type === 'CHANGE_ENDS') {
      state.physicalEnds = { A: state.physicalEnds.B, B: state.physicalEnds.A };
    }
  }
}
function nonTerminalRally(state, winner) {
  assert.equal(state.phase, 'IN_PROGRESS');
  state.score[winner] += 1;
  applyThresholdBranch(state);
}
function freshState({ bestOf, currentGame, threshold }) {
  return {
    ruleConfig: { bestOf, intervalAt: threshold, decidingGameChangeEndsAt: threshold },
    currentGame,
    score: { A: threshold - 1, B: 0 },
    pendingObligations: [],
    phase: 'IN_PROGRESS',
    physicalEnds: { A: 'END_1', B: 'END_2' },
  };
}
const cases = [
  { name: 'single-game-21: 11:0 acknowledged -> 11:1', bestOf: 1, currentGame: 1, threshold: 11 },
  { name: 'best-of-3-21, first game: 11:0 acknowledged -> 11:1', bestOf: 3, currentGame: 1, threshold: 11 },
  { name: 'best-of-3-21, deciding game: 11:0 acknowledged -> 11:1', bestOf: 3, currentGame: 3, threshold: 11 },
  { name: 'best-of-3-15, deciding game: 8:0 acknowledged -> 8:1', bestOf: 3, currentGame: 3, threshold: 8 },
];
const results = cases.map((testCase) => {
  const state = freshState(testCase);
  nonTerminalRally(state, 'A');
  const firstPending = clone(state.pendingObligations);
  acknowledgeAll(state);
  const firstConfirmedEnds = clone(state.physicalEnds);
  assert.equal(state.pendingObligations.length, 0);
  nonTerminalRally(state, 'B');
  const duplicatePending = clone(state.pendingObligations);
  assert.deepEqual(duplicatePending.map((item) => item.id), firstPending.map((item) => item.id));
  acknowledgeAll(state);
  return {
    name: testCase.name,
    reproducedDuplicateThreshold: duplicatePending.length > 0,
    scoreAfterNextRally: state.score,
    recreatedObligations: duplicatePending.map((item) => item.type),
    afterFirstAcknowledgmentEnds: firstConfirmedEnds,
    afterSecondAcknowledgmentEnds: state.physicalEnds,
    duplicateAcknowledgmentSwapsBack: state.physicalEnds.A !== firstConfirmedEnds.A,
  };
});
console.log(JSON.stringify({
  baseline: '84a159218b300de333e101da5af6ea8d51d3bacb',
  scope: 'extracted source branch reproduction only; not repository suite or live application',
  runtime: process.version,
  cases: results,
}, null, 2));
