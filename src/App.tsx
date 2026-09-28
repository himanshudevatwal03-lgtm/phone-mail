import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, Archive, ArrowLeft, ArrowUpRight, Check, ChevronDown, FileText, Globe2,
  Inbox, Menu, MessageCircle, MoreHorizontal, Paperclip, Phone, Plus, Reply, Search,
  Send, Settings, ShieldAlert, Smartphone, Star, Trash2, UserRound, Users, X
} from 'lucide-react';
import { api, getToken, json, setToken } from './api';

type User = { id: string; phoneNumber: string; emailAddress: string; displayName: string; avatarUrl?: string | null; language?: string };
type Peer = { id: string; phoneNumber: string; emailAddress: string; displayName: string; avatarUrl?: string | null };
type Message = { id: string; sender_id: string | null; sender_name: string; sender_email: string; subject: string; body_text: string; attachments?: any[]; created_at: string; status?: string; read_at?: string | null; is_favorite?: boolean; is_spam?: boolean; is_trash?: boolean; reply_to_id?: string | null; has_reply?: boolean };
type Conversation = { id: string; type: string; title: string; updated_at: string; last_message?: Message | null; unread_count?: number; participants: Peer[]; messages?: Message[]; has_favorite?: boolean; has_attachments?: boolean; draft?: any };
type AuthResult = { token: string; user: User };

const filters = [
  { id: 'all', label: 'All' }, { id: 'unread', label: 'Unread' },
  { id: 'attachments', label: 'Attachments' }, { id: 'favorites', label: 'Favorites' }
];

