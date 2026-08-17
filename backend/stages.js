// stages.js — canonical pipeline stage vocabulary, one shared source of
// truth. Matches the stage list already used by the existing frontend
// (log-stage select, pipeline filter select, stage badge classes) exactly —
// this does not introduce a new vocabulary, it codifies the one already in use.

const STAGES = ['New', 'Contacted', 'Engaged', 'Follow-up scheduled', 'Converted', 'Dead'];

function isValidStage(stage) {
  return STAGES.includes(stage);
}

module.exports = { STAGES, isValidStage };