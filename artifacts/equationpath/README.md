# EquationPath — Exact / Non-Exact ODE Studio

EquationPath is an interactive learning and computation workspace for first-order differential equations and introductory curve fitting. It checks whether `M(x,y) dx + N(x,y) dy = 0` is exact, solves verifiable exact equations, tests supported integrating factors that depend only on x or y, plots numerically integrated solution curves, and compares solution families with sample observations.

## Mathematical scope

- Safely parses expressions with `x`, `y`, arithmetic, powers, `pi`, `E`, and supported trigonometric, hyperbolic, exponential, logarithmic, square-root, and absolute-value functions.
- Compares symbolic `M_y` and `N_x`; exact solutions are constructed by integration and verified against both original partial derivatives.
- Supports one-variable integrating factors `μ(x)` and `μ(y)` only when the test simplifies to that variable and the transformed equation verifies as exact.
- Uses SciPy `solve_ivp` for initial-value plots of `dy/dx = -M/N`; singularities and integration failures are reported.
- Fits the integration constant `C` for three sample model families: `C exp(-x)`, `C exp(2x)`, and `x² + C`. Reports MSE, RMSE, MAE, and R² (undefined when the observed values have zero total variance).
- A lower residual error is not evidence that a differential equation is physically valid. Implicit and branch/domain limitations are preserved in explanations.

The parser builds SymPy expressions from a restricted Python AST; it does not call Python `eval` or accept arbitrary code.

## Stack

- Frontend: React, Vite, TypeScript, Tailwind CSS, Wouter, TanStack Query, Plotly-compatible charting.
- API gateway: Express 5 with OpenAPI-generated request/response schemas.
- Math service: Python, FastAPI, SymPy, NumPy, SciPy, and Pandas.
- Calculation history and uploaded CSV analysis state are held in the browser's local storage; no account or external service is required.

## Project structure

- `src/` — EquationPath interface, routes, and interactive visualizations.
- `backend/app/main.py` — safe parsing, exactness, symbolic solutions, numerical plots, example data, and fitting.
- `backend/tests/` — mathematical regression tests.
- `backend/requirements.txt` — Python runtime dependency list.
- `datasets/` — bundled synthetic CSV datasets and their generation notes.

## Running in the Replit workspace

The web interface and API gateway run as separate managed services. The API gateway starts the local FastAPI math service automatically.

- Start the web app: `pnpm --filter @workspace/equationpath run dev`
- Start the API gateway: `pnpm --filter @workspace/api-server run dev`
- Check TypeScript: `pnpm run typecheck`
- Run backend math tests: `PYTHONPATH=artifacts/equationpath/backend ./.pythonlibs/bin/python -m unittest discover -s artifacts/equationpath/backend/tests`

Python packages are installed in the workspace-managed `.pythonlibs` environment. For a clean Python environment, install `backend/requirements.txt` before starting the API gateway.

## Example workflow

1. Enter `M = 2*x*y + 3` and `N = x**2 + 4*y`.
2. Check exactness, then solve to obtain `x²y + 3x + 2y² = C`.
3. Set an initial condition to plot a numerical solution branch.
4. Open a bundled synthetic dataset, fit its supported model constant, and inspect prediction errors and residual metrics.

## Known limitations

- The symbolic solver supports exact equations and simple one-variable integrating factors; it does not claim that other non-exact equations have no solution.
- Some symbolic integrals may be unavailable or too complex to verify. Such cases return a limitation rather than a fabricated solution.
- The plot module produces an initial-value branch numerically and may stop near denominator zeros or solver singularities. It does not extract every implicit contour branch.
- Curve fitting is limited to the three bundled model families. Duplicate x-coordinates are rejected.

## Equation Solver → Visualization / Fitting workflow

After solving an equation, use **Visualize this equation** to transfer its exact M and N expressions into the existing numerical IVP visualizer. Initial conditions remain user-selectable.

The solver additionally offers **Compare with observations** only for explicitly recognized, backend-verifiable equations in the three supported fitting families (with N=1):

| M | N | ODE | Fit family |
| --- | --- | --- | --- |
| y | 1 | dy/dx = -y | decay |
| -2*y | 1 | dy/dx = 2y | growth |
| -2*x | 1 | dy/dx = 2x | quadratic |

The transfer preserves the source equation in browser local storage, preselects the correct model family, and retains CSV upload / case selection and residual plotting. More general exact ODEs can be visualized but **cannot yet be fitted automatically**; this restriction is intentional to prevent presenting an unrelated fitted family as if it came from the entered equation. Matching is a strict whitelist of recognized expression spellings, not symbolic equivalence of arbitrary inputs.

## Numerical fitting of a user-entered first-order ODE

The Data Fitting module now offers **Fit entered ODE**, alongside the existing three analytic sample families. Provide `M(x,y)`, `N(x,y)`, at least three observations and an initial `x₀`. The math service uses SciPy `solve_ivp` to evaluate the single regular `y(x)` branch and `least_squares` to estimate `y(x₀)`. It returns predictions, row-level residuals and the same error metrics/plots as sample fitting. A completed equation in the Solver can open this mode with M and N carried over.

The numerical fitter is local and bounded (3–200 observations, x-values within 100 units of x₀, max 90 residual evaluations). It cannot handle vertical curves, singular paths, arbitrary additional model parameters, or certify uniqueness/global optimality. Inspect the fit and model-domain warnings; a low RMSE does not establish physical validity.
