import { useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Link, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import {
  Activity, ArrowDownToLine, ArrowRight, Check, CheckCircle2, ChevronDown, CircleHelp,
  Clock3, Command, Database, FileSpreadsheet, FlaskConical, Gauge, History, Info,
  LineChart, Menu, Plus, RotateCcw, Sigma, Sparkles, X, XCircle
} from 'lucide-react';
import {
  getGetExamplesQueryKey, getHealthCheckQueryKey, useAnalyzeDataset, useCheckEquation,
  useGetExamples, useHealthCheck, usePlotEquation, useSolveEquation
} from '@workspace/api-client-react';
import type { Example } from '@workspace/api-client-react';
import { type ReactNode } from 'react';
import type { Data } from 'plotly.js';
import PlotlyChart from '@/components/PlotlyChart';

const queryClient = new QueryClient();
// Base URL of the separately deployed API service (build-time). Empty = same origin.
const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
type HistoryItem = { id: string; module: string; title: string; detail: string; at: number; href: string };
type ObservationRow = { x_value: number; observed_y: number };
type SavedDataset = {
  cases: Record<string, ObservationRow[]>;
  caseId: string;
  sourceCsv: string;
  filename: string;
  model: 'decay' | 'growth' | 'quadratic';
};
const HISTORY_KEY = 'equationpath-history-v1';
const DATASET_KEY = 'equationpath-dataset-v1';
const EQUATION_TRANSFER_KEY = 'equationpath-equation-transfer-v1';
type SupportedFitModel = 'decay' | 'growth' | 'quadratic';
type TransferredEquation = { m: string; n: string; model: SupportedFitModel | null };
// The parameter fitter supports exactly three ODE families. Only recognize these
// explicit, mathematically equivalent input spellings; never silently guess.
function fitFamily(m: string, n: string): SupportedFitModel | null {
  const tidy = (v: string) => v.replace(/\s+/g, '').replace(/\^/g, '**');
  const a = tidy(m), b = tidy(n);
  if (b !== '1' && b !== '+1') return null;
  if (a === 'y' || a === '+y') return 'decay';           // y' = -y
  if (a === '-2*y' || a === '-2y') return 'growth';      // y' = 2y
  if (a === '-2*x' || a === '-2x') return 'quadratic';   // y' = 2x
  return null;
}
function saveTransferredEquation(m: string, n: string): void {
  localStorage.setItem(EQUATION_TRANSFER_KEY, JSON.stringify({ m, n, model: fitFamily(m, n) } satisfies TransferredEquation));
}
function getTransferredEquation(): TransferredEquation | null {
  try {
    const value = JSON.parse(localStorage.getItem(EQUATION_TRANSFER_KEY) || 'null');
    if (typeof value?.m === 'string' && typeof value?.n === 'string')
      return {m: value.m, n: value.n, model: fitFamily(value.m, value.n)};
  } catch { /* stale browser storage */ }
  return null;
}
const readHistory = (): HistoryItem[] => {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') as HistoryItem[]; } catch { return []; }
};
const addHistory = (item: Omit<HistoryItem, 'id' | 'at'>) => {
  const next = [{ ...item, id: `${Date.now()}-${Math.random()}`, at: Date.now() }, ...readHistory()].slice(0, 40);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event('equationpath-history'));
};
const readSavedDataset = (): SavedDataset => {
  const fallback: SavedDataset = { cases: {}, caseId: '', sourceCsv: '', filename: '', model: 'decay' };
  try {
    const saved = JSON.parse(localStorage.getItem(DATASET_KEY) || 'null') as Partial<SavedDataset> | null;
    if (!saved || typeof saved.cases !== 'object' || saved.cases === null) return fallback;
    return {
      ...fallback,
      ...saved,
      cases: saved.cases as Record<string, ObservationRow[]>,
      model: ['decay', 'growth', 'quadratic'].includes(String(saved.model)) ? saved.model as SavedDataset['model'] : 'decay',
    };
  } catch { return fallback; }
};
function parseCsvGrid(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell.length === 0) quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (quoted) throw new Error('A quoted CSV value was not closed.');
  row.push(cell);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  return rows;
}
function parseObservationCsv(text: string): { cases?: Record<string, ObservationRow[]>; error?: string } {
  let rows: string[][];
  try { rows = parseCsvGrid(text); } catch (error) { return { error: error instanceof Error ? error.message : 'Could not parse this CSV.' }; }
  if (!rows.length) return { error: 'The CSV is empty.' };
  const headers = rows[0].map((header) => header.replace(/^\uFEFF/, '').trim().toLowerCase());
  const required = ['case_id', 'x_value', 'observed_y'];
  const missing = required.filter((name) => !headers.includes(name));
  if (missing.length) return { error: `Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.` };
  const caseIndex = headers.indexOf('case_id');
  const xIndex = headers.indexOf('x_value');
  const yIndex = headers.indexOf('observed_y');
  const groups: Record<string, ObservationRow[]> = {};
  for (let i = 1; i < rows.length; i += 1) {
    const line = rows[i];
    const caseId = (line[caseIndex] ?? '').trim();
    const xText = (line[xIndex] ?? '').trim();
    const yText = (line[yIndex] ?? '').trim();
    if (!caseId || !xText || !yText) return { error: `Row ${i + 1} has a missing case ID, x-value, or observation.` };
    const xValue = Number(xText);
    const observedY = Number(yText);
    if (!Number.isFinite(xValue) || !Number.isFinite(observedY)) return { error: `Row ${i + 1} contains a non-numeric x-value or observation.` };
    const observations = groups[caseId] ?? (groups[caseId] = []);
    if (observations.some((item) => item.x_value === xValue)) return { error: `Case "${caseId}" has a duplicate x-value (${xText}).` };
    observations.push({ x_value: xValue, observed_y: observedY });
    if (i > 2000) return { error: 'A CSV may contain at most 2,000 observations.' };
  }
  if (!Object.keys(groups).length) return { error: 'The CSV has a header but no observation rows.' };
  return { cases: groups };
}
const fmt = (value: unknown) => typeof value === 'number' ? Number(value.toPrecision(5)).toString() : String(value ?? '—');
const errText = (error: unknown) => (error as { message?: string })?.message || 'The request could not be completed. Check the service and try again.';

