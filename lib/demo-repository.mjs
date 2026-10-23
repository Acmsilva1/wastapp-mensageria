import { randomUUID } from 'node:crypto';
// Exclusivo do preview local. Nenhuma mensagem ou credencial real.
export class DemoRepository {
  constructor() {
    this.rows = [
      { id: randomUUID(), name: 'Perfil de exemplo', phone: '+5511900000000', audience: 'perfil-exemplo', events: ['health.water_progress', 'health.diet_menu'], enabled: true },
      { id: randomUUID(), name: 'Financeiro de exemplo', phone: '+5521900000000', audience: 'financeiro-exemplo', events: ['financeiro.daily_summary'], enabled: false }
    ];
  }
  async allowLogin() { return true; }
  async saveRecipient(r) {
    const old = this.rows.find(item => item.phone === r.phone && item.audience === r.audience);
    if (old) Object.assign(old, r); else this.rows.unshift({ ...r, id: randomUUID() });
    return old || this.rows[0];
  }
  async toggleRecipient(id, enabled) { const row = this.rows.find(r => r.id === id); if (row) row.enabled = enabled; }
  async snapshot() {
    const now = new Date().toISOString();
    return { state: { status: 'connected', account_name: 'Conta de demonstração', account_phone: '+5511900000000', lease_until: new Date(Date.now() + 90000).toISOString(), updated_at: now, session_saved_at: now },
      recipients: this.rows, deliveries: [{ id: 'demo', name: 'Perfil de exemplo', event_type: 'health.water_progress', status: 'sent', created_at: now }], logs: [{ event: 'connected', created_at: now }, { event: 'session_saved', created_at: now }] };
  }
}
