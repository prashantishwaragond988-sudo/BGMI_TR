const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const api = async (url, options = {}) => {
  const res = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
};
let siteConfig;
async function loadPublicConfig() {
  try {
    siteConfig = await api('/api/config');
    const count = siteConfig.registered;
    $('#registeredCount').textContent = String(count).padStart(2, '0');
    $('#slotFill').style.width = `${Math.min(100, count / siteConfig.capacity * 100)}%`;
    $('#slotsCaption').textContent = count >= siteConfig.capacity ? 'ALL SQUAD SLOTS FILLED' : `${siteConfig.capacity - count} SQUAD SLOTS AVAILABLE`;
    if (count >= siteConfig.capacity) $$('[data-go-register]').forEach(b => { b.disabled = true; b.textContent = 'SQUAD SLOTS FULL'; });
    $('#upiDisplay').textContent = siteConfig.upiId || 'UPI_ID not configured';
    if (siteConfig.upiId) {
      const qr = await api('/api/upi-qr');
      const img = document.createElement('img'); img.src = qr.image; img.alt = 'UPI payment QR code'; $('#qrWrap').replaceChildren(img);
      const pay = $('#payUpi'); pay.href = qr.payload; pay.removeAttribute('aria-disabled');
    }
  } catch (e) { console.warn('Public settings unavailable:', e.message); }
}
function openModal() { const m = $('#registrationModal'); m.classList.add('open'); m.setAttribute('aria-hidden', 'false'); document.body.style.overflow = 'hidden'; }
function closeModal() { const m = $('#registrationModal'); m.classList.remove('open'); m.setAttribute('aria-hidden', 'true'); document.body.style.overflow = ''; }
$$('[data-go-register]').forEach(b => b.addEventListener('click', openModal));
$$('[data-close]').forEach(b => b.addEventListener('click', closeModal));
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
$('#playerFields').innerHTML = Array.from({ length: 4 }, (_, i) => `<div class="player-field"><span class="player-num">0${i + 1}</span><div><input required name="playerName${i}" aria-label="Player ${i + 1} name" placeholder="Player ${i + 1} name" maxlength="60"><input required name="playerId${i}" aria-label="Player ${i + 1} BGMI Character ID" placeholder="BGMI Character ID" maxlength="30" style="margin-top:5px"></div></div>`).join('');
$('#copyUpi').addEventListener('click', async e => {
  const value = siteConfig?.upiId;
  if (!value) return;
  try { await navigator.clipboard.writeText(value); e.currentTarget.textContent = 'COPIED'; setTimeout(() => { e.currentTarget.textContent = 'COPY'; }, 1400); }
  catch { e.currentTarget.textContent = value; }
});
$('#registrationForm').addEventListener('submit', async e => {
  e.preventDefault(); const form = e.currentTarget; const btn = $('.submit-button'); const error = $('#formError'); error.textContent = ''; btn.disabled = true; btn.textContent = 'SUBMITTING…';
  const f = new FormData(form);
  const body = {
    squadName: f.get('squadName'), leaderName: f.get('leaderName'), email: f.get('email'), whatsapp: f.get('whatsapp'),
    players: Array.from({ length: 4 }, (_, i) => ({ name: f.get(`playerName${i}`), characterId: f.get(`playerId${i}`) })),
    substitute: { name: f.get('subName'), characterId: f.get('subId') }, transactionId: f.get('transactionId'), paymentConfirmed: f.has('paymentConfirmed')
  };
  try {
    const result = await api('/api/registrations', { method: 'POST', body: JSON.stringify(body) });
    $('#successMessage').textContent = result.emailSent
      ? `Your registration (${result.registrationNumber}) has been received. A confirmation was sent to ${body.email}. Payment is pending manual verification by the tournament organizer. You will receive a separate approval email after payment is verified.`
      : `Your registration (${result.registrationNumber}) was saved successfully and payment is pending manual verification. The confirmation email could not be delivered; please contact the organizer.`;
    $('#registrationView').hidden = true; $('#successView').hidden = false; form.reset(); loadPublicConfig();
  } catch (err) { error.textContent = err.message; }
  finally { btn.disabled = false; btn.innerHTML = 'SUBMIT REGISTRATION <span>↗</span>'; }
});