function AppFrame({ children }: { children: ReactNode }) {
  const [path] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const health = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 45000 } });
  const nav = [
    { href: '/', label: 'Overview', icon: Gauge },
    { href: '/solver', label: 'Exactness solver', icon: Sigma },
    { href: '/visualizer', label: 'Curve visualizer', icon: LineChart },
    { href: '/fitting', label: 'Data fitting', icon: FileSpreadsheet },
    { href: '/examples', label: 'Examples', icon: FlaskConical },
    { href: '/guide', label: 'Learning guide', icon: CircleHelp },
    { href: '/history', label: 'History', icon: History },
  ];
  return <div className="app-shell">
    <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
      <Link href="/" className="brand" onClick={() => setMobileOpen(false)}>
        <span className="brand-mark"><Sigma size={20} strokeWidth={2.2} /></span>
        <span className="brand-name">Equation<span>Path</span><small>ODE WORKSPACE</small></span>
      </Link>
      <div className="side-caption">WORKSPACE</div>
      <nav className="side-nav">
        {nav.map(({ href, label, icon: Icon }) => <Link key={href} href={href} onClick={() => setMobileOpen(false)} className={`nav-item ${path === href ? 'active' : ''}`} data-testid={`link-nav-${label.toLowerCase().replaceAll(' ', '-')}`}>
          <Icon size={17} strokeWidth={1.8} /><span>{label}</span>{path === href && <span className="nav-active-dot" />}
        </Link>)}
      </nav>
      <div className="side-bottom">
        <div className="side-status"><span className={`status-pip ${health.isError ? 'offline' : ''}`} /><div><b>{health.isLoading ? 'Connecting' : health.isError ? 'Service unavailable' : 'API connected'}</b><small>{health.data?.status || (health.isError ? 'Retry from any module' : 'Equation engine ready')}</small></div></div>
        <div className="sidebar-foot"><span>Built for understanding</span><span className="kbd">EP / 01</span></div>
      </div>
    </aside>
    {mobileOpen && <button className="mobile-scrim" onClick={() => setMobileOpen(false)} aria-label="Close navigation" />}
    <main className="main-area">
      <header className="topbar">
        <button className="mobile-menu icon-button" onClick={() => setMobileOpen(!mobileOpen)} aria-label="Toggle navigation"><Menu size={19} /></button>
        <div className="breadcrumb"><span>EquationPath</span><span className="crumb-slash">/</span><b>{nav.find((n) => n.href === path)?.label || 'Workspace'}</b></div>
        <div className="topbar-right"><span className="topbar-note"><span className="status-pip" /> Mathematical workspace</span><span className="topbar-key"><Command size={13} /> local</span></div>
      </header>
      <div className="page-wrap">{children}</div>
    </main>
  </div>;
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: ReactNode; description: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}
function Card({ children, className = '' }: { children: ReactNode; className?: string }) { return <section className={`panel ${className}`}>{children}</section>; }
function Label({ children }: { children: ReactNode }) { return <label className="field-label">{children}</label>; }
function InputField({ label, value, onChange, placeholder, type = 'text', hint, step }: { label: string; value: string | number; onChange: (value: string) => void; placeholder?: string; type?: string; hint?: string; step?: string }) {
  return <label className="field"><span className="field-label">{label}</span><input type={type} step={step} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} data-testid={`input-${label.toLowerCase().replaceAll(' ', '-')}`} />{hint && <small className="field-hint">{hint}</small>}</label>;
}
function Button({ children, onClick, variant = 'primary', disabled, type = 'button', className = '' }: { children: ReactNode; onClick?: () => void; variant?: 'primary' | 'secondary' | 'quiet' | 'danger'; disabled?: boolean; type?: 'button' | 'submit'; className?: string }) {
  return <button type={type} onClick={onClick} disabled={disabled} className={`btn btn-${variant} ${className}`} data-testid="button-action">{children}</button>;
}
function ErrorBlock({ error, retry }: { error: unknown; retry: () => void }) { return <div className="error-box"><XCircle size={18} /><div><b>Couldn’t complete that request</b><p>{errText(error)}</p></div><button onClick={retry} className="text-button">Retry</button></div>; }
function Skeleton({ rows = 3 }: { rows?: number }) { return <div className="skeleton-stack">{Array.from({ length: rows }, (_, i) => <div className="skeleton-row" key={i} />)}</div>; }
function ResultPill({ good, children }: { good: boolean; children: ReactNode }) { return <span className={`result-pill ${good ? 'good' : 'warn'}`}>{good ? <CheckCircle2 size={14} /> : <Info size={14} />}{children}</span>; }

