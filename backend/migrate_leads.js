// migrate_leads.js
//
// Reads a JSON export of the EXISTING CRM's LEADS array (the same shape
// documented in the Phase 4 report, section A) and migrates it into the
// new Lead + Contact tables for a given organisation.
//
// Usage: node migrate_leads.js <path-to-legacy-leads.json> <organisationId> <sourceLabel>
//
// Safe to re-run: already-migrated records (matched by legacy_id) are
// detected and skipped, not re-inserted or duplicated.

const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');
const leadRepo = require('./repositories/leadRepository');
const contactRepo = require('./repositories/contactRepository');
const auditRepo = require('./repositories/auditRepository');

function migrate(filePath, organisationId, sourceLabel) {
  const raw = fs.readFileSync(filePath, 'utf8');
  let sourceRecords;
  try {
    sourceRecords = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Source file is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(sourceRecords)) {
    throw new Error('Source file must contain a JSON array of lead records');
  }

  const runId = 'migrun_' + crypto.randomBytes(6).toString('hex');
  const startedAt = new Date().toISOString();

  const report = {
    sourceCount: sourceRecords.length,
    migratedCount: 0,
    alreadyMigratedCount: 0,
    duplicateCount: 0,
    contactsCreatedCount: 0,
    rejected: [], // { legacyId, company, reason }
  };

  for (const rec of sourceRecords) {
    const legacyId = rec.id || null;
    const company = (rec.company || '').toString().trim();

    // --- Validation ---
    if (!company) {
      report.rejected.push({ legacyId, company: rec.company || null, reason: 'Missing required field: company' });
      continue;
    }

    // --- Idempotency: already migrated? ---
    if (legacyId && leadRepo.findByLegacyId(organisationId, legacyId)) {
      report.alreadyMigratedCount++;
      continue;
    }

    // --- Duplicate detection: same company already exists (active) in this org ---
    const existingDupe = leadRepo.findDuplicateByCompany(organisationId, company);
    if (existingDupe && !legacyId) {
      // No legacy_id to key off — genuinely can't tell this apart from the
      // existing record, so treat as a duplicate and skip rather than guess.
      report.duplicateCount++;
      continue;
    }

    // --- Contact split-out (Phase 2 §E): only create one if there's
    //     actually contact information to preserve; don't invent empty rows.
    let contactId = null;
    const hasContactInfo = rec.contact || rec.email || rec.phone;
    if (hasContactInfo) {
      const contact = contactRepo.createContact({
        organisationId, name: rec.contact || null, email: rec.email || null, phone: rec.phone || null
      });
      contactId = contact.id;
      report.contactsCreatedCount++;
    }

    // --- Fields not yet modelled as first-class columns are preserved,
    //     not discarded, in raw_extra.
    const known = new Set([
      'id','agent','company','contact','email','phone','website','address',
      'industry','source','enrichmentStatus','regDate','stage','dateAdded',
      'createdAt','followUpDate','duplicateFlag','duplicateOfAgent','archived',
      'imported','needsReassignment','log'
    ]);
    const extra = {};
    for (const key of Object.keys(rec)) {
      if (!known.has(key)) extra[key] = rec[key];
    }
    // Deliberately preserve a few known-but-not-yet-columned fields too,
    // rather than lose them:
    if (rec.enrichmentStatus) extra.enrichmentStatus = rec.enrichmentStatus;
    if (rec.regDate) extra.regDate = rec.regDate;
    if (rec.imported !== undefined) extra.imported = rec.imported;
    if (rec.needsReassignment !== undefined) extra.needsReassignment = rec.needsReassignment;
    if (rec.log) extra.activityLog = rec.log; // activities migrate in a later phase — kept here so nothing is lost meanwhile

    const lead = leadRepo.createLead({
      organisationId,
      contactId,
      legacyId,
      company,
      source: rec.source || (sourceLabel || null),
      stage: rec.stage || 'New',
      ownerUserId: null,               // no user-account mapping exists yet for legacy agent names — see report section I
      ownerNameRaw: rec.agent || null,
      industry: rec.industry || null,
      address: rec.address || null,
      website: rec.website || null,
      followUpDate: rec.followUpDate || null,
      dateAdded: rec.dateAdded || null,
      duplicateFlag: !!rec.duplicateFlag,
      duplicateOfLeadId: null,         // cross-referencing legacy duplicate agent names to new lead IDs is future work
      archived: !!rec.archived,
      rawExtra: Object.keys(extra).length ? extra : null,
    });

    report.migratedCount++;
  }

  const finishedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO migration_runs (id, organisation_id, source_label, started_at, finished_at,
      source_count, migrated_count, duplicate_count, rejected_count, contacts_created_count, report_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId, organisationId, sourceLabel, startedAt, finishedAt,
    report.sourceCount, report.migratedCount, report.duplicateCount,
    report.rejected.length, report.contactsCreatedCount, JSON.stringify(report)
  );

  auditRepo.record({
    organisationId, userId: null, event: 'leads.migrated',
    entityType: 'migration_run', entityId: runId, metadata: report
  });

  return { runId, ...report };
}

if (require.main === module) {
  const [,, filePath, organisationId, sourceLabel] = process.argv;
  if (!filePath || !organisationId) {
    console.error('Usage: node migrate_leads.js <path-to-legacy-leads.json> <organisationId> [sourceLabel]');
    process.exit(1);
  }
  const result = migrate(filePath, organisationId, sourceLabel || 'legacy-export');
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { migrate };