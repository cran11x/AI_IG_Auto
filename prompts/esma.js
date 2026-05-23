/** Produkcijski prompt — koristi varijantu `production_v2` iz variants.js (A/B: `production`) */
const { variants } = require('./variants');

const ESMA_PROMPT = variants.production_v2;

module.exports = { ESMA_PROMPT };
