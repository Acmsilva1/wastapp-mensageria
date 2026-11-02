const PENDING_PURCHASE_STATUSES = new Set(['draft', 'clarification', 'preparing', 'submitting', 'blocked']);

function discardDraft(state, now) {
  const draft = state?.draft;
  if (!draft || !PENDING_PURCHASE_STATUSES.has(draft.status)) return 0;
  state.draft = {
    id: draft.id,
    status: 'cancelled',
    previous_status: draft.status,
    date: draft.date || null,
    expires_at: draft.expires_at || now,
    reset_at: now
  };
  return 1;
}

export function discardPendingPurchaseDrafts(root, now = new Date().toISOString()) {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return 0;
  let discarded = discardDraft(root, now);
  if (root.sessions && typeof root.sessions === 'object' && !Array.isArray(root.sessions)) {
    for (const state of Object.values(root.sessions)) discarded += discardDraft(state, now);
  }
  return discarded;
}