function Overview() {
  const { data, isLoading, isError, error, refetch } = useGetExamples({ query: { queryKey: getGetExamplesQueryKey() } });
  const items = readHistory().slice(0, 3);
  return <div className="page-content">
    <PageHeading eyebrow="A workspace for differential equations" title={<>Follow the logic.<br /><em>See the curve.</em></>} description="Check exactness, work through the solution, then connect the model to what you observed." action={<span className="date-chip"><Activity size={14} /> FIRST-ORDER ODEs</span>} />
    <div className="overview-hero">
      <div className="hero-copy"><div className="hero-kicker"><span className="pulse-line" /> START WITH THE STRUCTURE</div><h2>From equation<br />to <span>understanding.</span></h2><p>Make the reasoning visible. Begin with an equation, test its structure, and follow every supported step to a verified result.</p>
        <div className="hero-actions"><Link href="/solver" className="btn btn-primary">Open exactness solver <ArrowRight size={16} /></Link><Link href="/examples" className="btn btn-outline">Browse examples</Link></div>
        <div className="hero-meta"><span><span className="tiny-check"><Check size={11} /></span> Transparent steps</span><span><span className="tiny-check"><Check size={11} /></span> Computed from your input</span></div>
      </div>
      <div className="hero-graphic" aria-label="Abstract equation and curve illustration">
        <div className="graph-label"><span>FIELD NOTE 01</span><span>dy / dx</span></div>
        <div className="hero-equation"><span className="math-cyan">M</span> dx + <span className="math-violet">N</span> dy = 0</div>
        <svg viewBox="0 0 430 190" className="hero-curve" role="img" aria-label="Illustrative coordinate curve"><defs><linearGradient id="curveFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#36d6e9" stopOpacity=".19" /><stop offset="1" stopColor="#36d6e9" stopOpacity="0" /></linearGradient></defs><path d="M0 165 C55 147 68 45 130 62 S200 161 253 116 S325 24 430 31 L430 190 L0 190Z" fill="url(#curveFill)" /><path d="M0 165 C55 147 68 45 130 62 S200 161 253 116 S325 24 430 31" fill="none" stroke="#49d9e8" strokeWidth="2.5" /><circle cx="130" cy="62" r="4" fill="#a892f4" /><circle cx="253" cy="116" r="4" fill="#49d9e8" /><g stroke="#26394b" strokeWidth="1"><path d="M0 48H430M0 96H430M0 144H430M86 0V190M172 0V190M258 0V190M344 0V190" /></g></svg>
        <div className="hero-chart-footer"><span><i className="legend-dot cyan" /> solution family</span><span>IMPLICIT FORM · VERIFIED</span></div>
      </div>
    </div>
    <div className="section-label"><span>CHOOSE A PATH</span><span className="section-rule" /></div>
    <div className="module-grid">
      <Link href="/solver" className="module-card"><span className="module-index">01 / ANALYZE</span><span className="module-icon cyan-icon"><Sigma size={20} /></span><h3>Exactness solver</h3><p>Compare partial derivatives, surface supported integrating factors, and inspect a step-by-step solution.</p><span className="module-link">Open solver <ArrowRight size={14} /></span></Link>
      <Link href="/visualizer" className="module-card"><span className="module-index">02 / VISUALIZE</span><span className="module-icon violet-icon"><LineChart size={20} /></span><h3>Curve visualizer</h3><p>Set an initial condition and explore the numerical solution curve across a chosen interval.</p><span className="module-link">Plot a solution <ArrowRight size={14} /></span></Link>
      <Link href="/fitting" className="module-card"><span className="module-index">03 / COMPARE</span><span className="module-icon blue-icon"><Database size={20} /></span><h3>Data fitting</h3><p>Bring observations, fit a supported model parameter, and read residuals beside the fitted values.</p><span className="module-link">Fit observations <ArrowRight size={14} /></span></Link>
    </div>
    <div className="overview-lower">
      <Card className="recent-card"><div className="card-head"><div><div className="eyebrow">LOCAL SESSION</div><h3>Recent calculations</h3></div><Link className="text-link" href="/history">View history <ArrowRight size={14} /></Link></div>
        {items.length ? <div className="recent-list">{items.map((it) => <Link href={it.href} className="recent-row" key={it.id}><span className="recent-icon"><Clock3 size={15} /></span><span className="recent-info"><b>{it.title}</b><small>{it.detail}</small></span><time>{new Date(it.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></Link>)}</div> : <div className="quiet-empty"><span className="empty-mark"><History size={17} /></span><div><b>Your work stays on this device</b><p>Completed analyses will appear here for quick return.</p></div></div>}
      </Card>
      <Card className="examples-card"><div className="card-head"><div><div className="eyebrow">VERIFIED STARTING POINTS</div><h3>Explore a worked example</h3></div><FlaskConical size={18} className="muted-icon" /></div>
        {isLoading ? <Skeleton rows={2} /> : isError ? <ErrorBlock error={error} retry={() => void refetch()} /> : data?.examples?.length ? data.examples.slice(0, 3).map((e) => <Link href={`/solver?example=${encodeURIComponent(e.id)}`} className="example-mini" key={e.id}><span className="example-kind">{e.kind}</span><b>{e.title}</b><span className="example-equation">{e.m} dx + {e.n} dy = 0</span><ArrowRight size={14} /></Link>) : <div className="empty-inline">No examples are available yet.</div>}
      </Card>
    </div>
  </div>;
}

function Solver() {
  const query = new URLSearchParams(window.location.search);
  const [m, setM] = useState('2*x*y + 3');
  const [n, setN] = useState('x**2 + 4*y');
  const [exact, setExact] = useState<any>(null);
  const [solution, setSolution] = useState<any>(null);
  const check = useCheckEquation();
  const solve = useSolveEquation();
  const { data: examples } = useGetExamples({ query: { queryKey: getGetExamplesQueryKey() } });
  useEffect(() => { const ex = examples?.examples?.find((item) => item.id === query.get('example')); if (ex) { setM(ex.m); setN(ex.n); } }, [examples, query.get('example')]);
  const payload = { m: m.trim(), n: n.trim() };
  const runCheck = () => check.mutate({ data: payload }, { onSuccess: (res) => { setExact(res); setSolution(null); addHistory({ module: 'Exactness solver', title: 'Exactness check', detail: `${payload.m} dx + ${payload.n} dy`, href: '/solver' }); } });
  const runSolve = () => solve.mutate({ data: payload }, { onSuccess: (res) => { setSolution(res); if (res.status === 'solved') saveTransferredEquation(payload.m, payload.n); addHistory({ module: 'Exactness solver', title: 'Equation solved', detail: `${payload.m} dx + ${payload.n} dy`, href: '/solver' }); } });
  const fillExample = (ex: Example) => { setM(ex.m); setN(ex.n); setExact(null); setSolution(null); };
  return <div className="page-content">
    <PageHeading eyebrow="01 / Analyze" title="Exactness solver" description="Compare the cross-partials first. Then follow the method the equation supports." action={<span className="mode-chip"><span className="status-pip" /> SYMBOLIC ENGINE</span>} />
    <div className="solver-layout">
      <div className="solver-main">
        <Card className="equation-card"><div className="card-head"><div><div className="eyebrow">DEFINE YOUR EQUATION</div><h3>Enter M and N</h3></div><span className="step-badge">01</span></div>
          <div className="equation-entry"><div className="equation-symbol">M</div><div className="equation-input-wrap"><Label>M(x, y)</Label><input value={m} onChange={(e) => { setM(e.target.value); setExact(null); setSolution(null); }} placeholder="e.g. 2*x*y + 3" data-testid="input-equation-m" /><small>coefficient of dx</small></div><span className="equation-operator">dx +</span><div className="equation-symbol violet">N</div><div className="equation-input-wrap"><Label>N(x, y)</Label><input value={n} onChange={(e) => { setN(e.target.value); setExact(null); setSolution(null); }} placeholder="e.g. x**2 + 4*y" data-testid="input-equation-n" /><small>coefficient of dy</small></div><span className="equation-operator">dy = 0</span></div>
          <div className="equation-actions"><span className="helper-note"><Info size={14} /> Use <code>x</code>, <code>y</code>, powers, and standard functions.</span><div><Button variant="secondary" disabled={!m.trim() || !n.trim() || check.isPending} onClick={runCheck}>{check.isPending ? 'Checking…' : 'Check exactness'}</Button><Button disabled={!m.trim() || !n.trim() || solve.isPending} onClick={runSolve}>{solve.isPending ? 'Solving…' : <>Solve equation <ArrowRight size={15} /></>}</Button></div></div>
          {check.isError && <ErrorBlock error={check.error} retry={runCheck} />}{solve.isError && <ErrorBlock error={solve.error} retry={runSolve} />}
        </Card>
        {check.isPending || solve.isPending ? <Card><Skeleton rows={4} /></Card> : null}
        {exact && <Card className="result-card"><div className="card-head"><div><div className="eyebrow">CROSS-PARTIAL TEST</div><h3>What the derivatives tell us</h3></div><ResultPill good={exact.is_exact}>{exact.is_exact ? 'Exact equation' : exact.factor ? 'Factor supported' : 'Not exact'}</ResultPill></div>
          <div className="derivative-grid"><div className="derivative-cell"><span>∂M / ∂y</span><b>{exact.m_y}</b></div><span className="operator-equals">≟</span><div className="derivative-cell"><span>∂N / ∂x</span><b>{exact.n_x}</b></div><div className={`difference-cell ${exact.is_exact ? 'is-exact' : ''}`}><small>DIFFERENCE</small><b>{exact.difference}</b></div></div>
          <div className="explanation"><span className="explanation-mark"><Info size={16} /></span><div><b>{exact.method}</b><p>{exact.explanation}</p>{exact.factor && <p className="factor-line">Supported integrating factor <code>μ = {exact.factor}</code></p>}</div></div>
        </Card>}
        {solution && <Card className="solution-card"><div className="card-head"><div><div className="eyebrow">SOLUTION · {solution.method}</div><h3>Follow the derivation</h3></div><ResultPill good={solution.status === 'success' || solution.status === 'solved'}>{solution.status}</ResultPill></div>
          {solution.status === 'solved' && <div className="equation-actions"><Link href="/visualizer?from=solver" onClick={() => saveTransferredEquation(payload.m, payload.n)} className="btn btn-secondary">Visualize this equation <ArrowRight size={15} /></Link><Link href="/fitting?from=solver" onClick={() => saveTransferredEquation(payload.m, payload.n)} className="btn btn-primary">Fit observations numerically <ArrowRight size={15} /></Link></div>}
          {solution.implicit_solution && <div className="potential-result"><small>IMPLICIT SOLUTION</small><strong>{solution.implicit_solution}</strong></div>}
          {solution.potential && <div className="potential-result secondary-result"><small>POTENTIAL FUNCTION</small><strong>{solution.potential}</strong></div>}
          {solution.steps?.length ? <ol className="steps-list">{solution.steps.map((step: string, i: number) => <li key={`${i}-${step}`}><span>{String(i + 1).padStart(2, '0')}</span><p>{step}</p></li>)}</ol> : <div className="empty-inline">The solver did not return derivation steps for this input.</div>}
          <div className="verification-row"><CheckCircle2 size={16} /><div><b>Verification</b><span>{typeof solution.verification === 'object' ? JSON.stringify(solution.verification) : String(solution.verification || 'No verification details returned.')}</span></div></div>
          {solution.domain_restrictions?.length > 0 && <div className="notice-line"><Info size={15} /> Domain restrictions: {solution.domain_restrictions.join('; ')}</div>}
          {solution.warnings?.map((w: string, i: number) => <div className="notice-line warning-line" key={i}><Info size={15} />{w}</div>)}
        </Card>}
        {!exact && !solution && <Card className="empty-result"><div className="empty-illustration"><span>∂M</span><span className="line" /><span>∂N</span></div><b>The method starts with a comparison.</b><p>Check exactness to see the cross-partials, or solve to request the complete supported derivation.</p></Card>}
      </div>
      <aside className="solver-aside"><Card className="aside-card"><div className="eyebrow">QUICK REFERENCE</div><h3>The exactness test</h3><div className="formula-box">∂M/∂y = ∂N/∂x</div><p>For <span className="math-cyan">M(x,y) dx</span> + <span className="math-violet">N(x,y) dy</span> = 0, equal cross-partials indicate an exact equation on the domain.</p><div className="aside-divider" /><div className="aside-tip"><Sparkles size={15} /><span>If they differ, the engine checks for supported integrating factors.</span></div></Card>
        <Card className="aside-card example-picker"><div className="card-head"><div><div className="eyebrow">START WITH AN EXAMPLE</div><h3>Verified equations</h3></div><ChevronDown size={16} className="muted-icon" /></div>{examples?.examples?.length ? examples.examples.slice(0, 5).map((ex) => <button className="picker-row" key={ex.id} onClick={() => fillExample(ex)}><span><b>{ex.title}</b><small>{ex.kind} · {ex.expected_solution}</small></span><Plus size={15} /></button>) : <p className="small-muted">Examples will appear when the API is available.</p>}<Link href="/examples" className="text-link">All examples <ArrowRight size={13} /></Link></Card>
      </aside>
    </div>
  </div>;
}

function Visualizer() {
  const transferred = new URLSearchParams(window.location.search).get('from') === 'solver' ? getTransferredEquation() : null;
  const [m, setM] = useState(transferred?.m || 'y');
  const [n, setN] = useState(transferred?.n || '1');
  const [x0, setX0] = useState('0');
  const [y0, setY0] = useState('1');
  const [xmin, setXmin] = useState('-2');
  const [xmax, setXmax] = useState('2');
  const [result, setResult] = useState<any>(null);
  const [curves, setCurves] = useState<any[]>([]);
  const [showGrid, setShowGrid] = useState(true);
  const plot = usePlotEquation();
  const submit = async () => {
    const input = { m: m.trim(), n: n.trim(), x0: Number(x0), y0: Number(y0), x_min: Number(xmin), x_max: Number(xmax), points: 180 };
    try {
      const primary = await plot.mutateAsync({ data: input });
      const offset = Math.max(0.5, Math.abs(Number(y0)) * 0.35);
      const neighbors = await Promise.allSettled([-1, 1].map((direction) =>
        plot.mutateAsync({ data: { ...input, y0: Number(y0) + direction * offset } }),
      ));
      setResult(primary);
      setCurves([primary, ...neighbors.flatMap((item) => item.status === 'fulfilled' ? [item.value] : [])]);
      addHistory({ module: 'Curve visualizer', title: 'Solution curve family', detail: `At (${x0}, ${y0}) · ${m} dx + ${n} dy`, href: '/visualizer' });
    } catch {
      setResult(null);
      setCurves([]);
    }
  };
  const traces: Data[] = curves.map((curve, index) => ({
    type: 'scatter',
    mode: 'lines',
    x: curve.x,
    y: curve.y,
    name: index === 0 ? `Initial value y(${fmt(curve.x0)}) = ${fmt(curve.y0)}` : `Nearby start y₀ = ${fmt(curve.y0)}`,
    connectgaps: false,
    line: { color: index === 0 ? '#41d5e5' : index === 1 ? '#aa91f4' : '#7294ef', width: index === 0 ? 3 : 1.8, dash: index === 0 ? 'solid' : 'dot' },
    hovertemplate: 'x = %{x:.4g}<br>y = %{y:.5g}<extra>%{fullData.name}</extra>',
  }));
  if (result) traces.push({
    type: 'scatter',
    mode: 'markers',
    x: [result.x0],
    y: [result.y0],
    name: 'Initial condition',
    marker: { color: '#f2c76e', size: 10, line: { color: '#0d1420', width: 2 } },
    hovertemplate: 'Initial condition<br>x₀ = %{x:.4g}<br>y₀ = %{y:.5g}<extra></extra>',
  });
  return <div className="page-content"><PageHeading eyebrow="02 / Visualize" title="Curve visualizer" description="Numerically integrate from an initial condition and inspect the curve the equation describes." action={<span className="mode-chip"><LineChart size={14} /> NUMERICAL INTEGRATION</span>} />
    <div className="visual-layout"><Card className="plot-controls"><div className="card-head"><div><div className="eyebrow">EQUATION & INITIAL CONDITION</div><h3>Set the starting point</h3></div><span className="step-badge">02</span></div>
      <div className="two-fields"><InputField label="M(x, y)" value={m} onChange={setM} placeholder="e.g. y" /><InputField label="N(x, y)" value={n} onChange={setN} placeholder="e.g. -x" /></div>
      <div className="card-subhead"><span>Initial condition</span><span className="subhead-rule" /></div><div className="two-fields"><InputField label="x₀" type="number" step="any" value={x0} onChange={setX0} /><InputField label="y₀" type="number" step="any" value={y0} onChange={setY0} /></div>
      <div className="card-subhead"><span>Integration window</span><span className="subhead-rule" /></div><div className="two-fields"><InputField label="x minimum" type="number" step="any" value={xmin} onChange={setXmin} /><InputField label="x maximum" type="number" step="any" value={xmax} onChange={setXmax} /></div>
      <Button disabled={!m.trim() || !n.trim() || plot.isPending || Number(xmin) >= Number(xmax)} onClick={submit} className="full-button">{plot.isPending ? 'Integrating…' : <>Compute solution curve <ArrowRight size={15} /></>}</Button>
      {plot.isError && <ErrorBlock error={plot.error} retry={submit} />}
    </Card><div className="plot-output">
      {plot.isPending ? <Card className="plot-loading"><div className="loading-chart"><Skeleton rows={1} /></div><p>Integrating from the initial condition…</p></Card> : result ? <Card className="chart-panel"><div className="card-head"><div><div className="eyebrow">API-COMPUTED CURVE FAMILY</div><h3>Solution trajectories</h3></div><span className="method-chip">{result.method}</span></div><div className="chart-actions"><span className="chart-hint">Use the Plotly toolbar to zoom, pan, reset, or export a PNG.</span><button type="button" className={`filter-chip ${showGrid ? 'selected' : ''}`} onClick={() => setShowGrid(!showGrid)}>{showGrid ? 'Hide grid' : 'Show grid'}</button></div><div className="chart-wrap"><PlotlyChart data={traces} xTitle="x" yTitle="y" showGrid={showGrid} height={380} /></div><div className="plot-stats"><div><small>CURVES RETURNED</small><b>{curves.length}</b></div><div><small>X INTERVAL</small><b>{fmt(Math.min(...result.x))} — {fmt(Math.max(...result.x))}</b></div><div><small>INTEGRATION METHOD</small><b>{result.method}</b></div></div>{curves.flatMap((curve) => curve.warnings || []).filter((warning: string, index: number, all: string[]) => all.indexOf(warning) === index).map((w: string, i: number) => <div className="notice-line warning-line" key={i}><Info size={14} />{w}</div>)}</Card> : <Card className="plot-empty"><div className="plot-empty-icon"><LineChart size={22} /></div><b>Your computed curve family appears here</b><p>Choose an initial condition and interval. Each trajectory is returned by the numerical integration API.</p><div className="axis-preview"><span>y</span><i /><span>x</span></div></Card>}
    </div></div>
  </div>;
}

function extractObservations(dataset: Record<string, any>): { x_value: number; observed_y: number }[] {
  const raw = dataset.observations ?? dataset.data ?? dataset.rows ?? dataset.points;
  if (!Array.isArray(raw)) return [];
  return raw.map((row: any) => Array.isArray(row) ? { x_value: Number(row[0]), observed_y: Number(row[1]) } : {
    x_value: Number(row.x_value ?? row.x ?? row.time), observed_y: Number(row.observed_y ?? row.y ?? row.value)
  }).filter((r: any) => Number.isFinite(r.x_value) && Number.isFinite(r.observed_y));
}
function Fitting() {
  const transferred = new URLSearchParams(window.location.search).get('from') === 'solver' ? getTransferredEquation() : null;
  const [model, setModel] = useState<'decay' | 'growth' | 'quadratic'>(transferred?.model || 'decay');
  const [fitParameter, setFitParameter] = useState(true);
  const [numericMode, setNumericMode] = useState(Boolean(transferred));
  const [odeM, setOdeM] = useState(transferred?.m || 'y');
  const [odeN, setOdeN] = useState(transferred?.n || '1');
  const [initialX, setInitialX] = useState('0');
  const [initialGuess, setInitialGuess] = useState('1');
  const [numericPending, setNumericPending] = useState(false);
  const [numericError, setNumericError] = useState('');
  const [observations, setObservations] = useState<{ x_value: number; observed_y: number }[]>([]);
  const [result, setResult] = useState<any>(null);
  const [csvError, setCsvError] = useState('');
  const [cases, setCases] = useState<Record<string, ObservationRow[]>>({});
  const [caseId, setCaseId] = useState('');
  const analyze = useAnalyzeDataset();
  const examples = useGetExamples({ query: { queryKey: getGetExamplesQueryKey() } });
  const datasets = examples.data?.datasets || [];
  const datasetLabel = (d: any, i: number) => String(d.title ?? d.name ?? d.id ?? d.label ?? `Dataset ${i + 1}`);
  const loadDataset = (d: Record<string, any>) => { const rows = extractObservations(d); if (rows.length >= 2) { const grouped: Record<string, ObservationRow[]> = {}; for (const row of (d.observations || [])) { const id = String(row.case_id || 'sample'); (grouped[id] ||= []).push({x_value: Number(row.x_value), observed_y: Number(row.observed_y)}); } if (!Object.keys(grouped).length) grouped.sample = rows; const first = Object.keys(grouped)[0]; setCases(grouped); setCaseId(first); setObservations(grouped[first]); setResult(null); setCsvError(''); if (d.model && ['decay', 'growth', 'quadratic'].includes(d.model)) setModel(d.model); } else setCsvError('This dataset did not contain at least two numeric x/y observations.'); };
  const parseCsv = (file: File) => {
    setCsvError('');
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseObservationCsv(String(reader.result || ''));
      if (parsed.error || !parsed.cases) { setCsvError(parsed.error || 'Invalid CSV file.'); return; }
      const first = Object.keys(parsed.cases)[0];
      setCases(parsed.cases);
      setCaseId(first);
      setObservations(parsed.cases[first]);
      setResult(null);
    };
    reader.onerror = () => setCsvError('The file could not be read. Try another CSV.');
    reader.readAsText(file);
  };
  const submit = async () => {
    setResult(null);
    setNumericError('');
    if (!numericMode) {
      analyze.mutate({ data: { model, observations, fit_parameter: fitParameter } }, { onSuccess: (res) => { setResult(res); addHistory({ module: 'Data fitting', title: `${model} model fit`, detail: `${observations.length} observations · ${res.parameter_name || 'parameter'} ${fmt(res.parameter_value)}`, href: '/fitting' }); } });
      return;
    }
    setNumericPending(true);
    try {
      const response = await fetch(`${API_BASE}/api/data/fit-ode`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({m: odeM, n: odeN, observations, x0: Number(initialX), initial_guess: Number(initialGuess)})
      });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : typeof data.error === 'string' ? data.error : 'Numerical fitting failed.');
      setResult(data);
      addHistory({module: 'ODE data fitting', title: 'Numerical ODE fit', detail: `${observations.length} observations · y0 = ${fmt(data.parameter_value)}`, href:'/fitting'});
    } catch (error) { setNumericError(error instanceof Error ? error.message : 'Numerical fitting failed.'); }
    finally { setNumericPending(false); }
  };
  const rows = result?.rows || [];
  const metricEntries = Object.entries(result?.metrics || {});
  const resultRowKeys: string[] = Array.from(new Set<string>(rows.flatMap((r: Record<string, unknown>) => Object.keys(r))));
  const downloadCsv = () => {
    if (!rows.length) return;
    const csv = [resultRowKeys.join(','), ...rows.map((r: Record<string, unknown>) => resultRowKeys.map((k) => JSON.stringify(r[k] ?? '')).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'equationpath-fit-results.csv'; anchor.click(); URL.revokeObjectURL(url);
  };
  return <div className="page-content"><PageHeading eyebrow="03 / Compare" title="Data fitting" description="Compare observations with a supported solution family. Inspect the fitted parameter and residuals row by row." action={<span className="mode-chip"><Database size={14} /> MODEL COMPARISON</span>} />
    {transferred && <div className="notice-line"><Info size={15} />From solver: {transferred.m} dx + {transferred.n} dy = 0. {transferred.model ? `Matched supported solution family: ${transferred.model}. Upload or select observations to compare.` : 'Numerical fitting will use the transferred equation; choose the entered-ODE method to estimate its initial condition.'}</div>}
    <div className="fitting-layout"><div className="fit-input-column"><Card>
      <div className="card-head"><div><div className="eyebrow">COMPARISON METHOD</div><h3>Choose how to fit</h3></div></div>
      <div className="equation-actions"><Button variant={numericMode ? 'primary' : 'secondary'} onClick={() => {setNumericMode(true);setResult(null);}}>Fit entered ODE</Button><Button variant={!numericMode ? 'primary' : 'secondary'} onClick={() => {setNumericMode(false);setResult(null);}}>Sample model</Button></div>
      {numericMode && <><p className="small-muted">Find the initial value y(x₀) that best matches observed data using numerical integration of M dx + N dy = 0. Requires 3 or more observations and a regular y(x) branch.</p><div className="two-fields"><InputField label="M(x, y)" value={odeM} onChange={setOdeM} /><InputField label="N(x, y)" value={odeN} onChange={setOdeN} /><InputField label="Initial x₀" value={initialX} type="number" onChange={setInitialX} /><InputField label="Initial y guess" value={initialGuess} type="number" onChange={setInitialGuess} /></div></>}
      </Card>{!numericMode && <Card><div className="card-head"><div><div className="eyebrow">1 — CHOOSE A MODEL</div><h3>Model family</h3></div><span className="step-badge">A</span></div><div className="model-options">{(['decay', 'growth', 'quadratic'] as const).map((val) => <button className={`model-option ${model === val ? 'selected' : ''}`} key={val} onClick={() => { setModel(val); setResult(null); }}><span className="radio-mark">{model === val && <i />}</span><span><b>{val.charAt(0).toUpperCase() + val.slice(1)}</b><small>{val === 'decay' ? 'Exponential decrease' : val === 'growth' ? 'Exponential increase' : 'Second-degree polynomial'}</small></span><span className="model-formula">{val === 'quadratic' ? 'ax² + bx + c' : 'aeᵏˣ'}</span></button>)}</div><label className="check-setting"><input type="checkbox" checked={fitParameter} onChange={(e) => setFitParameter(e.target.checked)} /><span><b>Fit model parameter</b><small>Estimate the model constant from the observations</small></span></label></Card>
      }<Card><div className="card-head"><div><div className="eyebrow">2 — LOAD OBSERVATIONS</div><h3>Your data</h3></div><span className="step-badge">B</span></div>
        <label className="upload-zone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const file = e.dataTransfer.files[0]; if (file) parseCsv(file); }}><input type="file" accept=".csv,text/csv,.tsv,text/tab-separated-values" onChange={(e) => { const file = e.target.files?.[0]; if (file) parseCsv(file); e.currentTarget.value = ''; }} data-testid="input-csv-upload" /><span className="upload-icon"><ArrowDownToLine size={18} /></span><span><b>Drop a CSV here or browse files</b><small>Required columns: case_id, x_value, observed_y</small></span></label>
        {datasets.length > 0 && <div className="dataset-samples"><span className="field-label">OR LOAD VERIFIED SAMPLE</span><select value="" onChange={(e) => { const idx = Number(e.target.value); if (!Number.isNaN(idx)) loadDataset(datasets[idx] as Record<string, any>); }} data-testid="select-sample-dataset"><option value="" disabled>Choose an API sample dataset…</option>{datasets.map((d: any, i: number) => <option key={i} value={i}>{datasetLabel(d, i)}</option>)}</select></div>}
        {examples.isLoading && <div className="small-muted">Loading verified sample datasets…</div>}{examples.isError && <ErrorBlock error={examples.error} retry={() => void examples.refetch()} />}
        {Object.keys(cases).length > 1 && <label className="field"><span className="field-label">SELECT CASE</span><select value={caseId} onChange={(e) => { setCaseId(e.target.value); setObservations(cases[e.target.value] || []); setResult(null); }}>{Object.keys(cases).map(id => <option key={id} value={id}>{id} ({cases[id].length} observations)</option>)}</select></label>}
        {csvError && <div className="notice-line warning-line"><Info size={14} />{csvError}</div>}
        {observations.length > 0 ? <div className="csv-preview"><div className="preview-head"><b><CheckCircle2 size={14} /> Preview · {observations.length} rows</b><button className="text-button" onClick={() => { setObservations([]); setCases({}); setCaseId(''); setResult(null); }}><X size={14} /> Clear</button></div><div className="table-scroll"><table><thead><tr><th>Row</th><th>x value</th><th>Observed y</th></tr></thead><tbody>{observations.slice(0, 8).map((r, i) => <tr key={i}><td>{String(i + 1).padStart(2, '0')}</td><td>{fmt(r.x_value)}</td><td>{fmt(r.observed_y)}</td></tr>)}</tbody></table>{observations.length > 8 && <div className="preview-more">and {observations.length - 8} more rows</div>}</div></div> : <div className="empty-data-note"><FileSpreadsheet size={15} /><span>Waiting for observations. A minimum of two rows is required.</span></div>}
        <Button disabled={observations.length < (numericMode ? 3 : 2) || analyze.isPending || numericPending || (numericMode && (!odeM.trim() || !odeN.trim() || !Number.isFinite(Number(initialX)) || !Number.isFinite(Number(initialGuess))))} onClick={submit} className="full-button">{analyze.isPending || numericPending ? 'Fitting model…' : <>Analyze observations <ArrowRight size={15} /></>}</Button>
        {analyze.isError && !numericMode && <ErrorBlock error={analyze.error} retry={submit} />}
        {numericError && <div className="notice-line warning-line"><Info size={14} />{numericError}</div>}
      </Card></div>
      <div className="fit-results-column">{result ? <Card className="fit-result-card"><div className="card-head"><div><div className="eyebrow">API ANALYSIS</div><h3>Fit summary</h3></div><button className="icon-button export-button" onClick={downloadCsv} title="Export rows as CSV" aria-label="Export results as CSV"><ArrowDownToLine size={17} /></button></div><div className="fit-parameter"><span><small>FITTED PARAMETER</small><b>{result.parameter_name || 'Parameter'}</b></span><strong>{fmt(result.parameter_value)}</strong></div><div className="metrics-grid">{metricEntries.length ? metricEntries.map(([key, val]) => <div className="metric-box" key={key}><small>{key.replaceAll('_', ' ')}</small><b>{fmt(val)}</b></div>) : <div className="empty-inline">No fit metrics were returned.</div>}</div>{result.note && <div className="analysis-note"><Info size={15} />{result.note}</div>}<div className="result-table-head"><div><div className="eyebrow">ROW-LEVEL COMPARISON</div><b>Observed vs fitted</b></div><span>{rows.length} rows</span></div>{rows.length > 0 && rows.some((r: any) => r.predicted_y != null) && <div className="chart-wrap"><PlotlyChart height={300} xTitle="x" yTitle="y" data={[{ type: 'scatter', mode: 'markers', name: 'Observed', x: rows.map((r: any) => r.x_value), y: rows.map((r: any) => r.observed_y), marker: {color:'#a892f4',size:8} }, {type: 'scatter', mode: 'lines+markers', name: 'Fitted model', x: rows.map((r: any) => r.x_value), y: rows.map((r: any) => r.predicted_y), line:{color:'#41d5e5'} }]} /></div>}
        {rows.length > 0 && rows.some((r: any) => r.residual != null) && <div className="chart-wrap"><h3>Residuals vs x</h3><PlotlyChart height={240} xTitle="x" yTitle="Observed − predicted" data={[{type:'scatter',mode:'markers',name:'Residuals',x:rows.map((r: any) => r.x_value),y:rows.map((r: any) => r.residual),marker:{color:'#f2c76e',size:8}}]} /></div>}
        {rows.length ? <div className="table-scroll result-table-scroll"><table><thead><tr>{resultRowKeys.map((key) => <th key={key}>{key.replaceAll('_', ' ')}</th>)}</tr></thead><tbody>{rows.map((row: Record<string, unknown>, i: number) => <tr key={i}>{Object.values(row).map((val, j) => <td key={j}>{fmt(val)}</td>)}</tr>)}</tbody></table></div> : <div className="empty-inline">No row-level results returned by the API.</div>}</Card> : <Card className="fit-empty"><span className="fit-empty-icon"><Database size={21} /></span><div className="eyebrow">YOUR RESULTS, WITHOUT THE BLACK BOX</div><h3>Fit values and residuals</h3><p>Load a dataset and analyze it to see parameter estimates, fit metrics, and every returned row.</p><div className="empty-checks"><span><Check size={13} /> Fitted parameter</span><span><Check size={13} /> Residual comparison</span><span><Check size={13} /> CSV export</span></div></Card>}</div>
    </div>
  </div>;
}

function Examples() {
  const { data, isLoading, isError, error, refetch } = useGetExamples({ query: { queryKey: getGetExamplesQueryKey() } });
  const [filter, setFilter] = useState('all');
  const examples = data?.examples || [];
  const kinds = useMemo(() => Array.from(new Set(examples.map((e) => e.kind))), [examples]);
  const visible = filter === 'all' ? examples : examples.filter((e) => e.kind === filter);
  return <div className="page-content"><PageHeading eyebrow="REFERENCE / VERIFIED" title="Examples" description="A library of API-verified first-order equations. Open one in the solver to inspect the method and result." action={<span className="mode-chip"><FlaskConical size={14} /> {isLoading ? 'LOADING' : `${examples.length} VERIFIED`}</span>} />
    <div className="filter-row"><button onClick={() => setFilter('all')} className={`filter-chip ${filter === 'all' ? 'selected' : ''}`}>All examples <span>{examples.length}</span></button>{kinds.map((kind) => <button key={kind} onClick={() => setFilter(kind)} className={`filter-chip ${filter === kind ? 'selected' : ''}`}>{kind}</button>)}</div>
    {isLoading ? <Card><Skeleton rows={5} /></Card> : isError ? <ErrorBlock error={error} retry={() => void refetch()} /> : visible.length ? <div className="examples-list">{visible.map((ex, i) => <Card className="example-card" key={ex.id}><div className="example-card-top"><span className="example-number">{String(i + 1).padStart(2, '0')}</span><span className="example-kind">{ex.kind}</span><Link href={`/solver?example=${encodeURIComponent(ex.id)}`} className="btn btn-quiet">Open in solver <ArrowRight size={14} /></Link></div><h3>{ex.title}</h3><p>{ex.description}</p><div className="example-math"><span>{ex.m}</span><i>dx</i><b>+</b><span>{ex.n}</span><i>dy = 0</i></div><div className="expected-line"><span>EXPECTED SOLUTION</span><b>{ex.expected_solution}</b></div></Card>)}</div> : <Card className="empty-result"><FlaskConical size={22} /><b>No examples found</b><p>{filter === 'all' ? 'The API has not returned any verified examples.' : 'No examples match this category.'}</p>{filter !== 'all' && <Button variant="secondary" onClick={() => setFilter('all')}>Clear filter</Button>}</Card>}
    {!isLoading && !isError && data?.datasets && <div className="dataset-footnote"><Database size={15} /> {data.datasets.length} verified sample dataset{data.datasets.length === 1 ? '' : 's'} available in Data fitting.</div>}
  </div>;
}

function Guide() {
  const [open, setOpen] = useState('exactness');
  const lessons = [
    { id: 'exactness', n: '01', title: 'What makes an equation exact?', tag: 'STRUCTURE', body: <>A first-order equation in differential form, <code>M(x, y) dx + N(x, y) dy = 0</code>, is exact when there is a potential function <code>F(x, y)</code> whose total differential reproduces the equation: <code>dF = Fₓ dx + Fᵧ dy</code>. That means <code>Fₓ = M</code> and <code>Fᵧ = N</code>.</>, formula: '∂M/∂y = ∂N/∂x' },
    { id: 'test', n: '02', title: 'Why compare cross-partials?', tag: 'THE TEST', body: <>If <code>M = Fₓ</code> and <code>N = Fᵧ</code>, then under the usual smoothness conditions, the mixed partials agree: <code>Fₓᵧ = Fᵧₓ</code>. So differentiate <code>M</code> with respect to <code>y</code>, and <code>N</code> with respect to <code>x</code>. Equality is the local exactness test on a suitable domain.</>, formula: 'Mᵧ − Nₓ = 0' },
    { id: 'solve', n: '03', title: 'How do we recover the potential?', tag: 'INTEGRATION', body: <>Integrate <code>M</code> with respect to <code>x</code> to get a partial expression for <code>F</code>. The integration “constant” may depend on <code>y</code>. Differentiate that expression with respect to <code>y</code>, compare it with <code>N</code>, then determine the missing function of <code>y</code>.</>, formula: 'F(x, y) = C' },
    { id: 'factor', n: '04', title: 'What if it is not exact?', tag: 'SUPPORTED METHODS', body: <>A nonzero difference does not end the investigation. Some equations admit an integrating factor <code>μ</code> that transforms the differential form into an exact one. The solver reports a factor only when its supported test finds one; it will not claim a general solution for unsupported cases.</>, formula: 'μM dx + μN dy = 0' },
    { id: 'curves', n: '05', title: 'What does a solution curve show?', tag: 'INITIAL VALUE', body: <>An initial condition <code>y(x₀) = y₀</code> selects a particular trajectory from a family. Numerical integration approximates that trajectory over a finite interval. Changing the starting point can reveal nearby solution behavior, singularities, or where the integration method stops.</>, formula: 'y(x₀) = y₀' },
    { id: 'residuals', n: '06', title: 'How should I read residuals?', tag: 'MODEL FITTING', body: <>A residual is the observed value minus the model’s fitted value at the same <code>x</code>. Small residuals indicate closer agreement for those observations, but fit metrics and residual patterns matter too. A model can fit the supplied points and still be a poor explanation outside the observed range.</>, formula: 'residual = observed − fitted' },
  ];
  return <div className="page-content"><PageHeading eyebrow="FIELD GUIDE / CONCEPTS" title="Understand the method" description="Short notes on exact equations, integrating factors, numerical curves, and fitting observations." action={<span className="mode-chip"><CircleHelp size={14} /> 6 TOPICS</span>} />
    <div className="guide-layout"><div className="guide-list">{lessons.map((lesson) => <button key={lesson.id} className={`guide-item ${open === lesson.id ? 'open' : ''}`} onClick={() => setOpen(open === lesson.id ? '' : lesson.id)}><span className="guide-num">{lesson.n}</span><span className="guide-item-copy"><small>{lesson.tag}</small><b>{lesson.title}</b></span><span className="guide-toggle">{open === lesson.id ? <X size={15} /> : <Plus size={15} />}</span></button>)}</div><div className="guide-detail">{lessons.filter((l) => l.id === open).map((lesson) => <Card key={lesson.id} className="lesson-card"><div className="eyebrow">TOPIC {lesson.n} / {lesson.tag}</div><h2>{lesson.title}</h2><p>{lesson.body}</p><div className="lesson-formula">{lesson.formula}</div><div className="lesson-link-row"><span>TRY IT IN THE WORKSPACE</span><Link href={lesson.id === 'curves' ? '/visualizer' : lesson.id === 'residuals' ? '/fitting' : '/solver'} className="text-link">{lesson.id === 'curves' ? 'Open visualizer' : lesson.id === 'residuals' ? 'Open data fitting' : 'Open solver'} <ArrowRight size={14} /></Link></div></Card>)}
      {!open && <Card className="lesson-closed"><span className="empty-mark"><Sigma size={18} /></span><b>Select a topic</b><p>Choose a field note to read the explanation.</p></Card>}
      <div className="guide-aside-note"><Info size={15} /><p>EquationPath displays what its API can verify. Always check domain restrictions and the assumptions behind a chosen model.</p></div></div></div>
  </div>;
}

function HistoryPage() {
  const [items, setItems] = useState(readHistory);
  useEffect(() => { const update = () => setItems(readHistory()); window.addEventListener('equationpath-history', update); window.addEventListener('storage', update); return () => { window.removeEventListener('equationpath-history', update); window.removeEventListener('storage', update); }; }, []);
  const clear = () => { if (window.confirm('Clear all locally saved calculation history?')) { localStorage.removeItem(HISTORY_KEY); setItems([]); } };
  const grouped = items.reduce<Record<string, HistoryItem[]>>((acc, item) => { const key = new Date(item.at).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }); (acc[key] ||= []).push(item); return acc; }, {});
  return <div className="page-content"><PageHeading eyebrow="LOCAL SESSION / ON THIS DEVICE" title="Calculation history" description="A private record of analyses made in this browser. History is stored locally and is not synced." action={<Button variant="quiet" disabled={!items.length} onClick={clear}><RotateCcw size={14} /> Clear history</Button>} />
    {items.length ? <div className="history-groups">{Object.entries(grouped).map(([day, entries]) => <div className="history-group" key={day}><div className="history-day"><span>{day}</span><i /></div>{entries.map((item) => <Card className="history-entry" key={item.id}><div className="history-time">{new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div><span className="history-module-icon">{item.module.includes('Curve') ? <LineChart size={17} /> : item.module.includes('fitting') ? <Database size={17} /> : <Sigma size={17} />}</span><div className="history-entry-main"><small>{item.module}</small><b>{item.title}</b><span>{item.detail}</span></div><Link href={item.href} className="icon-button history-open" aria-label={`Open ${item.module}`}><ArrowRight size={16} /></Link></Card>)}</div>)}</div> : <Card className="history-empty"><div className="empty-mark large"><History size={21} /></div><div className="eyebrow">NOTHING IN THIS SESSION YET</div><h3>Start with an equation or observation set</h3><p>When you check, solve, plot, or fit something, the calculation will be saved here on this device.</p><div className="hero-actions"><Link href="/solver" className="btn btn-primary">Open solver <ArrowRight size={15} /></Link><Link href="/fitting" className="btn btn-outline">Fit data</Link></div></Card>}
    <div className="local-note"><Info size={14} /> Clearing browser storage also removes this history.</div>
  </div>;
}

function Router() {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}><AppFrame><Switch>
    <Route path="/" component={Overview} /><Route path="/solver" component={Solver} /><Route path="/visualizer" component={Visualizer} /><Route path="/fitting" component={Fitting} /><Route path="/examples" component={Examples} /><Route path="/guide" component={Guide} /><Route path="/history" component={HistoryPage} /><Route component={NotFound} />
  </Switch></AppFrame></ErrorBoundary>;
}
function App() {
  useEffect(() => { document.documentElement.classList.add('dark'); }, []);
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}
export default App;
