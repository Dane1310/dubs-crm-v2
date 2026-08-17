// crm-api-client.js
// Thin wrapper around the Phase 3-6 backend API. Written to run unmodified
// in BOTH the browser (embedded in the CRM HTML as a <script> tag) and in
// Node (for direct testing against the live backend) — same code, same
// fetch() calls, so a passing Node test is a genuine proof the browser
// integration logic is correct, not a separate parallel copy.

(function (root) {
  function makeApiClient(baseUrl) {
    let token = null;

    function setToken(t) { token = t; }
    function getToken() { return token; }

    async function request(path, options = {}) {
      const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const res = await fetch(baseUrl + path, Object.assign({}, options, { headers }));
      let body = null;
      try { body = await res.json(); } catch (e) { /* no body */ }
      if (!res.ok) {
        const err = new Error((body && body.error) || ('Request failed: ' + res.status));
        err.status = res.status;
        err.body = body;
        throw err;
      }
      return body;
    }

    return {
      setToken, getToken,

      async login(email, password) {
        const result = await request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
        token = result.token;
        return result;
      },
      async pinLogin(organisationId, displayName, pin) {
        const result = await request('/auth/pin-login', { method: 'POST', body: JSON.stringify({ organisationId, displayName, pin }) });
        token = result.token;
        return result;
      },
      async logout() {
        await request('/auth/logout', { method: 'POST' });
        token = null;
      },
      async me() { return request('/me'); },

      // Leads
      async listLeads() { return request('/leads'); },
      async createLead(data) { return request('/leads', { method: 'POST', body: JSON.stringify(data) }); },
      async getLead(id) { return request('/leads/' + id); },
      async updateLead(id, patch) { return request('/leads/' + id, { method: 'PUT', body: JSON.stringify(patch) }); },
      async updateLeadStage(id, stage) { return request('/leads/' + id, { method: 'PUT', body: JSON.stringify({ stage }) }); },
      async archiveLead(id) { return request('/leads/' + id + '/archive', { method: 'POST' }); },
      async unarchiveLead(id) { return request('/leads/' + id + '/unarchive', { method: 'POST' }); },
      async getStageHistory(leadId) { return request('/leads/' + leadId + '/stage-history'); },
      async getPipeline() { return request('/pipeline'); },

      // Contacts
      async getContact(id) { return request('/contacts/' + id); },
      async createContact(data) { return request('/contacts', { method: 'POST', body: JSON.stringify(data) }); },
      async updateContact(id, patch) { return request('/contacts/' + id, { method: 'PUT', body: JSON.stringify(patch) }); },

      // Users / ownership
      async listUsers() { return request('/users'); },
      async createUser(data) { return request('/users', { method: 'POST', body: JSON.stringify(data) }); },
      async updateUser(id, patch) { return request('/users/' + id, { method: 'PUT', body: JSON.stringify(patch) }); },
      async setUserPin(id, pin) { return request('/users/' + id + '/pin', { method: 'PUT', body: JSON.stringify({ pin }) }); },
      // Convenience used by the frontend's roster/PIN-assignment UI, which
      // works in display names (matching the floor PIN-login flow), not
      // backend user ids. Was previously called by assignPin() in the CRM
      // HTML but never actually implemented — every "sync to backend" PIN
      // assignment silently failed (caught, shown as "backend sync failed").
      async setPinByName(displayName, pin) {
        const users = await request('/users');
        const target = (users || []).find(u => (u.display_name || '').trim().toLowerCase() === displayName.trim().toLowerCase());
        if (!target) throw new Error(`No backend user found with display name "${displayName}" — add them via roster/user creation first, with that exact name.`);
        return request('/users/' + target.id + '/pin', { method: 'PUT', body: JSON.stringify({ pin }) });
      },
      async reassignLead(leadId, ownerUserId) { return request('/leads/' + leadId, { method: 'PUT', body: JSON.stringify({ ownerUserId }) }); },

      // Activities
      async createActivity(data) { return request('/activities', { method: 'POST', body: JSON.stringify(data) }); },
      async listActivitiesForLead(leadId) { return request('/leads/' + leadId + '/activities'); },

      // Tasks
      async createTask(data) { return request('/tasks', { method: 'POST', body: JSON.stringify(data) }); },
      async completeTask(id) { return request('/tasks/' + id + '/complete', { method: 'POST' }); },
      async getTask(id) { return request('/tasks/' + id); },
      async listTasksForLead(leadId) { return request('/leads/' + leadId + '/tasks'); },
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { makeApiClient };
  } else {
    root.CrmApiClient = { makeApiClient };
  }
})(typeof window !== 'undefined' ? window : globalThis);