const isAdmin = location.pathname === '/admin' || location.pathname === '/admin/';
if (isAdmin) {
  document.body.classList.add('admin-mode'); $('#home').hidden = true; $('footer').hidden = true; $('.topbar').hidden = true; $('#adminPage').hidden = false;
  async function showDashboard() {
    $('#adminLogin').hidden = true; $('#adminDashboard').hidden = false; $('#logoutButton').hidden = false;
    await refreshDashboard();
  }
  async function refreshDashboard() {
    const { items, stats } = await api('/api/admin/registrations');
    $('#statsGrid').innerHTML = [['TOTAL REGISTRATIONS', stats.total], ['PENDING PAYMENTS', stats.pending], ['APPROVED', stats.approved], ['REJECTED', stats.rejected], ['AVAILABLE SLOTS', `${stats.available} / 25`]].map(([label, value]) => `<article class="stat"><span>${label}</span><b>${value}</b></article>`).join('');
    $('#registrationRows').innerHTML = items.length ? items.map(reg => {
      const date = new Date(reg.registrationDate).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
      const players = (reg.players || []).map((p, i) => `${i + 1}. ${esc(p.name)} (${esc(p.characterId)})`).join('<br>') + (reg.substitute?.name ? `<br>SUB: ${esc(reg.substitute.name)} (${esc(reg.substitute.characterId)})` : '');
      return `<tr><td><b>${esc(reg.registrationNumber)}</b></td><td><b>${esc(reg.squadName)}</b><br>${esc(reg.leaderName)}</td><td>${esc(reg.email)}<br>${esc(reg.whatsapp)}</td><td>${players}</td><td>${esc(reg.transactionId)}<br>${date}</td><td><span class="status-pill ${reg.paymentStatus}">${reg.paymentStatus}</span><br><span class="status-pill ${reg.status}">${reg.status}</span></td><td>${reg.status === 'PENDING' ? `<button class="row-action" data-action="approve" data-id="${esc(reg._id)}">APPROVE PAYMENT</button><button class="row-action reject" data-action="reject" data-id="${esc(reg._id)}">REJECT</button>` : reg.emailSentAt ? '<small>EMAIL SENT</small>' : '—'}</td></tr>`;
    }).join('') : '<tr><td colspan="7">No registrations have been submitted.</td></tr>';
  }
  function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault(); const f = new FormData(e.currentTarget); const error = $('#loginError'); error.textContent = '';
    try { await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ username: f.get('username'), password: f.get('password') }) }); await showDashboard(); }
    catch (err) { error.textContent = err.message; }
  });
  $('#refreshAdmin').addEventListener('click', () => refreshDashboard().catch(e => alert(e.message)));
  $('#logoutButton').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST' }); location.reload(); });
  $('#registrationRows').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]'); if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'approve' && !confirm('Confirm you have manually verified this ₹50 payment in the UPI app or bank statement?')) return;
    if (action === 'reject' && !confirm('Reject this registration payment?')) return;
    btn.disabled = true;
    try { const result = await api(`/api/admin/registrations/${encodeURIComponent(btn.dataset.id)}/${action}`, { method: 'POST', body: '{}' }); if (result.emailError) alert(result.emailError); else if (action === 'approve' && !result.emailSent) alert('Registration approved, but the email could not be sent. Check the Gmail SMTP settings.'); await refreshDashboard(); }
    catch (err) { alert(err.message); await refreshDashboard(); }
  });
  api('/api/admin/me').then(showDashboard).catch(() => {});
}
loadPublicConfig();
