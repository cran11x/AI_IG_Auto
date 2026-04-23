/** Produkcijski prompt — koristi varijantu `production` iz variants.js */
const { variants } = require('./variants');

const ESMA_PROMPT = variants.production;

module.exports = { ESMA_PROMPT };
