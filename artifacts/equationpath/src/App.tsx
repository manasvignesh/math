import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ErrorBoundary } from "@/components/error-boundary";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Link, useLocation, Router as WouterRouter } from "wouter";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  Database,
  FileSpreadsheet,
  FlaskConical,
  Gauge,
  History,
  Info,
  LineChart,
  Menu,
  Plus,
  RotateCcw,
  Sigma,
  Sparkles,
  X,
  XCircle,
} from "lucide-react";
import {
  getGetExamplesQueryKey,
  getHealthCheckQueryKey,
  useCheckEquation,
  useGetExamples,
  useHealthCheck,
  useSolveEquation,
} from "@workspace/api-client-react";
import type { Example } from "@workspace/api-client-react";
import { type ReactNode } from "react";
const Visualizer = lazy(() => import("@/components/Visualizer"));
const Practice = lazy(() => import("@/components/Practice"));
const Fitting = lazy(() => import("@/components/Fitting"));
import MathView from "@/components/MathView";
import { equationPreview, expressionLatex } from "@/lib/math-display";
import { mathStatus } from "@/lib/browser-math";
import { downloadFile, readStorage, writeStorage } from "@/lib/storage";

const queryClient = new QueryClient();
type HistoryItem = {
  id: string;
  module: string;
  title: string;
  detail: string;
  at: number;
  href: string;
};
const HISTORY_KEY = "equationpath-history-v1";
const EQUATION_TRANSFER_KEY = "equationpath-equation-transfer-v1";
type SupportedFitModel = "decay" | "growth" | "quadratic";
type TransferredEquation = {
  m: string;
  n: string;
  model: SupportedFitModel | null;
  solution?: any;
  exactness?: any;
  x0?: string;
  y0?: string;
};
// The parameter fitter supports exactly three ODE families. Only recognize these
// explicit, mathematically equivalent input spellings; never silently guess.
function fitFamily(m: string, n: string): SupportedFitModel | null {
  const tidy = (v: string) => v.replace(/\s+/g, "").replace(/\^/g, "**");
  const a = tidy(m),
    b = tidy(n);
  if (b !== "1" && b !== "+1") return null;
  if (a === "y" || a === "+y") return "decay"; // y' = -y
  if (a === "-2*y" || a === "-2y") return "growth"; // y' = 2y
  if (a === "-2*x" || a === "-2x") return "quadratic"; // y' = 2x
  return null;
}
function saveTransferredEquation(
  m: string,
  n: string,
  solution?: any,
  exactness?: any,
  x0?: string,
  y0?: string,
): void {
  writeStorage(EQUATION_TRANSFER_KEY, {
    m,
    n,
    model: fitFamily(m, n),
    solution,
    exactness,
    x0,
    y0,
  } satisfies TransferredEquation);
}
function getTransferredEquation(): TransferredEquation | null {
  try {
    const value = JSON.parse(
      localStorage.getItem(EQUATION_TRANSFER_KEY) || "null",
    );
    if (typeof value?.m === "string" && typeof value?.n === "string")
      return {
        ...value,
        m: value.m,
        n: value.n,
        model: fitFamily(value.m, value.n),
      };
  } catch {
    /* stale browser storage */
  }
  return null;
}
const readHistory = (): HistoryItem[] => {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
};
const addHistory = (item: Omit<HistoryItem, "id" | "at">) => {
  const next = [
    { ...item, id: `${Date.now()}-${Math.random()}`, at: Date.now() },
    ...readHistory(),
  ].slice(0, 40);
  writeStorage(HISTORY_KEY, next);
  window.dispatchEvent(new Event("equationpath-history"));
};
const fmt = (value: unknown) =>
  typeof value === "number"
    ? Number(value.toPrecision(5)).toString()
    : String(value ?? "—");
const errText = (error: unknown) =>
  (error as { message?: string })?.message ||
  "The request could not be completed. Check the input and try again.";

function AppFrame({ children }: { children: ReactNode }) {
  const [path] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [engineStatus, setEngineStatus] = useState(mathStatus);
  useEffect(() => {
    const listener = (event: Event) =>
      setEngineStatus((event as CustomEvent).detail);
    window.addEventListener("equationpath-math-status", listener);
    return () =>
      window.removeEventListener("equationpath-math-status", listener);
  }, []);
  const health = useHealthCheck({
    query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 45000 },
  });
  const nav = [
    { href: "/", label: "Overview", icon: Gauge },
    { href: "/solver", label: "Exactness solver", icon: Sigma },
    { href: "/visualizer", label: "Curve visualizer", icon: LineChart },
    { href: "/fitting", label: "Data fitting", icon: FileSpreadsheet },
    { href: "/practice", label: "Practice mode", icon: Sigma },
    { href: "/examples", label: "Examples", icon: FlaskConical },
    { href: "/guide", label: "Learning guide", icon: CircleHelp },
    { href: "/history", label: "History", icon: History },
  ];
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}>
        <Link href="/" className="brand" onClick={() => setMobileOpen(false)}>
          <span className="brand-mark">
            <Sigma size={20} strokeWidth={2.2} />
          </span>
          <span className="brand-name">
            Equation<span>Path</span>
            <small>THE MATHEMATICS STUDIO</small>
          </span>
        </Link>
        <div className="side-caption">WORKSPACE</div>
        <nav className="side-nav">
          {nav.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setMobileOpen(false)}
              className={`nav-item ${path === href ? "active" : ""}`}
              data-testid={`link-nav-${label.toLowerCase().replaceAll(" ", "-")}`}
            >
              <Icon size={17} strokeWidth={1.8} />
              <span>{label}</span>
              {path === href && <span className="nav-active-dot" />}
            </Link>
          ))}
        </nav>
        <div className="side-bottom">
          <div className="side-status">
            <span className={`status-pip ${health.isError ? "offline" : ""}`} />
            <div>
              <b>
                {health.isLoading
                  ? "Connecting"
                  : health.isError
                    ? "Engine unavailable"
                    : "Browser computation"}
              </b>
              <small>{engineStatus}</small>
            </div>
          </div>
          <div className="sidebar-foot">
            <span>Built for understanding</span>
            <span className="kbd">EP / 01</span>
          </div>
        </div>
      </aside>
      {mobileOpen && (
        <button
          className="mobile-scrim"
          onClick={() => setMobileOpen(false)}
          aria-label="Close navigation"
        />
      )}
      <main className="main-area">
        <header className="topbar">
          <button
            className="mobile-menu icon-button"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label="Toggle navigation"
          >
            <Menu size={19} />
          </button>
          <div className="breadcrumb">
            <span>EquationPath</span>
            <span className="crumb-slash">/</span>
            <b>{nav.find((n) => n.href === path)?.label || "Workspace"}</b>
          </div>
          <div className="topbar-right">
            <span className="topbar-note">
              <span className="status-pip" /> Mathematical workspace
            </span>
            <span className="topbar-key">
              <Sigma size={13} /> Unit IV / V
            </span>
          </div>
        </header>
        <div className="page-wrap">{children}</div>
      </main>
    </div>
  );
}