function initials(value = '') { return value.trim().split(/[\s@+]+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || 'P'; }
function shortTime(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function peerName(conversation: Conversation, me?: User) {
  if (conversation.type === 'group') return conversation.title || conversation.participants?.map(peer => peer.displayName).join(', ') || 'Group conversation';
  const peer = conversation.participants?.[0];
  if (peer) return peer.displayName || peer.phoneNumber;
  return conversation.title || conversation.last_message?.sender_name || 'Email conversation';
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authBusy, setAuthBusy] = useState(Boolean(getToken()));
  const [toast, setToast] = useState('');
  const registrationOnly = window.location.pathname === '/register';
  const termsOnly = window.location.pathname === '/terms';

  useEffect(() => {
    if (!getToken()) { setAuthBusy(false); return; }
    api<User>('/profile').then(setUser).catch(() => setToken('')).finally(() => setAuthBusy(false));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  if (termsOnly) return <TermsPage />;
  if (registrationOnly) return <RegistrationPortal onToast={setToast} />;
  if (authBusy) return <div className="boot-screen"><div className="brand-mark">p</div><span>Opening your inbox</span></div>;
  if (!user) return <AuthScreen onComplete={setUser} onToast={setToast} />;
  return <MailApp user={user} onUser={setUser} onSignOut={() => { setToken(''); setUser(null); }} onToast={setToast} toast={toast} />;
}

function TermsPage() {
  return <main className="terms-page"><article className="terms-document"><a className="terms-brand" href="/"><Brand compact /></a><div className="eyebrow">PHONE MAIL · TERMS</div><h1>Terms of Service</h1><p className="terms-updated">Prototype terms · September 2026</p><p>PhoneMail is a prototype messaging service that gives a verified phone number a PhoneMail address and lets users exchange messages with other PhoneMail accounts.</p><h2>Using PhoneMail</h2><p>Use a phone number you control. Keep your verification codes private. You are responsible for the messages sent from your account and for keeping access to your device or sign-in method secure.</p><h2>Messages and privacy</h2><p>Messages and account details are stored by the PhoneMail service so conversations can be delivered and shown on your devices. PhoneMail may send an SMS notification to an account that has not registered a mobile app. Do not send information you do not have permission to share.</p><h2>Availability</h2><p>This build is an early prototype. Features, message delivery, and account access may change while the service is being developed. The demo deployment is not intended for sensitive or business-critical communication.</p><h2>Acceptable use</h2><p>Do not use PhoneMail to break the law, impersonate another person, harass people, distribute malware, or interfere with the service. We may suspend access to protect users or the service.</p><h2>Contact</h2><p>For this self-hosted build, contact the person or team operating your PhoneMail deployment.</p><a className="primary-button terms-back" href="/">Back to PhoneMail <ArrowUpRight size={16} /></a><p className="terms-disclaimer">These prototype terms should be reviewed and replaced by the service operator before a public launch.</p></article></main>;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? 'brand-compact' : ''}`}><div className="brand-mark">p</div><span>phone<span>mail</span></span></div>;
}

function AuthScreen({ onComplete, onToast }: { onComplete: (user: User) => void; onToast: (value: string) => void }) {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const [step, setStep] = useState(() => window.matchMedia('(max-width: 760px)').matches ? 1 : 3);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [authMode, setAuthMode] = useState<'otp' | 'password'>('otp');
  const [language, setLanguage] = useState('English');
  const verifier = useRef<AbortController | null>(null);

  useEffect(() => {
    api<{ authMode: 'otp' | 'password' }>('/config').then(config => setAuthMode(config.authMode)).catch(() => undefined);
    const query = window.matchMedia('(max-width: 760px)');
    const change = (event: MediaQueryListEvent) => { setMobile(event.matches); setStep(event.matches ? 1 : 3); };
    query.addEventListener('change', change);
    return () => { query.removeEventListener('change', change); verifier.current?.abort(); };
  }, []);

  const beginWebOtp = () => {
    if (!('OTPCredential' in window) || !('credentials' in navigator)) return;
    const controller = new AbortController();
    verifier.current?.abort();
    verifier.current = controller;
    (navigator.credentials as any).get({ otp: { transport: ['sms'] }, signal: controller.signal })
      .then((credential: any) => { if (credential?.code) setCode(credential.code); })
      .catch(() => undefined);
  };

  const verify = async (value = code) => {
    if (!phone.trim() || value.trim().length < 6 || busy) return;
    setBusy(true); setError('');
    try {
      const result = await api<AuthResult>('/auth/otp/verify', json({ phone, code: value.trim(), source: mobile ? 'mobile-web' : 'web', language }));
      verifier.current?.abort();
      setToken(result.token);
      onComplete(result.user);
      onToast('Phone number verified. Your inbox is ready.');
    } catch (err: any) { setError(err.message || 'Could not verify this code.'); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (awaitingCode && code.length === 6 && authMode === 'otp') void verify(code);
    // verification is intentionally triggered only when a complete 6-digit code arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, awaitingCode, authMode]);

  const continueWithOtp = async () => {
    setError('');
    if (!awaitingCode) {
      if (!phone.trim()) { setError('Enter your phone number with country code.'); return; }
      setBusy(true);
      try {
        const result = await api<{ developmentCode?: string; message: string }>('/auth/otp/request', json({ phone }));
        setAwaitingCode(true);
        if (result.developmentCode) setCode(result.developmentCode);
        onToast(result.developmentCode ? `Development code: ${result.developmentCode}` : result.message);
        if (!result.developmentCode) beginWebOtp();
        if (mobile) setStep(4);
      } catch (err: any) { setError(err.message || 'Could not send a verification code.'); }
      finally { setBusy(false); }
      return;
    }
    await verify();
  };

  const continueWithPassword = async () => {
    if (!phone.trim() || password.length < 8) { setError('Enter your phone number and a password of at least 8 characters.'); return; }
    setBusy(true); setError('');
    try {
      const result = await api<AuthResult>('/auth/password/continue', json({ phone, password, source: mobile ? 'mobile-web' : 'web', language }));
      setToken(result.token); onComplete(result.user); onToast('Your inbox is ready.');
    } catch (err: any) { setError(err.message || 'Could not continue.'); }
    finally { setBusy(false); }
  };

  if (mobile && step === 1) return <main className="onboarding mobile-step"><Brand /><div className="onboard-content"><div className="eyebrow">MAKE IT YOURS · 01 / 04</div><h1>Choose your<br /><em>language.</em></h1><p>PhoneMail feels more like home when it speaks your language.</p><label className="field-label">DISPLAY LANGUAGE</label><div className="select-wrap"><Globe2 size={18} /><select value={language} onChange={e => setLanguage(e.target.value)}><option>English</option><option>Hindi</option><option>বাংলা</option><option>मराठी</option><option>தமிழ்</option></select><ChevronDown size={17} /></div><div className="step-spacer" /><button className="primary-button" onClick={() => setStep(2)}>Continue <ArrowUpRight size={17} /></button></div><div className="onboard-foot">A little more private. A lot more personal.</div></main>;

  if (mobile && step === 2) return <main className="onboarding mobile-step"><Brand /><div className="onboard-content"><div className="eyebrow">A QUICK READ · 02 / 04</div><h1>Your inbox.<br /><em>Your choice.</em></h1><p>We’ll use your number to verify your account and let other PhoneMail users send mail to your PhoneMail address.</p><div className="terms-card"><ShieldAlert size={19} /><div><strong>Keep your code private</strong><span>PhoneMail will never ask you to share an OTP with another person.</span></div></div><a className="text-link" href="/terms" target="_blank" rel="noreferrer">Read Terms of Service <ArrowUpRight size={13} /></a><div className="step-spacer" /><button className="primary-button" onClick={() => setStep(3)}>Agree & continue <ArrowUpRight size={17} /></button></div><div className="onboard-foot">By continuing, you agree to the Terms of Service.</div></main>;

  return <main className={`auth-screen ${mobile ? 'onboarding mobile-step' : ''}`}>
    {mobile ? <Brand /> : <div className="auth-aside"><Brand /><div className="auth-aside-copy"><div className="eyebrow">EMAIL, REIMAGINED</div><h1>Your number<br />is your <em>address.</em></h1><p>One verified phone number. A quieter, more human inbox.</p><div className="phone-illustration"><div className="phone-illu-top"><span></span><i></i></div><div className="phone-illu-bubble">See you at 7? <span>9:41</span></div><div className="phone-illu-bubble phone-illu-out">Absolutely. <span>9:42 ✓</span></div><div className="phone-illu-line"></div><div className="phone-illu-message"><b>Today</b><br />From a phone number<br />to a real inbox.</div></div></div><div className="aside-note">PHONE FIRST. PEOPLE ALWAYS.</div></div>}
    <section className="auth-panel"><div className="auth-card">
      {!mobile && <div className="auth-card-brand"><Brand compact /><span className="secure-label"><span className="green-dot"></span> PRIVATE BY DEFAULT</span></div>}
      <div className="eyebrow">{mobile ? `PHONE VERIFICATION · 0${step} / 04` : 'WELCOME TO PHONE MAIL'}</div>
      <h2>{awaitingCode ? <>Check your<br /><em>messages.</em></> : <>Your inbox starts<br /><em>with your number.</em></>}</h2>
      <p className="auth-desc">{awaitingCode ? `Enter the 6-digit code we sent to ${phone}.` : 'Sign in or get started using a phone number you can verify.'}</p>
      {error && <div className="error-banner"><AlertCircle size={16} />{error}</div>}
      <form onSubmit={e => { e.preventDefault(); authMode === 'password' ? void continueWithPassword() : void continueWithOtp(); }}>
        <label className="field-label" htmlFor="auth-phone">PHONE NUMBER</label>
        <div className="input-with-icon"><Phone size={17} /><input id="auth-phone" autoComplete="tel" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+1 415 555 0123" disabled={awaitingCode} required /></div>
        {authMode === 'otp' && awaitingCode && <><label className="field-label code-label" htmlFor="auth-code">6-DIGIT VERIFICATION CODE</label><input id="auth-code" className="otp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" /></>}
        {authMode === 'password' && <><label className="field-label code-label" htmlFor="auth-password">PASSWORD</label><input id="auth-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" /></>}
        {!mobile && <p className="terms-note">By signing up, you agree to the <a href="/terms" target="_blank" rel="noreferrer">Terms of Service</a>.</p>}
        {mobile && step === 3 && <p className="phone-detect-note"><Smartphone size={15} /> Your browser may not allow automatic SIM number detection. You can edit this number before continuing.</p>}
        <button className="primary-button auth-submit" type="submit" disabled={busy || !phone.trim()}>{busy ? 'One moment…' : awaitingCode ? 'Verify & open inbox' : authMode === 'password' ? 'Continue securely' : 'Send verification code'} <ArrowUpRight size={17} /></button>
      </form>
      {awaitingCode && <button className="quiet-button" onClick={() => { setAwaitingCode(false); setCode(''); setStep(3); }}>Change number</button>}
      <div className="auth-bottom"><span><span className="green-dot"></span> Encrypted in transit</span><span>PHONE MAIL · {new Date().getFullYear()}</span></div>
    </div></section>
  </main>;
}

function RegistrationPortal({ onToast }: { onToast: (value: string) => void }) {
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [sent, setSent] = useState(false);
  const [createdAddress, setCreatedAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const next = async (event: React.FormEvent) => {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      if (!sent) {
        const result = await api<{ developmentCode?: string; message: string }>('/auth/otp/request', json({ phone, intent: 'register' }));
        setSent(true); if (result.developmentCode) setOtp(result.developmentCode);
        onToast(result.developmentCode ? `Development code: ${result.developmentCode}` : result.message);
      } else {
        const result = await api<{ user: User }>('/auth/otp/verify', json({ phone, code: otp, intent: 'register', source: 'web-registration' }));
        setCreatedAddress(result.user.emailAddress);
        setPhone(''); setOtp(''); setSent(false);
        onToast('Account created. You can now sign in from PhoneMail.');
      }
    } catch (err: any) { setError(err.message || 'Registration could not be completed.'); }
    finally { setBusy(false); }
  };
  return <main className="registration-page"><div className="registration-art"><Brand /><div><div className="eyebrow">THE PHONE IS THE ADDRESS</div><h1>An inbox that<br /><em>starts with you.</em></h1><p>Just your phone number and a verification code.</p></div><div className="reg-art-stamp">01<br /><span>YOUR<br />INBOX</span></div></div><section className="registration-card"><a className="back-link" href="/">← Back to PhoneMail</a><div className="eyebrow">NEW ACCOUNT · PHONE VERIFICATION</div><h2>Create your<br /><em>PhoneMail address.</em></h2><p className="auth-desc">Verify your number once. We’ll create a private inbox tied to it.</p>{error && <div className="error-banner"><AlertCircle size={16} />{error}</div>}{createdAddress ? <div className="created-card"><Check size={18} /><div><strong>Your account is ready</strong><span>{createdAddress}</span></div></div> : <form onSubmit={next}><label className="field-label">PHONE NUMBER</label><div className="input-with-icon"><Phone size={17} /><input autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+1 415 555 0123" required /></div>{sent && <><label className="field-label code-label">ONE-TIME CODE</label><input className="otp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" /></>}<button className="primary-button auth-submit" disabled={busy}>{busy ? 'One moment…' : sent ? 'Verify & create account' : 'Send verification code'} <ArrowUpRight size={17} /></button><p className="terms-note">By registering, you agree to the <a href="/terms" target="_blank" rel="noreferrer">Terms of Service</a>.</p></form>}</section></main>;
}

function MailApp({ user, onUser, onSignOut, onToast, toast }: { user: User; onUser: (user: User) => void; onSignOut: () => void; onToast: (value: string) => void; toast: string }) {
  const [folder, setFolder] = useState('all');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [matches, setMatches] = useState<Peer[]>([]);
  const [showCompose, setShowCompose] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [openMessage, setOpenMessage] = useState<Message | null>(null);
  const [showNewChat, setShowNewChat] = useState(false);

  const loadItems = async () => {
    setLoadingList(true);
    try {
      const result = await api<Conversation[]>(`/conversations?folder=${encodeURIComponent(folder)}&filter=${encodeURIComponent(filter)}&search=${encodeURIComponent(search)}`);
      setItems(result);
      if (selectedId && !result.some(item => item.id === selectedId)) { setSelectedId(''); setConversation(null); }
    } catch (err: any) { onToast(err.message); }
    finally { setLoadingList(false); }
  };
  const loadConversation = async (id: string) => {
    setSelectedId(id); setMobileChatOpen(true);
    try { setConversation(await api<Conversation>(`/conversations/${id}`)); await loadItems(); }
    catch (err: any) { onToast(err.message); }
  };

  useEffect(() => { const refresh = () => { if (document.visibilityState !== 'visible') return; api<Conversation[]>(`/conversations?folder=${encodeURIComponent(folder)}&filter=${encodeURIComponent(filter)}&search=${encodeURIComponent(search)}`).then(setItems).catch(() => undefined); if (selectedId) api<Conversation>(`/conversations/${selectedId}`).then(value => setConversation(current => current?.id === value.id ? value : current)).catch(() => undefined); }; const interval = window.setInterval(refresh, 4000); window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh); return () => { window.clearInterval(interval); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); }; }, [folder, filter, search, selectedId]);
  useEffect(() => {
    const installed = window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
    if (installed) api('/profile/mobile-app', { method: 'POST' }).catch(() => undefined);
  }, []);
  useEffect(() => {
    const refreshList = () => { void loadItems(); };
    const refreshConversation = (event: Event) => {
      const detail = (event as CustomEvent<Conversation>).detail;
      if (detail?.id === selectedId) setConversation(detail);
    };
    window.addEventListener('phonemail:refresh', refreshList);
    window.addEventListener('phonemail:conversation', refreshConversation);
    return () => { window.removeEventListener('phonemail:refresh', refreshList); window.removeEventListener('phonemail:conversation', refreshConversation); };
  }, [selectedId, folder, filter, search]);
  useEffect(() => {
    const value = search.trim();
    if (value.length < 2 || folder !== 'all') { setMatches([]); return; }
    const timer = window.setTimeout(() => api<Peer[]>(`/users/search?q=${encodeURIComponent(value)}`).then(setMatches).catch(() => setMatches([])), 220);
    return () => window.clearTimeout(timer);
  }, [search, folder]);

  const openPeer = async (peer: Peer) => {
    setMatches([]); setSearch(''); setShowNewChat(false);
    try { const result = await api<{ id: string }>('/conversations/open', json({ phone: peer.phoneNumber })); await loadItems(); await loadConversation(result.id); }
    catch (err: any) { onToast(err.message); }
  };

  const markState = async (message: Message, patch: Record<string, unknown>) => {
    try { await api(`/messages/${message.id}/state`, { method: 'PATCH', body: JSON.stringify(patch) }); await loadItems(); if (selectedId) setConversation(await api<Conversation>(`/conversations/${selectedId}`)); }
    catch (err: any) { onToast(err.message); }
  };

  const openDraft = (draft: any) => { setShowCompose(true); setConversation(null); setOpenMessage({ ...draft, id: draft.id, sender_id: user.id, sender_name: user.displayName, sender_email: user.emailAddress, created_at: draft.created_at, subject: draft.subject, body_text: draft.body_text, attachments: draft.attachments }); };

  const folderItems = [
    { id: 'all', label: 'Home', icon: Inbox }, { id: 'drafts', label: 'Drafts', icon: FileText },
    { id: 'spam', label: 'Spam', icon: ShieldAlert }, { id: 'trash', label: 'Trash', icon: Trash2 }
  ];

  return <main className="mail-app">
    <header className="topbar">
      <button className="icon-button mobile-menu-button" aria-label="Open menu" onClick={() => setMenuOpen(!menuOpen)}><Menu size={21} /></button>
      <Brand compact />
      <div className="global-search"><Search size={18} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search or start with a phone number" onKeyDown={e => { if (e.key === 'Escape') { setMatches([]); setSearch(''); } }} /><kbd>⌘ K</kbd>
        {matches.length > 0 && <div className="search-results"><div className="search-results-heading">PHONE MAIL USERS</div>{matches.map(peer => <button key={peer.id} onClick={() => void openPeer(peer)}><Avatar name={peer.displayName || peer.phoneNumber} image={peer.avatarUrl} small /><span><strong>{peer.displayName || peer.phoneNumber}</strong><small>{peer.phoneNumber} · {peer.emailAddress}</small></span><ArrowUpRight size={15} /></button>)}</div>}
      </div>
      <button className="icon-button top-profile" aria-label="Account settings" onClick={() => setSettingsOpen(true)}><Avatar name={user.displayName || user.phoneNumber} image={user.avatarUrl} small /></button>
    </header>

    <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
      <div className="side-user"><Avatar name={user.displayName || user.phoneNumber} image={user.avatarUrl} /><div><b>{user.displayName || user.phoneNumber}</b><span>{user.emailAddress}</span></div><button className="icon-button" aria-label="Settings" onClick={() => setSettingsOpen(true)}><Settings size={16} /></button></div>
      <button className="compose-button" onClick={() => { setOpenMessage(null); setShowCompose(true); }}><Plus size={18} /> Compose <span>⌘ N</span></button>
      <div className="side-section-label">YOUR MAIL</div>
      <nav className="folder-nav">{folderItems.map(item => { const Icon = item.icon; return <button key={item.id} className={folder === item.id ? 'active' : ''} onClick={() => { setFolder(item.id); setSelectedId(''); setConversation(null); setMenuOpen(false); }}><Icon size={17} /><span>{item.label}</span>{item.id === 'all' && <small>{items.reduce((total, entry) => total + (entry.unread_count || 0), 0) || ''}</small>}</button>; })}</nav>
      <div className="side-bottom"><div className="storage-card"><div className="storage-top"><span>YOUR PHONE MAIL ID</span><span className="green-dot" /></div><strong>{user.emailAddress}</strong><p>One number. One address. Yours.</p></div><button className="signout-button" onClick={onSignOut}><ArrowLeft size={16} /> Sign out</button></div>
    </aside>

    <section className={`conversation-list ${mobileChatOpen ? 'list-mobile-hidden' : ''}`}>
      <div className="list-heading"><div><div className="eyebrow">YOUR SPACE · {new Date().toLocaleDateString([], { month: 'long', day: 'numeric' }).toUpperCase()}</div><h1>{folderItems.find(item => item.id === folder)?.label || 'Home'}<span className="heading-count">{items.length}</span></h1></div><button className="icon-button new-chat-button" aria-label="New conversation" onClick={() => setShowNewChat(true)}><MessageCircle size={18} /></button></div>
      <div className="filter-row" role="tablist">{filters.map(item => <button key={item.id} className={filter === item.id ? 'selected' : ''} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div>
      <div className="conversation-scroll">
        {loadingList && !items.length && <div className="empty-state"><div className="loading-orbit" /><span>Finding your conversations…</span></div>}
        {!loadingList && !items.length && <div className="empty-state"><div className="empty-illustration"><MessageCircle size={25} /></div><strong>{folder === 'drafts' ? 'No drafts yet' : 'Your inbox has room to breathe.'}</strong><span>{folder === 'all' ? 'Search for a phone number to start your first conversation.' : 'Nothing here right now.'}</span>{folder === 'all' && <button onClick={() => setShowNewChat(true)}>Find someone <ArrowUpRight size={14} /></button>}</div>}
        {items.map(item => <ConversationRow key={item.id} item={item} active={selectedId === item.id} user={user} onClick={() => item.type === 'draft' ? openDraft(item.draft || item) : void loadConversation(item.id)} />)}
      </div>
      <div className="mobile-compose-wrap"><button className="mobile-compose" onClick={() => { setOpenMessage(null); setShowCompose(true); }}><Plus size={22} /><span>Compose</span></button></div>
    </section>

    <section className={`reader ${mobileChatOpen ? 'reader-mobile-open' : ''}`}>
      {conversation ? <ConversationView conversation={conversation} user={user} onBack={() => setMobileChatOpen(false)} onReply={(message, traditional) => { setOpenMessage({ ...message, ...(traditional ? { body_text: '' } : {}) }); setShowCompose(true); }} onState={markState} onLongMessage={setOpenMessage} onNewTraditional={() => { setOpenMessage(null); setShowCompose(true); }} onToast={onToast} />
        : <div className="reader-empty"><div className="reader-empty-art"><div className="reader-envelope"><span></span></div><div className="reader-art-dot dot-one" /><div className="reader-art-dot dot-two" /><div className="reader-art-dot dot-three" /></div><div className="eyebrow">A CALMER KIND OF INBOX</div><h2>Mail that feels<br /><em>like a conversation.</em></h2><p>Pick a chat, or search a phone number to write the first hello.</p><button className="outline-button" onClick={() => setShowNewChat(true)}><MessageCircle size={16} /> Find a person</button></div>}
    </section>

    {showNewChat && <NewChatDialog onClose={() => setShowNewChat(false)} onSearch={async value => { const result = await api<Peer[]>(`/users/search?q=${encodeURIComponent(value)}`); return result; }} onSelect={openPeer} />}
    {showCompose && <ComposeModal user={user} conversation={conversation} draft={openMessage?.sender_id === user.id && openMessage?.status === 'draft' ? openMessage : null} reply={openMessage && openMessage.status !== 'draft' ? openMessage : null} onClose={() => { setShowCompose(false); setOpenMessage(null); }} onToast={onToast} onSent={async result => { setShowCompose(false); setOpenMessage(null); await loadItems(); if (result.conversation?.id) await loadConversation(result.conversation.id); }} />}
    {openMessage && !showCompose && <MessageReader message={openMessage} canReply={Boolean(conversation && conversation.type !== 'external' && openMessage.sender_id !== user.id && !openMessage.has_reply)} onClose={() => setOpenMessage(null)} onReply={() => setShowCompose(true)} />}
    {settingsOpen && <SettingsDialog user={user} onClose={() => setSettingsOpen(false)} onUser={onUser} onToast={onToast} />}
    {toast && <div className="toast"><span className="toast-icon"><Check size={15} /></span>{toast}</div>}
    <div className="mobile-bottom-nav"><button onClick={() => { setFolder('all'); setMobileChatOpen(false); }} className={folder === 'all' ? 'selected' : ''}><Inbox size={19} /><span>Chats</span></button><button onClick={() => { setShowNewChat(true); }}><Search size={19} /><span>Find</span></button><button onClick={() => setSettingsOpen(true)}><UserRound size={19} /><span>You</span></button></div>
  </main>;
}

function Avatar({ name, image, small = false }: { name: string; image?: string | null; small?: boolean }) {
  return image ? <img className={`avatar ${small ? 'avatar-small' : ''}`} src={image} alt="" /> : <div className={`avatar avatar-color-${name.charCodeAt(0) % 6} ${small ? 'avatar-small' : ''}`}>{initials(name)}</div>;
}

function ConversationRow({ item, active, user, onClick }: { item: Conversation; active: boolean; user: User; onClick: () => void }) {
  const name = peerName(item, user);
  const message = item.last_message;
  const senderIsMe = message?.sender_id === user.id;
  return <button className={`conversation-row ${active ? 'conversation-active' : ''} ${item.unread_count ? 'conversation-unread' : ''}`} onClick={onClick}>
    <Avatar name={name} image={item.participants?.[0]?.avatarUrl} />
    <div className="conversation-row-copy"><div className="conversation-row-title"><strong>{name}</strong><time>{shortTime(message?.created_at || item.updated_at)}</time></div><div className="conversation-row-preview"><span>{item.type === 'group' && <Users size={12} />}{senderIsMe ? 'You: ' : ''}{message?.body_text || item.draft?.body_text || 'Start a new conversation'}</span>{item.unread_count ? <b>{item.unread_count}</b> : item.has_favorite ? <Star size={13} className="favorite-mini" fill="currentColor" /> : null}</div><div className="conversation-row-subject">{message?.subject || (item.type === 'group' ? `${item.participants?.length || 0} people` : item.participants?.[0]?.phoneNumber)}</div></div>
  </button>;
}

function NewChatDialog({ onClose, onSearch, onSelect }: { onClose: () => void; onSearch: (value: string) => Promise<Peer[]>; onSelect: (peer: Peer) => void }) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<Peer[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { const timer = window.setTimeout(() => { if (term.trim().length < 2) { setResults([]); return; } setBusy(true); onSearch(term.trim()).then(setResults).catch((err: any) => setError(err.message)).finally(() => setBusy(false)); }, 200); return () => window.clearTimeout(timer); }, [term]);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section className="dialog new-chat-dialog"><div className="dialog-head"><div><div className="eyebrow">START WITH A NUMBER</div><h3>Find someone</h3></div><button className="icon-button" onClick={onClose}><X size={19} /></button></div><p>Search a PhoneMail phone number or name. They need to verify their number before they appear.</p><div className="input-with-icon"><Search size={17} /><input autoFocus value={term} onChange={e => { setTerm(e.target.value); setError(''); }} placeholder="+1 415 555 0123" /></div><div className="new-chat-results">{busy && <div className="result-hint">Searching…</div>}{error && <div className="result-hint error-text">{error}</div>}{!busy && term.length >= 2 && results.length === 0 && !error && <div className="result-hint">No verified account found. Ask them to join with their phone number.</div>}{results.map(peer => <button key={peer.id} onClick={() => onSelect(peer)}><Avatar name={peer.displayName || peer.phoneNumber} image={peer.avatarUrl} small /><span><b>{peer.displayName || peer.phoneNumber}</b><small>{peer.phoneNumber}</small></span><ArrowUpRight size={15} /></button>)}</div><div className="dialog-foot"><span><Phone size={14} /> Phone numbers stay inside PhoneMail.</span><button className="quiet-button" onClick={onClose}>Cancel</button></div></section></div>;
}

function ConversationView({ conversation, user, onBack, onReply, onState, onLongMessage, onNewTraditional, onToast }: { conversation: Conversation; user: User; onBack: () => void; onReply: (message: Message, traditional: boolean) => void; onState: (message: Message, patch: Record<string, unknown>) => void; onLongMessage: (message: Message) => void; onNewTraditional: () => void; onToast: (value: string) => void }) {
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [sending, setSending] = useState(false);
  const [subject, setSubject] = useState('');
  const messages = conversation.messages || [];
  const participants = conversation.participants || [];
  const lockedTo = participants.map(peer => peer.phoneNumber || peer.emailAddress).filter(Boolean);
  const last = useRef<HTMLDivElement>(null);
  useEffect(() => { last.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages.length]);
  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await api('/messages/compose', json({ conversationId: conversation.id, to: lockedTo, subject: replyTo ? `Re: ${replyTo.subject || ''}` : subject, bodyText: text.trim(), replyToId: replyTo?.id }));
      setText(''); setSubject(''); setReplyTo(null);
      window.dispatchEvent(new CustomEvent('phonemail:refresh'));
      const refreshed = await api<Conversation>(`/conversations/${conversation.id}`);
      // Parent reloads the conversation on the next inbox refresh event.
      window.dispatchEvent(new CustomEvent('phonemail:conversation', { detail: refreshed }));
    } catch (err: any) { onToast(err.message); }
    finally { setSending(false); }
  };
  useEffect(() => {
    const update = (event: Event) => { const detail = (event as CustomEvent<Conversation>).detail; if (detail?.id === conversation.id) { /* current view is refreshed by its parent */ } };
    window.addEventListener('phonemail:conversation', update);
    return () => window.removeEventListener('phonemail:conversation', update);
  }, [conversation.id]);
  const onTouchStart = (event: React.TouchEvent, message: Message) => { (event.currentTarget as any).dataset.touchX = String(event.touches[0].clientX); (event.currentTarget as any).dataset.touchMessage = message.id; };
  const onTouchEnd = (event: React.TouchEvent, message: Message) => { const x = Number((event.currentTarget as any).dataset.touchX || 0); if (event.changedTouches[0].clientX - x > 58 && message.sender_id !== user.id && !message.has_reply) setReplyTo(message); };
  return <div className="chat-pane">
    <header className="chat-header"><button className="icon-button back-mobile" onClick={onBack}><ArrowLeft size={20} /></button><Avatar name={peerName(conversation, user)} image={participants[0]?.avatarUrl} /><div className="chat-header-copy"><strong>{peerName(conversation, user)}</strong><span>{conversation.type === 'group' ? `${participants.length + 1} people · ${participants.map(item => item.phoneNumber).join(', ')}` : participants[0]?.phoneNumber || conversation.last_message?.sender_email || 'PhoneMail conversation'}</span></div><div className="chat-head-actions"><button className="outline-button chat-compose-traditional" onClick={onNewTraditional}><FileText size={15} /> New email</button><button className="icon-button" aria-label="More options"><MoreHorizontal size={20} /></button></div></header>
    <div className="chat-message-scroll"><div className="conversation-date"><span>END-TO-END PRIVATE</span></div>{messages.map(message => {
      const mine = message.sender_id === user.id;
      const replied = Boolean(message.has_reply);
      return <article key={message.id} className={`message-row ${mine ? 'message-mine' : ''}`} onTouchStart={event => onTouchStart(event, message)} onTouchEnd={event => onTouchEnd(event, message)}>
        {!mine && <Avatar name={message.sender_name || message.sender_email} small />}
        <div className="message-content-wrap"><div className={`message-bubble ${mine ? 'bubble-mine' : ''}`} onClick={() => message.body_text.length > 320 && onLongMessage(message)}>
          {message.reply_to_id && <div className="reply-quote"><Reply size={13} /> Replied to an earlier email</div>}
          {message.subject && <div className="message-subject">{message.subject}</div>}
          <p>{message.body_text}</p>
          {message.body_text.length > 320 && <button className="read-full" onClick={() => onLongMessage(message)}>Read full email <ArrowUpRight size={13} /></button>}
          {message.attachments?.length ? <div className="message-attachments">{message.attachments.map((file: any, index: number) => <span key={file.id || index}><Paperclip size={13} />{file.name || 'Attachment'}</span>)}</div> : null}
          <div className="message-meta"><time>{shortTime(message.created_at)}</time>{mine && <Check size={13} />}{message.is_favorite && <Star size={12} fill="currentColor" />}</div>
        </div><div className="message-tools"><button aria-label="Favorite" onClick={() => onState(message, { is_favorite: !message.is_favorite })}><Star size={14} fill={message.is_favorite ? 'currentColor' : 'none'} /></button>{!mine && <button aria-label="Reply" disabled={replied} title={replied ? 'This email already has a reply' : 'Reply once'} onClick={() => setReplyTo(message)}><Reply size={14} /></button>}<button aria-label="Open traditional view" onClick={() => onReply(message, true)}><FileText size={14} /></button></div></div>
      </article>;
    })}<div ref={last} /></div>
    <div className="chat-composer-area">{replyTo && <div className="replying-banner"><Reply size={14} /><span>Replying to <b>{replyTo.sender_name || replyTo.sender_email}</b> · this message can only receive one reply</span><button onClick={() => setReplyTo(null)}><X size={14} /></button></div>}{!replyTo && <div className="chat-subject-line"><span>SUBJECT</span><input value={subject} onChange={e => setSubject(e.target.value)} placeholder="A short subject for this email" /></div>}<div className="chat-composer"><button className="icon-button" aria-label="Add attachment" onClick={() => onToast('Use Traditional compose to add an attachment.')}><Paperclip size={17} /></button><textarea value={text} onChange={e => setText(e.target.value)} rows={1} placeholder="Write a message…" onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} /><button className="send-button" aria-label="Send message" disabled={!text.trim() || sending} onClick={() => void send()}><Send size={17} /></button></div><div className="composer-hint">ENTER TO SEND <span>·</span> SHIFT + ENTER FOR A NEW LINE</div></div>
  </div>;
}

function ComposeModal({ user, conversation, draft, reply, onClose, onToast, onSent }: { user: User; conversation: Conversation | null; draft: any; reply: Message | null; onClose: () => void; onToast: (value: string) => void; onSent: (result: any) => void }) {
  const locked = Boolean(conversation);
  const recipients = useMemo(() => locked ? (conversation?.participants || []).map(peer => peer.phoneNumber || peer.emailAddress).filter(Boolean) : (draft?.to_addresses || []), [conversation, draft, locked]);
  const [to, setTo] = useState(recipients.join(', '));
  const [cc, setCc] = useState((draft?.cc_addresses || []).join(', '));
  const [subject, setSubject] = useState(reply ? `Re: ${reply.subject || ''}` : draft?.subject || '');
  const [body, setBody] = useState(reply ? '' : draft?.body_text || '');
  const [files, setFiles] = useState<any[]>(draft?.attachments || []);
  const [busy, setBusy] = useState(false);
  const [showCc, setShowCc] = useState(Boolean(draft?.cc_addresses?.length));
  const fileRef = useRef<HTMLInputElement>(null);
  const chooseContacts = async () => {
    const contactApi = (navigator as any).contacts;
    if (!contactApi?.select) { onToast('Contact picker is not supported in this browser. You can type a phone number.'); return; }
    try { const contacts = await contactApi.select(['name', 'tel'], { multiple: true }); const numbers = contacts.flatMap((contact: any) => contact.tel || []); if (numbers.length) setTo((previous: string) => [previous, ...numbers].filter(Boolean).join(', ')); }
    catch { /* user cancelled the contact picker */ }
  };
  const readFiles = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files || []);
    for (const file of selected) {
      if (file.size > 4 * 1024 * 1024) { onToast(`${file.name} is over the 4 MB attachment limit.`); continue; }
      const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
      setFiles(previous => [...previous, { id: `${Date.now()}-${file.name}`, name: file.name, size: file.size, type: file.type, dataUrl }]);
    }
    event.target.value = '';
  };
  const split = (value: string) => value.split(/[;,\n]/).map(item => item.trim()).filter(Boolean);
  const submit = async (isDraft: boolean) => {
    const addresses = locked ? recipients : split(to);
    if (!isDraft && addresses.length === 0) { onToast('Add at least one recipient.'); return; }
    setBusy(true);
    try {
      const fields = {
        to: addresses, cc: locked ? [] : split(cc), subject: reply ? `Re: ${reply.subject || ''}` : subject,
        bodyText: body, attachments: files, conversationId: conversation?.id,
        replyToId: reply?.id, isDraft, draftId: isDraft ? draft?.id : undefined
      };
      const result = draft && !isDraft
        ? await api(`/drafts/${draft.id}/send`, json(fields))
        : await api('/messages/compose', json(fields));
      onToast(isDraft ? 'Draft saved.' : 'Message sent.');
      onSent(result);
    } catch (err: any) { onToast(err.message || 'Could not send this message.'); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop compose-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section className="compose-dialog"><header className="compose-dialog-head"><div><div className="eyebrow">{reply ? 'ONE REPLY · LINKED TO ORIGINAL' : locked ? 'LOCKED TO THIS CONVERSATION' : 'NEW PHONE MAIL'}</div><h3>{reply ? 'Reply to email' : locked ? 'New email in this chat' : 'Compose a new email'}</h3></div><button className="icon-button" onClick={onClose}><X size={19} /></button></header><div className="compose-fields"><label><span>To</span><input value={to} onChange={e => setTo(e.target.value)} disabled={locked} placeholder="Phone number, PhoneMail address, or email" /><button className="quiet-button contacts-button" onClick={() => void chooseContacts()} disabled={locked}><Users size={14} /> Contacts</button></label>{!locked && <label><span>CC</span><input value={cc} onChange={e => setCc(e.target.value)} placeholder="Optional recipients" />{!showCc && <button className="quiet-button" onClick={() => setShowCc(true)}>Add CC</button>}</label>}{!reply && <label><span>Subject</span><input value={subject} onChange={e => setSubject(e.target.value)} placeholder="A short, useful subject" /></label>}</div><textarea className="traditional-body" value={body} onChange={e => setBody(e.target.value)} placeholder="Write your email…" /><div className="attached-files">{files.map((file, index) => <span key={file.id || index}><Paperclip size={13} />{file.name}<button onClick={() => setFiles(previous => previous.filter((_, i) => i !== index))}><X size={12} /></button></span>)}</div><footer className="compose-actions"><div><button className="send-button send-wide" disabled={busy} onClick={() => void submit(false)}><Send size={15} /> Send</button><button className="icon-button" aria-label="Attach a file" onClick={() => fileRef.current?.click()}><Paperclip size={17} /></button><button className="quiet-button" disabled={busy} onClick={() => void submit(true)}>Save draft</button><input ref={fileRef} type="file" multiple className="visually-hidden" onChange={readFiles} /></div><div className="compose-address">From <b>{user.emailAddress}</b></div></footer><p className="compose-locked-note">PhoneMail recipients are found by verified phone number. Multiple recipients start a group chat.</p></section></div>;
}

function MessageReader({ message, canReply, onClose, onReply }: { message: Message; canReply: boolean; onClose: () => void; onReply: () => void }) {
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><article className="dialog long-reader"><header className="dialog-head"><div><div className="eyebrow">FULL EMAIL VIEW</div><h3>{message.subject || '(No subject)'}</h3></div><button className="icon-button" onClick={onClose}><X size={19} /></button></header><div className="letter-meta"><Avatar name={message.sender_name || message.sender_email} small /><span><b>{message.sender_name || message.sender_email}</b><small>{message.sender_email} · {new Date(message.created_at).toLocaleString()}</small></span></div><div className="letter-body">{message.body_text}</div><footer className="reader-reply-row"><button className="outline-button" disabled={!canReply} onClick={onReply}><Reply size={15} /> {message.has_reply ? 'Already replied' : canReply ? 'Reply to this email' : 'Reply unavailable'}</button></footer></article></div>;
}

function SettingsDialog({ user, onClose, onUser, onToast }: { user: User; onClose: () => void; onUser: (user: User) => void; onToast: (value: string) => void }) {
  const [profile, setProfile] = useState(user);
  const [aliases, setAliases] = useState<any[]>([]);
  const [newAlias, setNewAlias] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { api<any>('/profile').then(result => { setProfile(result); setAliases(result.aliases || []); }).catch(() => undefined); }, []);
  const save = async () => { setSaving(true); try { const updated = await api<User>('/profile', { method: 'PUT', body: JSON.stringify({ displayName: profile.displayName, avatarUrl: profile.avatarUrl, language: profile.language }) }); onUser(updated); onToast('Profile saved.'); } catch (err: any) { onToast(err.message); } finally { setSaving(false); } };
  const addAlias = async () => { if (!newAlias.trim()) return; try { const alias = await api('/aliases', json({ alias: newAlias })); setAliases(previous => [...previous, alias]); setNewAlias(''); onToast('Alias added.'); } catch (err: any) { onToast(err.message); } };
  const removeAlias = async (id: string) => { try { await api(`/aliases/${id}`, { method: 'DELETE' }); setAliases(previous => previous.filter(alias => alias.id !== id)); onToast('Alias removed.'); } catch (err: any) { onToast(err.message); } };
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section className="dialog settings-dialog"><div className="dialog-head"><div><div className="eyebrow">YOUR PHONE MAIL</div><h3>Account settings</h3></div><button className="icon-button" onClick={onClose}><X size={19} /></button></div><div className="settings-identity"><Avatar name={profile.displayName || profile.phoneNumber} image={profile.avatarUrl} /><div><strong>{profile.emailAddress}</strong><span>{profile.phoneNumber}</span></div><span className="verified-pill"><Check size={13} /> VERIFIED</span></div><label className="field-label">DISPLAY NAME</label><input className="settings-input" value={profile.displayName || ''} onChange={e => setProfile({ ...profile, displayName: e.target.value })} placeholder="How people see you" /><label className="field-label">PROFILE PICTURE URL</label><input className="settings-input" value={profile.avatarUrl || ''} onChange={e => setProfile({ ...profile, avatarUrl: e.target.value })} placeholder="https://…" /><label className="field-label">LANGUAGE</label><select className="settings-input" value={profile.language || 'English'} onChange={e => setProfile({ ...profile, language: e.target.value })}><option>English</option><option>Hindi</option><option>বাংলা</option><option>मराठी</option><option>தமிழ்</option></select><button className="primary-button settings-save" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save details'} <Check size={16} /></button><div className="settings-divider" /><div className="alias-heading"><div><div className="eyebrow">MORE WAYS TO REACH YOU</div><h4>Alias IDs</h4></div></div><p className="alias-help">Aliases deliver to this same inbox. Only you can add or remove them.</p><div className="alias-list">{aliases.map(alias => <div className="alias-row" key={alias.id}><span><MailMark />{alias.aliasEmail}</span><button className="icon-button" aria-label="Remove alias" onClick={() => void removeAlias(alias.id)}><Trash2 size={15} /></button></div>)}</div><div className="alias-add"><input value={newAlias} onChange={e => setNewAlias(e.target.value)} placeholder="your.name" /><span>@{user.emailAddress.split('@')[1]}</span><button onClick={() => void addAlias()}><Plus size={15} /> Add</button></div><div className="settings-foot"><span><Smartphone size={15} /> SMS alerts apply while the app is not installed</span><span>PHONE MAIL</span></div></section></div>;
}

function MailMark() { return <span className="alias-mark">@</span>; }
