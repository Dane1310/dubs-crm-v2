// extracted_client.js
// Re-exports crm-api-client.js under the name the integration tests expect.
// This is the SAME client code embedded in the CRM HTML (crm-api-client.js
// is that file's canonical source) — not a second parallel copy. Kept as a
// separate file only because the original test scripts reference this
// filename directly.
module.exports = require('./crm-api-client.js');