function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: ReactNode;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={`panel ${className}`}>{children}</section>;
}
function Label({ children }: { children: ReactNode }) {
  return <label className="field-label">{children}</label>;
}
function InputField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  hint,
  step,
}: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  hint?: string;
  step?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type={type}
        step={step}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        data-testid={`input-${label.toLowerCase().replaceAll(" ", "-")}`}
      />
      {hint && <small className="field-hint">{hint}</small>}
    </label>
  );
}
function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  type = "button",
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "quiet" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`btn btn-${variant} ${className}`}
      data-testid="button-action"
    >
      {children}
    </button>
  );
}
function ErrorBlock({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="error-box">
      <XCircle size={18} />
      <div>
        <b>Couldn’t complete that request</b>
        <p>{errText(error)}</p>
      </div>
      <button onClick={retry} className="text-button">
        Retry
      </button>
    </div>
  );
}
function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton-stack">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton-row" key={i} />
      ))}
    </div>
  );
}
function ResultPill({
  good,
  children,
}: {
  good: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`result-pill ${good ? "good" : "warn"}`}>
      {good ? <CheckCircle2 size={14} /> : <Info size={14} />}
      {children}
    </span>
  );
}

function Overview() {
  const { data, isLoading, isError, error, refetch } = useGetExamples({
    query: { queryKey: getGetExamplesQueryKey() },
  });
  const items = readHistory().slice(0, 3);
  return (
    <div className="page-content">
      <PageHeading
        eyebrow="A workspace for differential equations"
        title={
          <>
            Follow the logic.
            <br />
            <em>See the curve.</em>
          </>
        }
        description="Check exactness, work through the solution, then connect the model to what you observed."
        action={
          <span className="date-chip">
            <Activity size={14} /> FIRST-ORDER ODEs
          </span>
        }
      />
      <div className="overview-hero">
        <div className="hero-copy">
          <div className="hero-kicker">
            <span className="pulse-line" /> START WITH THE STRUCTURE
          </div>
          <h2>
            From equation
            <br />
            to <span>understanding.</span>
          </h2>
          <p>
            Make the reasoning visible. Begin with an equation, test its
            structure, and follow every supported step to a verified result.
          </p>
          <div className="hero-actions">
            <Link href="/solver" className="btn btn-primary">
              Open exactness solver <ArrowRight size={16} />
            </Link>
            <Link href="/examples" className="btn btn-outline">
              Browse examples
            </Link>
          </div>
          <div className="hero-meta">
            <span>
              <span className="tiny-check">
                <Check size={11} />
              </span>{" "}
              Transparent steps
            </span>
            <span>
              <span className="tiny-check">
                <Check size={11} />
              </span>{" "}
              Computed from your input
            </span>
          </div>
        </div>
        <div
          className="hero-graphic"
          aria-label="Abstract equation and curve illustration"
        >
          <div className="graph-label">
            <span>FIELD NOTE 01</span>
            <span>dy / dx</span>
          </div>
          <div className="hero-equation">
            <span className="math-cyan">M</span> dx +{" "}
            <span className="math-violet">N</span> dy = 0
          </div>
          <svg
            viewBox="0 0 430 190"
            className="hero-curve"
            role="img"
            aria-label="Illustrative coordinate curve"
          >
            <defs>
              <linearGradient id="curveFill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#36d6e9" stopOpacity=".19" />
                <stop offset="1" stopColor="#36d6e9" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path
              d="M0 165 C55 147 68 45 130 62 S200 161 253 116 S325 24 430 31 L430 190 L0 190Z"
              fill="url(#curveFill)"
            />
            <path
              d="M0 165 C55 147 68 45 130 62 S200 161 253 116 S325 24 430 31"
              fill="none"
              stroke="#49d9e8"
              strokeWidth="2.5"
            />
            <circle cx="130" cy="62" r="4" fill="#a892f4" />
            <circle cx="253" cy="116" r="4" fill="#49d9e8" />
            <g stroke="#26394b" strokeWidth="1">
              <path d="M0 48H430M0 96H430M0 144H430M86 0V190M172 0V190M258 0V190M344 0V190" />
            </g>
          </svg>
          <div className="hero-chart-footer">
            <span>
              <i className="legend-dot cyan" /> conceptual curve
            </span>
            <span>ILLUSTRATIVE OVERVIEW</span>
          </div>
        </div>
      </div>
      <div className="section-label">
        <span>CHOOSE A PATH</span>
        <span className="section-rule" />
      </div>
      <div className="module-grid">
        <Link href="/solver" className="module-card">
          <span className="module-index">01 / ANALYZE</span>
          <span className="module-icon cyan-icon">
            <Sigma size={20} />
          </span>
          <h3>Exactness solver</h3>
          <p>
            Compare partial derivatives, surface supported integrating factors,
            and inspect a step-by-step solution.
          </p>
          <span className="module-link">
            Open solver <ArrowRight size={14} />
          </span>
        </Link>
        <Link href="/visualizer" className="module-card">
          <span className="module-index">02 / VISUALIZE</span>
          <span className="module-icon violet-icon">
            <LineChart size={20} />
          </span>
          <h3>Curve visualizer</h3>
          <p>
            Set an initial condition and explore the numerical solution curve
            across a chosen interval.
          </p>
          <span className="module-link">
            Plot a solution <ArrowRight size={14} />
          </span>
        </Link>
        <Link href="/fitting" className="module-card">
          <span className="module-index">03 / COMPARE</span>
          <span className="module-icon blue-icon">
            <Database size={20} />
          </span>
          <h3>Data fitting</h3>
          <p>
            Bring observations, fit a supported model parameter, and read
            residuals beside the fitted values.
          </p>
          <span className="module-link">
            Fit observations <ArrowRight size={14} />
          </span>
        </Link>
      </div>
      <div className="overview-lower">
        <Card className="recent-card">
          <div className="card-head">
            <div>
              <div className="eyebrow">LOCAL SESSION</div>
              <h3>Recent calculations</h3>
            </div>
            <Link className="text-link" href="/history">
              View history <ArrowRight size={14} />
            </Link>
          </div>
          {items.length ? (
            <div className="recent-list">
              {items.map((it) => (
                <Link href={it.href} className="recent-row" key={it.id}>
                  <span className="recent-icon">
                    <Clock3 size={15} />
                  </span>
                  <span className="recent-info">
                    <b>{it.title}</b>
                    <small>{it.detail}</small>
                  </span>
                  <time>
                    {new Date(it.at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </Link>
              ))}
            </div>
          ) : (
            <div className="quiet-empty">
              <span className="empty-mark">
                <History size={17} />
              </span>
              <div>
                <b>Your work stays on this device</b>
                <p>Completed analyses will appear here for quick return.</p>
              </div>
            </div>
          )}
        </Card>
        <Card className="examples-card">
          <div className="card-head">
            <div>
              <div className="eyebrow">VERIFIED STARTING POINTS</div>
              <h3>Explore a worked example</h3>
            </div>
            <FlaskConical size={18} className="muted-icon" />
          </div>
          {isLoading ? (
            <Skeleton rows={2} />
          ) : isError ? (
            <ErrorBlock error={error} retry={() => void refetch()} />
          ) : data?.examples?.length ? (
            data.examples.slice(0, 3).map((e) => (
              <Link
                href={`/solver?example=${encodeURIComponent(e.id)}`}
                className="example-mini"
                key={e.id}
              >
                <span className="example-kind">{e.kind}</span>
                <b>{e.title}</b>
                <span className="example-equation">
                  {e.m} dx + {e.n} dy = 0
                </span>
                <ArrowRight size={14} />
              </Link>
            ))
          ) : (
            <div className="empty-inline">No examples are available yet.</div>
          )}
        </Card>
      </div>
    </div>
  );
}

function Solver() {
  const [solverLocation] = useLocation();
  const query = new URLSearchParams(
    solverLocation === "/solver" ? window.location.search : "",
  );
  const [m, setM] = useState(() =>
    readStorage("equationpath-solver-m", "2*x*y + 3"),
  );
  const [x0, setX0] = useState("0");
  const [y0, setY0] = useState("1");
  useEffect(() => {
    writeStorage("equationpath-solver-m", m);
  }, [m]);
  const [n, setN] = useState(() =>
    readStorage("equationpath-solver-n", "x**2 + 4*y"),
  );
  useEffect(() => {
    writeStorage("equationpath-solver-n", n);
  }, [n]);
  const [exact, setExact] = useState<any>(null);
  const [solution, setSolution] = useState<any>(null);
  const [particular, setParticular] = useState<any>(null);
  const [particularError, setParticularError] = useState("");
  useEffect(() => {
    setParticular(null);
    setParticularError("");
  }, [m, n, x0, y0]);
  const particularSolve = useSolveEquation();
  const particularLatest = useRef("");
  particularLatest.current = JSON.stringify([m, n, x0, y0]);
  const check = useCheckEquation();
  const solve = useSolveEquation();
  const { data: examples } = useGetExamples({
    query: { queryKey: getGetExamplesQueryKey() },
  });
  useEffect(() => {
    const ex = examples?.examples?.find(
      (item) => item.id === query.get("example"),
    );
    if (ex) {
      setM(ex.m);
      setN(ex.n);
      setExact(null);
      setSolution(null);
    }
  }, [examples, query.get("example")]);
  const payload = { m: m.trim(), n: n.trim() };
  const current = JSON.stringify(payload);
  const latest = useRef(current);
  latest.current = current;
  const preview = equationPreview(m, n);
  const runCheck = () =>
    check.mutate(
      { data: payload },
      {
        onSuccess: (res) => {
          if (latest.current !== current) return;
          setExact(res);
          setSolution(null);
          addHistory({
            module: "Exactness solver",
            title: "Exactness check",
            detail: `${payload.m} dx + ${payload.n} dy`,
            href: `/solver?m=${encodeURIComponent(payload.m)}&n=${encodeURIComponent(payload.n)}`,
          });
        },
      },
    );
  const runSolve = () => {
    setSolution(null);
    check.mutate(
      { data: payload },
      {
        onSuccess: (res) => {
          if (latest.current === current) setExact(res);
        },
      },
    );
    solve.mutate(
      { data: payload },
      {
        onSuccess: (res) => {
          if (latest.current !== current) return;
          setSolution(res);
          if (res.status === "solved")
            saveTransferredEquation(payload.m, payload.n, res, exact, x0, y0);
          addHistory({
            module: "Exactness solver",
            title:
              res.status === "solved"
                ? "Verified solution"
                : "Symbolic method limitation",
            detail: `${payload.m} dx + ${payload.n} dy`,
            href: `/solver?m=${encodeURIComponent(payload.m)}&n=${encodeURIComponent(payload.n)}`,
          });
        },
      },
    );
  };
  useEffect(() => {
    const a = query.get("m"),
      b = query.get("n");
    if (a && b) {
      setM(a);
      setN(b);
      setExact(null);
      setSolution(null);
    }
  }, [query.get("m"), query.get("n")]);
  const fillExample = (ex: Example) => {
    setM(ex.m);
    setN(ex.n);
    setExact(null);
    setSolution(null);
  };
  return (
    <div className="page-content">
      <PageHeading
        eyebrow="01 / Analyze"
        title="Exactness solver"
        description="Compare the cross-partials first. Then follow the method the equation supports."
        action={
          <span className="mode-chip">
            <span className="status-pip" /> SYMBOLIC ENGINE
          </span>
        }
      />
      <div className="solver-layout">
        <div className="solver-main">
          <Card className="equation-card">
            <label className="field">
              <span className="field-label">Load example</span>
              <select
                aria-label="Load example"
                value=""
                onChange={(e) => {
                  const ex = examples?.examples.find(
                    (item) => item.id === e.target.value,
                  );
                  if (ex) fillExample(ex);
                }}
              >
                <option value="" disabled>
                  Choose a worked example…
                </option>
                {examples?.examples.map((ex) => (
                  <option key={ex.id} value={ex.id}>
                    {ex.title} — {ex.kind}
                  </option>
                ))}
              </select>
            </label>
            <div className="card-head">
              <div>
                <div className="eyebrow">DEFINE YOUR EQUATION</div>
                <h3>Enter M and N</h3>
              </div>
              <span className="step-badge">01</span>
            </div>
            <div className="equation-entry">
              <div className="equation-symbol">M</div>
              <div className="equation-input-wrap">
                <Label>M(x, y)</Label>
                <input
                  value={m}
                  onChange={(e) => {
                    setM(e.target.value);
                    setExact(null);
                    setSolution(null);
                  }}
                  placeholder="e.g. 2*x*y + 3"
                  data-testid="input-equation-m"
                />
                <small>coefficient of dx</small>
              </div>
              <span className="equation-operator">dx +</span>
              <div className="equation-symbol violet">N</div>
              <div className="equation-input-wrap">
                <Label>N(x, y)</Label>
                <input
                  value={n}
                  onChange={(e) => {
                    setN(e.target.value);
                    setExact(null);
                    setSolution(null);
                  }}
                  placeholder="e.g. x**2 + 4*y"
                  data-testid="input-equation-n"
                />
                <small>coefficient of dy</small>
              </div>
              <span className="equation-operator">dy = 0</span>
            </div>
            {preview && <MathView latex={preview} block />}
            <div className="equation-actions">
              <span className="helper-note">
                <Info size={14} /> Use <code>x</code>, <code>y</code>,{" "}
                <code>**</code> or <code>^</code> for powers.
              </span>
              <div>
                <Button
                  variant="secondary"
                  disabled={
                    !m.trim() || !n.trim() || check.isPending || solve.isPending
                  }
                  onClick={runCheck}
                >
                  {check.isPending ? "Checking…" : "Check exactness"}
                </Button>
                <Button
                  disabled={
                    !m.trim() || !n.trim() || check.isPending || solve.isPending
                  }
                  onClick={runSolve}
                >
                  {solve.isPending ? (
                    "Solving…"
                  ) : (
                    <>
                      Solve equation <ArrowRight size={15} />
                    </>
                  )}
                </Button>
              </div>
            </div>
            <Button
              variant="quiet"
              onClick={() => {
                setM("");
                setN("");
                setExact(null);
                setSolution(null);
                check.reset();
                solve.reset();
              }}
            >
              Clear equation
            </Button>
            {check.isError &&
              JSON.stringify(check.variables?.data) === current && (
                <ErrorBlock error={check.error} retry={runCheck} />
              )}
            {solve.isError &&
              JSON.stringify(solve.variables?.data) === current && (
                <ErrorBlock error={solve.error} retry={runSolve} />
              )}
          </Card>
          {check.isPending || solve.isPending ? (
            <Card>
              <Skeleton rows={4} />
            </Card>
          ) : null}
          {exact && (
            <Card className="result-card">
              <div className="card-head">
                <div>
                  <div className="eyebrow">CROSS-PARTIAL TEST</div>
                  <h3>What the derivatives tell us</h3>
                </div>
                <ResultPill good={exact.is_exact}>
                  {exact.is_exact ? "Equal → Exact" : "Not equal → Non-exact"}
                </ResultPill>
              </div>
              <div className="derivative-grid">
                <div className="derivative-cell">
                  <span>∂M / ∂y</span>
                  <MathView latex={exact.m_y_latex || exact.m_y} />
                </div>
                <span className="operator-equals">≟</span>
                <div className="derivative-cell">
                  <span>∂N / ∂x</span>
                  <MathView latex={exact.n_x_latex || exact.n_x} />
                </div>
                <div
                  className={`difference-cell ${exact.is_exact ? "is-exact" : ""}`}
                >
                  <small>DIFFERENCE</small>
                  <MathView
                    latex={
                      equationPreview(exact.difference, "0")
                        ? expressionLatex(exact.difference)
                        : exact.difference
                    }
                  />
                </div>
              </div>
              <div className="explanation">
                <span className="explanation-mark">
                  <Info size={16} />
                </span>
                <div>
                  <b>{exact.method}</b>
                  <p>{exact.explanation}</p>
                  {exact.factor && (
                    <p className="factor-line">
                      Supported integrating factor{" "}
                      <MathView
                        latex={`\\mu = ${exact.factor_latex || exact.factor}`}
                      />
                    </p>
                  )}
                </div>
              </div>
            </Card>
          )}
          {solution && (
            <Card className="solution-card">
              <div className="card-head">
                <div>
                  <div className="eyebrow">SOLUTION · {solution.method}</div>
                  <h3>Follow the derivation</h3>
                </div>
                <ResultPill
                  good={
                    solution.status === "success" ||
                    solution.status === "solved"
                  }
                >
                  {solution.status}
                </ResultPill>
              </div>
              {solution.status === "unsupported" && (
                <div className="notice-line" role="status">
                  <Info size={18} />
                  <div>
                    <b>Non-exact · outside the supported methods</b>
                    <p>{solution.steps?.[0]}</p>
                    <MathView
                      latex={`\\frac{M_y-N_x}{N} = ${solution.ratio_x_latex || "\\text{undefined}"}`}
                      block
                    />
                    <MathView
                      latex={`\\frac{N_x-M_y}{M} = ${solution.ratio_y_latex || "\\text{undefined}"}`}
                      block
                    />
                  </div>
                </div>
              )}
              {solution.integrating_factor && (
                <div className="potential-result">
                  <div>
                    <small>INTEGRATING FACTOR</small>
                    <p>{solution.integrating_factor_condition}</p>
                  </div>
                  <MathView
                    latex={`\\mu = ${solution.integrating_factor_latex}`}
                    block
                  />
                </div>
              )}
              {solution.status === "solved" && (
                <>
                  <div className="two-fields">
                    <InputField
                      label="Transfer x₀"
                      value={x0}
                      type="number"
                      onChange={setX0}
                    />
                    <InputField
                      label="Transfer y₀"
                      value={y0}
                      type="number"
                      onChange={setY0}
                    />
                  </div>
                  <Button
                    variant="secondary"
                    disabled={
                      particularSolve.isPending ||
                      !x0.trim() ||
                      !y0.trim() ||
                      !Number.isFinite(Number(x0)) ||
                      !Number.isFinite(Number(y0))
                    }
                    onClick={() => {
                      setParticularError("");
                      const signature = JSON.stringify([m, n, x0, y0]);
                      particularSolve.mutate(
                        {
                          data: { ...payload, x0: Number(x0), y0: Number(y0) },
                        },
                        {
                          onSuccess: (res) => {
                            if (signature === particularLatest.current)
                              setParticular(res);
                          },
                          onError: (e) => {
                            if (signature === particularLatest.current)
                              setParticularError(errText(e));
                          },
                        },
                      );
                    }}
                  >
                    {particularSolve.isPending
                      ? "Computing C…"
                      : "Find particular solution"}
                  </Button>
                  {particular && (
                    <div className="potential-result">
                      <div>
                        <small>PARTICULAR SOLUTION</small>
                        <MathView
                          latex={`C = ${particular.constant_latex}`}
                          block
                        />
                        <MathView
                          latex={particular.particular_solution_latex}
                          block
                        />
                      </div>
                    </div>
                  )}
                  {particularError && (
                    <p className="notice-line" role="alert">
                      {particularError}
                    </p>
                  )}
                  <div className="equation-actions">
                    <Link
                      href="/visualizer?from=solver"
                      onClick={() =>
                        saveTransferredEquation(
                          payload.m,
                          payload.n,
                          solution,
                          exact,
                          x0,
                          y0,
                        )
                      }
                      className="btn btn-secondary"
                    >
                      Visualize this equation <ArrowRight size={15} />
                    </Link>
                    <Link
                      href="/fitting?from=solver"
                      onClick={() =>
                        saveTransferredEquation(
                          payload.m,
                          payload.n,
                          solution,
                          exact,
                          x0,
                          y0,
                        )
                      }
                      className="btn btn-primary"
                    >
                      Compare with observations <ArrowRight size={15} />
                    </Link>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        downloadFile(
                          "equationpath-solution.json",
                          JSON.stringify(
                            {
                              ...payload,
                              exactness: exact,
                              solution,
                              initial_condition: { x0, y0 },
                            },
                            null,
                            2,
                          ),
                        )
                      }
                    >
                      <ArrowDownToLine size={15} />
                      Export solution
                    </Button>
                  </div>
                </>
              )}
              {solution.implicit_solution && (
                <div className="potential-result">
                  <small>IMPLICIT SOLUTION</small>
                  <MathView
                    latex={
                      solution.solution_latex || solution.implicit_solution
                    }
                    block
                  />
                </div>
              )}
              {solution.potential && (
                <div className="potential-result secondary-result">
                  <small>POTENTIAL FUNCTION</small>
                  <MathView
                    latex={solution.potential_latex || solution.potential}
                    block
                  />
                </div>
              )}
              {solution.steps_latex?.length ? (
                <ol className="steps-list">
                  {solution.steps_latex.map((latex: string, i: number) => (
                    <li key={i}>
                      <span>{String(i + 1).padStart(2, "0")}</span>
                      <div>
                        <p>
                          {solution.step_descriptions?.[i] ||
                            "Computed derivation step"}
                        </p>
                        <MathView latex={latex} block />
                      </div>
                    </li>
                  ))}
                </ol>
              ) : solution.steps?.length ? (
                <ol className="steps-list">
                  {solution.steps.map((step: string, i: number) => (
                    <li key={i}>
                      <span>{i + 1}</span>
                      <p>{step}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="empty-inline">
                  No derivation is available for this input.
                </div>
              )}
              <div className="verification-row">
                {solution.status === "solved" ? (
                  <CheckCircle2 size={16} />
                ) : (
                  <Info size={16} />
                )}
                <div>
                  <b>Verification</b>
                  <span>
                    {typeof solution.verification === "object"
                      ? Object.entries(solution.verification)
                          .map(
                            ([key, value]) =>
                              `${key.replaceAll("_", " ")}: ${value ? "verified" : "unverified"}`,
                          )
                          .join(" · ")
                      : String(
                          solution.verification ||
                            "No verification details returned.",
                        )}
                  </span>
                </div>
              </div>
              {solution.domain_restrictions?.length > 0 && (
                <div className="notice-line">
                  <Info size={15} /> Domain restrictions:{" "}
                  {solution.domain_restrictions.join("; ")}
                </div>
              )}
              {solution.warnings?.map((w: string, i: number) => (
                <div className="notice-line warning-line" key={i}>
                  <Info size={15} />
                  {w}
                </div>
              ))}
            </Card>
          )}
          {!exact && !solution && (
            <Card className="empty-result">
              <div className="empty-illustration">
                <span>∂M</span>
                <span className="line" />
                <span>∂N</span>
              </div>
              <b>The method starts with a comparison.</b>
              <p>
                Check exactness to see the cross-partials, or solve to request
                the complete supported derivation.
              </p>
            </Card>
          )}
        </div>
        <aside className="solver-aside">
          <Card className="aside-card">
            <div className="eyebrow">QUICK REFERENCE</div>
            <h3>The exactness test</h3>
            <div className="formula-box">∂M/∂y = ∂N/∂x</div>
            <p>
              For <span className="math-cyan">M(x,y) dx</span> +{" "}
              <span className="math-violet">N(x,y) dy</span> = 0, equal
              cross-partials indicate an exact equation on the domain.
            </p>
            <div className="aside-divider" />
            <div className="aside-tip">
              <Sparkles size={15} />
              <span>
                If they differ, the engine checks for supported integrating
                factors.
              </span>
            </div>
          </Card>
          <Card className="aside-card example-picker">
            <div className="card-head">
              <div>
                <div className="eyebrow">START WITH AN EXAMPLE</div>
                <h3>Verified equations</h3>
              </div>
              <ChevronDown size={16} className="muted-icon" />
            </div>
            {examples?.examples?.length ? (
              examples.examples.slice(0, 5).map((ex) => (
                <button
                  className="picker-row"
                  key={ex.id}
                  onClick={() => fillExample(ex)}
                >
                  <span>
                    <b>{ex.title}</b>
                    <small>
                      {ex.kind} · {ex.expected_solution}
                    </small>
                  </span>
                  <Plus size={15} />
                </button>
              ))
            ) : (
              <p className="small-muted">
                Examples will appear when the engine is ready.
              </p>
            )}
            <Link href="/examples" className="text-link">
              All examples <ArrowRight size={13} />
            </Link>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function Examples() {
  const { data, isLoading, isError, error, refetch } = useGetExamples({
    query: { queryKey: getGetExamplesQueryKey() },
  });
  const [filter, setFilter] = useState("all");
  const examples = data?.examples || [];
  const kinds = useMemo(
    () => Array.from(new Set(examples.map((e) => e.kind))),
    [examples],
  );
  const visible =
    filter === "all" ? examples : examples.filter((e) => e.kind === filter);
  return (
    <div className="page-content">
      <PageHeading
        eyebrow="REFERENCE / VERIFIED"
        title="Examples"
        description="A library of verified first-order equations. Open one in the solver to inspect the method and result."
        action={
          <span className="mode-chip">
            <FlaskConical size={14} />{" "}
            {isLoading ? "LOADING" : `${examples.length} VERIFIED`}
          </span>
        }
      />
      <div className="filter-row">
        <button
          onClick={() => setFilter("all")}
          className={`filter-chip ${filter === "all" ? "selected" : ""}`}
        >
          All examples <span>{examples.length}</span>
        </button>
        {kinds.map((kind) => (
          <button
            key={kind}
            onClick={() => setFilter(kind)}
            className={`filter-chip ${filter === kind ? "selected" : ""}`}
          >
            {kind}
          </button>
        ))}
      </div>
      {isLoading ? (
        <Card>
          <Skeleton rows={5} />
        </Card>
      ) : isError ? (
        <ErrorBlock error={error} retry={() => void refetch()} />
      ) : visible.length ? (
        <div className="examples-list">
          {visible.map((ex, i) => (
            <Card className="example-card" key={ex.id}>
              <div className="example-card-top">
                <span className="example-number">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="example-kind">{ex.kind}</span>
                <Link
                  href={`/solver?example=${encodeURIComponent(ex.id)}`}
                  className="btn btn-quiet"
                >
                  Open in solver <ArrowRight size={14} />
                </Link>
              </div>
              <h3>{ex.title}</h3>
              <p>{ex.description}</p>
              <MathView
                latex={
                  (ex as any).equation_latex ||
                  equationPreview(ex.m, ex.n) ||
                  ""
                }
                block
              />
              <div className="expected-line">
                <span>EXPECTED RESULT</span>
                <b>{ex.expected_solution}</b>
              </div>
              {(ex as any).analysis && (
                <p className="small-muted">
                  Mᵧ = {(ex as any).analysis.m_y}; Nₓ ={" "}
                  {(ex as any).analysis.n_x}. {(ex as any).analysis.explanation}
                </p>
              )}
              {(ex as any).solution?.solution_latex && (
                <MathView latex={(ex as any).solution.solution_latex} block />
              )}
              <ol className="steps-list">
                {(
                  (ex as any).solution?.steps_latex ||
                  (ex as any).solution?.steps ||
                  []
                ).map((step: string, j: number) => (
                  <li key={j}>
                    <span>{j + 1}</span>
                    <div>
                      {(ex as any).solution?.steps_latex ? (
                        <>
                          <p>{(ex as any).solution.step_descriptions?.[j]}</p>
                          <MathView latex={step} block />
                        </>
                      ) : (
                        <p>{step}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
              {(ex as any).solution?.domain_restrictions?.map(
                (item: string, j: number) => (
                  <p className="notice-line" key={j}>
                    {item}
                  </p>
                ),
              )}
            </Card>
          ))}
        </div>
      ) : (
        <Card className="empty-result">
          <FlaskConical size={22} />
          <b>No examples found</b>
          <p>
            {filter === "all"
              ? "The math engine has not returned any examples."
              : "No examples match this category."}
          </p>
          {filter !== "all" && (
            <Button variant="secondary" onClick={() => setFilter("all")}>
              Clear filter
            </Button>
          )}
        </Card>
      )}
      {!isLoading && !isError && data?.datasets && (
        <div className="dataset-footnote">
          <Database size={15} /> {data.datasets.length} verified sample dataset
          {data.datasets.length === 1 ? "" : "s"} available in Data fitting.
        </div>
      )}
    </div>
  );
}

function Guide() {
  const [open, setOpen] = useState("exactness");
  const lessons = [
    {
      id: "exactness",
      n: "01",
      title: "What makes an equation exact?",
      tag: "STRUCTURE",
      body: (
        <>
          A first-order equation in differential form,{" "}
          <code>M(x, y) dx + N(x, y) dy = 0</code>, is exact when there is a
          potential function <code>F(x, y)</code> whose total differential
          reproduces the equation: <code>dF = Fₓ dx + Fᵧ dy</code>. That means{" "}
          <code>Fₓ = M</code> and <code>Fᵧ = N</code>.
        </>
      ),
      formula: "∂M/∂y = ∂N/∂x",
    },
    {
      id: "test",
      n: "02",
      title: "Why compare cross-partials?",
      tag: "THE TEST",
      body: (
        <>
          If <code>M = Fₓ</code> and <code>N = Fᵧ</code>, then under the usual
          smoothness conditions, the mixed partials agree:{" "}
          <code>Fₓᵧ = Fᵧₓ</code>. So differentiate <code>M</code> with respect
          to <code>y</code>, and <code>N</code> with respect to <code>x</code>.
          Equality is the local exactness test on a suitable domain.
        </>
      ),
      formula: "Mᵧ − Nₓ = 0",
    },
    {
      id: "solve",
      n: "03",
      title: "How do we recover the potential?",
      tag: "INTEGRATION",
      body: (
        <>
          Integrate <code>M</code> with respect to <code>x</code> to get a
          partial expression for <code>F</code>. The integration “constant” may
          depend on <code>y</code>. Differentiate that expression with respect
          to <code>y</code>, compare it with <code>N</code>, then determine the
          missing function of <code>y</code>.
        </>
      ),
      formula: "F(x, y) = C",
    },
    {
      id: "factor",
      n: "04",
      title: "What if it is not exact?",
      tag: "SUPPORTED METHODS",
      body: (
        <>
          A nonzero difference does not end the investigation. Some equations
          admit an integrating factor <code>μ</code> that transforms the
          differential form into an exact one. The solver reports a factor only
          when its supported test finds one; it will not claim a general
          solution for unsupported cases.
        </>
      ),
      formula: "μM dx + μN dy = 0",
    },
    {
      id: "curves",
      n: "05",
      title: "What does a solution curve show?",
      tag: "INITIAL VALUE",
      body: (
        <>
          An initial condition <code>y(x₀) = y₀</code> selects a particular
          trajectory from a family. Numerical integration approximates that
          trajectory over a finite interval. Changing the starting point can
          reveal nearby solution behavior, singularities, or where the
          integration method stops.
        </>
      ),
      formula: "y(x₀) = y₀",
    },
    {
      id: "residuals",
      n: "06",
      title: "How should I read residuals?",
      tag: "MODEL FITTING",
      body: (
        <>
          A residual is the observed value minus the model’s fitted value at the
          same <code>x</code>. Small residuals indicate closer agreement for
          those observations, but fit metrics and residual patterns matter too.
          A model can fit the supplied points and still be a poor explanation
          outside the observed range.
        </>
      ),
      formula: "residual = observed − fitted",
    },
    {
      id: "least-squares",
      n: "07",
      title: "How does least squares estimate a parameter?",
      tag: "CURVE FITTING",
      body: (
        <>
          We vary one solution parameter and minimize the sum of squared
          differences between observations and predictions. For C exp(−x), this
          is a linear one-parameter problem. For a general ODE, each trial
          initial value requires numerical integration. A local optimizer need
          not find a global minimum.
        </>
      ),
      formula: "min Σ (observed − predicted)²",
    },
    {
      id: "metrics",
      n: "08",
      title: "What do the error metrics measure?",
      tag: "ERROR ANALYSIS",
      body: (
        <>
          MSE averages squared residuals; RMSE takes its square root and shares
          the units of y. MAE averages absolute residuals. R² compares squared
          error with predicting the mean: it can be negative, and is undefined
          for constant observations. Inspect residual patterns alongside these
          numbers.
        </>
      ),
      formula: "RMSE = √MSE",
    },
    {
      id: "domains",
      n: "09",
      title: "Why do domains and initial conditions matter?",
      tag: "BRANCHES",
      body: (
        <>
          The equation y² = x² has two straight-line branches. A potential level
          set may have disconnected components, while a regular initial-value
          problem follows one locally defined y(x). Where N is zero, dy/dx =
          −M/N is unavailable. Integrating factors can exclude points or whole
          branches; always retain the original restrictions.
        </>
      ),
      formula: "dy/dx = −M/N",
    },
  ];
  return (
    <div className="page-content">
      <PageHeading
        eyebrow="FIELD GUIDE / CONCEPTS"
        title="Understand the method"
        description="Short notes on exact equations, integrating factors, numerical curves, and fitting observations."
        action={
          <span className="mode-chip">
            <CircleHelp size={14} /> 9 TOPICS
          </span>
        }
      />
      <div className="guide-layout">
        <div className="guide-list">
          {lessons.map((lesson) => (
            <button
              key={lesson.id}
              className={`guide-item ${open === lesson.id ? "open" : ""}`}
              onClick={() => setOpen(open === lesson.id ? "" : lesson.id)}
            >
              <span className="guide-num">{lesson.n}</span>
              <span className="guide-item-copy">
                <small>{lesson.tag}</small>
                <b>{lesson.title}</b>
              </span>
              <span className="guide-toggle">
                {open === lesson.id ? <X size={15} /> : <Plus size={15} />}
              </span>
            </button>
          ))}
        </div>
        <div className="guide-detail">
          {lessons
            .filter((l) => l.id === open)
            .map((lesson) => (
              <Card key={lesson.id} className="lesson-card">
                <div className="eyebrow">
                  TOPIC {lesson.n} / {lesson.tag}
                </div>
                <h2>{lesson.title}</h2>
                <p>{lesson.body}</p>
                <div className="lesson-formula">{lesson.formula}</div>
                <div className="lesson-link-row">
                  <span>TRY IT IN THE WORKSPACE</span>
                  <Link
                    href={
                      lesson.id === "curves"
                        ? "/visualizer"
                        : lesson.id === "residuals"
                          ? "/fitting"
                          : "/solver"
                    }
                    className="text-link"
                  >
                    {lesson.id === "curves"
                      ? "Open visualizer"
                      : lesson.id === "residuals"
                        ? "Open data fitting"
                        : "Open solver"}{" "}
                    <ArrowRight size={14} />
                  </Link>
                </div>
              </Card>
            ))}
          {!open && (
            <Card className="lesson-closed">
              <span className="empty-mark">
                <Sigma size={18} />
              </span>
              <b>Select a topic</b>
              <p>Choose a field note to read the explanation.</p>
            </Card>
          )}
          <div className="guide-aside-note">
            <Info size={15} />
            <p>
              EquationPath computes and verifies results on this device. Always
              check domain restrictions and the assumptions behind a chosen
              model.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function HistoryPage() {
  const [items, setItems] = useState(readHistory);
  useEffect(() => {
    const update = () => setItems(readHistory());
    window.addEventListener("equationpath-history", update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener("equationpath-history", update);
      window.removeEventListener("storage", update);
    };
  }, []);
  const clear = () => {
    if (window.confirm("Clear all locally saved calculation history?")) {
      localStorage.removeItem(HISTORY_KEY);
      setItems([]);
    }
  };
  const grouped = items.reduce<Record<string, HistoryItem[]>>((acc, item) => {
    const key = new Date(item.at).toLocaleDateString([], {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    (acc[key] ||= []).push(item);
    return acc;
  }, {});
  return (
    <div className="page-content">
      <PageHeading
        eyebrow="LOCAL SESSION / ON THIS DEVICE"
        title="Calculation history"
        description="A private record of analyses made in this browser. History is stored locally and is not synced."
        action={
          <Button variant="quiet" disabled={!items.length} onClick={clear}>
            <RotateCcw size={14} /> Clear history
          </Button>
        }
      />
      {items.length ? (
        <div className="history-groups">
          {Object.entries(grouped).map(([day, entries]) => (
            <div className="history-group" key={day}>
              <div className="history-day">
                <span>{day}</span>
                <i />
              </div>
              {entries.map((item) => (
                <Card className="history-entry" key={item.id}>
                  <div className="history-time">
                    {new Date(item.at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                  <span className="history-module-icon">
                    {item.module.includes("Curve") ? (
                      <LineChart size={17} />
                    ) : item.module.includes("fitting") ? (
                      <Database size={17} />
                    ) : (
                      <Sigma size={17} />
                    )}
                  </span>
                  <div className="history-entry-main">
                    <small>{item.module}</small>
                    <b>{item.title}</b>
                    <span>{item.detail}</span>
                  </div>
                  <Link
                    href={item.href}
                    className="icon-button history-open"
                    aria-label={`Open ${item.module}`}
                  >
                    <ArrowRight size={16} />
                  </Link>
                </Card>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <Card className="history-empty">
          <div className="empty-mark large">
            <History size={21} />
          </div>
          <div className="eyebrow">NOTHING IN THIS SESSION YET</div>
          <h3>Start with an equation or observation set</h3>
          <p>
            When you check, solve, plot, or fit something, the calculation will
            be saved here on this device.
          </p>
          <div className="hero-actions">
            <Link href="/solver" className="btn btn-primary">
              Open solver <ArrowRight size={15} />
            </Link>
            <Link href="/fitting" className="btn btn-outline">
              Fit data
            </Link>
          </div>
        </Card>
      )}
      <div className="local-note">
        <Info size={14} /> Clearing browser storage also removes this history.
      </div>
    </div>
  );
}

function Router() {
  const [location] = useLocation();
  const [visited, setVisited] = useState<string[]>([location]);
  useEffect(() => {
    setVisited((items) =>
      items.includes(location) ? items : [...items, location],
    );
  }, [location]);
  useEffect(() => {
    const listener = (event: Event) =>
      addHistory((event as CustomEvent).detail);
    window.addEventListener("equationpath-calculation", listener);
    return () =>
      window.removeEventListener("equationpath-calculation", listener);
  }, []);
  const screens: Record<string, ReactNode> = {
    "/": <Overview />,
    "/solver": <Solver />,
    "/visualizer": <Visualizer />,
    "/fitting": <Fitting />,
    "/practice": <Practice />,
    "/examples": <Examples />,
    "/guide": <Guide />,
    "/history": <HistoryPage />,
  };
  return (
    <ErrorBoundary resetKey={location}>
      <AppFrame>
        <Suspense
          fallback={
            <div className="panel" role="status">
              Loading module…
            </div>
          }
        >
          {Array.from(new Set([...visited, location])).map((path) => (
            <div key={path} hidden={path !== location}>
              {screens[path] || <NotFound />}
            </div>
          ))}
        </Suspense>
      </AppFrame>
    </ErrorBoundary>
  );
}
function App() {
  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
export default App;
